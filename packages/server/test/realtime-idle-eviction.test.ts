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
import { InMemoryPresenceStore, DEFAULT_PRESENCE_TTL_MS } from "../src/presence.js";
import { readConfig } from "../src/config.js";

/**
 * Found by the 24-person team-session run: the presence store forgets anyone
 * whose cursor hasn't moved for its TTL, and a socket closing evicted the room
 * whenever the store said nobody was left — dropping every still-open socket
 * from the broadcast set. They stayed connected and heard nothing more; their
 * own edits committed into a fresh room nobody else was in.
 *
 * Here the clock jumps past the TTL (everyone quiet), one tab closes, and the
 * people still connected must keep receiving each other's edits.
 */

const sockets: WebSocket[] = [];
let closeApp: (() => Promise<void>) | null = null;
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await closeApp?.();
  closeApp = null;
});

async function setup() {
  let clock = Date.now();
  const presenceStore = new InMemoryPresenceStore(DEFAULT_PRESENCE_TTL_MS, () => clock);
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: "test-secret-at-least-16-chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    presenceStore,
  });
  closeApp = close;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, token: string | null, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const person = async (name: string) => {
    const r = await api("/api/auth/signup", null, {
      email: `${name}@idle.test`,
      password: "password123",
      name,
    });
    return { token: r.body.token as string, id: r.body.user.id as string };
  };
  const open = async (token: string, boardId: string) => {
    const { body } = await api("/api/realtime/ticket", token, {});
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(body.ticket)}`,
    );
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const welcome = next(socket, "welcome");
    socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
    await welcome;
    return socket;
  };
  return { api, person, open, advance: (ms: number) => (clock += ms) };
}

function next(
  socket: WebSocket,
  type: string,
  pred: (m: any) => boolean = () => true,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 4000);
    const on = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== type || !pred(msg)) return;
      clearTimeout(timer);
      socket.off("message", on);
      resolve(msg);
    };
    socket.on("message", on);
  });
}

const createNode = (id: string) => ({ op: "CREATE_NODE", id, nodeType: "step", label: id });

describe("a quiet room is not evicted from under its open sockets", () => {
  it("after everyone idles past the presence TTL, one tab closing cuts no one off", async () => {
    const t = await setup();
    const ava = await t.person("ava");
    const ben = await t.person("ben");
    const { body: board } = await t.api("/api/boards", ava.token, {
      name: "Idle",
      workspace: createWorkspace(),
    });
    const { body: link } = await t.api(`/api/boards/${board.id}/share`, ava.token, {
      role: "editor",
    });
    await t.api(`/api/boards/${board.id}/join`, ben.token, { token: link.token });

    const avaSocket = await t.open(ava.token, board.id);
    const benSocket = await t.open(ben.token, board.id);
    const avaSecondTab = await t.open(ava.token, board.id);

    // Nobody moves a cursor for longer than the TTL.
    t.advance(DEFAULT_PRESENCE_TTL_MS + 5_000);
    avaSecondTab.close();
    await new Promise((r) => setTimeout(r, 150)); // let the leave (and any eviction) run

    // Ben edits; Ava's first tab must still hear it.
    const heard = next(avaSocket, "op", (m) =>
      m.entry?.ops?.some((o: any) => o.id === "after-leave"),
    );
    benSocket.send(
      JSON.stringify({ type: "op", requestId: "r1", ops: [createNode("after-leave")] }),
    );
    const entry = await heard;
    expect(entry.entry.seq).toBe(1);
  });

  it("closing one of a person's two tabs doesn't tell the room they left", async () => {
    const t = await setup();
    const ava = await t.person("cleo");
    const ben = await t.person("dev");
    const { body: board } = await t.api("/api/boards", ava.token, {
      name: "Tabs",
      workspace: createWorkspace(),
    });
    const { body: link } = await t.api(`/api/boards/${board.id}/share`, ava.token, {
      role: "editor",
    });
    await t.api(`/api/boards/${board.id}/join`, ben.token, { token: link.token });
    const benSocket = await t.open(ben.token, board.id);
    await t.open(ava.token, board.id);
    const tab2 = await t.open(ava.token, board.id);
    const left: string[] = [];
    benSocket.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "peer-left") left.push(msg.userId);
    });
    tab2.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(left).not.toContain(ava.id);
  });
});
