import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, type Operation, type Workspace } from "@lucent/core";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresUserStore } from "../src/store/pg-users.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { PostgresProposalStore } from "../src/store/pg-proposals.js";
import { PostgresAssetStore } from "../src/store/pg-assets.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import type { StoredBoard } from "../src/boards.js";
import type { Role, StoredUser } from "../src/identity.js";

/**
 * Integration tests for the Postgres-backed user/board stores (docs/06). These
 * only run when LUCENT_TEST_DATABASE_URL is set; otherwise the suite is a
 * no-op. CI sets the URL via a `postgres:16` service and runs `db:migrate`
 * before `npm test`.
 *
 * Every id written here carries a per-run `tag`, so the file needs no
 * TRUNCATE and one shared database can host the whole suite without ordering.
 * It used to wipe the shared tables in `beforeAll`, which raced its sibling pg
 * suites — audit-store, boardListing and usageStore each say in their headers
 * that they avoid TRUNCATE for exactly this reason. That race made the two
 * op-log tests below fail intermittently once every file runs in parallel
 * against one database: a sibling's wipe deleted this file's board mid-test.
 *
 * This file had drifted and was green locally only because the URL is usually
 * unset: it called `listByOwner`, `addOrg` and `addMembership` — none of which
 * exist on the stores any more — and it stored boards with no `orgId` and users
 * with no `tokenVersion`. In CI, where the URL *is* set, that made the whole
 * `@lucent/server` job red and masked every other server failure. The
 * assertions now track current semantics rather than merely compiling: listing
 * is tenant-scoped *and* membership-scoped, and `memberRole` combines the org
 * grant with the board row.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;

/** Unique per run: why no suite in this file has to wipe a shared table. */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A complete StoredUser — `tokenVersion`/`emailVerifiedAt` are not optional. */
function storedUser(id: string, email: string): StoredUser {
  return {
    id,
    email,
    name: id,
    createdAt: 1,
    passwordHash: "salt:hash",
    tokenVersion: 0,
    emailVerifiedAt: null,
  };
}

