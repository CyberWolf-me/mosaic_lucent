/**
 * THE DEPLOYMENT REHEARSAL (2026-09 review §13–14): prove the
 * modular-monolith scale-out story — two real server processes over one
 * Postgres, pg_notify fanout between them, instance kill/restart, and the
 * restart-persistence arms the live pass could not run without working
 * local credentials.
 *
 * The protocol (each arm prints PASS/FAIL and the exit code reflects them):
 *   1. CROSS-INSTANCE SEED   — signup+board+ops on A; GET on B shows them.
 *   2. CROSS-INSTANCE WRITE  — ops via B; GET on A sees the op (the op log
 *                              is the source of truth; the fanout
 *                              notification costs a replay, never a loss).
 *   3. INSTANCE KILL         — A is killed hard; B still serves the board.
 *   4. RESTART PERSISTENCE   — A restarts; every account, board, and op
 *                              survives (the in-memory fallback cannot do
 *                              this — the arm that proves the database).
 *
 * Run (CI, or anywhere a disposable Postgres exists):
 *   LUCENT_DATABASE_URL=postgres://… npx tsx scripts/deploy-rehearsal.ts
 * Skips honestly (exit 0, one line) when the URL is absent — the local
 * default has no working credentials, and the PG suites already gate CI.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DATABASE_URL = process.env.LUCENT_DATABASE_URL;
const SERVER_DIST = new URL("../packages/server/dist/main.js", import.meta.url);

if (!DATABASE_URL) {
  console.log(
    "deploy-rehearsal: SKIPPED — LUCENT_DATABASE_URL is not set. Two-instance and\n" +
      "restart-persistence arms need a real Postgres (CI provides one); the in-memory\n" +
      "fallback cannot prove persistence by construction.",
  );
  process.exit(0);
}

let failures = 0;
const arm = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

interface Instance {
  proc: ChildProcess;
  port: number;
  base: string;
  start(): Promise<void>;
  kill(): Promise<void>;
}

function instance(name: "A" | "B", port: number): Instance {
  let proc: ChildProcess | null = null;
  const base = `http://127.0.0.1:${port}`;
  const self: Instance = {
    proc: null as unknown as ChildProcess,
    port,
    base,
    async start() {
      proc = spawn(
        process.execPath,
        [SERVER_DIST.pathname],
        {
          env: {
            ...process.env,
            LUCENT_DATABASE_URL: DATABASE_URL,
            LUCENT_PORT: String(port),
            LUCENT_HOST: "127.0.0.1",
            // The rehearsal uses its own throwaway orgs; auth on, provider mock.
            LUCENT_REQUIRE_AUTH: "1",
            LUCENT_AI_PROVIDER: "mock",
          },
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      self.proc = proc;
      // Wait for the health endpoint; the migrations run on boot.
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(`${base}/health`);
          if (res.ok) return;
        } catch {
          // not up yet
        }
        await sleep(500);
      }
      throw new Error(`${name} never became healthy`);
    },
    async kill() {
      if (proc) {
        proc.kill("SIGKILL");
        await sleep(500);
      }
    },
  };
  return self;
}

async function api(base: string, path: string, init: RequestInit & { token?: string; csrf?: string } = {}) {
  const { token, csrf, ...rest } = init;
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function main() {
  const a = instance("A", 4461);
  const b = instance("B", 4462);
  console.log("deploy-rehearsal: booting instances A (:4461) and B (:4462)…");
  await a.start();
  await b.start();

  try {
    // --- ARM 1: cross-instance seed ---
    const signup = await api(a.base, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: `rehearsal+${Date.now()}@example.com`, password: "rehearsal-pass-1", name: "Rehearsal" }),
    });
    const token = (signup.body as { token?: string }).token;
    arm("signup on A", signup.status === 201 && Boolean(token));
    if (!token) throw new Error("cannot continue without a token");

    const created = await api(a.base, "/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Rehearsal board" }),
    });
    const boardId = created.body.id as string;
    arm("board created on A", created.status === 201 && Boolean(boardId));

    await api(a.base, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token,
      body: JSON.stringify({
        label: "rehearsal seed",
        ops: [{ op: "CREATE_NODE", id: "node-a", nodeType: "service", label: "From A" }],
      }),
    });
    const seenOnB = await api(b.base, `/api/boards/${boardId}`, { token });
    const nodesB = Object.keys(
      (seenOnB.body.workspace as { nodes?: Record<string, unknown> } | undefined)?.nodes ?? {},
    );
    arm("1. cross-instance seed — A's write visible on B", seenOnB.status === 200 && nodesB.includes("node-a"), `B sees: ${nodesB.join(", ") || "nothing"}`);

    // --- ARM 2: cross-instance write ---
    await api(b.base, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token,
      body: JSON.stringify({
        label: "rehearsal via B",
        ops: [{ op: "CREATE_NODE", id: "node-b", nodeType: "service", label: "From B" }],
      }),
    });
    const seenOnA = await api(a.base, `/api/boards/${boardId}`, { token });
    const nodesA = Object.keys(
      (seenOnA.body.workspace as { nodes?: Record<string, unknown> } | undefined)?.nodes ?? {},
    );
    arm("2. cross-instance write — B's write visible on A", nodesA.includes("node-b"), `A sees: ${nodesA.join(", ") || "nothing"}`);

    // --- ARM 3: instance kill ---
    await a.kill();
    const bAfterKill = await api(b.base, `/api/boards/${boardId}`, { token });
    arm("3. instance kill — B still serves after A dies hard", bAfterKill.status === 200);

    // --- ARM 4: restart persistence ---
    await a.start();
    const aAfterRestart = await api(a.base, `/api/boards/${boardId}`, { token });
    const nodesRestarted = Object.keys(
      (aAfterRestart.body.workspace as { nodes?: Record<string, unknown> } | undefined)?.nodes ?? {},
    );
    arm(
      "4. restart persistence — A restarts and every write survives",
      aAfterRestart.status === 200 && nodesRestarted.includes("node-a") && nodesRestarted.includes("node-b"),
      `restarted A sees: ${nodesRestarted.join(", ") || "nothing"}`,
    );
  } finally {
    await b.kill();
    // A may already be dead from arm 3; kill() tolerates that.
    await a.kill();
  }

  console.log(failures === 0 ? "\nDEPLOYMENT REHEARSAL: ALL PASS" : `\nDEPLOYMENT REHEARSAL: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("deploy-rehearsal ERROR", err);
  process.exit(1);
});
