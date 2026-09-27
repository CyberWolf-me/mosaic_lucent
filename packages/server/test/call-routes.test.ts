import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import {
  admitToCall,
  CALL_ATTRIBUTES,
  InMemoryCallControl,
  newCallMeta,
  parseCallMeta,
  withHost,
  withRemoved,
} from "../src/calls.js";

/**
 * docs/28 A3.2: the board call has a host. The first person in hosts it; the
 * host mutes, removes, makes co-hosts and ends the call for everyone; a
 * removed person stays out of that call; a call whose hosts have all left
 * hands hosting to the next person in. LiveKit is the in-memory stand-in:
 * `calls.join` is a participant arriving in the room.
 */

const SECRET = "test-secret-at-least-16-chars";
const LK = {
  LUCENT_LIVEKIT_API_KEY: "test-lk-key",
  LUCENT_LIVEKIT_API_SECRET: "test-lk-secret-with-enough-entropy",
  LUCENT_LIVEKIT_URL: "wss://lucent.test.livekit.cloud",
};

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  calls: InMemoryCallControl;
  close: () => Promise<void>;
}
interface Actor {
  token: string;
  id: string;
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(options: { calls?: boolean } = {}): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1", ...LK }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const calls = new InMemoryCallControl();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    ...(options.calls === false ? {} : { callControl: calls }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, calls, close: async () => close() };
}

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
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const post = (h: Harness, path: string, who: Actor, body: unknown = {}) =>
  api(h, path, { method: "POST", token: who.token, body: JSON.stringify(body) });

async function signup(h: Harness, email: string): Promise<Actor> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

