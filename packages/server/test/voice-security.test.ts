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
import { verifyLiveKitToken } from "../src/livekit.js";
import { issueToken, verifyToken } from "../src/auth.js";
import { issueAgentGrant, resolveRoomAccess, verifyAgentGrant } from "../src/agentGrant.js";

/**
 * docs/26 F1 + F2, pinned.
 *
 * F1 — the LiveKit token route minted for ANY room name: any signed-in user
 * could join `board-<anyone's id>` (another team's call), and every board-less
 * user shared one "lucent-voice" room. Rooms are now authorized: board rooms
 * need a role on the board, everything else is the caller's private room.
 *
 * F2 — the voice agent received the user's session token through LiveKit
 * metadata (or ran as a static service account). It now gets a board-scoped
 * grant that can never pass as a session token, and its edits are recorded
 * as AI initiated by the user.
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
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1", ...LK }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, close: async () => close() };
}

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string; agent?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, agent, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(agent ? { authorization: `Agent ${agent}` } : {}),
      origin: h.base,
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
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

async function makeBoard(h: Harness, token: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "B", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

function roomOf(token: string): string {
  const verified = verifyLiveKitToken(token, LK.LUCENT_LIVEKIT_API_SECRET);
  if (!verified.ok) throw new Error("token failed verification");
  return (verified.payload.video as { room: string }).room;
}

describe("F1 · LiveKit rooms are authorized, not trusted", () => {
  it("a member gets their board's room; a stranger gets 404", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const mallory = await signup(h, "mallory@example.com");
    const boardId = await makeBoard(h, alice.token);

    const mine = await api(h, "/api/livekit/token", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ room: `board-${boardId}` }),
    });
    expect(mine.status).toBe(200);
    expect(roomOf(mine.body.token)).toBe(`board-${boardId}`);

    const theirs = await api(h, "/api/livekit/token", {
      method: "POST",
      token: mallory.token,
      body: JSON.stringify({ room: `board-${boardId}` }),
    });
    expect(theirs.status).toBe(404);
    expect(theirs.body.token).toBeUndefined();
  });

  it("board-less callers get a private room, not a shared one", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "a2@example.com");
    const bob = await signup(h, "b2@example.com");
    for (const body of [undefined, JSON.stringify({ room: "lucent-voice" })]) {
      const a = await api(h, "/api/livekit/token", { method: "POST", token: alice.token, ...(body ? { body } : {}) });
      const b = await api(h, "/api/livekit/token", { method: "POST", token: bob.token, ...(body ? { body } : {}) });
      expect(roomOf(a.body.token)).toBe(`user-${alice.id}`);
      expect(roomOf(b.body.token)).toBe(`user-${bob.id}`);
    }
  });

  it("any other room name is refused, including someone else's private room", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "a3@example.com");
    for (const room of ["brd_meeting", "anything", "user-usr_someone_else"]) {
      const res = await api(h, "/api/livekit/token", {
        method: "POST",
        token: alice.token,
        body: JSON.stringify({ room }),
      });
      expect(res.status).toBe(403);
    }
  });

  it("resolveRoomAccess: the policy table", () => {
    expect(resolveRoomAccess({}, "u1")).toEqual({ kind: "private", room: "user-u1" });
    expect(resolveRoomAccess({ boardId: "b1" }, "u1")).toMatchObject({ room: "board-b1", minRole: "viewer" });
    expect(resolveRoomAccess({ room: "voice_b1" }, "u1")).toMatchObject({ boardId: "b1", minRole: "editor" });
    expect(resolveRoomAccess({ room: "user-u2" }, "u1")).toEqual({ kind: "refused" });
  });
});

describe("F2 · the voice agent's board grant", () => {
  it("can never pass as a session token, and a session token never passes as a grant", () => {
    const grant = issueAgentGrant({ userId: "u1", boardId: "b1" }, SECRET);
    expect(verifyToken(grant, SECRET)).toBeNull();
    expect(verifyAgentGrant(grant, SECRET)).toMatchObject({ userId: "u1", boardId: "b1" });
    const session = issueToken("u1", SECRET);
    expect(verifyAgentGrant(session, SECRET)).toBeNull();
  });

  it("expires, and is bound to its secret", () => {
    const grant = issueAgentGrant({ userId: "u1", boardId: "b1", ttlSeconds: 60 }, SECRET, 0);
    expect(verifyAgentGrant(grant, SECRET, 61_000)).toBeNull();
    expect(verifyAgentGrant(issueAgentGrant({ userId: "u1", boardId: "b1" }, "another-secret-16c"), SECRET)).toBeNull();
  });

  it("writes to its own board as AI on the user's behalf — and nowhere else", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "ag@example.com");
    const boardA = await makeBoard(h, alice.token);
    const boardB = await makeBoard(h, alice.token);
    const grant = issueAgentGrant({ userId: alice.id, boardId: boardA }, SECRET);

    const read = await api(h, `/api/boards/${boardA}`, { agent: grant });
    expect(read.status).toBe(200);

    const write = await api(h, `/api/boards/${boardA}/ops`, {
      method: "POST",
      agent: grant,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "service", label: "Payments" }],
        label: "Voice agent",
      }),
    });
    expect(write.status).toBe(200);

    const history = await api(h, `/api/boards/${boardA}/history`, { token: alice.token });
    expect(history.status).toBe(200);
    expect(history.body.items[0].actor).toMatchObject({ type: "ai" });

    const elsewhere = await api(h, `/api/boards/${boardB}/ops`, {
      method: "POST",
      agent: grant,
      body: JSON.stringify({ ops: [{ op: "CREATE_NODE", id: "n2", nodeType: "service", label: "X" }] }),
    });
    expect(elsewhere.status).toBe(401);
    expect((await api(h, `/api/boards/${boardB}`, { agent: grant })).status).toBe(401);
  });
});
