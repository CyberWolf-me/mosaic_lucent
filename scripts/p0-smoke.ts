/**
 * The P0 live smoke (2026-09-10): boot the real app (createApp, all routes and
 * middleware registered) and verify the three fixed seams over real HTTP —
 * the strict 422 (formerly a process crash, eval defect E1), the ops-API
 * batch reaching the board (defect M1/M2's coherence family), and the
 * history window no longer hiding the log behind a snapshot floor (defect P1).
 *
 * Run: npx tsx scripts/p0-smoke.ts
 */
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp } from "../packages/server/src/app.js";
import { InMemoryUserStore } from "../packages/server/src/accounts.js";
import { InMemoryBoardStore } from "../packages/server/src/boards.js";
import { InMemoryProposalStore } from "../packages/server/src/proposals.js";
import { InMemoryMeetingStore } from "../packages/server/src/meetings.js";
import { InMemoryUsageStore } from "../packages/server/src/usageStore.js";
import { PLAN_LADDER } from "../packages/server/src/plans.js";
import { UsageTracker, limitsFromEnv } from "../packages/server/src/usage.js";
import { Telemetry } from "../packages/server/src/telemetry.js";
import { Limiter } from "../packages/server/src/limiter.js";
import { InMemoryTicketStore } from "../packages/server/src/realtimeTicket.js";
import { InMemorySessionStore } from "../packages/server/src/sessions.js";
import { readConfig } from "../packages/server/src/config.js";

const SECRET = "p0-smoke-secret-at-least-16-chars";

let exitCode = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) exitCode = 1;
};

async function main() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore: new InMemoryUsageStore(PLAN_LADDER),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  // --- account ---
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `p0smoke+${Date.now()}@example.com`,
      password: "p0-smoke-pass-1",
      name: "P0 Smoke",
    }),
  });
  const signupBody = (await signup.json()) as { token?: string };
  ok("signup returns 201", signup.status === 201, `status ${signup.status}`);
  const token = signupBody.token;
  if (!token) throw new Error(`no token from signup: ${JSON.stringify(signupBody)}`);

  // --- board ---
  const board = await fetch(`${base}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "P0 smoke board" }),
  });
  const boardBody = (await board.json()) as { id?: string };
  ok("create board returns 201", board.status === 201, `status ${board.status}`);
  const boardId = boardBody.id as string;

  // --- SEAM 1: the E1 crash vector now 422s instead of killing the process ---
  const malformed = await fetch(`${base}/api/boards/${boardId}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ops: [{ op: "SET_STATEMENT", id: "n1", kind: "decision", status: "open" }],
    }),
  });
  const malformedBody = (await malformed.json()) as { errors?: { message?: string }[] };
  ok(
    "malformed SET_STATEMENT answers 422 with the issue named",
    malformed.status === 422 && (malformedBody.errors?.length ?? 0) > 0,
    `status ${malformed.status}: ${malformedBody.errors?.[0]?.message ?? "no issue listed"}`,
  );

  // The server must still answer after the malformed op — the crash repro.
  const afterMalformed = await fetch(`${base}/api/boards/${boardId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  ok(
    "server alive after malformed op (the E1 crash repro)",
    afterMalformed.status === 200,
    `status ${afterMalformed.status}`,
  );

  // --- SEAM 2: a valid ops-API batch reaches the board ---
  const seed = await fetch(`${base}/api/boards/${boardId}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      label: "p0 smoke seed",
      ops: [
        { op: "CREATE_NODE", id: "n1", nodeType: "decision", label: "Phased rollout" },
        { op: "SET_STATEMENT", id: "n1", statement: { kind: "decision", status: "open" } },
        { op: "CREATE_NODE", id: "n2", nodeType: "action", label: "Write the plan" },
        { op: "SET_STATEMENT", id: "n2", statement: { kind: "action", status: "open" } },
        { op: "SET_ISSUE", id: "n2", issue: { type: "task", status: "open" } },
      ],
    }),
  });
  const seedBody = (await seed.json()) as { seq?: number; applied?: number };
  ok(
    "valid ops batch applies",
    seed.status === 200 && seedBody.applied === 5,
    `status ${seed.status}, seq ${seedBody.seq}, applied ${seedBody.applied}`,
  );

  const got = await fetch(`${base}/api/boards/${boardId}`, { headers: { authorization: `Bearer ${token}` } });
  const gotBody = (await got.json()) as { workspace?: { nodes?: Record<string, unknown> } };
  const nodeIds = Object.keys(gotBody.workspace?.nodes ?? {});
  ok(
    "ops-API batch is visible in the board",
    nodeIds.includes("n1") && nodeIds.includes("n2"),
    `nodes: ${nodeIds.join(", ") || "none"}`,
  );

  // --- SEAM 3: the history window shows the log, not an empty timeline ---
  const history = await fetch(`${base}/api/boards/${boardId}/history?depth=25`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const historyBody = (await history.json()) as {
    items?: unknown[];
    latestSeq?: number;
    hasMore?: boolean;
  };
  const entries = historyBody.items?.length ?? 0;
  const head = historyBody.latestSeq ?? 0;
  ok(
    "history window returns the log (not the P1 empty timeline)",
    history.status === 200 && entries > 0 && head >= 1,
    `status ${history.status}, ${entries} entries, head ${head}, hasMore ${historyBody.hasMore}`,
  );

  console.log(exitCode === 0 ? "\nP0 SMOKE: ALL PASS" : "\nP0 SMOKE: FAILURES");
  await close();
  process.exit(exitCode);
}

main().catch(async (err) => {
  console.error("P0 SMOKE ERROR", err);
  process.exit(1);
});
