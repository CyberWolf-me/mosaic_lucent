import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { issueToken } from "../src/auth.js";
import { issueAgentGrant } from "../src/agentGrant.js";

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

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
  open = { base: `http://127.0.0.1:${port}`, boardStore, userStore, close };
  return open;
}

async function api(
  h: Harness,
  path: string,
  options: { token?: string; agent?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.agent ? { authorization: `Agent ${options.agent}` } : {}),
  };
  const res = await fetch(`${h.base}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/boards/:id/orchestrate", () => {
  it("orchestrates diagram construction, validates, and commits via canonical mutation", async () => {
    const h = await harness();

    // Create user and board
    const user = {
      id: "usr_alice",
      email: "alice@example.com",
      name: "Alice",
      passwordHash: "x",
      tokenVersion: 0,
      emailVerifiedAt: Date.now(),
      createdAt: Date.now(),
    };
    await h.userStore.insert(user);
    await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
    const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

    const board = {
      id: "brd_arch_1",
      name: "System Architecture",
      ownerId: user.id,
      orgId: "org-1",
      workspace: createWorkspace({ diagramKind: "architecture" }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await h.boardStore.put(board);

    // Call orchestrate
    const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
      token,
      body: {
        prompt: "Design our backend microservices with web client, gateway, and database",
        requestId: "req-1",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcome).toBe("committed");
    expect(res.body.seq).toBeGreaterThan(0);
    expect(res.body.operations.length).toBeGreaterThan(0);

    // Verify persisted state in authoritative board store
    const updated = await h.boardStore.get(board.id);
    expect(Object.keys(updated!.workspace.nodes).length).toBeGreaterThan(0);
    expect(Object.keys(updated!.workspace.edges).length).toBeGreaterThan(0);
  });

  it("enforces idempotency on replayed requestIds", async () => {
    const h = await harness();

    const user = {
      id: "usr_bob",
      email: "bob@example.com",
      name: "Bob",
      passwordHash: "x",
      tokenVersion: 0,
      emailVerifiedAt: Date.now(),
      createdAt: Date.now(),
    };
    await h.userStore.insert(user);
    await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
    const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

    const board = {
      id: "brd_flow_1",
      name: "Flowchart",
      ownerId: user.id,
      orgId: "org-1",
      workspace: createWorkspace({ diagramKind: "flowchart" }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await h.boardStore.put(board);

    // First submit
    const res1 = await api(h, `/api/boards/${board.id}/orchestrate`, {
      token,
      body: { prompt: "Make a flowchart of our sign-in process", requestId: "idemp-99" },
    });
    expect(res1.status).toBe(200);
    const firstSeq = res1.body.seq;

    // Replay with exact same requestId
    const res2 = await api(h, `/api/boards/${board.id}/orchestrate`, {
      token,
      body: { prompt: "Make a flowchart of our sign-in process", requestId: "idemp-99" },
    });
    expect(res2.status).toBe(200);
    expect(res2.body.duplicate).toBe(true);
    expect(res2.body.seq).toBe(firstSeq);
  });

  it("allows voice agent with board-scoped grant to orchestrate without user session", async () => {
    const h = await harness();

    const user = {
      id: "usr_carol",
      email: "carol@example.com",
      name: "Carol",
      passwordHash: "x",
      tokenVersion: 0,
      emailVerifiedAt: Date.now(),
      createdAt: Date.now(),
    };
    await h.userStore.insert(user);
    await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());

    const board = {
      id: "brd_voice_1",
      name: "Voice Board",
      ownerId: user.id,
      orgId: "org-1",
      workspace: createWorkspace({ diagramKind: "flowchart" }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await h.boardStore.put(board);

    const grant = issueAgentGrant({ boardId: board.id, userId: user.id }, SECRET);

    const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
      agent: grant,
      body: { prompt: "Brainstorm 3 marketing ideas for our launch" },
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcome).toBe("committed");

    // Independent clusters should have created nodes without requiring edges
    const updated = await h.boardStore.get(board.id);
    expect(Object.keys(updated!.workspace.nodes).length).toBe(3);
    expect(Object.keys(updated!.workspace.edges).length).toBe(0);
  });
});
