import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * POST /api/boards/:id/ops (E3 / R1): the agent op-apply route.
 *
 * Six behaviours, one per test:
 *   1. A valid batch lands on the board and is visible to a later GET.
 *   2. An invalid batch is refused 422 with the validator's own errors, and
 *      — the part that makes the route safe — the board is unchanged.
 *   3. Authorship is stamped with the CALLER's id, not "assistant": the
 *      op log and any comment the batch carries attribute to the human who
 *      authorised the agent, which is what the authorship rules exist for.
 *   4. `expectedSeq` optimistic concurrency: a stale expectation gets 409
 *      with the head, not a silent write on top of someone's edit.
 *   5. A viewer is refused (404 via the board role guard, ids unguessable).
 *   6. Anonymous is 401.
 *
 * The harness is the collab.e2e pattern: real createApp, real signup (the
 * bearer token from the response body), real board creation through the
 * store — because the point of this route is the seam between an external
 * agent and the real persistence path.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  close: () => Promise<void>;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  api: (
    path: string,
    init: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string) => Promise<{ token: string; id: string }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (path, init) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const signup = async (email: string) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(status).toBe(201);
    return { token: body.token as string, id: body.user.id as string };
  };

  return { base, close, userStore, boardStore, api, signup };
}

async function seedBoard(
  h: Harness,
  owner: { token: string; id: string },
  name = "Agent board",
): Promise<string> {
  const { status, body } = await h.api("/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ name, workspace: createWorkspace() }),
  });
  expect(status).toBe(201);
  return body.id as string;
}

describe("POST /api/boards/:id/ops (agent op-apply, R1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("applies a valid batch and the change survives a later GET", async () => {
    h = await harness();
    const owner = await h.signup("owner@example.com");
    const boardId = await seedBoard(h, owner);

    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "n-agent-1", nodeType: "step", label: "From an agent" },
    ];
    const applied = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ ops, label: "agent: seed the flow" }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(1);
    expect(typeof applied.body.seq).toBe("number");

    const after = await h.api(`/api/boards/${boardId}`, { token: owner.token });
    expect(after.status).toBe(200);
    expect(after.body.workspace.nodes["n-agent-1"]).toBeTruthy();
    expect(after.body.workspace.nodes["n-agent-1"].label).toBe("From an agent");
  });

  it("refuses an invalid batch 422 with the validator's errors, board untouched", async () => {
    h = await harness();
    const owner = await h.signup("owner2@example.com");
    const boardId = await seedBoard(h, owner);

    // Connects to a node that does not exist: the validator names it.
    const bad: Operation[] = [
      { op: "CONNECT_NODES", source: "ghost", target: "phantom", relationship: "flow" },
    ];
    const refused = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ ops: bad }),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("operations failed validation");
    expect(Array.isArray(refused.body.errors)).toBe(true);
    expect(refused.body.errors.length).toBeGreaterThan(0);

    const after = await h.api(`/api/boards/${boardId}`, { token: owner.token });
    expect(Object.keys(after.body.workspace.nodes)).toHaveLength(0);
  });

  it("stamps the caller's authorship, not the assistant's", async () => {
    h = await harness();
    const owner = await h.signup("owner3@example.com");
    const boardId = await seedBoard(h, owner);

    // ADD_COMMENT requires a target that exists; create it first, then a
    // comment whose author must come out as the caller.
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "n-c", nodeType: "step", label: "target" },
      { op: "ADD_COMMENT", id: "cmt-agent", targetId: "n-c", body: "agent note" },
    ];
    const applied = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ ops }),
    });
    expect(applied.status).toBe(200);

    const after = await h.api(`/api/boards/${boardId}`, { token: owner.token });
    const comment = after.body.workspace.comments["cmt-agent"];
    expect(comment).toBeTruthy();
    expect(comment.by).toBe(owner.id);
  });

  it("409s with the head when expectedSeq is stale", async () => {
    h = await harness();
    const owner = await h.signup("owner4@example.com");
    const boardId = await seedBoard(h, owner);

    const ops: Operation[] = [{ op: "CREATE_NODE", id: "n-a", nodeType: "step", label: "a" }];
    await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ ops }),
    });

    // A second batch claiming to have validated against seq 1 (already
    // taken) must be told it is stale, not silently appended.
    const stale = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-b", nodeType: "step", label: "b" }],
        expectedSeq: 1,
      }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.reason).toBeTruthy();
    expect(typeof stale.body.head).toBe("number");
  });

  it("refuses a viewer with the board guard's 404 (ids stay unguessable)", async () => {
    h = await harness();
    const owner = await h.signup("owner5@example.com");
    const viewer = await h.signup("viewer@example.com");
    const boardId = await seedBoard(h, owner);
    // Owner grants the viewer a viewer seat on the board.
    const { boardStore } = h;
    await boardStore.setMember({
      boardId,
      userId: viewer.id,
      role: "viewer",
      invitedBy: owner.id,
      createdAt: Date.now(),
    });

    const refused = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-v", nodeType: "step", label: "no" }],
      }),
    });
    // requireBoardRole answers 404 whether the board is missing or the
    // caller merely lacks the role — same masking as every board route.
    expect(refused.status).toBe(404);

    const after = await h.api(`/api/boards/${boardId}`, { token: owner.token });
    expect(after.body.workspace.nodes["n-v"]).toBeUndefined();
  });

  it("requires authentication (401 anonymous)", async () => {
    h = await harness();
    const owner = await h.signup("owner6@example.com");
    const boardId = await seedBoard(h, owner);
    const res = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-x", nodeType: "step", label: "x" }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it("folds agent-submitted topic variants onto the board's existing key (Stage C5)", async () => {
    // Agent ops are machine-authored — a model's output riding a human's
    // token — so they fold like any model batch. Without this site, the MCP
    // path mints 'prices' while generate folds to 'pricing': the four-way
    // divergence (AI / MCP / WebSocket / Web) the boundary rule closes.
    h = await harness();
    const owner = await h.signup("owner7@example.com");
    const boardId = await seedBoard(h, owner);

    // Seed the board's existing authored key directly through the store.
    const { applyOperations } = await import("@lucent/core");
    const board = await h.boardStore.get(boardId);
    if (!board) throw new Error("board missing");
    const seed: Operation[] = [
      { op: "CREATE_NODE", id: "p1", nodeType: "decision", label: "Pricing" },
      {
        op: "SET_STATEMENT",
        id: "p1",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
      },
    ];
    await h.boardStore.put({
      ...board,
      workspace: applyOperations(board.workspace, seed),
    });

    const res = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        ops: [
          { op: "CREATE_NODE", id: "p2", nodeType: "decision", label: "Pricing model" },
          {
            op: "SET_STATEMENT",
            id: "p2",
            statement: { kind: "decision", status: "open", topic: "prices" },
          },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const after = await h.api(`/api/boards/${boardId}`, { token: owner.token });
    const topic = after.body.workspace.nodes.p2?.statement?.topic;
    expect(topic).toBe("pricing");
  });
});