describeIf("PostgresUserStore", () => {
  let db: Db;
  let store: PostgresUserStore;

  const USER = `usr_pgu_${tag}`;
  const DUP_A = `usr_pgu_dupa_${tag}`;
  const DUP_B = `usr_pgu_dupb_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    store = new PostgresUserStore(db);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("round-trips a user with case-insensitive email lookup", async () => {
    const email = `Mixed@Case.${tag}.com`;
    const user = storedUser(USER, email);
    await store.insert(user);
    const a = await store.findByEmail(email.toLowerCase());
    const b = await store.findByEmail(email.toUpperCase());
    expect(a?.id).toBe(user.id);
    expect(b?.id).toBe(user.id);
    expect((await store.findById(user.id))?.email).toBe(user.email);
  });

  it("refuses a duplicate email via the lower() unique index", async () => {
    await store.insert(storedUser(DUP_A, `dup_${tag}@example.com`));
    // Same address, different case: the lower(email) unique index must refuse it.
    await expect(store.insert(storedUser(DUP_B, `DUP_${tag}@EXAMPLE.com`))).rejects.toThrow();
  });

  it("round-trips the personal org and its membership", async () => {
    // Org creation goes through `ensurePersonalOrg` now — `addOrg` and
    // `addMembership`, which this test used to call, no longer exist. It is
    // idempotent by design so signup, OAuth-link and login all converge on one
    // personal org per user.
    const org = await store.ensurePersonalOrg(USER, "M", 1);
    const again = await store.ensurePersonalOrg(USER, "M", 2);
    expect(again.id).toBe(org.id);
    const mems = await store.membershipsFor(USER);
    expect(mems).toHaveLength(1);
    expect(mems[0]?.orgId).toBe(org.id);
    expect(mems[0]?.role).toBe("owner");
  });

  /**
   * Does the org row still exist? `PostgresUserStore` has no org getter (that
   * lives on the OrgStore), and the distinction this asserts is precisely
   * "memberless" vs "gone", so it goes straight to the table.
   */
  async function orgExists(orgId: string): Promise<boolean> {
    const { rows } = await db.pool.query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
    return rows.length > 0;
  }

  it("deletes the personal org and its boards when its last member is deleted", async () => {
    // The defect this pins: `deleteUser` used to drop the membership row and the
    // user, leaving the personal org behind with no members - unreachable,
    // unbillable, and holding its id forever. `InMemoryUserStore.deleteUser`
    // removes every org left memberless, so Postgres must too.
    const userId = `usr_pgdel_${tag}`;
    const boardId = `brd_pgdel_${tag}`;
    await store.insert(storedUser(userId, `del_${tag}@pg.test`));
    const org = await store.ensurePersonalOrg(userId, "Del", 1);
    const boards = new PostgresBoardStore(db);
    await boards.put({
      id: boardId,
      orgId: org.id,
      ownerId: userId,
      name: "Doomed",
      workspace: { ...createWorkspace(), name: "Doomed" },
      createdAt: 1,
      updatedAt: 2,
    });

    await store.deleteUser(userId);

    expect(await store.findById(userId)).toBeUndefined();
    expect(await store.countMembers(org.id)).toBe(0);
    // The org row itself, not merely its memberships.
    expect(await orgExists(org.id)).toBe(false);
    // Nothing of the org is left behind either. Honest about this one: the board
    // is reachable through both cascades (boards.org_id from the org row,
    // boards.owner_id from the user), so the org-row assertion above is the one
    // that distinguishes fixed from broken.
    expect(await boards.get(boardId)).toBeUndefined();
  });

  it("keeps an org that still has members, and removes it with the last one", async () => {
    // The other half of the rule: a shared tenant must survive losing one of
    // its members, and must not survive losing all of them.
    const solo = `usr_pgshare_a_${tag}`;
    const mate = `usr_pgshare_b_${tag}`;
    await store.insert(storedUser(solo, `share_a_${tag}@pg.test`));
    await store.insert(storedUser(mate, `share_b_${tag}@pg.test`));
    const org = await store.ensurePersonalOrg(solo, "Shared", 1);
    await store.setMembership({ userId: mate, orgId: org.id, role: "editor" });

    await store.deleteUser(solo);
    expect(await orgExists(org.id)).toBe(true);
    expect(await store.countMembers(org.id)).toBe(1);
    expect((await store.membershipsFor(mate)).map((m) => m.orgId)).toContain(org.id);

    await store.deleteUser(mate);
    expect(await orgExists(org.id)).toBe(false);
  });

  it("deletes a user who is in no org at all", async () => {
    // The empty-candidate branch: no memberships to read, nothing to sweep, and
    // the user row must still go rather than the sweep short-circuiting first.
    const loner = `usr_pgloner_${tag}`;
    await store.insert(storedUser(loner, `loner_${tag}@pg.test`));
    await store.deleteUser(loner);
    expect(await store.findById(loner)).toBeUndefined();
    // A user who was never there is a no-op, not a throw: `runScheduledDeletions`
    // can be handed a matured row whose user a previous pass already wiped.
    await expect(store.deleteUser(`usr_pgnever_${tag}`)).resolves.toBeUndefined();
  });
});

describeIf("PostgresBoardStore", () => {
  let db: Db;
  let store: PostgresBoardStore;
  let users: PostgresUserStore;
  let orgId: string;

  const OWNER = `usr_pg_owner_${tag}`;
  const MEMBER = `usr_pg_member_${tag}`;
  /** In the org, on none of its boards — the user a tenant-wide list leaks to. */
  const ORG_MATE = `usr_pg_orgmate_${tag}`;
  /** Deliberately never created: a tenant this fixture holds no row in. */
  const OTHER_ORG = `org_pg_other_${tag}`;
  const BOARD = `brd_pg_${tag}`;
  const BOARD_EFF = `brd_pg_eff_${tag}`;
  const BOARD_LOG = `brd_pg_log_${tag}`;
  const BOARD_DEL = `brd_pg_del_${tag}`;
  /** Never stored: `memberRole` must answer undefined, not throw. */
  const BOARD_MISSING = `brd_pg_missing_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    store = new PostgresBoardStore(db);
    users = new PostgresUserStore(db);
    // `boards.owner_id` and `boards.org_id` are NOT NULL foreign keys, so the
    // rows they point at must exist before a board can be stored: the fixture
    // is three real users and a real org, not bare ids. The old fixture had no
    // orgId at all, which no longer satisfies the schema.
    await users.insert(storedUser(OWNER, `owner_${tag}@pg.test`));
    await users.insert(storedUser(MEMBER, `member_${tag}@pg.test`));
    await users.insert(storedUser(ORG_MATE, `orgmate_${tag}@pg.test`));
    orgId = (await users.ensurePersonalOrg(OWNER, "Owner", 1)).id;
    await users.setMembership({ userId: ORG_MATE, orgId, role: "editor" });
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  function emptyBoard(): Workspace {
    return { ...createWorkspace(), name: "B" };
  }

  function board(id: string, over: Partial<StoredBoard> = {}): StoredBoard {
    return {
      id,
      orgId,
      ownerId: OWNER,
      name: "N",
      workspace: emptyBoard(),
      createdAt: 1,
      updatedAt: 2,
      ...over,
    };
  }

  it("round-trips a board and lists it only for the users who can reach it", async () => {
    await store.put(board(BOARD));
    const got = await store.get(BOARD);
    expect(got?.name).toBe("N");
    expect(got?.orgId).toBe(orgId);
    expect(got?.workspace.name).toBe("B");

    await store.setMember({
      boardId: BOARD,
      userId: MEMBER,
      role: "editor",
      invitedBy: OWNER,
      createdAt: 2,
    });

    // `listForUser` replaced `listByOwner`: owned boards *plus* boards with an
    // explicit membership row, scoped to a single org.
    expect((await store.listForUser(orgId, OWNER)).map((b) => b.id)).toContain(BOARD);
    expect((await store.listForUser(orgId, MEMBER)).map((b) => b.id)).toContain(BOARD);
    // Being in the org is not being on the board.
    expect((await store.listForUser(orgId, ORG_MATE)).map((b) => b.id)).not.toContain(BOARD);
    // The tenant-wide query does return it — that difference is exactly what the
    // route's `?scope=org|shared` switch selects between.
    expect((await store.listForOrg(orgId)).map((b) => b.id)).toContain(BOARD);
    // Neither query crosses the tenant boundary, whatever the caller is at home.
    expect(await store.listForUser(OTHER_ORG, OWNER)).toHaveLength(0);
    expect(await store.listForOrg(OTHER_ORG)).toHaveLength(0);
  });

  it("resolves the effective role from the org grant and the board row", async () => {
    // Store-level counterpart of the route fix (M2.2). Owned by MEMBER, so the
    // org owner holds no board_members row on it.
    await store.put(board(BOARD_EFF, { ownerId: MEMBER }));
    const asOwner = async (): Promise<Role | undefined> => "owner";
    const asEditor = async (): Promise<Role | undefined> => "editor";

    // Without the resolver — the call every route used to make — the org grant
    // is invisible and an org owner is refused a board in their own org.
    expect(await store.memberRole(BOARD_EFF, OWNER)).toBeUndefined();
    expect(await store.memberRole(BOARD_EFF, OWNER, asOwner)).toBe("owner");
    // max(org, board): a viewer row does not demote an org editor.
    await store.setMember({
      boardId: BOARD_EFF,
      userId: ORG_MATE,
      role: "viewer",
      invitedBy: null,
      createdAt: 3,
    });
    expect(await store.memberRole(BOARD_EFF, ORG_MATE, asEditor)).toBe("editor");
    expect(await store.memberRole(BOARD_EFF, ORG_MATE)).toBe("viewer");
    // A board that does not exist resolves to undefined rather than throwing.
    expect(await store.memberRole(BOARD_MISSING, OWNER, asOwner)).toBeUndefined();
  });

  it("appends and reloads the op log in seq order", async () => {
    await store.put(board(BOARD_LOG, { name: "log", createdAt: 0, updatedAt: 0 }));
    const op1: Operation = { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" };
    const op2: Operation = { op: "CHANGE_TEXT", id: "a", text: "A2" };
    await store.appendOp({ boardId: BOARD_LOG, ops: [op1], by: "u", label: "x", at: 1 });
    await store.appendOp({ boardId: BOARD_LOG, ops: [op2], by: "u", label: "y", at: 2 });
    const log = await store.loadLog(BOARD_LOG);
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect((log[1]?.ops[0] as { text?: string }).text).toBe("A2");
  });

  it("delete cascades to op_log entries", async () => {
    await store.put(board(BOARD_DEL, { name: "c", createdAt: 0, updatedAt: 0 }));
    await store.appendOp({ boardId: BOARD_DEL, ops: [], by: "u", label: "x", at: 1 });
    await store.delete(BOARD_DEL);
    expect(await store.get(BOARD_DEL)).toBeUndefined();
    expect(await store.loadLog(BOARD_DEL)).toHaveLength(0);
  });
});

// --- Stage B: proposals + the idempotency index (Postgres parity) ---------

describeIf("PostgresProposalStore", () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ORG = `org_pg_${tag}`;
  const BOARD = `brd_pg_${tag}`;
  const BOARD2 = `brd_pg2_${tag}`;
  const USER = `usr_pg_${tag}`;

  let store: PostgresProposalStore;
  let boards: PostgresBoardStore;
  let orgs: PostgresOrgStore;
  let users: PostgresUserStore;

  beforeAll(async () => {
    const target = createDb(URL!);
    store = new PostgresProposalStore(target);
    boards = new PostgresBoardStore(target);
    orgs = new PostgresOrgStore(target);
    users = new PostgresUserStore(target);
    await orgs.insert({ id: ORG, name: "P", createdAt: Date.now() });
    await users.insert({
      id: USER,
      email: `pg_${tag}@e.com`,
      name: "PG",
      passwordHash: "x:y",
      tokenVersion: 0,
      createdAt: Date.now(),
      emailVerifiedAt: null,
    });
    const { emptyWorkspace } = await import("../src/boards.js");
    await boards.put({
      id: BOARD,
      orgId: ORG,
      ownerId: USER,
      name: "A",
      workspace: emptyWorkspace("A"),
      createdAt: 0,
      updatedAt: 0,
    });
    await boards.put({
      id: BOARD2,
      orgId: ORG,
      ownerId: USER,
      name: "B",
      workspace: emptyWorkspace("B"),
      createdAt: 0,
      updatedAt: 0,
    });
  });

  it("create supersedes the pending predecessor; one pending per board", async () => {
    const ops = [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "N" }];
    const first = await store.create({
      boardId: BOARD,
      orgId: ORG,
      operations: ops as never,
      request: "one",
      createdBy: USER,
      createdAt: 1,
    });
    expect(first.proposal.status).toBe("pending");
    expect(first.supersededId).toBeNull();
    const second = await store.create({
      boardId: BOARD,
      orgId: ORG,
      operations: ops as never,
      request: "two",
      createdBy: USER,
      createdAt: 2,
    });
    expect(second.supersededId).toBe(first.proposal.id);
    const list = await store.forBoard(BOARD);
    expect(list.filter((p) => p.status === "pending")).toHaveLength(1);
    expect(list.find((p) => p.id === first.proposal.id)?.status).toBe("superseded");
  });

  it("decide is transition-guarded: a second decision changes nothing", async () => {
    const { proposal } = await store.create({
      boardId: BOARD2,
      orgId: ORG,
      operations: [{ op: "CREATE_NODE", id: "z", nodeType: "step", label: "Z" }] as never,
      request: "r",
      createdBy: USER,
      createdAt: 3,
    });
    const first = await store.decide(BOARD2, proposal.id, {
      status: "approved",
      decidedBy: USER,
      decidedAt: 4,
      appliedSeq: 9,
    });
    expect(first?.status).toBe("approved");
    expect(first?.appliedSeq).toBe(9);
    const again = await store.decide(BOARD2, proposal.id, {
      status: "rejected",
      decidedBy: USER,
      decidedAt: 5,
    });
    // The second decision is a read: the record still says approved.
    expect(again?.status).toBe("approved");
    expect(again?.appliedSeq).toBe(9);
  });
});

