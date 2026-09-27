import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { InMemoryThreadStore, THREAD_KEEP, type NewThreadMessage } from "../src/threads.js";
import { PostgresThreadStore } from "../src/store/pg-threads.js";

/**
 * docs/26 J7 (ADR 0048): the Postgres thread store behaves like its twin —
 * one thread per (person, scope), oldest first, trimmed to THREAD_KEEP,
 * cleared on request. Gated on LUCENT_TEST_DATABASE_URL.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("PostgresThreadStore", () => {
  let db: Db;
  const orgId = `org_thr_${tag}`;
  const alice = `usr_thr_a_${tag}`;
  const bob = `usr_thr_b_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Threads", createdAt: 1 });
    for (const id of [alice, bob]) {
      await db.pool.query(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
        [id, `${id}@example.com`, id, "x"],
      );
    }
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  const msg = (text: string, at: number, role: "user" | "ai" = "user"): NewThreadMessage => ({
    role,
    text,
    reply: null,
    citations: role === "ai" ? [{ kind: "node", id: "n" }] : null,
    surface: "chat",
    at,
  });

  it("round-trips like the twin, per person and scope", async () => {
    const pg = new PostgresThreadStore(db);
    const mem = new InMemoryThreadStore();
    for (const store of [pg, mem]) {
      await store.append(alice, orgId, "board:b1", [msg("q1", 1), msg("a1", 2, "ai")]);
      await store.append(alice, orgId, "board:b1", [msg("q2", 3)]);
      await store.append(bob, orgId, "board:b1", [msg("bob's", 4)]);
    }
    const strip = (list: Array<{ id: string }>) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(await pg.messages(alice, "board:b1"))).toEqual(
      strip(await mem.messages(alice, "board:b1")),
    );
    expect((await pg.messages(alice, "board:b1")).map((m) => m.text)).toEqual(["q1", "a1", "q2"]);
    expect((await pg.messages(bob, "board:b1")).map((m) => m.text)).toEqual(["bob's"]);
    expect(await pg.messages(alice, "board:other")).toEqual([]);
    await pg.clear(alice, "board:b1");
    expect(await pg.messages(alice, "board:b1")).toEqual([]);
    expect(await pg.messages(bob, "board:b1")).toHaveLength(1);
  });

  it("keeps the latest THREAD_KEEP", async () => {
    const pg = new PostgresThreadStore(db);
    for (let i = 0; i < THREAD_KEEP + 15; i += 10) {
      await pg.append(
        alice,
        orgId,
        "board:long",
        Array.from({ length: 10 }, (_, j) => msg(`m${i + j}`, 1000 + i + j)),
      );
    }
    const kept = await pg.messages(alice, "board:long", 500);
    expect(kept).toHaveLength(THREAD_KEEP);
    expect(kept.at(-1)!.text).toBe(`m${THREAD_KEEP + 19}`);
  });
});
