import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, inverseOperations, type Operation } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";

/**
 * Stage C6's definition of done. The Intelligence view is a PURE CLIENT
 * projection (ADR 0026) — its projection functions are node-tested in the
 * web package, exactly as the C4 palette functions were. What this e2e
 * pins is the server-side contract the view stands on:
 *
 *   The workspace the client fetches carries every statement (all six
 *   kinds, open and settled, provenance included) — fetchBoard installs
 *   exactly what intelligenceSections reads, with no server-side
 *   reduction. And the inbox's Merge batch — UPDATE_STATEMENT ops the
 *   human confirmed — validates against a real stored board through the
 *   ordinary ops route, converges the duplicate pair, and round-trips
 *   through the inverse: the same validator, the same undo, the same
 *   history as any human edit. Detection may be automatic; application is
 *   never silent, and only the explicit click applies.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore: new InMemoryUsageStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    close: async () => {
      await close();
    },
  };
}

let open: Harness | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      origin: h.base,
      ...(rest.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function signup(h: Harness, email: string): Promise<{ token: string; id: string }> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

/** The C6 story board: all six kinds, mixed statuses, a variant pair, the assignee bridge. */
function storyOps(): Operation[] {
  return [
    { op: "CREATE_NODE", id: "launch-decision", nodeType: "decision", label: "Launch Oct 15" },
    {
      op: "SET_STATEMENT",
      id: "launch-decision",
      statement: {
        kind: "decision",
        status: "resolved",
        topic: "launch",
        provenance: { meetingId: "mtg_mon", turnRange: [0, 0] },
      },
    },
    {
      op: "CREATE_NODE",
      id: "university-proposal",
      nodeType: "decision",
      label: "Maybe target universities",
    },
    {
      op: "SET_STATEMENT",
      id: "university-proposal",
      statement: { kind: "proposal", status: "open", topic: "targeting" },
    },
    {
      op: "CREATE_NODE",
      id: "billing-question",
      nodeType: "decision",
      label: "Monthly or annual pricing?",
    },
    {
      op: "SET_STATEMENT",
      id: "billing-question",
      statement: { kind: "question", status: "open", topic: "pricing" },
    },
    { op: "CREATE_NODE", id: "launch-brief", nodeType: "action", label: "Prepare launch brief" },
    {
      op: "SET_STATEMENT",
      id: "launch-brief",
      statement: {
        kind: "action",
        status: "open",
        topic: "launch",
        provenance: { meetingId: "mtg_wed", turnRange: [2, 2] },
      },
    },
    {
      op: "SET_ISSUE",
      id: "launch-brief",
      issue: { type: "task", status: "To Do", statusCategory: "todo", assignee: "sarah" },
    },
    { op: "CREATE_NODE", id: "sso-requirement", nodeType: "decision", label: "Support SSO" },
    {
      op: "SET_STATEMENT",
      id: "sso-requirement",
      statement: { kind: "requirement", status: "resolved", topic: "auth" },
    },
    {
      op: "CREATE_NODE",
      id: "appstore-risk",
      nodeType: "decision",
      label: "App Store review delay",
    },
    {
      op: "SET_STATEMENT",
      id: "appstore-risk",
      statement: { kind: "risk", status: "open", topic: "launch" },
    },
    // The variant pair the inbox detects: 'pricing' beside 'pricing-model'.
    { op: "CREATE_NODE", id: "pricing-decision", nodeType: "decision", label: "Pricing at $15/mo" },
    {
      op: "SET_STATEMENT",
      id: "pricing-decision",
      statement: { kind: "decision", status: "resolved", topic: "pricing" },
    },
    {
      op: "CREATE_NODE",
      id: "pricing-model-risk",
      nodeType: "decision",
      label: "Pricing model complexity",
    },
    {
      op: "SET_STATEMENT",
      id: "pricing-model-risk",
      statement: {
        kind: "risk",
        status: "open",
        topic: "pricing-model",
        provenance: { meetingId: "mtg_wed", turnRange: [4, 4] },
      },
    },
  ];
}