describeIf("PostgresBoardStore idempotency (Stage B)", () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ORG = `org_bi_${tag}`;
  const BOARD = `brd_bi_${tag}`;
  const USER = `usr_bi_${tag}`;

  let boards: PostgresBoardStore;
  let orgs: PostgresOrgStore;
  let users: PostgresUserStore;

  beforeAll(async () => {
    const target = createDb(URL!);
    boards = new PostgresBoardStore(target);
    orgs = new PostgresOrgStore(target);
    users = new PostgresUserStore(target);
    await orgs.insert({ id: ORG, name: "B", createdAt: Date.now() });
    await users.insert({
      id: USER,
      email: `bi_${tag}@e.com`,
      name: "BI",
      passwordHash: "x:y",
      tokenVersion: 0,
      createdAt: Date.now(),
      emailVerifiedAt: null,
    });
    const { emptyWorkspace } = await import("../src/boards.js");
    await boards.put({
      id: BOARD,
      orgId: ORG,
      ownerId: USER,
      name: "I",
      workspace: emptyWorkspace("I"),
      createdAt: 0,
      updatedAt: 0,
    });
  });

  it("a replayed requestId answers the original seq via findRequest + appendOp", async () => {
    const ops = [{ op: "CREATE_NODE", id: "q1", nodeType: "step", label: "Q" }];
    const base = {
      boardId: BOARD,
      ops: ops as never,
      by: USER,
      label: "t",
      at: 1,
      requestId: `req_${tag}`,
    };
    const first = await boards.appendOp(base);
    expect(first.ok).toBe(true);
    // The replay through findRequest: the pre-validation guard the REST route runs.
    const prior = await boards.findRequest(BOARD, `req_${tag}`);
    expect(prior?.seq).toBe(first.ok ? first.seq : undefined);
    // And the allocator-level duplicate answer for the two-instance race.
    const replay = await boards.appendOp({ ...base, at: 2 });
    expect(replay).toMatchObject({ ok: true, duplicate: true, seq: prior?.seq });
    const log = await boards.loadLog(BOARD);
    expect(log.filter((e) => e.requestId === `req_${tag}`)).toHaveLength(1);
  });

  it("the actor columns round-trip through the log", async () => {
    const ops = [{ op: "CREATE_NODE", id: "q2", nodeType: "step", label: "Q2" }];
    await boards.appendOp({
      boardId: BOARD,
      ops: ops as never,
      by: USER,
      label: "t",
      at: 3,
      requestId: `req_actor_${tag}`,
      actor: { actorType: "ai", actorId: "lucent", initiatedBy: USER, approvedBy: USER },
    });
    const log = await boards.loadLog(BOARD);
    const entry = log.find((e) => e.requestId === `req_actor_${tag}`);
    expect(entry?.actor).toEqual({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: USER,
      approvedBy: USER,
    });
  });
});

