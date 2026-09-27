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
 * End-to-end collaboration over the real HTTP + WebSocket wiring.
 *
 * This test exists because the previous suite could not have caught the headline
 * defect: `GET /api/boards/:id` compared `ownerId` and 404'd every non-owner, so
 * the invite flow silently no-opped and the whole viewer/read-only UX was
 * unreachable — while the unit tests, which exercised the store and the Room
 * directly, stayed green. Anything that spans "two users, HTTP and a socket"
 * belongs here.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  ws: string;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
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
  // M1.4: the user store is shared with the app; reach into it to verify
  // the email so the owner can mint share links without going through the
  // token flow. In a real signup the user clicks the email link.
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

/** Exchange a session token for a single-use realtime ticket. */
async function ticketFor(h: Harness, token: string): Promise<string> {
  const { status, body } = await api(h, "/api/realtime/ticket", { method: "POST", token });
  expect(status).toBe(200);
  return body.ticket as string;
}

/** Open a socket, join a board, and resolve with the welcome frame. */
async function join(
  h: Harness,
  boardId: string,
  token: string,
  /** The cursor the joiner claims; the server replays everything after it. */
  fromSeq = 0,
): Promise<{ socket: WebSocket; welcome: any }> {
  const ticket = await ticketFor(h, token);
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq }));
  return { socket, welcome: await welcome };
}

/** Resolve on the next frame whose type is in `types`. */
function frame(socket: WebSocket, types: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${types.join("|")}`)),
      4000,
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

/**
 * Wait for an `op` frame carrying a specific node id. The server broadcasts an
 * accepted op to *everyone* including the sender, so "the next op frame" on a
 * socket is ambiguous — a socket sees its own edit echoed as well as its peer's.
 * Matching on the id is what makes the assertion deterministic.
 */
function opFor(socket: WebSocket, nodeId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for op ${nodeId}`)), 4000);
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== "op") return;
      if (!msg.entry?.ops?.some((o: { id?: string }) => o.id === nodeId)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

/**
 * Publish a board and commit `ids` as one sequenced batch each, over a single
 * socket. Every send waits for its own broadcast, so by the time this resolves
 * the room has committed all of them — otherwise a joiner could race the
 * commits and see a shorter catchup than the test expects.
 */
async function seedBoard(
  h: Harness,
  owner: { token: string; id: string },
  name: string,
  ids: string[],
): Promise<{ boardId: string; socket: WebSocket; entries: any[] }> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ name, workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const { socket, welcome } = await join(h, boardId, owner.token);
  expect(welcome.type).toBe("welcome");
  // A brand-new board has nothing to replay, which is the baseline the
  // catchup assertions below are measured against.
  expect(welcome.catchup).toEqual([]);
  const entries: any[] = [];
  for (const id of ids) {
    const applied = opFor(socket, id);
    socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id, nodeType: "step", label: id }],
        label: `create ${id}`,
      }),
    );
    entries.push((await applied).entry);
  }
  return { boardId, socket, entries };
}

