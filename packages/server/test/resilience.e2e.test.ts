import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, type Workspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * Reconnect resilience, end to end (Stage B4). The advisory's resilience
 * batch as automated tests over the real HTTP + WebSocket wiring:
 *
 *   - edits made while the socket is down are QUEUED and replayed on
 *     reconnect, exactly once (their original requestIds make a half-delivered
 *     batch a duplicate no-op rather than a second effect);
 *   - a client whose cursor predates the log's snapshot floor is RESEEDED
 *     (state wholesale) instead of handed a catchup with a hole in it;
 *   - an evicted room writes a snapshot, so the next cold join rebuilds from
 *     it and replays only the tail;
 *   - GET /api/boards/:id reports latestSeq, so a first join knows its
 *     revision before the socket opens.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  ws: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  close: () => Promise<void>;
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    userStore,
    boardStore,
    close: async () => {
      await close();
    },
  };
}

let open: Harness | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
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
  return { token: body.token, id: body.user.id };
}

async function ticketFor(h: Harness, token: string): Promise<string> {
  const { status, body } = await api(h, "/api/realtime/ticket", { method: "POST", token });
  expect(status).toBe(200);
  return body.ticket as string;
}

async function openSocket(h: Harness, boardId: string, token: string, fromSeq = 0) {
  const ticket = await ticketFor(h, token);
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "error", "resync"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq }));
  // Resolve only after the server answered the join — callers send ops on the
  // returned socket, and an op sent before the join completes is dropped
  // (the connection has no boardId yet).
  await welcome;
  return socket;
}

/** Join and resolve with the first answer frame itself (resync tests). */
async function joinAndAnswer(h: Harness, boardId: string, token: string, fromSeq = 0) {
  const ticket = await ticketFor(h, token);
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const answer = frame(socket, ["welcome", "error", "resync"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq }));
  return answer;
}