// --- Stage B6: asset metadata, Postgres parity --------------------------------

describeIf("PostgresAssetStore", () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ORG = `org_as_${tag}`;
  const BOARD = `brd_as_${tag}`;
  const BOARD_B = `brd_asb_${tag}`;
  const USER = `usr_as_${tag}`;

  let store: PostgresAssetStore;
  let boards: PostgresBoardStore;
  let orgs: PostgresOrgStore;
  let users: PostgresUserStore;

  const asset = (id: string, checksum: string, bytes: number) => ({
    id,
    orgId: ORG,
    boardId: BOARD,
    mime: "image/png",
    bytes,
    checksum,
    storageKey: `asset/${checksum}`,
    thumbKey: null,
    width: 100,
    height: 80,
    createdBy: USER,
    createdAt: Date.now(),
  });

  beforeAll(async () => {
    const target = createDb(URL!);
    store = new PostgresAssetStore(target);
    boards = new PostgresBoardStore(target);
    orgs = new PostgresOrgStore(target);
    users = new PostgresUserStore(target);
    await orgs.insert({ id: ORG, name: "Assets", createdAt: Date.now() });
    await users.insert({
      id: USER,
      email: `as_${tag}@e.com`,
      name: "AS",
      passwordHash: "x:y",
      tokenVersion: 0,
      createdAt: Date.now(),
      emailVerifiedAt: null,
    });
    const { emptyWorkspace } = await import("../src/boards.js");
    await boards.put({
      id: BOARD,
      orgId: ORG,
      ownerId: USER,
      name: "Assets",
      workspace: emptyWorkspace("A"),
      createdAt: 0,
      updatedAt: 0,
    });
  });

  it("create + get round-trip the full row", async () => {
    const created = await store.create(asset(`ast_${tag}_1`, `chk_${tag}_1`, 1234));
    expect(created.id).toBe(`ast_${tag}_1`);
    const got = await store.get(`ast_${tag}_1`);
    expect(got?.bytes).toBe(1234);
    expect(got?.width).toBe(100);
    expect(got?.boardId).toBe(BOARD);
  });

  it("a checksum collision returns the existing row (dedupe)", async () => {
    const first = await store.create(asset(`ast_${tag}_2a`, `chk_${tag}_2`, 500));
    const dup = await store.create(asset(`ast_${tag}_2b`, `chk_${tag}_2`, 500));
    expect(dup.id).toBe(first.id);
    // One row, one billable object.
    const list = await store.listForOrg(ORG, 50);
    expect(list.filter((a) => a.checksum === `chk_${tag}_2`)).toHaveLength(1);
  });

  it("byChecksum finds the org-scoped row; totalBytes sums; delete falls through", async () => {
    const found = await store.byChecksum(ORG, `chk_${tag}_1`);
    expect(found?.id).toBe(`ast_${tag}_1`);
    const bytes = await store.totalBytes(ORG);
    expect(bytes).toBeGreaterThanOrEqual(1234);
    const removed = await store.delete(`ast_${tag}_1`);
    expect(removed?.id).toBe(`ast_${tag}_1`);
    expect(await store.get(`ast_${tag}_1`)).toBeUndefined();
  });

  it("listForBoard scopes to the board, oldest first", async () => {
    // A second board with its own asset, so the scoping half of the contract
    // is actually exercised: the earlier form only ever created assets on
    // BOARD, so "scopes to the board" was asserted against nothing.
    const { emptyWorkspace } = await import("../src/boards.js");
    await boards.put({
      id: BOARD_B,
      orgId: ORG,
      ownerId: USER,
      name: "Assets B",
      workspace: emptyWorkspace("AB"),
      createdAt: 0,
      updatedAt: 0,
    });
    await store.create({ ...asset(`ast_${tag}_b`, `chk_${tag}_b`, 10), boardId: BOARD_B });
    await store.create({ ...asset(`ast_${tag}_3`, `chk_${tag}_3`, 10), createdAt: 200 });
    await store.create({ ...asset(`ast_${tag}_4`, `chk_${tag}_4`, 10), createdAt: 100 });
    const list = await store.listForBoard(BOARD);
    const ids = list.map((a) => a.id);
    // Scoping: the sibling board's asset is absent.
    expect(ids).not.toContain(`ast_${tag}_b`);
    // Oldest first: _4 (createdAt 100, inserted second, deliberately out of
    // order) sorts before _3 (createdAt 200) — createdAt is the contract,
    // not insertion order. The dedupe test's survivor (_2a, createdAt ~now)
    // stays on the same board and sorts last; assert only the relative
    // order of the two this test controls so the suites stay independent.
    expect(ids).toContain(`ast_${tag}_3`);
    expect(ids).toContain(`ast_${tag}_4`);
    expect(ids.indexOf(`ast_${tag}_4`)).toBeLessThan(ids.indexOf(`ast_${tag}_3`));
  });
});
