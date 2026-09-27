import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresFavoriteStore } from "../src/store/pg-favorites.js";
import { InMemoryFavoriteStore, type FavoriteStore } from "../src/favorites.js";

/** Favorites in Postgres behave like the twin (docs/26 A6). */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("PostgresFavoriteStore", () => {
  let db: Db;
  const user = `usr_fav_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [user, `${user}@example.com`, user, "x"],
    );
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("adds once, lists newest first, removes", async () => {
    for (const [name, store] of [
      ["postgres", new PostgresFavoriteStore(db.db)],
      ["memory", new InMemoryFavoriteStore()],
    ] as Array<[string, FavoriteStore]>) {
      const base = { userId: user, orgId: "org_x" };
      await store.add({ ...base, kind: "board", targetId: `b1_${name}`, createdAt: 1 });
      await store.add({ ...base, kind: "board", targetId: `b1_${name}`, createdAt: 5 });
      await store.add({ ...base, kind: "project", targetId: `p1_${name}`, createdAt: 2 });
      const mine = (await store.list(user)).filter((f) => f.targetId.endsWith(name));
      expect(
        mine.map((f) => [f.kind, f.targetId, f.createdAt]),
        name,
      ).toEqual([
        ["project", `p1_${name}`, 2],
        ["board", `b1_${name}`, 1],
      ]);
      expect(await store.remove(user, "board", `b1_${name}`), name).toBe(true);
      expect(await store.remove(user, "board", `b1_${name}`), name).toBe(false);
      await store.remove(user, "project", `p1_${name}`);
    }
  });
});
