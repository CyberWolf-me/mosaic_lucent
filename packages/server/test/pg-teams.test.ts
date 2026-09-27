import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { InMemoryTeamStore, type TeamStore } from "../src/teams.js";
import { PostgresTeamStore } from "../src/store/pg-teams.js";

/**
 * The Postgres team store against its in-memory twin (docs/26 A6): teams,
 * members, board grants, the strongest role through teams, and the cascades
 * (a deleted team takes its members and grants).
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("PostgresTeamStore", () => {
  let db: Db;
  const orgId = `org_team_${tag}`;
  const ada = `usr_team_a_${tag}`;
  const bo = `usr_team_b_${tag}`;
  const board = `brd_team_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Teams", createdAt: 1 });
    for (const id of [ada, bo]) {
      await db.pool.query(
        "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
        [id, `${id}@example.com`, id, "x"],
      );
    }
    await db.pool.query(
      "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, 'B', '{}'::jsonb, 1, 1)",
      [board, orgId, ada],
    );
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("behaves like the twin", async () => {
    for (const [name, store] of [
      ["postgres", new PostgresTeamStore(db.db)],
      ["memory", new InMemoryTeamStore()],
    ] as Array<[string, TeamStore]>) {
      const id = `team_${name}_${tag}`;
      const other = `team_${name}_x_${tag}`;
      await store.create({ id, orgId, name: "Design", createdAt: 1, externalId: null });
      await store.create({
        id: other,
        orgId,
        name: "Admins",
        createdAt: 2,
        externalId: `ext_${name}`,
      });
      expect(
        (await store.list(orgId)).map((t) => t.name),
        name,
      ).toEqual(["Admins", "Design"]);
      expect((await store.byExternalId(orgId, `ext_${name}`))?.id, name).toBe(other);

      await store.addMember(id, ada);
      await store.addMember(id, ada);
      await store.setMembers(other, [bo, ada]);
      expect((await store.members(id)).sort(), name).toEqual([ada]);

      await store.setGrant({ boardId: board, teamId: id, role: "commenter" });
      await store.setGrant({ boardId: board, teamId: other, role: "editor" });
      await store.setGrant({ boardId: board, teamId: id, role: "viewer" });
      expect(await store.roleOnBoard(board, ada), name).toBe("editor");
      expect(await store.roleOnBoard(board, bo), name).toBe("editor");

      await store.removeUserFromOrg(orgId, ada);
      expect(await store.roleOnBoard(board, ada), name).toBeUndefined();

      expect(await store.rename(orgId, id, "Design team"), name).toBe(true);
      expect(await store.delete(orgId, other), name).toBe(true);
      expect(await store.grants(board), name).toEqual([
        { boardId: board, teamId: id, role: "viewer" },
      ]);
      expect(await store.roleOnBoard(board, bo), name).toBeUndefined();
      await store.delete(orgId, id);
    }
  });
});
