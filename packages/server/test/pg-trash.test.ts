import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { PostgresTrashStore } from "../src/store/pg-trash.js";
import { InMemoryTrashStore, type TrashStore } from "../src/trash.js";
import { emptyWorkspace } from "../src/boards.js";

/**
 * The trash in Postgres (docs/26 A6): a trashed board is gone to every board
 * read until restored, purging deletes it for good; the meeting/project
 * register behaves like its twin.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("the trash in Postgres", () => {
  let db: Db;
  const orgId = `org_trash_${tag}`;
  const owner = `usr_trash_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Trash", createdAt: 1 });
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [owner, `${owner}@example.com`, owner, "x"],
    );
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("hides a trashed board from every read, restores it, purges it", async () => {
    const boards = new PostgresBoardStore(db);
    const put = async (id: string, name: string) =>
      boards.put({
        id,
        orgId,
        ownerId: owner,
        name,
        workspace: emptyWorkspace(name),
        createdAt: 1,
        updatedAt: 1,
      });
    const a = `brd_trash_a_${tag}`;
    const b = `brd_trash_b_${tag}`;
    await put(a, "Keep");
    await put(b, "Bin");
    expect(await boards.trash(b, owner, 1_000)).toBe(true);
    expect(await boards.trash(b, owner, 2_000)).toBe(false);
    expect(await boards.get(b)).toBeUndefined();
    expect((await boards.listForOrg(orgId)).map((x) => x.id)).toEqual([a]);
    expect((await boards.listForUser(orgId, owner)).map((x) => x.id)).toEqual([a]);
    expect(await boards.countForOrg(orgId)).toBe(1);
    expect(await boards.memberRole(b, owner)).toBeUndefined();
    expect((await boards.trashed(orgId)).map((t) => [t.board.id, t.deletedAt])).toEqual([
      [b, 1_000],
    ]);

    expect(await boards.restore(b)).toBe(true);
    expect((await boards.get(b))?.name).toBe("Bin");

    await boards.trash(b, owner, 1_000);
    expect(await boards.purgeTrashed(500, 10)).toEqual([]);
    expect(await boards.purgeTrashed(5_000, 10)).toEqual([b]);
    expect(await boards.trashed(orgId)).toEqual([]);
    expect(await boards.restore(b)).toBe(false);
  });

  it("the meeting/project register behaves like its twin", async () => {
    for (const [name, store] of [
      ["postgres", new PostgresTrashStore(db.db)],
      ["memory", new InMemoryTrashStore()],
    ] as Array<[string, TrashStore]>) {
      const id = `prj_${name}_${tag}`;
      await store.put({
        kind: "project",
        id,
        orgId,
        boardId: null,
        name: "Launch",
        deletedBy: owner,
        deletedAt: 1_000,
      });
      expect((await store.get("project", id))?.name, name).toBe("Launch");
      expect([...(await store.hidden("project", [id, "other"]))], name).toEqual([id]);
      expect((await store.hidden("meeting", [id])).size, name).toBe(0);
      expect(
        (await store.forOrg(orgId)).map((i) => i.id),
        name,
      ).toContain(id);
      expect(
        (await store.expired(2_000, 10)).map((i) => i.id),
        name,
      ).toContain(id);
      expect(await store.remove("project", id), name).toBe(true);
      expect(await store.get("project", id), name).toBeUndefined();
    }
  });
});
