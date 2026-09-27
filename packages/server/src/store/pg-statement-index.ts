import { and, asc, eq, inArray } from "drizzle-orm";
import type { StatementKind, StatementRow, StatementStatus } from "@lucent/core";
import { isBlockedRow } from "@lucent/core";
import type { Db } from "../db/client.js";
import { statementIndex, statementIndexState } from "../db/schema.js";
import type { IndexFilter, IndexedStatement, StatementIndexStore } from "../statementIndex.js";

/**
 * Postgres-backed statement index (docs/26 J3, ADR 0046). A board's rows are
 * replaced in one transaction with its state row, so a reader never sees a
 * board's rows from one revision beside the state of another. Rows and state
 * cascade away with their board.
 */
export class PostgresStatementIndexStore implements StatementIndexStore {
  constructor(private readonly target: Db) {}

  async replaceBoard(
    boardId: string,
    orgId: string,
    rows: readonly StatementRow[],
    sourceAt: number,
    indexedAt: number,
  ): Promise<void> {
    await this.target.db.transaction(async (tx) => {
      await tx.delete(statementIndex).where(eq(statementIndex.boardId, boardId));
      if (rows.length > 0) {
        await tx.insert(statementIndex).values(
          rows.map((r, ord) => ({
            boardId,
            nodeId: r.id,
            orgId,
            ord,
            kind: r.kind,
            status: r.status,
            label: r.label,
            topic: r.topic ?? null,
            supersedes: r.supersedes ?? null,
            assignee: r.assignee ?? null,
            dueDate: r.dueDate ?? null,
            executionStatus: r.executionStatus ?? null,
            blocked: isBlockedRow(r),
            drivesActions: r.drivesActions ?? null,
            meetingId: r.provenance?.meetingId ?? null,
            turnStart: r.provenance?.turnRange?.[0] ?? null,
            turnEnd: r.provenance?.turnRange?.[1] ?? null,
          })),
        );
      }
      await tx
        .insert(statementIndexState)
        .values({ boardId, orgId, sourceAt, indexedAt })
        .onConflictDoUpdate({
          target: statementIndexState.boardId,
          set: { orgId, sourceAt, indexedAt },
        });
    });
  }

  async dropBoard(boardId: string): Promise<void> {
    await this.target.db.transaction(async (tx) => {
      await tx.delete(statementIndex).where(eq(statementIndex.boardId, boardId));
      await tx.delete(statementIndexState).where(eq(statementIndexState.boardId, boardId));
    });
  }

  async sourcesFor(boardIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (boardIds.length === 0) return out;
    const rows = await this.target.db
      .select({ boardId: statementIndexState.boardId, sourceAt: statementIndexState.sourceAt })
      .from(statementIndexState)
      .where(inArray(statementIndexState.boardId, [...boardIds]));
    for (const r of rows) out.set(r.boardId, r.sourceAt);
    return out;
  }

  async query(boardIds: readonly string[], filter: IndexFilter = {}): Promise<IndexedStatement[]> {
    if (boardIds.length === 0) return [];
    const conditions = [inArray(statementIndex.boardId, [...boardIds])];
    if (filter.kinds?.length) conditions.push(inArray(statementIndex.kind, [...filter.kinds]));
    if (filter.statuses?.length) {
      conditions.push(inArray(statementIndex.status, [...filter.statuses]));
    }
    const rows = await this.target.db
      .select()
      .from(statementIndex)
      .where(and(...conditions))
      .orderBy(asc(statementIndex.boardId), asc(statementIndex.ord));
    // Board order is the caller's (their board list), not the table's.
    const order = new Map(boardIds.map((id, i) => [id, i] as const));
    rows.sort((a, b) => (order.get(a.boardId) ?? 0) - (order.get(b.boardId) ?? 0) || a.ord - b.ord);
    return rows.map((r) => ({
      kind: r.kind as StatementKind,
      id: r.nodeId,
      label: r.label,
      status: r.status as StatementStatus,
      boardId: r.boardId,
      orgId: r.orgId,
      blocked: r.blocked,
      ...(r.topic ? { topic: r.topic } : {}),
      ...(Array.isArray(r.supersedes) && r.supersedes.length
        ? { supersedes: r.supersedes as string[] }
        : {}),
      ...(r.assignee ? { assignee: r.assignee } : {}),
      ...(r.dueDate ? { dueDate: r.dueDate } : {}),
      ...(r.executionStatus ? { executionStatus: r.executionStatus } : {}),
      ...(r.drivesActions ? { drivesActions: r.drivesActions } : {}),
      ...(r.meetingId
        ? {
            provenance: {
              meetingId: r.meetingId,
              ...(r.turnStart !== null && r.turnEnd !== null
                ? { turnRange: [r.turnStart, r.turnEnd] as [number, number] }
                : {}),
            },
          }
        : {}),
    }));
  }

  async clearOrg(orgId: string): Promise<void> {
    await this.target.db.transaction(async (tx) => {
      await tx.delete(statementIndex).where(eq(statementIndex.orgId, orgId));
      await tx.delete(statementIndexState).where(eq(statementIndexState.orgId, orgId));
    });
  }
}
