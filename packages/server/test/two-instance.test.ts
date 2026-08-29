import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createWorkspace } from "@lucent/core";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InProcessFanout } from "../src/fanout.js";

/**
 * M3, the scale-out proof: TWO app instances, ONE durable store, one board.
 *
 * Everything else in this suite pins single-instance behaviour; this file
 * exists because the failure mode that matters only appears with two rooms —
 * two in-memory seq counters racing for the next slot. Both instances draw
 * their seqs from the shared store's allocator, so exactly one of two racing
 * commits wins slot `head + 1`; the loser pulls the winner's entry in,
 * re-validates, and retries. The assertions are the convergence contract:
 * unique seqs in the store, and every client seeing every entry.
 *
 * (Postgres is the real deployment story; the shared in-memory store enforces
 * the same append contract — `expectedSeq` guard, seq assigned by the store —
 * so the race resolves identically without a database.)
 */

const SECRET = "test-secret-at-least-16-chars";

interface Instance {
  base: string;
  ws: string;
  close: () => Promise<void>;
}

interface Cluster {
  a: Instance;
  b: Instance;
  boardStore: InMemoryBoardStore;
  close: () => Promise<void>;
}

const sockets: WebSocket[] = [];

// One hook, sockets first: afterEach hooks run in reverse declaration order,
// so two separate hooks would close the servers while sockets were still
// open — and server.close() waits for every connection to end.
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await open?.close();
  open = null;
});

async function startInstance(
  boardStore: InMemoryBoardStore,
  userStore: InMemoryUserStore,
  orgStore: InMemoryOrgStore,
  fanout: InProcessFanout,
): Promise<Instance> {
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1" });
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    secret: SECRET,
    usage: new UsageTracker(limitsFromEnv()),
    limits: limitsFromEnv(),
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore,
    inviteStore: new InMemoryOrgInviteStore(),
    notifications: new InMemoryNotificationStore(),
    fanout,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { base, ws: `ws://127.0.0.1:${port}`, close };
}

async function cluster(): Promise<Cluster> {
  // Shared durable state; per-instance everything else (tickets are
  // deliberately per-instance — a ticket minted on A must not work on B,
  // which is exactly how the production ticket store behaves).
  const boardStore = new InMemoryBoardStore();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  // Share-link redemption requires a verified email (shareGate.ts); tests
  // reach into the shared user store for the same reason the collab suite does.
  sharedUserStore = userStore;
  // One bus for both instances — the in-process stand-in for the Postgres
  // LISTEN/NOTIFY pair main.ts opens in a real deployment. Without it the
  // winning instance's sockets would never hear the loser's absorbed entry
  // (and that is exactly what the fanout exists to prevent).
  const fanout = new InProcessFanout();
  const a = await startInstance(boardStore, userStore, orgStore, fanout);
  const b = await startInstance(boardStore, userStore, orgStore, fanout);
  return {
    a,
    b,
    boardStore,
    close: async () => {
      await a.close();
      await b.close();
    },
  };
}

let open: Cluster | null = null;

async function api(
  instance: Instance,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const res = await fetch(`${instance.base}${path}`, {
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

let sharedUserStore: InMemoryUserStore | null = null;

async function signup(instance: Instance, email: string): Promise<string> {
  const { status, body } = await api(instance, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await sharedUserStore!.findByEmail(email);
  if (user) await sharedUserStore!.setEmailVerified(user.id, Date.now());
  return body.token as string;
}

/** The next `count` "op" frames, in arrival order, from ONE listener. */
function collectOps(socket: WebSocket, count: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout collecting ${count} op frames`)),
      5000,
    );
    const got: any[] = [];
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== "op") return;
      got.push(msg);
      if (got.length >= count) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(got);
      }
    };
    socket.on("message", onMessage);
  });
}

function frame(socket: WebSocket, types: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${types.join("|")}`)),
      5000,
    );
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (!types.includes(msg.type)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

async function join(
  instance: Instance,
  boardId: string,
  token: string,
): Promise<{ socket: WebSocket; welcome: any }> {
  const { status, body } = await api(instance, "/api/realtime/ticket", {
    method: "POST",
    token,
  });
  expect(status).toBe(200);
  const socket = new WebSocket(
    `${instance.ws}/ws?ticket=${encodeURIComponent(body.ticket as string)}`,
  );
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
  return { socket, welcome: await welcome };
}

function sendOp(socket: WebSocket, id: string, label: string): void {
  socket.send(
    JSON.stringify({
      type: "op",
      ops: [{ op: "CREATE_NODE", id, nodeType: "step", label: id }],
      label,
    }),
  );
}

describe("two instances, one board", () => {
  it("racing commits from both instances land with unique seqs and converge", async () => {
    const c = (open = await cluster());
    const owner = await signup(c.a, "owner@example.com");
    const guest = await signup(c.a, "guest@example.com");

    const created = await api(c.a, "/api/boards", {
      method: "POST",
      token: owner,
      body: JSON.stringify({ name: "Two", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    const link = await api(c.a, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner,
      body: JSON.stringify({ role: "editor" }),
    });
    const joined = await api(c.a, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: guest,
      body: JSON.stringify({ token: link.body.token }),
    });
    expect(joined.status).toBe(200);

    const a = await join(c.a, boardId, owner);
    const b = await join(c.b, boardId, guest);
    expect(a.welcome.version).toBe(0);
    expect(b.welcome.version).toBe(0);

    // Collect the next two op frames per socket, then race the commits: two
    // rooms, two processes' worth of state, one shared log slot each. One
    // listener per socket, frames consumed in arrival order — two independent
    // `frame()` promises would BOTH resolve on the first message.
    const aFrames = collectOps(a.socket, 2);
    const bFrames = collectOps(b.socket, 2);
    sendOp(a.socket, "from-a", "a edit");
    sendOp(b.socket, "from-b", "b edit");

    const [as, bs] = await Promise.all([aFrames, bFrames]);
    const seqsOf = (frames: any[]) => frames.map((f) => f.entry.seq).sort((x, y) => x - y);
    // Exactly the slots {1, 2} on both sides: the allocator never dealt the
    // same seq twice, and the loser's retry did not skip one.
    expect(seqsOf(as)).toEqual([1, 2]);
    expect(seqsOf(bs)).toEqual([1, 2]);
    // Both clients saw BOTH entries — the loser's instance broadcast what it
    // absorbed, and the winner's instance pulled the rest through its own
    // fanout subscription, so neither side is left a seq behind.
    for (const frames of [as, bs]) {
      const ids = frames.flatMap((f) => f.entry.ops.map((o: { id?: string }) => o.id ?? "")).sort();
      expect(ids).toEqual(["from-a", "from-b"]);
    }

    // The durable log holds both entries exactly once each.
    const log = await c.boardStore.loadLog(boardId);
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect(log.map((e) => (e.ops[0] as { id?: string }).id ?? "").sort()).toEqual([
      "from-a",
      "from-b",
    ]);

    // A commit from instance B lands at seq 3; instance A's room is one seq
    // behind (its last commit lost), so its client only converges once the
    // fanout triggers A's pull — the same reload path a real deployment rides.
    const aThird = collectOps(a.socket, 1);
    sendOp(b.socket, "from-b-2", "b again");
    const [thirdFrame] = await aThird;
    expect(thirdFrame.entry.seq).toBe(3);

    // And the store is the single truth both instances agree on.
    expect((await c.boardStore.loadLog(boardId)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
