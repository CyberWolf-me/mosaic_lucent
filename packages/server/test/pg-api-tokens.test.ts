import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresApiTokenStore } from "../src/store/pg-api-tokens.js";
import {
  InMemoryApiTokenStore,
  mintApiToken,
  type ApiTokenStore,
  type StoredApiToken,
} from "../src/apiTokens.js";

/** API tokens in Postgres behave like the twin (docs/26 A6). */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("PostgresApiTokenStore", () => {
  let db: Db;
  const user = `usr_tok_${tag}`;
  const org = `org_tok_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [user, `${user}@example.com`, user, "x"],
    );
    await db.pool.query(
      "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, 1) ON CONFLICT (id) DO NOTHING",
      [org, "Tokens Inc"],
    );
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("finds by hash, lists live tokens newest first, revokes once, touches", async () => {
    for (const [name, store] of [
      ["postgres", new PostgresApiTokenStore(db.db)],
      ["memory", new InMemoryApiTokenStore()],
    ] as Array<[string, ApiTokenStore]>) {
      const make = (id: string, createdAt: number): StoredApiToken & { raw: string } => {
        const minted = mintApiToken();
        return {
          raw: minted.token,
          id: `${id}_${name}_${tag}`,
          userId: user,
          orgId: org,
          name: id,
          tokenHash: minted.tokenHash,
          prefix: minted.prefix,
          scopes: ["read", "write"],
          createdAt,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        };
      };
      const a = make("a", 1);
      const b = make("b", 2);
      for (const t of [a, b]) {
        const { raw: _raw, ...stored } = t;
        await store.create(stored);
      }
      const found = await store.findByHash(b.tokenHash);
      expect(found, name).toMatchObject({ id: b.id, scopes: ["read", "write"], orgId: org });
      const mine = (await store.listForUser(user)).filter((t) => t.id.endsWith(`${name}_${tag}`));
      expect(
        mine.map((t) => t.name),
        name,
      ).toEqual(["b", "a"]);

      await store.touch(a.id, 50);
      expect((await store.get(a.id))?.lastUsedAt, name).toBe(50);
      expect(await store.revoke(a.id, 60), name).toBe(true);
      expect(await store.revoke(a.id, 61), name).toBe(false);
      expect((await store.get(a.id))?.revokedAt, name).toBe(60);
      const left = (await store.listForOrg(org)).filter((t) => t.id.endsWith(`${name}_${tag}`));
      expect(
        left.map((t) => t.name),
        name,
      ).toEqual(["b"]);
      await store.revoke(b.id, 70);
    }
  });
});
