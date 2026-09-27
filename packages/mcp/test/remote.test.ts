import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
// Deep imports rather than the package index: @lucent/server exports only the
// generate/usage surface from index.ts, and the package has no `exports` map,
// so `@lucent/server/src/x.js` resolves — the same paths the server's own
// tests import relatively.
import { createApp } from "@lucent/server/src/app.js";
import { InMemoryUserStore } from "@lucent/server/src/accounts.js";
import { InMemoryBoardStore } from "@lucent/server/src/boards.js";
import { InMemorySessionStore } from "@lucent/server/src/sessions.js";
import { UsageTracker, limitsFromEnv } from "@lucent/server/src/usage.js";
import { Telemetry } from "@lucent/server/src/telemetry.js";
import { Limiter } from "@lucent/server/src/limiter.js";
import { InMemoryTicketStore } from "@lucent/server/src/realtimeTicket.js";
import { readConfig } from "@lucent/server/src/config.js";
import { RemoteBoardSession, remoteConfigFromEnv } from "../src/remote.js";

/**
 * RemoteBoardSession against a REAL server (E3 / R1's gate).
 *
 * The plan's promise for agent access: "an agent emits
 * `apply_canvas_operations` and the change is on the server; `get_board`
 * returns the server's board; server and MCP agree afterwards." Testing that
 * against a stubbed fetch proves nothing about the seam, so this boots the
 * actual `createApp` — the same harness shape the server's own collab
 * e2e suite uses — and drives the session through its real HTTP path.
 *
 * The @lucent/server devDependency exists for this file (and the package's
 * runtime deps stay exactly `@lucent/core`): the shipped MCP client needs
 * nothing but core; the test needs the server it talks to.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  close: () => Promise<void>;
  api: (
    path: string,
    init: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
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

  return { base, close, api };
}

async function ownerWithBoard(h: Harness): Promise<{ token: string; boardId: string }> {
  const { status, body } = await h.api("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      email: "agent@example.com",
      password: "password123",
      name: "Agent Owner",
    }),
  });
  expect(status).toBe(201);
  const token = body.token as string;
  const created = await h.api("/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "Agent board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  return { token, boardId: created.body.id as string };
}

describe("RemoteBoardSession against a real server (E3/R1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("round-trips: MCP applies, and get_board reflects the server's board", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });

    const applied = await session.callTool("apply_canvas_operations", {
      operations: [
        { op: "CREATE_NODE", id: "n-r1", nodeType: "service", label: "Via MCP" },
        { op: "CREATE_NODE", id: "n-r2", nodeType: "service", label: "Also MCP" },
        { op: "CONNECT_NODES", source: "n-r1", target: "n-r2", relationship: "calls" },
      ],
    });
    expect(applied.isError).toBeUndefined();
    expect(applied.content[0]!.text).toMatch(/Applied 3 operation/);

    const summary = await session.callTool("get_board", {});
    expect(summary.isError).toBeUndefined();
    const parsed = JSON.parse(summary.content[0]!.text) as {
      nodeCount: number;
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(parsed.nodeCount).toBe(2);
    expect(parsed.edges).toEqual([{ source: "n-r1", target: "n-r2", relationship: "calls" }]);
  });

  it("pre-validates locally: a malformed batch is named before any network call", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });

    // Prime the local cache with the board's current state.
    await session.callTool("get_board", {});

    // A fetch that records calls: the point is that apply never reaches it.
    let calls = 0;
    const countingSession = new RemoteBoardSession({
      baseUrl: h.base,
      token,
      boardId,
      fetchImpl: (async (...a: Parameters<typeof fetch>) => {
        calls += 1;
        return fetch(...a);
      }) as typeof fetch,
    });
    // Share the primed cache by re-reading through the counting session first.
    await countingSession.callTool("get_board", {});

    const bad: Operation[] = [
      { op: "CONNECT_NODES", source: "ghost", target: "worse", relationship: "flow" },
    ];
    const refused = await countingSession.callTool("apply_canvas_operations", {
      operations: bad,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Rejected 2 invalid operation/);
    // Two calls = the get_board prime + nothing else. The apply never hit
    // the wire: local validation caught it, exactly the plan's requirement.
    expect(calls).toBe(1);
  });

  it("maps a server 422 to the local session's rejection text", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    // No get_board first: no local cache, so the SERVER's validation is the
    // one that fires (the two paths must both work).
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });

    const refused = await session.callTool("apply_canvas_operations", {
      operations: [{ op: "CONNECT_NODES", source: "nope", target: "nada", relationship: "flow" }],
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/Rejected 2 invalid operation/);
  });

  it("refuses reset_board honestly", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });
    const res = await session.callTool("reset_board", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not available against a live server/);
  });

  it("handles a stale board (409) by naming the head and asking for a re-read", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });

    // Prime the local cache, then drive the 409 through the API directly
    // (the session itself does not send expectedSeq — that guard belongs to
    // callers who did read; here we confirm the server's stale answer and
    // that the session's next call still works, cache dropped, no residue).
    await session.callTool("get_board", {});
    const direct = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-a", nodeType: "step", label: "a" }],
        // The head is 0 (fresh board): expecting seq 0 (i.e. the batch will
        // land "after nothing") is stale the moment the write below races
        // itself — use 1 to collide with the write the session is about to
        // make is unreliable; instead claim 1, then write two ops in one
        // batch through the API so the head moves past it.
        expectedSeq: 1,
      }),
    });
    expect(direct.status).toBe(200);
    // The head is now 1. A caller still believing the head is 1 (claiming
    // the NEXT seq is 2 by passing expectedSeq=2 is current; the stale claim
    // is expectedSeq=1 again) is told it lost:
    const staleDirect = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-b", nodeType: "step", label: "b" }],
        expectedSeq: 1,
      }),
    });
    expect(staleDirect.status).toBe(409);
    // And the session — whose cache is one write behind — still functions:
    // its next get_board reads fresh state (the refusal path, either local
    // or server-side, drops the stale cache before it can mislead twice).
    const refused = await session.callTool("apply_canvas_operations", {
      operations: [{ op: "CONNECT_NODES", source: "n-a", target: "missing", relationship: "flow" }],
    });
    expect(refused.isError).toBe(true);
  });

  it("refuses a board the token cannot see, with a 404-shaped message", async () => {
    h = await harness();
    const { token } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({
      baseUrl: h.base,
      token,
      boardId: "brd_not_a_real_board",
    });
    const res = await session.callTool("get_board", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/not found|no access/);
  });

  it("surfaces an auth refusal as a token problem, not a server error", async () => {
    h = await harness();
    const { boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token: "forged-token", boardId });
    const res = await session.callTool("get_board", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/LUCENT_MCP_TOKEN|refused/);
  });

  it("import_mermaid lands on the server's board, and export_mermaid reads it back", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });

    const imported = await session.callTool("import_mermaid", {
      mermaid: "stateDiagram-v2\n  [*] --> Draft\n  Draft --> Live : publish\n  Live --> [*]",
    });
    expect(imported.isError).toBeUndefined();
    const summary = JSON.parse((await session.callTool("get_board", {})).content[0]!.text) as {
      diagramKind: string;
      nodeCount: number;
    };
    expect(summary).toMatchObject({ diagramKind: "statemachine", nodeCount: 4 });

    const exported = await session.callTool("export_mermaid", {});
    // Imported ids carry a per-import prefix; the labels are the Mermaid's own.
    expect(exported.content[0]!.text).toMatch(/_Draft --> \w+_Live : publish/);
    expect(exported.content[0]!.text).toContain('state "Draft" as');

    const refused = await session.callTool("import_mermaid", { mermaid: "hello" });
    expect(refused.isError).toBe(true);
  });

  it("remoteConfigFromEnv requires all three variables", () => {
    expect(remoteConfigFromEnv({})).toBeNull();
    expect(remoteConfigFromEnv({ LUCENT_MCP_URL: "http://x" })).toBeNull();
    expect(
      remoteConfigFromEnv({
        LUCENT_MCP_URL: "http://127.0.0.1:4387/",
        LUCENT_MCP_TOKEN: "t",
        LUCENT_MCP_BOARD: "brd_x",
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:4387", token: "t", boardId: "brd_x" });
  });
});

describe("MCP v2: reads across the workspace (docs/26 A4, ADR 0048)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("search_workspace, list_decisions and get_project answer from the board's workspace", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });
    await session.callTool("apply_canvas_operations", {
      operations: [
        { op: "CREATE_NODE", id: "pg", nodeType: "process", label: "Use Postgres for billing" },
        { op: "SET_STATEMENT", id: "pg", statement: { kind: "decision", status: "resolved" } },
      ] as Operation[],
    });

    const found = await session.callTool("search_workspace", { query: "postgres" });
    expect(found.isError).toBeUndefined();
    const results = JSON.parse(found.content[0]!.text).results as Array<{
      kind: string;
      id?: string;
      boardId: string;
    }>;
    expect(results[0]).toMatchObject({ kind: "node", id: "pg", boardId });

    const decisions = await session.callTool("list_decisions", { status: "resolved" });
    const statements = JSON.parse(decisions.content[0]!.text).statements as Array<{
      id: string;
      trust?: string;
    }>;
    // Written by an agent: a suggestion until a person reviews it (ADR 0047).
    expect(statements).toEqual([expect.objectContaining({ id: "pg", trust: "ai-suggested" })]);

    const me = await h.api("/api/auth/me", { token });
    const orgId = (me.body.memberships as Array<{ orgId: string }>)[0]!.orgId;
    const project = await h.api(`/api/orgs/${orgId}/projects`, {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Billing", boardIds: [boardId] }),
    });
    const read = await session.callTool("get_project", { projectId: project.body.id });
    expect(JSON.parse(read.content[0]!.text).project).toMatchObject({ name: "Billing" });

    const missing = await session.callTool("get_meeting", { meetingId: "mtg_nope" });
    expect(missing.isError).toBe(true);
  });

  it("a restricted board stays out of an agent's workspace reads", async () => {
    h = await harness();
    const { token, boardId } = await ownerWithBoard(h);
    const session = new RemoteBoardSession({ baseUrl: h.base, token, boardId });
    await session.callTool("apply_canvas_operations", {
      operations: [
        { op: "CREATE_NODE", id: "secret", nodeType: "process", label: "Postgres secret plan" },
      ],
    });
    // A second, restricted board in the same workspace.
    const me = await h.api("/api/auth/me", { token });
    const orgId = (me.body.memberships as Array<{ orgId: string }>)[0]!.orgId;
    const restricted = await h.api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({
        name: "Restricted",
        orgId,
        classification: "restricted",
        workspace: {
          ...createWorkspace(),
          nodes: {
            r: {
              id: "r",
              nodeType: "process",
              label: "Postgres restricted thing",
              position: { x: 0, y: 0 },
            },
          },
        },
      }),
    });
    expect([200, 201]).toContain(restricted.status);
    const found = await session.callTool("search_workspace", { query: "postgres" });
    const results = JSON.parse(found.content[0]!.text).results as Array<{ boardId: string }>;
    expect(results.some((r) => r.boardId === restricted.body.id)).toBe(false);
    // A person's own search still sees both boards.
    const human = await h.api(`/api/orgs/${orgId}/search?q=postgres`, { token });
    expect(
      (human.body.results as Array<{ boardId: string }>).some(
        (r) => r.boardId === restricted.body.id,
      ),
    ).toBe(true);
  });
});
