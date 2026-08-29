import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import type { RealtimeServer } from "../src/realtime.js";

/**
 * Route-level cross-tenant leakage tests (M2.1/M2.2/M2.3).
 *
 * The audit that produced this file found exactly one route-level cross-tenant
 * assertion in the whole suite (orgs.test.ts, "an outsider who knows a board id
 * cannot read it through any route"). Everything else was asserted at the store
 * layer, which is how three real defects survived a green suite:
 *
 *   1. redeeming a board share link also wrote a `memberships` row, so a link
 *      to one board made its holder an org member — and `GET /api/boards`
 *      lists an org member every board in the tenant;
 *   2. `effectiveBoardRole` was tested but unreachable: every board route ran a
 *      bare `memberRole(id, user.id)` with no org-role resolver, so an org owner
 *      had no access to a board in their own org (including over WebSocket,
 *      where the role is stamped into the Room at join time);
 *   3. there was no `DELETE /api/boards/:id` at all, and `DELETE /api/orgs/:id`
 *      refuses while any board is left — an org that ever held a board could
 *      never be deleted.
 *
 * So the rule here is: every board route gets an assertion from a caller who is
 * in a *different tenant*, and the refusal is always 404 rather than 403 so a
 * board or org id cannot be confirmed by probing. Where the fix depends on a
 * role being carried somewhere (the Room, an audit entry), the test follows it
 * there rather than trusting the status code.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  ws: string;
  userStore: InMemoryUserStore;
  realtime: RealtimeServer;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const { server, realtime, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
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
    sessionStore: new InMemorySessionStore(),
    // The audit assertions below read this store through GET /api/orgs/:id/audit.
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    userStore,
    realtime,
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

interface Json {
  status: number;
  body: any;
}

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Json> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A signed-up user with a verified email and their personal org id. */
interface Actor {
  id: string;
  token: string;
  orgId: string;
}

async function signup(h: Harness, email: string): Promise<Actor> {
  const created = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(created.status).toBe(201);
  // Minting a share link is gated on a verified email (M1.4); verify through
  // the store so these tests don't depend on the mail flow.
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  const orgs = await api(h, "/api/orgs", { token: created.body.token });
  expect(orgs.status).toBe(200);
  return {
    id: created.body.user.id as string,
    token: created.body.token as string,
    orgId: orgs.body.orgs[0].id as string,
  };
}

/** Create a board, defaulting to the actor's personal org. */
async function newBoard(h: Harness, owner: Actor, name: string, orgId?: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify(orgId ? { name, orgId } : { name }),
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

/** Mint a share link for a board and return its token. */
async function shareToken(
  h: Harness,
  boardId: string,
  owner: Actor,
  role: "editor" | "viewer",
): Promise<string> {
  const link = await api(h, `/api/boards/${boardId}/share`, {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ role }),
  });
  expect(link.status).toBe(201);
  return link.body.token as string;
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
 * Open a socket with a single-use ticket and send `join`, resolving with the
 * first `welcome` *or* `error` frame — a refused join has to be observable, so
 * this deliberately does not assert success.
 */