function frame(socket: WebSocket, types: string[], match?: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${types.join("|")}`)), 4000);
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (!types.includes(msg.type)) return;
      if (match && !match(msg)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

function seededBoard(): Workspace {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
  ]);
}

async function makeBoard(
  h: Harness,
  owner: { token: string; id: string },
  ws?: Workspace,
): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ name: "Resilience", workspace: ws ?? seededBoard() }),
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe("reconnect resilience end to end (Stage B4)", () => {
  it("an edit made while the socket is down lands after reconnect — exactly once", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const boardId = await makeBoard(h, owner);

    const socket = await openSocket(h, boardId, owner.token);
    // Baseline: one committed entry.
    const base = frame(socket, ["op"], (m) => m.entry?.ops?.some((o: any) => o.id === "a2"));
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_base",
        ops: [{ op: "CREATE_NODE", id: "a2", nodeType: "step", label: "A2" }],
      }),
    );
    await base;

    // The "half-delivered" batch: the user committed it, the server applied
    // it, and the response was lost when the network dropped. Reproduced by a
    // REAL commit (the store row and the board workspace stay consistent —
    // what production always has) followed by a socket close before the
    // client could see the ack.
    const flakyOp = frame(socket, ["op"], (m) => m.entry?.ops?.some((o: any) => o.id === "flaky"));
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_flaky",
        ops: [{ op: "CREATE_NODE", id: "flaky", nodeType: "step", label: "F" }],
      }),
    );
    await flakyOp; // the effect landed; pretend the ack never reached the user
    socket.close();
    await new Promise((r) => setTimeout(r, 150));

    // Reconnect. The client replays BOTH: the flaky one (duplicate no-op)
    // and the queued one (fresh).
    const second = await openSocket(h, boardId, owner.token, 1);
    const dupAck = frame(second, ["op-ack"], (m) => m.requestId === "req_flaky");
    const queuedOp = frame(second, ["op"], (m) =>
      m.entry?.ops?.some((o: any) => o.id === "queued"),
    );
    second.send(
      JSON.stringify({
        type: "op",
        requestId: "req_flaky",
        ops: [{ op: "CREATE_NODE", id: "flaky", nodeType: "step", label: "F" }],
      }),
    );
    second.send(
      JSON.stringify({
        type: "op",
        requestId: "req_queued",
        ops: [{ op: "CREATE_NODE", id: "queued", nodeType: "step", label: "Q" }],
      }),
    );
    const dup = await dupAck;
    expect(dup.duplicate).toBe(true);
    await queuedOp;

    // Exactly-once: the flaky node was created ONCE (the replay never
    // re-applied it), the queued node exists, and the log holds one row per
    // requestId.
    const board = await h.boardStore.get(boardId);
    expect(board?.workspace.nodes?.flaky).toBeDefined();
    expect(board?.workspace.nodes?.queued).toBeDefined();
    const log = await h.boardStore.loadLog(boardId);
    const flakyRows = log.filter((e) => e.requestId === "req_flaky");
    expect(flakyRows).toHaveLength(1);
    expect(log.filter((e) => e.requestId === "req_queued")).toHaveLength(1);
  });

  it("a cursor below the snapshot floor is reseeded, not handed a partial catchup", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const boardId = await makeBoard(h, owner);

    // Two entries land, then the log is pruned against a snapshot at seq 2 —
    // a client at seq 0 can no longer be served entries 1-2 honestly. The
    // snapshot must be the state AFTER both entries (what the compaction
    // moment would really hold), built by applying them to the seed board.
    const board = await h.boardStore.get(boardId);
    const withBoth = applyOperations(board!.workspace, [
      { op: "CREATE_NODE", id: "p1", nodeType: "step", label: "P1" },
      { op: "CREATE_NODE", id: "p2", nodeType: "step", label: "P2" },
    ]);
    await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "p1", nodeType: "step", label: "P1" }] as never,
      by: owner.id,
      label: "",
      at: 1,
    });
    await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "p2", nodeType: "step", label: "P2" }] as never,
      by: owner.id,
      label: "",
      at: 2,
    });
    await h.boardStore.putSnapshot(boardId, 2, withBoth);
    await h.boardStore.pruneLog(boardId, 2);

    // A stale client joins from seq 0: the answer must be resync (state
    // wholesale), never a welcome whose catchup starts at seq 3.
    const answer = await joinAndAnswer(h, boardId, owner.token, 0);
    expect(answer.type).toBe("resync");
    expect(answer.version).toBe(2);
    expect(answer.workspace.nodes?.p2).toBeDefined();
    expect(answer.workspace.nodes?.p1).toBeDefined();
  });

  it("an evicted room snapshots, and the next cold join rebuilds from it", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const boardId = await makeBoard(h, owner);

    const socket = await openSocket(h, boardId, owner.token);
    const op = frame(socket, ["op"], (m) => m.entry?.ops?.some((o: any) => o.id === "ev1"));
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_ev",
        ops: [{ op: "CREATE_NODE", id: "ev1", nodeType: "step", label: "E" }],
      }),
    );
    await op;
    // Everyone leaves → eviction → a snapshot must exist at the room's head.
    socket.close();
    await new Promise((r) => setTimeout(r, 250));
    const snap = await h.boardStore.latestSnapshot(boardId);
    expect(snap).toBeDefined();
    expect(snap?.seq).toBeGreaterThanOrEqual(1);
    expect(snap?.workspace.nodes?.ev1).toBeDefined();
  });

  it("GET /api/boards/:id reports latestSeq for the first-join handshake", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const boardId = await makeBoard(h, owner);
    await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "s1", nodeType: "step", label: "S" }] as never,
      by: owner.id,
      label: "",
      at: 1,
    });
    await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "s2", nodeType: "step", label: "S2" }] as never,
      by: owner.id,
      label: "",
      at: 2,
    });
    const got = await api(h, `/api/boards/${boardId}`, { token: owner.token });
    expect(got.status).toBe(200);
    expect(got.body.latestSeq).toBe(2);
  });
});