describe("collaboration end to end", () => {
  it("an invited editor joins the owner's board and both see each other's ops", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@example.com");
    const guest = await signup(h, "guest@example.com");

    // Owner publishes a board.
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Shared", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    // Before an invite, the guest cannot even see it exists.
    expect((await api(h, `/api/boards/${boardId}`, { token: guest.token })).status).toBe(404);

    // Owner mints an editor link; the guest redeems it.
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(link.status).toBe(201);
    const joined = await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: guest.token,
      body: JSON.stringify({ token: link.body.token }),
    });
    expect(joined.status).toBe(200);
    expect(joined.body.role).toBe("editor");

    // Now the guest can fetch it, and learns their role in the same response.
    const fetched = await api(h, `/api/boards/${boardId}`, { token: guest.token });
    expect(fetched.status).toBe(200);
    expect(fetched.body.role).toBe("editor");

    // Both join the room over WS.
    const a = await join(h, boardId, owner.token);
    expect(a.welcome.type).toBe("welcome");
    expect(a.welcome.role).toBe("owner");
    const b = await join(h, boardId, guest.token);
    expect(b.welcome.role).toBe("editor");

    // The guest's edit reaches the owner.
    const seenByOwner = opFor(a.socket, "from-guest");
    b.socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "from-guest", nodeType: "step", label: "Guest" }],
        label: "guest edit",
      }),
    );
    const relayed = await seenByOwner;
    expect(relayed.entry.ops[0].id).toBe("from-guest");
    expect(relayed.entry.by).toBe(guest.id);

    // And the owner's edit reaches the guest.
    const seenByGuest = opFor(b.socket, "from-owner");
    a.socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "from-owner", nodeType: "step", label: "Owner" }],
        label: "owner edit",
      }),
    );
    const echoed = await seenByGuest;
    expect(echoed.entry.by).toBe(owner.id);
    // Sequence numbers are server-assigned and monotonic across both authors.
    expect(echoed.entry.seq).toBe(relayed.entry.seq + 1);

    // The board lists for both users, but through different views (M2.2).
    //
    // This assertion used to sum `?orgId=` listings across the *owner's* orgs
    // while authenticated as the guest, and it only passed because redeeming a
    // share link also inserted an org membership for the redeemer — the
    // privilege escalation this change removed. A link to one board must not
    // make its holder a member of the tenant, so the guest is no longer
    // entitled to the org-wide listing; they reach their board via scope=shared.
    const ownerOrgId = fetched.body.orgId as string;
    const ownerList = await api(h, `/api/boards?orgId=${encodeURIComponent(ownerOrgId)}`, {
      token: owner.token,
    });
    expect(ownerList.status).toBe(200);
    expect((ownerList.body.boards as Array<{ id: string }>).map((b) => b.id)).toContain(boardId);

    // The guest is not an org member, so the org-scoped view answers 404 — the
    // same response an unknown org id gets, so org ids stay unguessable.
    const guestOrgList = await api(h, `/api/boards?orgId=${encodeURIComponent(ownerOrgId)}`, {
      token: guest.token,
    });
    expect(guestOrgList.status).toBe(404);

    // The one board they were invited to does show up under scope=shared.
    const guestShared = await api(
      h,
      `/api/boards?orgId=${encodeURIComponent(ownerOrgId)}&scope=shared`,
      {
        token: guest.token,
      },
    );
    expect(guestShared.status).toBe(200);
    expect((guestShared.body.boards as Array<{ id: string }>).map((b) => b.id)).toEqual([boardId]);
  });

  it("a viewer is admitted read-only and the server refuses their edits", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner2@example.com");
    const guest = await signup(h, "viewer@example.com");

    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Read only", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;

    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: guest.token,
      body: JSON.stringify({ token: link.body.token }),
    });

    const b = await join(h, boardId, guest.token);
    expect(b.welcome.role).toBe("viewer");

    const rejected = frame(b.socket, ["op-rejected"]);
    b.socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "nope", nodeType: "step", label: "Nope" }],
      }),
    );
    expect((await rejected).error).toBe("permission");
  });

  it("refuses a socket join from someone with no membership", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner3@example.com");
    const stranger = await signup(h, "stranger@example.com");

    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Private", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;

    // A board id is not a capability: knowing it is not enough to join.
    const attempt = await join(h, boardId, stranger.token);
    expect(attempt.welcome.type).toBe("error");
  });

  it("a revoked link stops new joins but keeps existing members", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner4@example.com");
    const early = await signup(h, "early@example.com");
    const late = await signup(h, "late@example.com");

    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Revoke", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "editor" }),
    });

    // Early guest redeems before the revoke.
    expect(
      (
        await api(h, `/api/boards/${boardId}/join`, {
          method: "POST",
          token: early.token,
          body: JSON.stringify({ token: link.body.token }),
        })
      ).status,
    ).toBe(200);

    const revoked = await api(h, `/api/boards/${boardId}/share`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(revoked.body.revoked).toBe(1);

    // The late guest is refused the same token.
    expect(
      (
        await api(h, `/api/boards/${boardId}/join`, {
          method: "POST",
          token: late.token,
          body: JSON.stringify({ token: link.body.token }),
        })
      ).status,
    ).toBe(404);

    // The early guest keeps access: the membership row, not the link, grants it.
    expect((await api(h, `/api/boards/${boardId}`, { token: early.token })).status).toBe(200);
  });

  it("only the owner may share or change members, and the owner cannot be demoted", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner5@example.com");
    const guest = await signup(h, "guest5@example.com");

    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Perms", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "editor" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: guest.token,
      body: JSON.stringify({ token: link.body.token }),
    });

    // An editor may read the member list but not mint links or change roles.
    expect((await api(h, `/api/boards/${boardId}/members`, { token: guest.token })).status).toBe(
      200,
    );
    expect(
      (
        await api(h, `/api/boards/${boardId}/share`, {
          method: "POST",
          token: guest.token,
          body: JSON.stringify({ role: "editor" }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(h, `/api/boards/${boardId}/members/${guest.id}`, {
          method: "PATCH",
          token: guest.token,
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(403);

    // The owner may demote the editor to a viewer.
    expect(
      (
        await api(h, `/api/boards/${boardId}/members/${guest.id}`, {
          method: "PATCH",
          token: owner.token,
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(200);

    // But nobody may change the owner's own role — it lives on the board row.
    expect(
      (
        await api(h, `/api/boards/${boardId}/members/${owner.id}`, {
          method: "PATCH",
          token: owner.token,
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(409);

    // Removing the member revokes their access entirely.
    expect(
      (
        await api(h, `/api/boards/${boardId}/members/${guest.id}`, {
          method: "DELETE",
          token: owner.token,
        })
      ).status,
    ).toBe(200);
    expect((await api(h, `/api/boards/${boardId}`, { token: guest.token })).status).toBe(404);
  });

  it("requires authentication on every board route when LUCENT_REQUIRE_AUTH is on", async () => {
    const h = (open = await harness());
    expect((await api(h, "/api/boards")).status).toBe(401);
    expect((await api(h, "/api/boards/brd_x")).status).toBe(401);
    expect((await api(h, "/api/generate", { method: "POST", body: "{}" })).status).toBe(401);
  });

  /**
   * Catchup is the reconnect story: a client that was offline for two edits
   * must be handed exactly those two, in order, rather than silently resuming
   * from a stale workspace. `fromSeq: 0` is what a fresh tab sends.
   */
  it("replays the ops a joiner missed, in seq order, when it joins from seq 0", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "catchup@example.com");
    const { boardId, entries } = await seedBoard(h, owner, "Catchup", ["n1", "n2"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);

    // A second socket for the same account: catchup keys off the cursor the
    // socket claims, not off identity, so one user is enough to exercise it.
    const late = await join(h, boardId, owner.token, 0);
    expect(late.welcome.type).toBe("welcome");
    expect(late.welcome.version).toBe(2);

    const catchup = late.welcome.catchup as Array<{
      seq: number;
      by: string;
      ops: Array<{ id?: string }>;
    }>;
    expect(catchup).toHaveLength(2);
    expect(catchup.map((e) => e.ops[0]?.id)).toEqual(["n1", "n2"]);
    expect(catchup.map((e) => e.seq)).toEqual([1, 2]);
    // Strictly increasing, and the last entry lands the client on the room's
    // version -- a client that applies these in order needs nothing else.
    for (let i = 1; i < catchup.length; i += 1) {
      expect(catchup[i]!.seq).toBeGreaterThan(catchup[i - 1]!.seq);
    }
    expect(catchup.at(-1)?.seq).toBe(late.welcome.version);
    expect(catchup.every((e) => e.by === owner.id)).toBe(true);
  });

  it("sends an empty catchup to a joiner already at the latest seq", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "uptodate@example.com");
    const { boardId, entries } = await seedBoard(h, owner, "Up to date", ["n1", "n2"]);
    const latest = entries.at(-1).seq as number;

    // The cursor already covers every entry, so replaying anything would be a
    // duplicate apply on the client.
    const current = await join(h, boardId, owner.token, latest);
    expect(current.welcome.catchup).toEqual([]);
    expect(current.welcome.version).toBe(latest);
  });
});

describe("follow, spotlight, bring everyone here (docs/28 S5)", () => {
  it("shares where people look; editors direct everyone's view; it ends when they leave", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "lead@example.com");
    const editor = await signup(h, "ed@example.com");
    const viewer = await signup(h, "vi@example.com");
    const { boardId } = await seedBoard(h, owner, "Follow me", []);
    for (const [who, role] of [
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const) {
      const link = await api(h, `/api/boards/${boardId}/share`, {
        method: "POST",
        token: owner.token,
        body: JSON.stringify({ role }),
      });
      await api(h, `/api/boards/${boardId}/join`, {
        method: "POST",
        token: who.token,
        body: JSON.stringify({ token: link.body.token }),
      });
    }
    const o = await join(h, boardId, owner.token);
    const e = await join(h, boardId, editor.token);
    const v = await join(h, boardId, viewer.token);
    expect(e.welcome.spotlight).toBeNull();

    // Where someone looks rides their presence; nonsense doesn't.
    const seen = frame(o.socket, ["presence"]);
    e.socket.send(JSON.stringify({ type: "presence", viewport: { x: 120, y: -40, zoom: 150 } }));
    expect((await seen).presence.viewport).toEqual({ x: 120, y: -40, zoom: 150 });
    const junk = frame(o.socket, ["presence"]);
    e.socket.send(JSON.stringify({ type: "presence", viewport: { x: 1, y: 2, zoom: 0 } }));
    expect((await junk).presence.viewport).toBeNull();

    // A viewer can't direct anyone's view.
    const refused = frame(v.socket, ["error"]);
    v.socket.send(JSON.stringify({ type: "spotlight", on: true }));
    expect((await refused).message).toBe("only editors can spotlight");

    // An editor takes the spotlight: everyone hears, and a late joiner is told.
    const toOwner = frame(o.socket, ["spotlight"]);
    const toViewer = frame(v.socket, ["spotlight"]);
    e.socket.send(JSON.stringify({ type: "spotlight", on: true }));
    expect((await toOwner).spotlight).toEqual({ userId: editor.id, name: "ed" });
    expect((await toViewer).spotlight.userId).toBe(editor.id);
    const late = await join(h, boardId, viewer.token);
    expect(late.welcome.spotlight).toEqual({ userId: editor.id, name: "ed" });

    // "Bring everyone here" moves everyone else, once.
    const summoned = frame(o.socket, ["summon"]);
    e.socket.send(JSON.stringify({ type: "summon", viewport: { x: 300, y: 200, zoom: 90 } }));
    expect(await summoned).toMatchObject({
      from: { userId: editor.id, name: "ed" },
      viewport: { x: 300, y: 200, zoom: 90 },
    });

    // The spotlight leaves with its holder.
    const ended = frame(o.socket, ["spotlight"]);
    e.socket.close();
    expect((await ended).spotlight).toBeNull();
  });
});
