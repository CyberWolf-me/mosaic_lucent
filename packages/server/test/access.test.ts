import { describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import {
  InMemoryBoardStore,
  newBoardId,
  newShareToken,
  shareLinkUsable,
  type ShareLink,
  type StoredBoard,
} from "../src/boards.js";

/**
 * Board access control (docs/12). Before this existed, a board id was the only
 * capability and `GET /api/boards/:id` 404'd every non-owner, so the sharing the
 * docs described could not work. These pin the properties the routes rely on:
 * the owner needs no membership row, membership is explicit, and revoking a link
 * stops new joins without evicting people who already joined.
 */

const OWNER = "usr_owner";
const GUEST = "usr_guest";

function board(id = newBoardId()): StoredBoard {
  return {
    id,
    orgId: "org_test",
    ownerId: OWNER,
    name: "Test",
    workspace: createWorkspace(),
    createdAt: 1,
    updatedAt: 1,
  };
}

function link(boardId: string, over: Partial<ShareLink> = {}): ShareLink {
  return {
    token: newShareToken(),
    boardId,
    role: "editor",
    createdBy: OWNER,
    createdAt: 1,
    expiresAt: null,
    revokedAt: null,
    ...over,
  };
}

describe("board membership", () => {
  it("resolves the owner without a membership row", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    expect(await store.memberRole(b.id, OWNER)).toBe("owner");
    // No row was written, so existing boards need no backfill.
    expect(await store.members(b.id)).toHaveLength(0);
  });

  it("refuses a non-member — a board id alone is not access", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    expect(await store.memberRole(b.id, GUEST)).toBeUndefined();
  });

  it("grants, upgrades, and removes an explicit member", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);

    await store.setMember({
      boardId: b.id,
      userId: GUEST,
      role: "viewer",
      invitedBy: OWNER,
      createdAt: 2,
    });
    expect(await store.memberRole(b.id, GUEST)).toBe("viewer");

    await store.setMember({
      boardId: b.id,
      userId: GUEST,
      role: "editor",
      invitedBy: OWNER,
      createdAt: 2,
    });
    expect(await store.memberRole(b.id, GUEST)).toBe("editor");
    // Upgrading is an update, not a second row.
    expect(await store.members(b.id)).toHaveLength(1);

    await store.removeMember(b.id, GUEST);
    expect(await store.memberRole(b.id, GUEST)).toBeUndefined();
  });

  it("lists boards in an org", async () => {
    const store = new InMemoryBoardStore();
    const own = { ...board(), id: "brd_own", updatedAt: 10 };
    const shared = { ...board(), id: "brd_shared", ownerId: "usr_other", updatedAt: 20 };
    const invisible = {
      ...board(),
      id: "brd_hidden",
      ownerId: "usr_other",
      orgId: "org_other",
      updatedAt: 30,
    };
    await store.put(own);
    await store.put(shared);
    await store.put(invisible);

    const ids = (await store.listForOrg("org_test")).map((b) => b.id);
    expect(ids).toEqual(["brd_shared", "brd_own"]);
    expect(ids).not.toContain("brd_hidden");
  });

  it("drops members and links when the board is deleted", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    await store.setMember({
      boardId: b.id,
      userId: GUEST,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });
    await store.createShareLink(link(b.id));
    await store.delete(b.id);
    expect(await store.members(b.id)).toHaveLength(0);
    expect(await store.shareLinks(b.id)).toHaveLength(0);
  });
});

describe("share links", () => {
  it("round-trips a link and finds it by token", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    const l = link(b.id, { role: "viewer" });
    await store.createShareLink(l);
    const found = await store.shareLinkByToken(l.token);
    expect(found?.boardId).toBe(b.id);
    expect(found?.role).toBe("viewer");
  });

  it("treats a revoked or expired link as unusable", () => {
    const b = board();
    expect(shareLinkUsable(link(b.id))).toBe(true);
    expect(shareLinkUsable(link(b.id, { revokedAt: 5 }))).toBe(false);
    expect(shareLinkUsable(link(b.id, { expiresAt: 100 }), 200)).toBe(false);
    expect(shareLinkUsable(link(b.id, { expiresAt: 300 }), 200)).toBe(true);
  });

  it("revokes one link by token, leaving the others live", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    const keep = link(b.id);
    const kill = link(b.id);
    await store.createShareLink(keep);
    await store.createShareLink(kill);

    expect(await store.revokeShareLinks(b.id, 9, kill.token)).toBe(1);
    expect((await store.shareLinkByToken(kill.token))?.revokedAt).toBe(9);
    expect((await store.shareLinkByToken(keep.token))?.revokedAt).toBeNull();
  });

  it("revokes every live link when no token is given, and is not double-counted", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    await store.createShareLink(link(b.id));
    await store.createShareLink(link(b.id));

    expect(await store.revokeShareLinks(b.id, 9)).toBe(2);
    // Already-revoked links aren't revoked again, so the count is honest.
    expect(await store.revokeShareLinks(b.id, 10)).toBe(0);
  });

  it("keeps access for someone who already joined after the link is revoked", async () => {
    const store = new InMemoryBoardStore();
    const b = board();
    await store.put(b);
    const l = link(b.id);
    await store.createShareLink(l);
    // Redeem, then revoke.
    await store.setMember({
      boardId: b.id,
      userId: GUEST,
      role: l.role,
      invitedBy: null,
      createdAt: 2,
    });
    await store.revokeShareLinks(b.id, 9);

    expect(shareLinkUsable((await store.shareLinkByToken(l.token))!)).toBe(false);
    // The membership row is what grants access, so the guest is unaffected.
    expect(await store.memberRole(b.id, GUEST)).toBe("editor");
  });

  it("mints unique, URL-safe tokens", () => {
    const a = newShareToken();
    const b = newShareToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes base64url — long enough not to be guessable.
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});
