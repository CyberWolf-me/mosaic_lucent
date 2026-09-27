import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  stampAuthorship,
  stampTrust,
  statementRows,
  type Operation,
} from "@lucent/core";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { InMemoryAiRunStore, type NewAiRun } from "../src/aiRuns.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { PostgresAiRunStore } from "../src/store/pg-ai-runs.js";
import { PostgresProposalStore } from "../src/store/pg-proposals.js";
import { PostgresStatementIndexStore } from "../src/store/pg-statement-index.js";

/**
 * docs/26 A2 (ADR 0047): the Postgres run store, the pending-proposal query
 * and the index's trust column behave like their in-memory twins. Gated on
 * LUCENT_TEST_DATABASE_URL like the other pg suites.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describeIf("Postgres trust stores", () => {
  let db: Db;
  const orgId = `org_trust_${tag}`;
  const user = `usr_trust_${tag}`;
  const boardA = `brd_trust_a_${tag}`;
  const boardB = `brd_trust_b_${tag}`;

  beforeAll(async () => {
    if (!URL) return;
    db = createDb(URL);
    await migrate(db);
    await new PostgresOrgStore(db).insert({ id: orgId, name: "Trust", createdAt: 1 });
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

  it("AI runs record, link and list like the twin", async () => {
    const run: NewAiRun = {
      orgId,
      boardId: boardA,
      initiatedBy: user,
      surface: "canvas",
      provider: "mock",
      model: "m-1",
      contextScope: "board",
      tools: ["apply_canvas_operations"],
      outputHash: "abc",
      opCount: 3,
      createdAt: 100,
    };
    const pg = new PostgresAiRunStore(db);
    const mem = new InMemoryAiRunStore();
    const [a, b] = [await pg.record(run), await mem.record(run)];
    for (const [store, r] of [
      [pg, a],
      [mem, b],
    ] as const) {
      await store.linkProposal(r.id, "prp_1");
      await store.linkCommit(r.id, 7, user, 200);
      await store.linkCommit(r.id, 7, user, 201); // the same seq twice is once
      await store.linkCommit(r.id, 9, null, 202); // a later commit keeps the approver
    }
    const fromPg = await pg.get(a.id);
    const fromMem = await mem.get(b.id);
    expect({ ...fromPg, id: "x" }).toEqual({ ...fromMem, id: "x" });
    expect(fromPg).toMatchObject({ opSeqs: [7, 9], approvedBy: user, proposalId: "prp_1" });
    expect((await pg.forOrg(orgId, { boardIds: [boardA] })).map((r) => r.id)).toContain(a.id);
    expect(await pg.forOrg(orgId, { boardIds: [boardB] })).toEqual([]);
    expect(await pg.forOrg(orgId, { surface: "mcp" })).toEqual([]);
  });

  it("pending proposals across boards, with their run", async () => {
    const pg = new PostgresProposalStore(db);
    const mem = new InMemoryProposalStore();
    for (const store of [pg, mem]) {
      await store.create({
        boardId: boardA,
        orgId,
        operations: [
          { op: "CREATE_NODE", id: "n", nodeType: "process", label: "n" },
        ] as Operation[],
        request: "r",
        createdBy: user,
        createdAt: 10,
        runId: "run_x",
      });
    }
    const [p] = await pg.pendingForBoards([boardA, boardB]);
    const [m] = await mem.pendingForBoards([boardA, boardB]);
    expect(p).toMatchObject({ boardId: boardA, status: "pending", runId: "run_x" });
    expect({ ...p, id: "x" }).toEqual({ ...m, id: "x" });
    expect(await pg.pendingForBoards([boardB])).toEqual([]);
  });

  it("the index keeps each statement's trust", async () => {
    const ws = applyOperations(
      createWorkspace(),
      stampTrust(
        stampAuthorship(
          [
            {
              op: "CREATE_NODE",
              id: "q",
              nodeType: "process",
              label: "q",
              provenance: { meetingId: "mtg_1" },
            },
            { op: "SET_STATEMENT", id: "q", statement: { kind: "question", status: "open" } },
          ] as Operation[],
          user,
        ),
        "requested",
      ),
    );
    const store = new PostgresStatementIndexStore(db);
    await store.replaceBoard(boardB, orgId, statementRows(ws), 5, 6);
    expect((await store.query([boardB]))[0]).toMatchObject({ id: "q", trust: "ai-suggested" });
  });
});