describe("Stage C6 definition of done — the continuous scenario", () => {
  it("the fetched workspace carries every statement, and the merge batch validates, converges, and undoes", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");

    // -- A shared board carrying the C6 story --------------------------------
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Q3 launch", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    const ops = storyOps();
    const appended = await h.boardStore.appendOp({
      boardId,
      ops,
      by: alice.id,
      label: "the meeting extraction",
      at: Date.now(),
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(appended.ok).toBe(true);
    const board = await h.boardStore.get(boardId);
    if (!board || !appended.ok) throw new Error("board missing");
    const storyWorkspace = applyOperations(board.workspace, ops);
    await h.boardStore.put({ ...board, workspace: storyWorkspace });

    // -- The client contract: fetchBoard installs EXACTLY what the projection
    // reads — every statement kind, open and settled, provenance included,
    // no server-side reduction. (The pure projection itself is pinned in
    // packages/web/test/intelligence.test.ts; here we pin that the data
    // reaches the client whole.)
    const fetched = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(fetched.status).toBe(200);
    const nodes = fetched.body.workspace.nodes as Record<string, any>;
    const kinds = new Set(
      Object.values(nodes)
        .filter((n: any) => n.statement)
        .map((n: any) => n.statement.kind),
    );
    expect([...kinds].sort()).toEqual([
      "action",
      "decision",
      "proposal",
      "question",
      "requirement",
      "risk",
    ]);
    // Provenance rides to the client (the ✦ jump's source).
    expect(nodes["launch-decision"]?.statement?.provenance).toEqual({
      meetingId: "mtg_mon",
      turnRange: [0, 0],
    });
    // The assignee bridge: the action statement ALSO carries work tracking.
    expect(nodes["launch-brief"]?.issue?.assignee).toBe("sarah");
    // The variant pair is on the board as-authored.
    expect(nodes["pricing-decision"]?.statement?.topic).toBe("pricing");
    expect(nodes["pricing-model-risk"]?.statement?.topic).toBe("pricing-model");

    // -- The inbox Merge, committed as the human's explicit action -----------
    // The previewed-and-confirmed batch: UPDATE_STATEMENT ops for the dup
    // side (what mergeOps derives on the client — re-derived here directly
    // from the fetched workspace, the same derivation).
    const mergeBatch: Operation[] = Object.values(nodes)
      .filter((n: any) => n.statement?.topic === "pricing-model")
      .map((n: any) => ({ op: "UPDATE_STATEMENT", id: n.id, topic: "pricing" }));
    expect(mergeBatch).toEqual([
      { op: "UPDATE_STATEMENT", id: "pricing-model-risk", topic: "pricing" },
    ]);

    // Through the ordinary ops route — the same validator applyManual runs.
    // A USER-actor batch: the merge is the human's confirmed action, so the
    // room's ai-only topic fold does NOT touch it — and does not need to:
    // 'pricing' is the exact existing authored key, already canonical.
    const merged = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: mergeBatch, label: "merge duplicate topics" }),
    });
    expect(merged.status).toBe(200);

    const afterMerge = await h.boardStore.get(boardId);
    // The pair converged: the dup side now carries the existing key.
    expect(afterMerge?.workspace.nodes["pricing-model-risk"]?.statement?.topic).toBe("pricing");
    // And the log carries the merge as an ordinary sequenced entry — the
    // same history any human edit rides.
    const log = await h.boardStore.loadLog(boardId);
    const mergeEntry = log.find((e) =>
      e.ops.some((o) => o.op === "UPDATE_STATEMENT" && (o as any).topic === "pricing"),
    );
    expect(mergeEntry).toBeDefined();
    expect(mergeEntry?.label).toBe("merge duplicate topics");

    // -- And the merge undoes: the same inverse machinery any edit rides ----
    // The inverse is derived against the state BEFORE the batch (the
    // workspace the client validated against), then applied to the merged
    // state — exactly how undo rebuilds the prior world.
    const inverse = inverseOperations(mergeBatch, storyWorkspace);
    const restored = applyOperations(afterMerge!.workspace, inverse);
    expect(restored.nodes["pricing-model-risk"]?.statement?.topic).toBe("pricing-model");
  });
});
