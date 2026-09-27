import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  stampAuthorship,
  statementRows,
  type Operation,
} from "@lucent/core";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { InMemoryProjectStore, type StoredProject } from "../src/projects.js";
import { InMemoryStatementIndexStore } from "../src/statementIndex.js";
import { PostgresProjectStore } from "../src/store/pg-projects.js";
import { PostgresStatementIndexStore } from "../src/store/pg-statement-index.js";

/**
 * docs/26 A1 (ADR 0046): the Postgres project store and statement index
 * behave like their in-memory twins, and both go when their board goes.
 * Gated on LUCENT_TEST_DATABASE_URL like the other pg suites; each run tags
 * its own ids, so no TRUNCATE.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const rows = statementRows(
  applyOperations(
    createWorkspace(),
    stampAuthorship(
      [
        { op: "CREATE_NODE", id: "q", nodeType: "process", label: "Grandfather?" },
        {
          op: "SET_STATEMENT",
          id: "q",
          statement: { kind: "question", status: "open", topic: "pricing" },
        },
        { op: "CREATE_NODE", id: "a", nodeType: "process", label: "Roll out" },
        { op: "SET_STATEMENT", id: "a", statement: { kind: "action", status: "open" } },
        {
          op: "SET_ISSUE",
          id: "a",
          issue: { type: "task", status: "blocked", assignee: "Ada", dueDate: "2026-10-01" },
        },
      ] as Operation[],
      "test-user",
    ),
  ),
);

describeIf("Postgres workspace spine stores", () => {
  let db: Db;
  const orgId = `org_spine_${tag}`;
  const user = `usr_spine_${tag}`;
  const boardA = `brd_spine_a_${tag}`;
  const boardB = `brd_spine_b_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Spine", createdAt: 1 });
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [user, `${user}@example.com`, user, "x"],
    );
    for (const id of [boardA, boardB]) {
      await db.pool.query(
        "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 1) ON CONFLICT (id) DO NOTHING",
        [id, orgId, user, id],
      );
    }
  });

  afterAll(async () => {
    if (db) await closeDb(db);
  });

  it("the statement index round-trips like its twin, and replaces a board's rows whole", async () => {
    const pg = new PostgresStatementIndexStore(db);
    const mem = new InMemoryStatementIndexStore();
    for (const store of [pg, mem]) {
      await store.replaceBoard(boardA, orgId, rows, 10, 11);
    }
    const fromPg = await pg.query([boardA]);
    expect(fromPg).toEqual(await mem.query([boardA]));
    expect(fromPg.map((r) => [r.id, r.blocked])).toEqual([
      ["q", false],
      ["a", true],
    ]);
    expect(await pg.query([boardA], { kinds: ["action"] })).toHaveLength(1);
    expect((await pg.sourcesFor([boardA, boardB])).get(boardA)).toBe(10);

    await pg.replaceBoard(boardA, orgId, rows.slice(0, 1), 20, 21);
    expect((await pg.query([boardA])).map((r) => r.id)).toEqual(["q"]);
    expect((await pg.sourcesFor([boardA])).get(boardA)).toBe(20);

    await pg.clearOrg(orgId);
    expect(await pg.query([boardA])).toEqual([]);
  });

  it("projects round-trip like their twin; links go with their board", async () => {
    const pg = new PostgresProjectStore(db);
    const mem = new InMemoryProjectStore();
    const project: StoredProject = {
      id: `prj_spine_${tag}`,
      orgId,
      name: "Q4",
      objective: "Annual plans",
      status: "active",
      leadId: user,
      members: [user],
      createdBy: user,
      createdAt: 100,
      updatedAt: 100,
      archivedAt: null,
      boardIds: [boardA],
    };
    for (const store of [pg, mem]) {
      await store.create(project);
      expect(await store.linkBoard(project.id, boardB, user, 200)).toBe(true);
      expect(await store.linkBoard(project.id, boardB, user, 201)).toBe(false);
      await store.update(project.id, { status: "paused" }, 300);
    }
    const fromPg = await pg.get(project.id);
    expect(fromPg).toEqual(await mem.get(project.id));
    expect(fromPg?.boardIds).toEqual([boardA, boardB]);
    expect((await pg.forBoard(boardB)).map((p) => p.id)).toEqual([project.id]);
    expect((await pg.listForOrg(orgId)).map((p) => p.id)).toEqual([project.id]);

    await pg.update(project.id, { archived: true }, 400);
    expect(await pg.listForOrg(orgId)).toEqual([]);
    expect(await pg.forBoard(boardB)).toEqual([]);

    await db.pool.query("DELETE FROM boards WHERE id = $1", [boardB]);
    expect((await pg.get(project.id))?.boardIds).toEqual([boardA]);
  });
});
