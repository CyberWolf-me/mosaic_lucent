import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { aiRuns, type DbAiRun } from "../db/schema.js";
import {
  AI_RUN_LIST_LIMIT,
  newRunId,
  type AiRun,
  type AiRunStore,
  type AiSurface,
  type NewAiRun,
} from "../aiRuns.js";

/**
 * Postgres-backed AI run records (docs/26 J6, ADR 0047). `op_seqs` grows by
 * an atomic JSONB append, so two commits from one run (a partial apply, then
 * a retry) can't overwrite each other's seq.
 */
export class PostgresAiRunStore implements AiRunStore {
  constructor(private readonly target: Db) {}

  private static toRun(r: DbAiRun): AiRun {
    return {
      id: r.id,
      orgId: r.orgId,
      boardId: r.boardId,
      initiatedBy: r.initiatedBy,
      surface: r.surface as AiSurface,
      provider: r.provider,
      model: r.model,
      contextScope: r.contextScope,
      tools: Array.isArray(r.tools) ? (r.tools as string[]) : [],
      outputHash: r.outputHash,
      opCount: r.opCount,
      proposalId: r.proposalId,
      opSeqs: Array.isArray(r.opSeqs) ? (r.opSeqs as number[]) : [],
      approvedBy: r.approvedBy,
      createdAt: r.createdAt,
      decidedAt: r.decidedAt,
    };
  }

  async record(run: NewAiRun): Promise<AiRun> {
    const stored: AiRun = {
      proposalId: null,
      opSeqs: [],
      approvedBy: null,
      decidedAt: null,
      ...run,
      id: newRunId(),
    };
    await this.target.db.insert(aiRuns).values({ ...stored });
    return stored;
  }

  async get(id: string) {
    const rows = await this.target.db.select().from(aiRuns).where(eq(aiRuns.id, id)).limit(1);
    return rows[0] ? PostgresAiRunStore.toRun(rows[0]) : undefined;
  }

  async linkCommit(id: string, seq: number, approvedBy: string | null, at: number) {
    await this.target.db
      .update(aiRuns)
      .set({
        opSeqs: sql`CASE WHEN ${aiRuns.opSeqs} @> ${JSON.stringify([seq])}::jsonb
                    THEN ${aiRuns.opSeqs}
                    ELSE ${aiRuns.opSeqs} || ${JSON.stringify([seq])}::jsonb END`,
        ...(approvedBy ? { approvedBy } : {}),
        decidedAt: at,
      })
      .where(eq(aiRuns.id, id));
  }

  async linkProposal(id: string, proposalId: string) {
    await this.target.db.update(aiRuns).set({ proposalId }).where(eq(aiRuns.id, id));
  }

  async forOrg(
    orgId: string,
    options: { boardIds?: readonly string[]; surface?: AiSurface; limit?: number } = {},
  ) {
    if (options.boardIds && options.boardIds.length === 0) return [];
    const conditions = [eq(aiRuns.orgId, orgId)];
    if (options.boardIds) conditions.push(inArray(aiRuns.boardId, [...options.boardIds]));
    if (options.surface) conditions.push(eq(aiRuns.surface, options.surface));
    const rows = await this.target.db
      .select()
      .from(aiRuns)
      .where(and(...conditions))
      .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
      .limit(Math.min(options.limit ?? AI_RUN_LIST_LIMIT, AI_RUN_LIST_LIMIT));
    return rows.map(PostgresAiRunStore.toRun);
  }
}
