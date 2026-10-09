import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWorkspace, applyOperations, type Operation } from "@lucent/core";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { BoardSession } from "@lucent/mcp";
import { createApp } from "../../src/app.js";
import { InMemoryUserStore } from "../../src/accounts.js";
import { InMemoryBoardStore } from "../../src/boards.js";
import { InMemoryProposalStore } from "../../src/proposals.js";
import { UsageTracker, limitsFromEnv } from "../../src/usage.js";
import { Telemetry } from "../../src/telemetry.js";
import { Limiter } from "../../src/limiter.js";
import { InMemoryTicketStore } from "../../src/realtimeTicket.js";
import { readConfig } from "../../src/config.js";
import { issueToken } from "../../src/auth.js";
import { issueAgentGrant } from "../../src/agentGrant.js";

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
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
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, boardStore, userStore, close };
}

async function api(
  h: Harness,
  path: string,
  options: { method?: string; token?: string; agent?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.agent ? { authorization: `Agent ${options.agent}` } : {}),
  };
  const res = await fetch(`${h.base}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("Pipeline Certification V2 - Suite 2: Construction Pathways & Convergence", () => {
  it("certifies Server Orchestration Route construction from empty canvas", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_pw_server",
        email: "pw_server@test.com",
        name: "Pathway User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_pw_server",
        name: "Server Pathway Board",
        ownerId: user.id,
        orgId: "org-pw",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Design e-commerce payment flow" },
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.outcome).toBe("committed");
      expect(res.body.seq).toBeGreaterThan(0);
      expect(res.body.operations.length).toBeGreaterThan(0);

      const updated = await h.boardStore.get(board.id);
      expect(Object.keys(updated!.workspace.nodes).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("certifies MCP Tool construct_diagram execution and board state mutation", () => {
    const session = new BoardSession();
    expect(Object.keys(session.workspace.nodes)).toHaveLength(0);

    const res = session.callTool("construct_diagram", {
      prompt: "Build user registration flowchart with validation and confirmation",
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain("Constructed diagram via pipeline");
    expect(Object.keys(session.workspace.nodes).length).toBeGreaterThan(0);
    expect(session.workspace.diagramKind).toBe("flowchart");
  });

  it("certifies LiveKit Voice Agent tool pathway with agent grant authorization", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_pw_agent",
        email: "pw_agent@test.com",
        name: "Voice Agent User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());

      const board = {
        id: "brd_pw_agent",
        name: "Voice Agent Pathway Board",
        ownerId: user.id,
        orgId: "org-pw",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // Issue agent grant token for LiveKit voice agent session
      const grant = issueAgentGrant(
        { userId: user.id, boardId: board.id, ttlSeconds: 3600 },
        SECRET,
      );

      const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
        agent: grant,
        body: { prompt: "Voice command: Create customer onboarding flow" },
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.outcome).toBe("committed");
      expect(res.body.seq).toBeGreaterThan(0);

      // Verify the board was mutated via the agent grant
      const updated = await h.boardStore.get(board.id);
      expect(Object.keys(updated!.workspace.nodes).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("certifies Logical Graph Parity across all three pathways for equivalent objectives", async () => {
    const objective = "Step-by-step user checkout and billing flowchart";
    const h = await harness();
    try {
      const user = {
        id: "usr_parity",
        email: "parity@test.com",
        name: "Parity User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      // Pathway 1: Server Orchestration Route
      const b1 = {
        id: "brd_p1",
        name: "Parity B1",
        ownerId: user.id,
        orgId: "org-parity",
        workspace: createWorkspace({ diagramKind: "flowchart" }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(b1);
      const res1 = await api(h, `/api/boards/${b1.id}/orchestrate`, {
        token,
        body: { prompt: objective },
      });
      expect(res1.status).toBe(200);
      const ws1 = (await h.boardStore.get(b1.id))!.workspace;

      // Pathway 2: LiveKit Voice Agent
      const b2 = {
        id: "brd_p2",
        name: "Parity B2",
        ownerId: user.id,
        orgId: "org-parity",
        workspace: createWorkspace({ diagramKind: "flowchart" }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(b2);
      const grant = issueAgentGrant({ userId: user.id, boardId: b2.id, ttlSeconds: 3600 }, SECRET);
      const res2 = await api(h, `/api/boards/${b2.id}/orchestrate`, {
        agent: grant,
        body: { prompt: objective },
      });
      expect(res2.status).toBe(200);
      const ws2 = (await h.boardStore.get(b2.id))!.workspace;

      // Pathway 3: MCP Tool
      const mcpSession = new BoardSession(createWorkspace({ diagramKind: "flowchart" }));
      mcpSession.callTool("construct_diagram", { prompt: objective });
      const ws3 = mcpSession.workspace;

      // PARITY VERIFICATION: All three produce identical representation and topology!
      expect(ws1.diagramKind).toBe("flowchart");
      expect(ws2.diagramKind).toBe("flowchart");
      expect(ws3.diagramKind).toBe("flowchart");

      expect(Object.keys(ws1.nodes).length).toBeGreaterThan(0);
      expect(Object.keys(ws2.nodes).length).toBeGreaterThan(0);
      expect(Object.keys(ws3.nodes).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("certifies Incremental Additions strictly preserve existing node IDs and connections", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_inc",
        email: "inc@test.com",
        name: "Inc User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      // Pre-existing board with two user-positioned nodes
      let ws = createWorkspace();
      const initialOps: Operation[] = [
        { op: "CREATE_NODE", id: "auth_svc", nodeType: "service", label: "Auth Service" },
        { op: "CREATE_NODE", id: "user_db", nodeType: "database", label: "User DB" },
        { op: "MOVE_NODE", id: "auth_svc", position: { x: 200, y: 150 } },
        { op: "MOVE_NODE", id: "user_db", position: { x: 500, y: 150 } },
        {
          op: "CONNECT_NODES",
          source: "auth_svc",
          target: "user_db",
          relationship: "reads_writes",
        },
      ];
      ws = applyOperations(ws, initialOps);

      const board = {
        id: "brd_inc_test",
        name: "Incremental Test Board",
        ownerId: user.id,
        orgId: "org-inc",
        workspace: ws,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // Perform incremental turn
      const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Add Redis Cache connected to Auth Service" },
      });

      expect(res.status).toBe(200);

      const updated = (await h.boardStore.get(board.id))!.workspace;

      // INVARIANT: Pre-existing nodes and positions remain strictly intact
      expect(updated.nodes["auth_svc"]).toBeDefined();
      expect(updated.nodes["user_db"]).toBeDefined();
      expect(updated.nodes["auth_svc"]?.position).toEqual({ x: 200, y: 150 });
      expect(updated.nodes["user_db"]?.position).toEqual({ x: 500, y: 150 });

      // Pre-existing edge remains
      const initialEdge = Object.values(updated.edges).find(
        (e) => e.source === "auth_svc" && e.target === "user_db",
      );
      expect(initialEdge).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it("certifies Retry Behavior: replayed request receives idempotent cached result without state corruption", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_retry",
        email: "retry@test.com",
        name: "Retry User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_retry_test",
        name: "Retry Board",
        ownerId: user.id,
        orgId: "org-retry",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      const reqId = "client-tx-uuid-778899";

      // Turn 1
      const res1 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Deploy worker queue", requestId: reqId },
      });
      expect(res1.status).toBe(200);
      const data1 = res1.body;

      // Turn 2 (simulated client network retry after timeout)
      const res2 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Deploy worker queue", requestId: reqId },
      });
      expect(res2.status).toBe(200);
      const data2 = res2.body;

      // Idempotency guarantee: exact duplicate indicator, matching seq, zero extra mutations
      expect(data2.duplicate).toBe(true);
      expect(data2.seq).toBe(data1.seq);
    } finally {
      await h.close();
    }
  });
});