/** Alice's board, with Bob and Carol as members of the given role. */
async function boardWith(
  h: Harness,
  role: "editor" | "viewer" = "editor",
): Promise<{ boardId: string; alice: Actor; bob: Actor; carol: Actor }> {
  const tag = Math.random().toString(36).slice(2, 8);
  const alice = await signup(h, `alice.${tag}@example.com`);
  const bob = await signup(h, `bob.${tag}@example.com`);
  const carol = await signup(h, `carol.${tag}@example.com`);
  const created = await post(h, "/api/boards", alice, {
    name: "Call",
    workspace: createWorkspace(),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  for (const member of [bob, carol]) {
    const link = await post(h, `/api/boards/${boardId}/share`, alice, { role });
    expect(link.status).toBe(201);
    const joined = await post(h, `/api/boards/${boardId}/join`, member, {
      token: link.body.token,
    });
    expect(joined.status).toBe(200);
  }
  return { boardId, alice, bob, carol };
}

/** Ask for a call token, and — as LiveKit would — put the person in the room. */
async function enter(h: Harness, boardId: string, who: Actor, name = who.id) {
  const res = await post(h, "/api/livekit/token", who, { boardId, room: `board-${boardId}` });
  if (res.status === 200) {
    h.calls.join(`board-${boardId}`, {
      identity: who.id,
      name,
      tracks: [
        { sid: `TR_mic_${who.id}`, source: "microphone", muted: false },
        { sid: `TR_cam_${who.id}`, source: "camera", muted: false },
      ],
    });
  }
  return res;
}

describe("call admission (pure)", () => {
  it("hosts the first person, keeps a host a host, and keeps a removed person out", () => {
    const meta = newCallMeta("usr_a", 1);
    expect(admitToCall(meta, [], "usr_a", 2)).toMatchObject({ host: true, changed: false });
    expect(admitToCall(meta, ["usr_a"], "usr_b", 2)).toMatchObject({
      host: false,
      changed: false,
    });
    const removed = withRemoved(withHost(meta, "usr_b"), "usr_b");
    expect(removed.hosts).toEqual(["usr_a"]);
    expect(admitToCall(removed, ["usr_a"], "usr_b", 2)).toEqual({ kind: "removed" });
  });

  it("hands hosting on when no host is in the room, and hosts a room with no metadata", () => {
    const meta = newCallMeta("usr_a", 1);
    const handed = admitToCall(meta, ["usr_c"], "usr_b", 2);
    expect(handed).toMatchObject({ host: true, changed: true });
    expect(handed.kind === "admitted" && handed.meta.hosts).toEqual(["usr_a", "usr_b"]);
    const bare = admitToCall(null, [], "usr_b", 5);
    expect(bare).toMatchObject({ host: true, changed: true });
    expect(bare.kind === "admitted" && bare.meta.startedBy).toBe("usr_b");
  });

  it("reads only its own metadata shape", () => {
    expect(parseCallMeta(JSON.stringify(newCallMeta("usr_a", 3)))).toEqual(newCallMeta("usr_a", 3));
    expect(parseCallMeta("{not json")).toBeNull();
    expect(parseCallMeta(JSON.stringify({ hosts: ["x"] }))).toBeNull();
    expect(parseCallMeta(JSON.stringify({ v: 1, hosts: ["x", 3], removed: "no" }))).toMatchObject({
      hosts: ["x"],
      removed: [],
    });
  });
});

describe("the board call's host (docs/28 A3.2)", () => {
  it("the first person in hosts the call; the next does not", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob } = await boardWith(h);
    const first = await enter(h, boardId, alice, "Alice");
    expect(first.status).toBe(200);
    expect(first.body.host).toBe(true);
    const second = await enter(h, boardId, bob, "Bob");
    expect(second.body.host).toBe(false);

    const call = await api(h, `/api/boards/${boardId}/call`, { token: bob.token });
    expect(call.status).toBe(200);
    expect(call.body.live).toBe(true);
    expect(call.body.you).toEqual({ host: false });
    expect(
      call.body.participants.map((p: { name: string; host: boolean }) => [p.name, p.host]),
    ).toEqual([
      ["Alice", true],
      ["Bob", false],
    ]);
  });

  it("only a host mutes, and Mute everyone spares the host and what's already muted", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    await enter(h, boardId, carol);

    const refused = await post(h, `/api/boards/${boardId}/call/mute`, bob, {
      identity: carol.id,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("Only the host can do that.");

    const one = await post(h, `/api/boards/${boardId}/call/mute`, alice, { identity: bob.id });
    expect(one.body).toEqual({ ok: true, muted: 1 });
    const all = await post(h, `/api/boards/${boardId}/call/mute`, alice, { everyone: true });
    expect(all.body).toEqual({ ok: true, muted: 1 });
    expect(h.calls.log.filter((l) => l.startsWith("mute"))).toEqual([
      `mute ${bob.id} TR_mic_${bob.id}`,
      `mute ${carol.id} TR_mic_${carol.id}`,
    ]);

    const camera = await post(h, `/api/boards/${boardId}/call/mute`, alice, {
      identity: bob.id,
      source: "camera",
    });
    expect(camera.body.muted).toBe(1);
    const bogus = await post(h, `/api/boards/${boardId}/call/mute`, alice, {
      identity: bob.id,
      source: "everything",
    });
    expect(bogus.status).toBe(400);
  });

  it("a removed person is disconnected and can't rejoin this call", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);

    expect(
      (await post(h, `/api/boards/${boardId}/call/remove`, bob, { identity: alice.id })).status,
    ).toBe(403);
    expect(
      (await post(h, `/api/boards/${boardId}/call/remove`, alice, { identity: alice.id })).status,
    ).toBe(400);
    const removed = await post(h, `/api/boards/${boardId}/call/remove`, alice, {
      identity: bob.id,
    });
    expect(removed.status).toBe(200);
    expect(h.calls.log).toContain(`remove ${bob.id}`);

    const back = await enter(h, boardId, bob);
    expect(back.status).toBe(403);
    expect(back.body).toEqual({ error: "The host removed you from this call.", removed: true });
  });

  it("a co-host gets every host power, and ending the call ends it for everyone", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    await enter(h, boardId, carol);

    expect((await post(h, `/api/boards/${boardId}/call/end`, bob)).status).toBe(403);
    const made = await post(h, `/api/boards/${boardId}/call/hosts`, alice, { identity: bob.id });
    expect(made.status).toBe(200);
    const ended = await post(h, `/api/boards/${boardId}/call/end`, bob);
    expect(ended.status).toBe(200);
    expect(h.calls.log).toContain(`end board-${boardId}`);

    const after = await api(h, `/api/boards/${boardId}/call`, { token: carol.token });
    expect(after.body).toMatchObject({ live: false, participants: [] });
    const late = await post(h, `/api/boards/${boardId}/call/mute`, bob, { everyone: true });
    expect(late.status).toBe(404);
    expect(late.body.error).toBe("No call is running on this board.");
  });

  it("when every host has left, the next person in hosts the call", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    // Alice leaves; the room goes on with Bob.
    const room = h.calls.rooms.get(`board-${boardId}`)!;
    room.participants = room.participants.filter((p) => p.identity !== alice.id);

    const next = await enter(h, boardId, carol);
    expect(next.body.host).toBe(true);
    // Alice is still a host when she comes back.
    expect((await enter(h, boardId, alice)).body.host).toBe(true);
  });

  it("a hand goes up and down; a host lowers someone else's, and nothing more", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h, "viewer");
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);

    const up = await post(h, `/api/boards/${boardId}/call/state`, bob, { hand: true });
    expect(up.status).toBe(200);
    const bobInRoom = () =>
      h.calls.rooms.get(`board-${boardId}`)!.participants.find((p) => p.identity === bob.id)!;
    expect(Number(bobInRoom().attributes[CALL_ATTRIBUTES.hand])).toBeGreaterThan(0);

    const capture = await post(h, `/api/boards/${boardId}/call/state`, bob, { capture: true });
    expect(capture.status).toBe(200);
    expect(Number(bobInRoom().attributes[CALL_ATTRIBUTES.capture])).toBeGreaterThan(0);
    const optOut = await post(h, `/api/boards/${boardId}/call/state`, bob, { transcribe: false });
    expect(optOut.status).toBe(200);
    expect(bobInRoom().attributes[CALL_ATTRIBUTES.optOut]).toBe("1");
    await post(h, `/api/boards/${boardId}/call/state`, bob, { transcribe: true });
    expect(bobInRoom().attributes[CALL_ATTRIBUTES.optOut]).toBeUndefined();

    // A host may lower Bob's hand, but not mark Bob as transcribing.
    const spoof = await post(h, `/api/boards/${boardId}/call/state`, alice, {
      identity: bob.id,
      capture: false,
    });
    expect(spoof.status).toBe(403);
    const lowered = await post(h, `/api/boards/${boardId}/call/state`, alice, {
      identity: bob.id,
      hand: false,
    });
    expect(lowered.status).toBe(200);
    expect(bobInRoom().attributes[CALL_ATTRIBUTES.hand]).toBeUndefined();

    // Bob (not a host) can't touch Alice's hand; Carol isn't in the call.
    expect(
      (await post(h, `/api/boards/${boardId}/call/state`, bob, { identity: alice.id, hand: false }))
        .status,
    ).toBe(403);
    const absent = await post(h, `/api/boards/${boardId}/call/state`, carol, { hand: true });
    expect(absent.status).toBe(409);
    expect(absent.body.error).toBe("You're not in this call.");
  });

  it("a locked call keeps newcomers out, never a host, and not someone already in", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    expect(
      (await post(h, `/api/boards/${boardId}/call/settings`, bob, { locked: true })).status,
    ).toBe(403);
    const locked = await post(h, `/api/boards/${boardId}/call/settings`, alice, { locked: true });
    expect(locked.body).toMatchObject({ ok: true, locked: true });

    const refused = await enter(h, boardId, carol);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "The host locked this call.", locked: true });
    // Bob reconnecting (still in the room) and Alice (a host) get back in.
    expect((await enter(h, boardId, bob)).status).toBe(200);
    expect((await enter(h, boardId, alice)).status).toBe(200);

    await post(h, `/api/boards/${boardId}/call/settings`, alice, { locked: false });
    expect((await enter(h, boardId, carol)).status).toBe(200);
  });

  it("only hosts present: the others lose the screen at once, and new tokens say so", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob, carol } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    const room = h.calls.rooms.get(`board-${boardId}`)!;
    room.participants
      .find((p) => p.identity === bob.id)!
      .tracks.push({ sid: "TR_screen_bob", source: "screen_share", muted: false });

    await post(h, `/api/boards/${boardId}/call/settings`, alice, { hostsOnlyShare: true });
    expect(h.calls.log).toEqual(
      expect.arrayContaining([
        `scope ${alice.id} all`,
        `scope ${bob.id} no-screen`,
        `mute ${bob.id} TR_screen_bob`,
      ]),
    );

    const carolToken = (await enter(h, boardId, carol)).body.token as string;
    const claims = JSON.parse(
      Buffer.from(
        carolToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString(),
    );
    expect(claims.video.canPublishSources).toEqual(["camera", "microphone"]);

    await post(h, `/api/boards/${boardId}/call/hosts`, alice, { identity: bob.id });
    expect(h.calls.log).toContain(`scope ${bob.id} all`);
  });

  it("marks who reads captions, so speakers' devices know to send them", async () => {
    const h = (open = await harness());
    const { boardId, alice, bob } = await boardWith(h);
    await enter(h, boardId, alice);
    await enter(h, boardId, bob);
    expect(
      (await post(h, `/api/boards/${boardId}/call/state`, bob, { captions: true })).status,
    ).toBe(200);
    const bobInRoom = h.calls.rooms
      .get(`board-${boardId}`)!
      .participants.find((p) => p.identity === bob.id)!;
    expect(bobInRoom.attributes[CALL_ATTRIBUTES.captions]).toBe("1");
  });

  it("keeps the call to the board's members", async () => {
    const h = (open = await harness());
    const { boardId, alice } = await boardWith(h);
    await enter(h, boardId, alice);
    const eve = await signup(h, "eve.call@example.com");
    expect((await api(h, `/api/boards/${boardId}/call`, { token: eve.token })).status).toBe(404);
    expect((await post(h, `/api/boards/${boardId}/call/state`, eve, { hand: true })).status).toBe(
      404,
    );
  });

  it("without the call service, calls still join — without hosts — and the controls say why", async () => {
    const h = (open = await harness({ calls: false }));
    const { boardId, alice } = await boardWith(h);
    const joined = await post(h, "/api/livekit/token", alice, { boardId });
    expect(joined.status).toBe(200);
    expect(joined.body.host).toBe(false);
    const call = await api(h, `/api/boards/${boardId}/call`, { token: alice.token });
    expect(call.status).toBe(503);
    expect(call.body.error).toBe("Video calls aren't set up on this server.");
  });
});
