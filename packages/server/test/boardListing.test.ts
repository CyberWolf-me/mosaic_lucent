import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { InMemoryBoardStore, type StoredBoard } from "../src/boards.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";

/**
 * Membership-scoped listing (`listForUser`) versus tenant-wide listing
 * (`listForOrg`).
 *
 * This exists because `GET /api/boards` was answered with the org-wide query:
 * any member of an org could enumerate every board in it, including boards
 * they held no membership row on. That is the mirror image of the defect the
 * collab e2e suite was written for -- there the owner check was too strict and
 * 404'd real members; here it is missing entirely and leaks board names,
 * sizes and ids across a tenant.
 *
 * Both stores are asserted against the same fixture so the SQL and the
 * in-memory map cannot drift apart.
 */

const ORG = "org_listing";
const OTHER_ORG = "org_listing_other";
const OWNER = "usr_listing_owner";
const MEMBER = "usr_listing_member";
/** In the org, on none of its boards -- the user the old query leaked to. */
const ORG_MATE = "usr_listing_orgmate";

function board(id: string, orgId: string, ownerId: string, updatedAt: number): StoredBoard {
  return {
    id,
    orgId,
    ownerId,
    name: id,
    workspace: createWorkspace(),
    createdAt: 1,
    updatedAt,
  };
}

/** ids of a listing, in the order the store returned them. */
function ids(boards: StoredBoard[]): string[] {
  return boards.map((b) => b.id);
}

async function seeded(): Promise<InMemoryBoardStore> {
  const store = new InMemoryBoardStore();
  await store.put(board("brd_owned", ORG, OWNER, 30));
  await store.put(board("brd_shared", ORG, OWNER, 20));
  await store.put(board("brd_private", ORG, OWNER, 10));
  // Same user, different tenant: proves the org filter still applies to the
  // owner branch of the union.
  await store.put(board("brd_elsewhere", OTHER_ORG, MEMBER, 40));
  await store.setMember({
    boardId: "brd_shared",
    userId: MEMBER,
    role: "editor",
    invitedBy: OWNER,
    createdAt: 2,
  });
  return store;
}

describe("InMemoryBoardStore.listForUser", () => {
  it("hides a board from an org member who holds no membership row on it", async () => {
    const store = await seeded();
    expect(ids(await store.listForUser(ORG, ORG_MATE))).toEqual([]);
    // The boards are there -- the org-wide query still returns all three, so
    // the empty result above is the membership filter and not an empty store.
    expect(ids(await store.listForOrg(ORG))).toEqual(["brd_owned", "brd_shared", "brd_private"]);
  });

  it("gives the owner every board they own and the invited member only theirs", async () => {
    const store = await seeded();
    expect(ids(await store.listForUser(ORG, OWNER))).toEqual([
      "brd_owned",
      "brd_shared",
      "brd_private",
    ]);
    expect(ids(await store.listForUser(ORG, MEMBER))).toEqual(["brd_shared"]);
  });

  it("starts and stops listing a board as the membership row appears and goes", async () => {
    const store = await seeded();
    await store.setMember({
      boardId: "brd_private",
      userId: ORG_MATE,
      role: "viewer",
      invitedBy: null,
      createdAt: 3,
    });
    expect(ids(await store.listForUser(ORG, ORG_MATE))).toEqual(["brd_private"]);
    await store.removeMember("brd_private", ORG_MATE);
    expect(ids(await store.listForUser(ORG, ORG_MATE))).toEqual([]);
  });

  it("never crosses the org boundary, even for a board the user owns", async () => {
    const store = await seeded();
    expect(ids(await store.listForUser(ORG, MEMBER))).toEqual(["brd_shared"]);
    expect(ids(await store.listForUser(OTHER_ORG, MEMBER))).toEqual(["brd_elsewhere"]);
    expect(ids(await store.listForUser(OTHER_ORG, OWNER))).toEqual([]);
  });

  it("orders newest first, matching listForOrg", async () => {
    const store = await seeded();
    const listed = await store.listForUser(ORG, OWNER);
    expect(listed.map((b) => b.updatedAt)).toEqual([30, 20, 10]);
    expect(ids(listed)).toEqual(ids(await store.listForOrg(ORG)));
  });
});

/**
 * The same properties against real SQL. Gated on LUCENT_TEST_DATABASE_URL, the
 * same convention as pg-store.test.ts and pg-bootstrap.test.ts; CI supplies a
 * `postgres:16` service. Worth running there because the in-memory store cannot
 * catch the failure mode the query is written to avoid: a join that duplicates
 * a board row, or a correlated EXISTS that quietly matches every row.
 */
const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;

describeIf("PostgresBoardStore.listForUser", () => {
  let db: Db;
  let store: PostgresBoardStore;
  // Ids are unique per run, so this file needs no TRUNCATE: wiping the shared
  // tables would race the other pg suites, which truncate in their own
  // beforeAll, and every assertion here is scoped to these ids.
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const org = `org_lst_${tag}`;
  const owner = `usr_lst_owner_${tag}`;
  const member = `usr_lst_member_${tag}`;
  const orgMate = `usr_lst_mate_${tag}`;
  const owned = `brd_lst_owned_${tag}`;
  const shared = `brd_lst_shared_${tag}`;
  const hidden = `brd_lst_hidden_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    // The org and user rows exist only to satisfy the FKs; UserStore has no
    // "create an arbitrary org" method (only `ensurePersonalOrg`), so the
    // fixture inserts them directly rather than reaching through a store.
    await db.pool.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [
      org,
      "Listing",
      1,
    ]);
    for (const id of [owner, member, orgMate]) {
      await db.pool.query(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, `${id}@example.com`, id, "salt:hash", 1],
      );
      await db.pool.query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)", [
        id,
        org,
        "editor",
      ]);
    }
    store = new PostgresBoardStore(db);
    await store.put(board(owned, org, owner, 30));
    await store.put(board(shared, org, owner, 20));
    await store.put(board(hidden, org, owner, 10));
    await store.setMember({
      boardId: shared,
      userId: member,
      role: "editor",
      invitedBy: owner,
      createdAt: 2,
    });
  });

  afterAll(async () => {
    if (!db) return;
    // Leave the shared CI database as it was found: the org cascades to its
    // boards and memberships, the users cascade to their board_members rows.
    await db.pool.query("DELETE FROM organizations WHERE id = $1", [org]).catch(() => {});
    await db.pool
      .query("DELETE FROM users WHERE id = ANY($1::text[])", [[owner, member, orgMate]])
      .catch(() => {});
    await closeDb(db);
  });

  it("unions owned boards with member boards in one statement, newest first", async () => {
    expect(ids(await store.listForUser(org, owner))).toEqual([owned, shared, hidden]);
    // Exactly one row per board: an inner join on board_members would have
    // dropped the owned-only boards, an outer join would have duplicated them.
    expect(ids(await store.listForUser(org, member))).toEqual([shared]);
  });

  it("hides a board from an org member with no membership row", async () => {
    expect(await store.listForUser(org, orgMate)).toEqual([]);
    expect(ids(await store.listForOrg(org))).toEqual([owned, shared, hidden]);
  });
});
