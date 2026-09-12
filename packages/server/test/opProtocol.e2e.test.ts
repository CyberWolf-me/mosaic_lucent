import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * Stage B operation protocol, end to end over the real HTTP + WebSocket
 * wiring: requestId idempotency (a replayed submit is answered with the
 * original outcome, never a second effect) and the explicit ack
 * (`op-ack` naming seq + operationId, `op-rejected` naming the request).
 *
 * The room/store unit suites pin the semantics; this suite pins the PROTOCOL —
 * what actually goes over the wire, which is what a client replays against.
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
  // Sharing a board requires a verified email (the share gate); the store is
  // shared with the app, so verify it directly — in a real signup the user
  // clicks the email link.
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

async function ticketFor(h: Harness, token: string): Promise<string> {
  const { status, body } = await api(h, "/api/realtime/ticket", { method: "POST", token });
  expect(status).toBe(200);
  return body.ticket as string;
}

async function joinBoard(h: Harness, boardId: string, token: string): Promise<WebSocket> {
  const ticket = await ticketFor(h, token);
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
  const w = await welcome;
  expect(w.type).toBe("welcome");
  return socket;
}

/** Resolve on the next frame whose type is in `types` (with an optional match). */
function frame(socket: WebSocket, types: string[], match?: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${types.join("|")}`)),
      4000,
    );
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

/** Resolve when N frames of `type` have arrived (counting from subscription). */
function frames(socket: WebSocket, type: string, n: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const got: any[] = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout collecting ${n} ${type} frames (got ${got.length})`)),
      4000,
    );
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== type) return;
      got.push(msg);
      if (got.length >= n) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(got);
      }
    };
    socket.on("message", onMessage);
  });
}

describe("operation protocol end to end (Stage B)", () => {
  it("a replayed requestId is acked with the original seq and broadcasts nothing new", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Protocol", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const socket = await joinBoard(h, boardId, owner.token);

    // First submit: ack + own broadcast.
    const ack1 = frame(socket, ["op-ack"], (m) => m.requestId === "req_once");
    const op1 = frame(socket, ["op"], (m) => m.entry?.ops?.some((o: any) => o.id === "n1"));
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_once",
        label: "create",
        ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "N1" }],
      }),
    );
    socket.on("message", () => {});
    const a1 = await ack1;
    const e1 = await op1;
    expect(a1.requestId).toBe("req_once");
    expect(a1.seq).toBe(e1.entry.seq);
    expect(a1.operationId).toMatch(/^op_/);
    expect(e1.entry.requestId).toBe("req_once");

    // The network retry: same requestId, same ops. It must be answered with
    // the ORIGINAL outcome — one op-ack marked duplicate, and crucially no
    // second broadcast (peers would re-receive an entry they already applied;
    // the room also never re-applied it, so there is no entry to send).
    const op2 = frame(socket, ["op"]); // must NOT resolve
    const ack2 = frame(socket, ["op-ack"], (m) => m.requestId === "req_once" && m.duplicate);
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_once",
        label: "create",
        ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "N1" }],
      }),
    );
    const a2 = await ack2;
    expect(a2.duplicate).toBe(true);
    expect(a2.seq).toBe(e1.entry.seq);
    const spurious = await Promise.race([op2.then(() => true), wait(600).then(() => false)]);
    expect(spurious).toBe(false);
    // One row in the durable log, named by the request.
    const log = await h.boardStore.loadLog(boardId);
    expect(log).toHaveLength(1);
    expect(log[0]?.requestId).toBe("req_once");
  });

  it("a rejection names the requestId and the log head", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Refusal", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const socket = await joinBoard(h, boardId, owner.token);

    const rejected = frame(socket, ["op-rejected"], (m) => m.requestId === "req_bad");
    socket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_bad",
        ops: [{ op: "CHANGE_TEXT", id: "ghost", text: "x" }],
      }),
    );
    const r = await rejected;
    expect(r.error).toBe("validation");
    expect(r.requestId).toBe("req_bad");
    expect(typeof r.head).toBe("number");
  });

  it("a peer receives the broadcast but never another peer's ack", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const peer = await signup(h, "peer@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Peers", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    // Peer joins as a viewer via the share flow is heavier than needed; the
    // owner adds them as an editor over the members API instead.
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "editor" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: peer.token,
      body: JSON.stringify({ token: link.body.token }),
    });
    const ownerSocket = await joinBoard(h, boardId, owner.token);
    const peerSocket = await joinBoard(h, boardId, peer.token);

    const peerOp = frame(peerSocket, ["op"], (m) => m.entry?.requestId === "req_owner");
    const peerAcks = frames(peerSocket, "op-ack", 1); // must NOT resolve
    socketSend(ownerSocket, {
      type: "op",
      requestId: "req_owner",
      ops: [{ op: "CREATE_NODE", id: "pn1", nodeType: "step", label: "P" }],
    });
    const seen = await peerOp;
    expect(seen.entry.requestId).toBe("req_owner");
    const gotAck = await Promise.race([peerAcks.then(() => true), wait(600).then(() => false)]);
    expect(gotAck).toBe(false);
  });

  it("the REST ops route is idempotent on requestId (duplicate 200, one row)", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "restowner@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Rest", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const submit = (requestId: string) =>
      api(h, `/api/boards/${boardId}/ops`, {
        method: "POST",
        token: owner.token,
        body: JSON.stringify({
          requestId,
          ops: [{ op: "CREATE_NODE", id: "r1", nodeType: "step", label: "R" }],
        }),
      });
    const first = await submit("req_rest");
    expect(first.status).toBe(200);
    expect(first.body.seq).toBeGreaterThan(0);
    expect(first.body.operationId).toMatch(/^op_/);
    const retry = await submit("req_rest");
    expect(retry.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.seq).toBe(first.body.seq);
    const log = await h.boardStore.loadLog(boardId);
    expect(log).toHaveLength(1);
  });

  it("an ops-route batch reaches the live room (found live: 2026-09-10)", async () => {
    // The pre-fix route wrote only to the store: the room's in-memory state
    // kept serving its stale truth, the connected peer never saw the ops,
    // and a later eviction snapshotted that stale state — permanently
    // emptying the board for future ws joiners. The route now commits
    // room-first (the B3 approve's dual-path pattern), so a live peer
    // receives the batch as an ordinary broadcast.
    const h = (open = await harness());
    const owner = await signup(h, "roomfirst@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Room first", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;

    const socket = await joinBoard(h, boardId, owner.token);
    const opFrame = frame(socket, ["op"]);

    const applied = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-rf", nodeType: "step", label: "From the route" }],
      }),
    });
    expect(applied.status).toBe(200);

    const seen = await opFrame;
    expect(seen.type).toBe("op");
    expect(seen.entry.ops[0].op).toBe("CREATE_NODE");
    expect(seen.entry.ops[0].id).toBe("n-rf");
  });
});

function socketSend(socket: WebSocket, msg: unknown): void {
  socket.send(JSON.stringify(msg));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
