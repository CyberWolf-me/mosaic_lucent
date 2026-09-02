import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { proposals } from "../db/schema.js";
import {
  PROPOSAL_LIST_LIMIT,
  newProposalId,
  type NewProposal,
  type ProposalDecision,
  type ProposalProvenance,
  type ProposalStatus,
  type ProposalStore,
  type StoredProposal,
} from "../proposals.js";
import type { Operation } from "@lucent/core";

/**
 * Postgres-backed proposal store (Stage B3). Parity with
 * `InMemoryProposalStore` is pinned by the gated suite in pg-store.test.ts.
 *
 * `create` runs the supersede-and-insert as ONE statement: the UPDATE that
 * retires any pending predecessor and the INSERT of the new row share a
 * data-modifying CTE, so two browsers racing to extract into the same board
 * cannot both keep a pending record (the partial unique index would refuse
 * the second INSERT, but the CTE means the loser never reaches a state where
 * it holds a retired-and-replaced pair half-written).
 */
export class PostgresProposalStore implements ProposalStore {
  constructor(private readonly target: Db) {}

  async create(
    input: NewProposal,
  ): Promise<{ proposal: StoredProposal; supersededId: string | null }> {
    const id = newProposalId();
    const result = await this.target.db.execute(sql`
      with retired as (
        update ${proposals}
           set "status" = 'superseded', "decided_at" = ${input.createdAt}::bigint
         where "board_id" = ${input.boardId} and "status" = 'pending'
         returning "id"
      ), ins as (
        insert into ${proposals}
          ("id", "org_id", "board_id", "meeting_id", "status", "operations",
           "request", "explanation", "provenance", "created_by", "created_at")
        select ${id}, ${input.orgId}, ${input.boardId}, ${input.meetingId ?? null}::text,
               'pending', ${JSON.stringify(input.operations)}::jsonb,
               ${input.request}, ${input.explanation ?? null}::text,
               ${input.provenance ? JSON.stringify(input.provenance) : null}::jsonb,
               ${input.createdBy}, ${input.createdAt}::bigint
         where not exists (select 1 from retired)
         returning "id"
      )
      select (select id from ins) as inserted,
             (select id from retired) as retired
    `);
    const row = result.rows[0] as { inserted: string | null; retired: string | null } | undefined;
    const retiredId = row?.retired ?? null;
    const insertedId = row?.inserted ?? null;
    if (insertedId === null || insertedId === undefined) {
      // Another pending row survived the race (its create won between our
      // UPDATE and INSERT). Refuse rather than crash the caller: the client
      // re-reads the board's pending proposal and shows THAT one — the
      // invariant (one pending per board) held, just not in our favour.
      throw new Error("a pending proposal already exists on this board");
    }
    const created = await this.get(input.boardId, insertedId);
    if (!created) throw new Error("proposal insert reported success but read back empty");
    return { proposal: created, supersededId: retiredId };
  }

  async forBoard(boardId: string, limit = PROPOSAL_LIST_LIMIT): Promise<StoredProposal[]> {
    const rows = await this.target.db
      .select()
      .from(proposals)
      .where(eq(proposals.boardId, boardId))
      .orderBy(desc(proposals.createdAt), asc(proposals.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async get(boardId: string, id: string): Promise<StoredProposal | undefined> {
    const rows = await this.target.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.boardId, boardId), eq(proposals.id, id)))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * The transition guard lives in the WHERE: `status = 'pending'`. A second
   * decision (the other browser's approve arriving after ours) updates zero
   * rows and the route answers with the record as it now stands — a read, not
   * a second commit. `applied_seq` is written in the same statement so an
   * approval and its log link can never disagree.
   */
  async decide(
    boardId: string,
    id: string,
    decision: ProposalDecision,
  ): Promise<StoredProposal | undefined> {
    const rows = await this.target.db
      .update(proposals)
      .set({
        status: decision.status,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        ...(decision.appliedSeq !== undefined && decision.status === "approved"
          ? { appliedSeq: decision.appliedSeq }
          : {}),
      })
      .where(
        and(eq(proposals.boardId, boardId), eq(proposals.id, id), eq(proposals.status, "pending")),
      )
      .returning();
    if (rows[0]) return toRow(rows[0]);
    // Either already decided (return the current state — the idempotent
    // answer) or nonexistent (undefined — the route's 404).
    return this.get(boardId, id);
  }
}

function toRow(row: typeof proposals.$inferSelect): StoredProposal {
  return {
    id: row.id,
    orgId: row.orgId,
    boardId: row.boardId,
    meetingId: row.meetingId,
    status: row.status as ProposalStatus,
    operations: row.operations as Operation[],
    request: row.request,
    explanation: row.explanation,
    provenance: (row.provenance as ProposalProvenance | null) ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    appliedSeq: row.appliedSeq,
  };
}