async function joinBoard(
  h: Harness,
  boardId: string,
  actor: Actor,
): Promise<{ socket: WebSocket; first: any }> {
  const minted = await api(h, "/api/realtime/ticket", { method: "POST", token: actor.token });
  expect(minted.status).toBe(200);
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(minted.body.ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const first = frame(socket, ["welcome", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
  return { socket, first: await first };
}

/** Send one CREATE_NODE batch and resolve with the `op` or `op-rejected` frame. */
function commit(socket: WebSocket, nodeId: string): Promise<any> {
  const settled = frame(socket, ["op", "op-rejected"]);
  socket.send(
    JSON.stringify({
      type: "op",
      ops: [{ op: "CREATE_NODE", id: nodeId, nodeType: "step", label: nodeId }],
      label: `create ${nodeId}`,
    }),
  );
  return settled;
}

/**
 * Round-trip a ping so the assertions that follow can rely on an earlier
 * message having been fully handled. The server processes socket messages in
 * order, so a `pong` proves the `op` before it was already dealt with — which
 * for a socket with no board means dropped. Cheaper and less flaky than a sleep.
 */
async function barrier(socket: WebSocket): Promise<void> {
  const pong = frame(socket, ["pong"]);
  socket.send(JSON.stringify({ type: "ping" }));
  await pong;
}

describe("M2 cross-tenant leakage: board routes", () => {
  it("POST /api/boards refuses another tenant's org and another owner's board", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.ct@example.com");
    const eve = await signup(h, "eve.ct@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    // Naming someone else's org is a 404, the same answer an unknown org id
    // gets, so org ids cannot be probed for existence.
    const intoAliceOrg = await api(h, "/api/boards", {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ name: "Trojan", orgId: alice.orgId }),
    });
    expect(intoAliceOrg.status).toBe(404);

    // Overwriting an existing board she does not own is refused. The route
    // answers 404 (not 403) so a guessed board id is indistinguishable from a
    // non-existent one — the same shape `GET /api/boards/:id` already uses.
    // This closes the existence oracle `POST /api/boards {id: "brd_X"}` had:
    // "no such board" and "board belongs to someone else" used to answer
    // differently and let a caller enumerate board ids by trial.
    const overwrite = await api(h, "/api/boards", {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ id: boardId, name: "Stolen" }),
    });
    expect(overwrite.status).toBe(404);
    expect(overwrite.body).toEqual({ error: "board not found" });
    // Nothing was written: the board still belongs to Alice, under its own name.
    const read = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(read.body.name).toBe("Plan");
    expect(read.body.ownerId).toBe(alice.id);
  });

  it("a share token is a capability for exactly one board", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.link@example.com");
    const eve = await signup(h, "eve.link@example.com");
    const shared = await newBoard(h, alice, "Shared");
    const private_ = await newBoard(h, alice, "Private");
    const token = await shareToken(h, shared, alice, "editor");

    // A token minted for one board does not open another, even though Eve holds
    // a genuine, unrevoked link.
    const wrongBoard = await api(h, `/api/boards/${private_}/join`, {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ token }),
    });
    expect(wrongBoard.status).toBe(404);
    expect((await api(h, `/api/boards/${private_}`, { token: eve.token })).status).toBe(404);

    // An invented token is refused.
    const forged = await api(h, `/api/boards/${shared}/join`, {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(forged.status).toBe(404);

    // Revocation is a write, not a hope: the same token stops working.
    const revoked = await api(h, `/api/boards/${shared}/share?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
      token: alice.token,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(1);
    const afterRevoke = await api(h, `/api/boards/${shared}/join`, {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ token }),
    });
    expect(afterRevoke.status).toBe(404);
    expect((await api(h, `/api/boards/${shared}`, { token: eve.token })).status).toBe(404);
  });

  it("redeeming a share link grants board access only, never org membership", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.esc@example.com");
    const guest = await signup(h, "guest.esc@example.com");
    const shared = await newBoard(h, alice, "Shared");
    const other = await newBoard(h, alice, "Other");

    const joined = await api(h, `/api/boards/${shared}/join`, {
      method: "POST",
      token: guest.token,
      body: JSON.stringify({ token: await shareToken(h, shared, alice, "editor") }),
    });
    expect(joined.status).toBe(200);
    expect(joined.body.role).toBe("editor");

    // The regression this test exists for: the join used to also write a
    // `memberships` row for Alice's org, which made a link to one board a key to
    // the whole tenant. The guest's memberships must still be their own org only.
    const memberships = await h.userStore.membershipsFor(guest.id);
    expect(memberships.map((m) => m.orgId)).toEqual([guest.orgId]);
    expect(memberships.map((m) => m.orgId)).not.toContain(alice.orgId);
    // …and the same answer from the API the client actually uses.
    const orgs = await api(h, "/api/orgs", { token: guest.token });
    expect(orgs.body.orgs.map((o: { id: string }) => o.id)).toEqual([guest.orgId]);

    // The org-wide listing stays closed to them.
    const orgScoped = await api(h, `/api/boards?orgId=${encodeURIComponent(alice.orgId)}`, {
      token: guest.token,
    });
    expect(orgScoped.status).toBe(404);

    // The "shared with me" view returns the one board they were invited to and
    // nothing else in the tenant — this is the listing outside collaborators get.
    const sharedScoped = await api(
      h,
      `/api/boards?orgId=${encodeURIComponent(alice.orgId)}&scope=shared`,
      { token: guest.token },
    );
    expect(sharedScoped.status).toBe(200);
    expect(sharedScoped.body.scope).toBe("shared");
    expect(sharedScoped.body.boards.map((b: { id: string }) => b.id)).toEqual([shared]);
    // And the board they were not invited to is still invisible by id.
    expect((await api(h, `/api/boards/${other}`, { token: guest.token })).status).toBe(404);
    // An unknown scope is a 400 rather than a silent fallback to the org view.
    const bogus = await api(h, `/api/boards?orgId=${encodeURIComponent(guest.orgId)}&scope=all`, {
      token: guest.token,
    });
    expect(bogus.status).toBe(400);
  });

  it("POST and DELETE /api/boards/:id/share are refused to outsiders and to non-owners", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.share@example.com");
    const eve = await signup(h, "eve.share@example.com");
    const editor = await signup(h, "editor.share@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    const live = await shareToken(h, boardId, alice, "editor");
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: editor.token,
      body: JSON.stringify({ token: live }),
    });

    // An outsider cannot mint a link, and neither can an invited editor: minting
    // is owner-only, so a shared board cannot be re-shared by its guests.
    for (const caller of [eve, editor]) {
      const minted = await api(h, `/api/boards/${boardId}/share`, {
        method: "POST",
        token: caller.token,
        body: JSON.stringify({ role: "editor" }),
      });
      expect(minted.status).toBe(404);
      const revoked = await api(h, `/api/boards/${boardId}/share`, {
        method: "DELETE",
        token: caller.token,
      });
      expect(revoked.status).toBe(404);
    }

    // Neither refusal touched the board's links: the owner's live link still
    // works, which is what proves the guard ran before the revoke.
    const stillWorks = await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ token: live }),
    });
    expect(stillWorks.status).toBe(200);
    const ownerRevoke = await api(h, `/api/boards/${boardId}/share`, {
      method: "DELETE",
      token: alice.token,
    });
    expect(ownerRevoke.status).toBe(200);
    expect(ownerRevoke.body.revoked).toBe(1);
  });

  it("the members routes refuse outsiders, and refuse writes from non-owner members", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.mem@example.com");
    const eve = await signup(h, "eve.mem@example.com");
    const editor = await signup(h, "editor.mem@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: editor.token,
      body: JSON.stringify({ token: await shareToken(h, boardId, alice, "editor") }),
    });

    // Outsider: all three verbs are 404, and none of them may learn who is on
    // the board or change it.
    expect((await api(h, `/api/boards/${boardId}/members`, { token: eve.token })).status).toBe(404);
    const evePatch = await api(h, `/api/boards/${boardId}/members/${editor.id}`, {
      method: "PATCH",
      token: eve.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(evePatch.status).toBe(404);
    const eveDelete = await api(h, `/api/boards/${boardId}/members/${editor.id}`, {
      method: "DELETE",
      token: eve.token,
    });
    expect(eveDelete.status).toBe(404);

    // A member may read the roster (needed to attribute comments and presence)
    // but not rewrite it: writes are owner-only, answered 403 because the caller
    // has already proved they can see the board.
    const roster = await api(h, `/api/boards/${boardId}/members`, { token: editor.token });
    expect(roster.status).toBe(200);
    expect(roster.body.role).toBe("editor");
    const selfPromote = await api(h, `/api/boards/${boardId}/members/${editor.id}`, {
      method: "PATCH",
      token: editor.token,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(selfPromote.status).toBe(403);

    // Every refusal above was a no-op: the editor is still an editor, and still
    // the only member row on the board.
    const after = await api(h, `/api/boards/${boardId}/members`, { token: alice.token });
    expect(after.body.members).toHaveLength(1);
    expect(after.body.members[0].userId).toBe(editor.id);
    expect(after.body.members[0].role).toBe("editor");
    // The owner's own row is on the board, not in board_members.
    expect((await api(h, `/api/boards/${boardId}/members`, { token: alice.token })).body.role).toBe(
      "owner",
    );
  });

  it("a WS join for a board in another tenant is refused and creates no room", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.ws@example.com");
    const eve = await signup(h, "eve.ws@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    const { first } = await joinBoard(h, boardId, eve);
    expect(first.type).toBe("error");
    // Same wording as the HTTP refusal: the socket must not reveal that the
    // board exists either.
    expect(first.message).toBe("board not found");
    // A refused join must not even instantiate the room — otherwise a stranger
    // could pin an unbounded number of boards into memory.
    expect(h.realtime.roomCount()).toBe(0);
  });

  it("an op on a socket whose join was refused never reaches the board", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.wsop@example.com");
    const eve = await signup(h, "eve.wsop@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    const { socket, first } = await joinBoard(h, boardId, eve);
    expect(first.type).toBe("error");
    // The socket stays open (the client may join a board they *can* reach), so
    // the guard that matters is `conn.boardId` being null: the op is dropped
    // rather than committed. The ping round-trip is the barrier that proves the
    // op was handled before we assert.
    socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "eve-node", nodeType: "step", label: "Eve" }],
        label: "eve edit",
      }),
    );
    await barrier(socket);

    const read = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(Object.keys(read.body.workspace.nodes)).toHaveLength(0);
    expect(h.realtime.roomCount()).toBe(0);
  });
});

describe("M2.2 effective roles: an org grant reaches the org's boards", () => {
  it("an org owner who is not a board member administers and edits the board", async () => {
    const h = (open = await harness());
    const admin = await signup(h, "admin.eff@example.com");
    const author = await signup(h, "author.eff@example.com");
    // A shared org with two members. The invite flow is covered in orgs.test.ts;
    // granting the membership row directly keeps this test on the board guard.
    const org = await api(h, "/api/orgs", {
      method: "POST",
      token: admin.token,
      body: JSON.stringify({ name: "Team" }),
    });
    expect(org.status).toBe(201);
    const orgId = org.body.id as string;
    await h.userStore.setMembership({ userId: author.id, orgId, role: "editor" });
    const boardId = await newBoard(h, author, "Roadmap", orgId);

    // Before the fix every one of these was a 404: the routes called
    // `memberRole` with no org-role resolver, so the org owner's grant was
    // invisible and they had no access to a board in their own org.
    const read = await api(h, `/api/boards/${boardId}`, { token: admin.token });
    expect(read.status).toBe(200);
    expect(read.body.role).toBe("owner");
    const roster = await api(h, `/api/boards/${boardId}/members`, { token: admin.token });
    expect(roster.status).toBe(200);
    expect(roster.body.role).toBe("owner");
    // Owner-only administration works without a board_members row.
    const minted = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: admin.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(minted.status).toBe(201);

    // The WS half. The role is stamped into the Room at join time and every
    // later op inherits it, so a socket that resolved the wrong role would
    // refuse edits for the whole session even though REST allowed them.
    const joined = await joinBoard(h, boardId, admin);
    expect(joined.first.type).toBe("welcome");
    expect(joined.first.role).toBe("owner");
    const committed = await commit(joined.socket, "admin-node");
    expect(committed.type).toBe("op");
    expect(committed.entry.by).toBe(admin.id);
    // The commit is persisted against the board, not just broadcast.
    const after = await api(h, `/api/boards/${boardId}`, { token: author.token });
    expect(Object.keys(after.body.workspace.nodes)).toContain("admin-node");
  });

  it("an org editor may edit but not administer, and a viewer row cannot demote them", async () => {
    const h = (open = await harness());
    const admin = await signup(h, "admin.max@example.com");
    const helper = await signup(h, "helper.max@example.com");
    const org = await api(h, "/api/orgs", {
      method: "POST",
      token: admin.token,
      body: JSON.stringify({ name: "Team" }),
    });
    const orgId = org.body.id as string;
    const boardId = await newBoard(h, admin, "Roadmap", orgId);

    // The helper joins the board as a *viewer* first, then gets an org-level
    // editor grant. `effectiveBoardRole` takes the max of the two, so the
    // weaker board row must not cap them at viewer.
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: helper.token,
      body: JSON.stringify({ token: await shareToken(h, boardId, admin, "viewer") }),
    });
    expect((await api(h, `/api/boards/${boardId}`, { token: helper.token })).body.role).toBe(
      "viewer",
    );
    await h.userStore.setMembership({ userId: helper.id, orgId, role: "editor" });
    expect((await api(h, `/api/boards/${boardId}`, { token: helper.token })).body.role).toBe(
      "editor",
    );

    // Editor is not owner: administration is still refused, and with a 404 so
    // the response is identical to a stranger's.
    const minted = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: helper.token,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(minted.status).toBe(404);
    const deleted = await api(h, `/api/boards/${boardId}`, {
      method: "DELETE",
      token: helper.token,
    });
    expect(deleted.status).toBe(404);
    expect((await api(h, `/api/boards/${boardId}`, { token: admin.token })).status).toBe(200);

    // Over WS they are an editor, and the Room accepts their ops.
    const joined = await joinBoard(h, boardId, helper);
    expect(joined.first.role).toBe("editor");
    expect((await commit(joined.socket, "helper-node")).type).toBe("op");
  });
});

describe("M2.3 DELETE /api/boards/:id", () => {
  it("the owner deletes a board, the action is audited, and the org becomes deletable", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.del@example.com");
    const org = await api(h, "/api/orgs", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Team" }),
    });
    const orgId = org.body.id as string;
    const boardId = await newBoard(h, alice, "Roadmap", orgId);

    // The deadlock this route was missing for: DELETE /api/orgs/:id refuses
    // while any board is left, and nothing could delete a board.
    const blocked = await api(h, `/api/orgs/${orgId}`, { method: "DELETE", token: alice.token });
    expect(blocked.status).toBe(409);

    const deleted = await api(h, `/api/boards/${boardId}`, {
      method: "DELETE",
      token: alice.token,
    });
    expect(deleted.status).toBe(204);
    expect((await api(h, `/api/boards/${boardId}`, { token: alice.token })).status).toBe(404);

    // Audited the way the org routes are, on the board's own org.
    const audit = await api(h, `/api/orgs/${orgId}/audit`, { token: alice.token });
    expect(audit.status).toBe(200);
    const entry = audit.body.entries.find((e: { action: string }) => e.action === "board.delete");
    expect(entry).toBeDefined();
    expect(entry.subject).toBe(boardId);
    expect(entry.actorId).toBe(alice.id);
    expect(entry.metadata.name).toBe("Roadmap");

    // And now the org can go.
    expect(
      (await api(h, `/api/orgs/${orgId}`, { method: "DELETE", token: alice.token })).status,
    ).toBe(204);
  });

  it("an outsider and an invited editor cannot delete a board", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.del2@example.com");
    const eve = await signup(h, "eve.del2@example.com");
    const editor = await signup(h, "editor.del2@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: editor.token,
      body: JSON.stringify({ token: await shareToken(h, boardId, alice, "editor") }),
    });

    for (const caller of [eve, editor]) {
      const refused = await api(h, `/api/boards/${boardId}`, {
        method: "DELETE",
        token: caller.token,
      });
      expect(refused.status).toBe(404);
    }
    // Still there, and still readable by the people who should see it.
    expect((await api(h, `/api/boards/${boardId}`, { token: alice.token })).status).toBe(200);
    expect((await api(h, `/api/boards/${boardId}`, { token: editor.token })).status).toBe(200);
  });

  it("deleting a board evicts its live room", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.del3@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    const joined = await joinBoard(h, boardId, alice);
    expect(joined.first.type).toBe("welcome");
    expect(h.realtime.roomCount()).toBe(1);

    // The socket is told, rather than left committing ops into a log whose
    // board row is gone.
    const evicted = frame(joined.socket, ["error"]);
    const deleted = await api(h, `/api/boards/${boardId}`, {
      method: "DELETE",
      token: alice.token,
    });
    expect(deleted.status).toBe(204);
    expect((await evicted).message).toBe("board deleted");
    expect(h.realtime.roomCount()).toBe(0);

    // A late op from that socket is dropped, not applied and not a crash: the
    // ping proves the server handled it and is still serving this connection.
    joined.socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "late", nodeType: "step", label: "Late" }],
        label: "late edit",
      }),
    );
    await barrier(joined.socket);
    expect(h.realtime.roomCount()).toBe(0);
  });
});
