import { and, asc, desc, eq, exists, gt, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  applyOperations,
  parseWorkspaceOrDefault,
  type Workspace,
  type Operation,
} from "@lucent/core";
import type { Db } from "../db/client.js";
import {
  boardMembers,
  boards,
  boardTrash,
  boardShareLinks,
  boardSnapshots,
  opLog,
  outboxEvents,
} from "../db/schema.js";
import type {
  AppendResult,
  BoardMember,
  BoardSnapshot,
  BoardStore,
  LoggedOpEntry,
  OpAppend,
  ShareLink,
  StoredBoard,
  TrashedBoard,
} from "../boards.js";
import { effectiveBoardRole, type Role } from "../identity.js";
import { newOperationId, emptyWorkspace } from "../boards.js";

/**
 * Postgres-backed BoardStore. Implements the full interface: board CRUD, the
 * membership and share-link tables that make sharing real (docs/12), and the
 * op-log methods that make collaboration survive a restart.
 *
 * Two invariants worth stating because SQL doesn't:
 *   - the owner has no `board_members` row; `memberRole` resolves ownership
 *     from `boards.owner_id`, so existing boards need no backfill.
 *   - `listForUser` is the union of owned boards and boards with a membership
 *     row, which is why it replaced the old owner-only listing.
 */
export class PostgresBoardStore implements BoardStore {
  constructor(private readonly target: Db) {}

  /** docs/26 A6: not in the trash. */
  private notTrashed() {
    return notExists(
      this.target.db
        .select({ one: sql`1` })
        .from(boardTrash)
        .where(eq(boardTrash.boardId, boards.id)),
    );
  }

  async get(id: string): Promise<StoredBoard | undefined> {
    const rows = await this.target.db
      .select()
      .from(boards)
      .where(and(eq(boards.id, id), this.notTrashed()))
      .limit(1);
    return rows[0] ? rowToStoredBoard(rows[0]) : undefined;
  }

  async findByPublicToken(token: string): Promise<StoredBoard | undefined> {
    if (!token) return undefined;
    const rows = await this.target.db
      .select()
      .from(boards)
      .where(and(eq(boards.publicToken, token), this.notTrashed()))
      .limit(1);
    return rows[0] ? rowToStoredBoard(rows[0]) : undefined;
  }

  async trash(id: string, by: string, at: number): Promise<boolean> {
    const [board] = await this.target.db
      .select({ orgId: boards.orgId })
      .from(boards)
      .where(eq(boards.id, id));
    if (!board) return false;
    const inserted = await this.target.db
      .insert(boardTrash)
      .values({ boardId: id, orgId: board.orgId, deletedBy: by, deletedAt: at })
      .onConflictDoNothing()
      .returning();
    return inserted.length > 0;
  }

  async restore(id: string): Promise<boolean> {
    const gone = await this.target.db
      .delete(boardTrash)
      .where(eq(boardTrash.boardId, id))
      .returning();
    return gone.length > 0;
  }

  async trashed(orgId: string): Promise<TrashedBoard[]> {
    const rows = await this.target.db
      .select({ board: boards, trash: boardTrash })
      .from(boardTrash)
      .innerJoin(boards, eq(boards.id, boardTrash.boardId))
      .where(eq(boardTrash.orgId, orgId))
      .orderBy(desc(boardTrash.deletedAt));
    return rows.map((r) => ({
      board: rowToStoredBoard(r.board),
      deletedBy: r.trash.deletedBy,
      deletedAt: r.trash.deletedAt,
    }));
  }

  async purgeTrashed(before: number, limit: number): Promise<string[]> {
    const rows = await this.target.db
      .select({ id: boardTrash.boardId })
      .from(boardTrash)
      .where(lt(boardTrash.deletedAt, before))
      .limit(limit);
    for (const { id } of rows) await this.delete(id);
    return rows.map((r) => r.id);
  }

  async listForOrg(orgId: string): Promise<StoredBoard[]> {
    // Tenant-scoped query (M2.1). The store never returns boards from another
    // org — that property is what cross-tenant leakage tests verify.
    const rows = await this.target.db
      .select()
      .from(boards)
      .where(and(eq(boards.orgId, orgId), this.notTrashed()))
      .orderBy(desc(boards.updatedAt));
    return rows.map(rowToStoredBoard);
  }

  /**
   * INDEX USE: `boards_org_idx` on `(org_id)`, counted in the index rather than
   * the heap. The point of not using `listForOrg().length` is the projection —
   * that query selects `workspace`, so counting an Enterprise tenant's boards
   * would stream every diagram's JSONB out of Postgres to throw it away.
   *
   * `count()` is int8, which node-postgres hands over as a string rather than
   * lose precision, so it goes through `toNumber` instead of being trusted.
   */
  async countForOrg(orgId: string): Promise<number> {
    const rows = await this.target.db
      .select({ count: sql<string>`count(*)` })
      .from(boards)
      .where(and(eq(boards.orgId, orgId), this.notTrashed()));
    return toNumber(rows[0]?.count);
  }

  async listForUser(orgId: string, userId: string): Promise<StoredBoard[]> {
    // The caller-facing listing (see the BoardStore doc). One statement, not
    // listForOrg plus a membership probe per board: EXISTS lets Postgres stop
    // at the first matching row and hits the board_members primary key. Owned
    // boards come from boards.owner_id because the owner has no member row.
    // Same ordering as listForOrg so the two agree on "most recent first".
    const rows = await this.target.db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.orgId, orgId),
          this.notTrashed(),
          or(
            eq(boards.ownerId, userId),
            exists(
              this.target.db
                .select({ one: sql`1` })
                .from(boardMembers)
                .where(and(eq(boardMembers.boardId, boards.id), eq(boardMembers.userId, userId))),
            ),
          ),
        ),
      )
      .orderBy(desc(boards.updatedAt));
    return rows.map(rowToStoredBoard);
  }

  async listGrantedTo(
    userId: string,
    limit = 200,
  ): Promise<Array<{ board: StoredBoard; role: Role }>> {
    const rows = await this.target.db
      .select({ board: boards, role: boardMembers.role })
      .from(boardMembers)
      .innerJoin(boards, eq(boards.id, boardMembers.boardId))
      .where(and(eq(boardMembers.userId, userId), this.notTrashed()))
      .orderBy(desc(boards.updatedAt))
      .limit(limit);
    return rows.map((r) => ({ board: rowToStoredBoard(r.board), role: r.role as Role }));
  }

  async put(board: StoredBoard): Promise<void> {
    await this.target.db
      .insert(boards)
      .values({
        id: board.id,
        orgId: board.orgId,
        ownerId: board.ownerId,
        name: board.name,
        classification: board.classification ?? null,
        workspace: board.workspace,
        publicToken: board.publicToken ?? null,
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
      })
      .onConflictDoUpdate({
        target: boards.id,
        set: {
          orgId: board.orgId,
          ownerId: board.ownerId,
          name: board.name,
          classification: board.classification ?? null,
          workspace: board.workspace,
          publicToken: board.publicToken ?? null,
          updatedAt: board.updatedAt,
        },
      });
  }

  async delete(id: string): Promise<void> {
    // op_log, board_members and board_share_links all cascade on the FK.
    await this.target.db.delete(boards).where(eq(boards.id, id));
  }

  async memberRole(
    boardId: string,
    userId: string,
    lookupOrgRole?: (userId: string) => Promise<Role | undefined>,
  ): Promise<Role | undefined> {
    const board = await this.get(boardId);
    if (!board) return undefined;
    const orgRole = lookupOrgRole ? await lookupOrgRole(userId) : undefined;
    if (board.ownerId === userId || orgRole === "owner") return "owner";
    const rows = await this.target.db
      .select()
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
      .limit(1);
    const boardRole = rows[0]?.role as Role | undefined;
    return effectiveBoardRole(orgRole, boardRole);
  }

  async members(boardId: string): Promise<BoardMember[]> {
    const rows = await this.target.db
      .select()
      .from(boardMembers)
      .where(eq(boardMembers.boardId, boardId))
      .orderBy(asc(boardMembers.createdAt));
    return rows.map((r) => ({
      boardId: r.boardId,
      userId: r.userId,
      role: r.role as Role,
      invitedBy: r.invitedBy,
      createdAt: r.createdAt,
    }));
  }

  async setMember(member: BoardMember): Promise<void> {
    await this.target.db
      .insert(boardMembers)
      .values({
        boardId: member.boardId,
        userId: member.userId,
        role: member.role,
        invitedBy: member.invitedBy,
        createdAt: member.createdAt,
      })
      .onConflictDoUpdate({
        target: [boardMembers.boardId, boardMembers.userId],
        set: { role: member.role, invitedBy: member.invitedBy },
      });
  }

  async removeMember(boardId: string, userId: string): Promise<void> {
    await this.target.db
      .delete(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)));
  }

  async createShareLink(link: ShareLink): Promise<void> {
    await this.target.db.insert(boardShareLinks).values({
      token: link.token,
      boardId: link.boardId,
      role: link.role,
      createdBy: link.createdBy,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      revokedAt: link.revokedAt,
    });
  }

  async shareLinkByToken(token: string): Promise<ShareLink | undefined> {
    const rows = await this.target.db
      .select()
      .from(boardShareLinks)
      .where(eq(boardShareLinks.token, token))
      .limit(1);
    return rows[0] ? rowToShareLink(rows[0]) : undefined;
  }

  async shareLinks(boardId: string): Promise<ShareLink[]> {
    const rows = await this.target.db
      .select()
      .from(boardShareLinks)
      .where(eq(boardShareLinks.boardId, boardId))
      .orderBy(desc(boardShareLinks.createdAt));
    return rows.map(rowToShareLink);
  }

  async revokeShareLinks(boardId: string, at: number, token?: string): Promise<number> {
    // Only live links count as revoked, so calling this twice reports 0 the
    // second time rather than inflating the number.
    const where =
      token === undefined
        ? and(eq(boardShareLinks.boardId, boardId), isNull(boardShareLinks.revokedAt))
        : and(
            eq(boardShareLinks.boardId, boardId),
            eq(boardShareLinks.token, token),
            isNull(boardShareLinks.revokedAt),
          );
    const updated = await this.target.db
      .update(boardShareLinks)
      .set({ revokedAt: at })
      .where(where)
      .returning({ token: boardShareLinks.token });
    return updated.length;
  }

  /**
   * One statement does the allocation, the staleness guard, the loser report,
   * and the idempotency check (Stage B).
   *
   * Raw SQL because the shape has no query-builder equivalent: a data-modifying
   * CTE whose INSERT ... SELECT reads the head it is about to extend. Splitting
   * it into "select max(seq)" then "insert" would put a network round trip inside
   * the race it is trying to win, and would still need this statement to be
   * correct -- so it is the only statement.
   *
   * How the four answers arise:
   *   - a row came back from the INSERT -> `ok`, that is the allocated seq.
   *   - no insert row, a PRIOR row holds this requestId -> `ok` + `duplicate`:
   *     the request already landed (a network retry); the caller is answered
   *     with the original seq and nothing is written. The lookup runs before the
   *     head CTE so a duplicate is settled without reading the log's max.
   *   - no insert row, guard failed -> `conflict`: head + 1 was already past
   *     `expectedSeq`, so nothing was even attempted.
   *   - no insert row, guard passed -> `lost`: another writer took `head + 1`
   *     between this statement's read and its insert, and ON CONFLICT DO NOTHING
   *     made that a fact to report rather than an exception to unwind.
   *
   * `ops` is stringified and cast: node-postgres would otherwise send a JS array
   * as a Postgres array literal, and the column is jsonb. Identifiers are quoted
   * because `by` is a keyword everywhere else in SQL.
   *
   * A duplicate ignores `expectedSeq` on purpose: the request already committed
   * at ITS seq, and re-checking the caller's (now stale) expectation would
   * 409 a replay of something that already succeeded.
   */
  async appendOp(entry: OpAppend): Promise<AppendResult> {
    const expected = entry.expectedSeq ?? null;
    const requestId = entry.requestId ?? null;
    const operationId = entry.operationId ?? newOperationId();
    // The actor columns: defaulted at the call sites to the acting user, so
    // `by` and the actor agree on every pre-Stage-B path by construction.
    const actor = entry.actor ?? {
      actorType: "user" as const,
      actorId: entry.by,
      initiatedBy: entry.by,
    };
    const approvedBy = actor.approvedBy ?? null;
    const initiatedBy = actor.initiatedBy ?? null;
    // P2 (docs/20): the committed batch announces itself in the SAME
    // statement that makes it real. This is the transactional outbox at its
    // strongest — not "a row written in the same transaction" but a row
    // written by the same statement, so there is no window at all between
    // the op log gaining a row and the outbox gaining its event. A rollback
    // (or an `on conflict do nothing` that inserts nothing) takes both.
    //
    // The payload is `{boardId, seq}` — notification-shaped, exactly the
    // shape the pg_notify fanout uses, and for the same reason: a subscriber
    // resyncs from the op log rather than trusting a payload copy.
    const outboxId = randomUUID();
    const result = await this.target.db.execute(sql`
      with prior as (
        select "seq", "operation_id" from ${opLog}
         where "board_id" = ${entry.boardId} and "request_id" = ${requestId}::text
         limit 1
      ), head as (
        select coalesce(max("seq"), 0) as seq from ${opLog} where "board_id" = ${entry.boardId}
      ), ins as (
        insert into ${opLog} ("board_id", "seq", "ops", "by", "label", "at", "operation_id", "request_id", "actor_type", "actor_id", "initiated_by", "approved_by")
        select ${entry.boardId}, head.seq + 1, ${JSON.stringify(entry.ops)}::jsonb,
               ${entry.by}, ${entry.label}, ${entry.at}::bigint,
               ${operationId}, ${requestId}::text,
               ${actor.actorType}, ${actor.actorId},
               ${initiatedBy}::text, ${approvedBy}::text
          from head
         where (${expected}::bigint is null or head.seq + 1 = ${expected}::bigint)
           and not exists (select 1 from prior)
         on conflict ("board_id", "seq") do nothing
         returning "seq", "operation_id"
      ), evt as (
        insert into ${outboxEvents} ("id", "type", "board_id", "org_id", "payload", "created_at")
        select ${outboxId}, 'BoardOperationCommitted', ${entry.boardId},
               ${entry.orgId ?? null}::text,
               jsonb_build_object('boardId', ${entry.boardId}::text, 'seq', ins.seq),
               ${entry.at}::bigint
          from ins
        returning "id"
      )
      select (select seq from ins) as seq,
             (select operation_id from ins) as operation_id,
             (select seq from head) as head,
             (select seq from prior) as prior_seq,
             (select operation_id from prior) as prior_operation_id,
             (select id from evt) as outbox_id
    `);
    const row = result.rows[0] as
      | {
          seq: unknown;
          head: unknown;
          operation_id: unknown;
          prior_seq: unknown;
          prior_operation_id: unknown;
        }
      | undefined;
    const head = toNumber(row?.head);
    // A replayed requestId: answer with the original outcome, write nothing.
    if (row?.prior_seq !== null && row?.prior_seq !== undefined) {
      return {
        ok: true,
        seq: toNumber(row.prior_seq),
        duplicate: true,
        operationId:
          row.prior_operation_id === null || row.prior_operation_id === undefined
            ? undefined
            : String(row.prior_operation_id),
      };
    }
    if (row?.seq === null || row?.seq === undefined) {
      const reason = expected !== null && head + 1 !== expected ? "conflict" : "lost";
      return { ok: false, reason, head };
    }
    return {
      ok: true,
      seq: toNumber(row.seq),
      operationId:
        row.operation_id === null || row.operation_id === undefined
          ? undefined
          : String(row.operation_id),
    };
  }

  async findRequest(boardId: string, requestId: string): Promise<LoggedOpEntry | undefined> {
    // Serves the partial unique index (board_id, request_id); the equality
    // lookup is an index hit, never a log scan.
    const rows = await this.target.db
      .select()
      .from(opLog)
      .where(and(eq(opLog.boardId, boardId), eq(opLog.requestId, requestId)))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    return {
      seq: r.seq,
      ops: r.ops as Operation[],
      by: r.by,
      label: r.label,
      at: r.at,
      ...(r.operationId !== null && r.operationId !== undefined
        ? { operationId: r.operationId }
        : {}),
      requestId: r.requestId ?? requestId,
      ...rowActor(r),
    };
  }

  async loadLog(boardId: string, fromSeq?: number): Promise<LoggedOpEntry[]> {
    // INDEX USE: the (board_id, seq) primary key serves both the equality and the
    // range, so a snapshot-anchored tail read touches only the entries it returns.
    const where =
      fromSeq === undefined || fromSeq <= 0
        ? eq(opLog.boardId, boardId)
        : and(eq(opLog.boardId, boardId), gt(opLog.seq, fromSeq));
    const rows = await this.target.db.select().from(opLog).where(where).orderBy(asc(opLog.seq));
    return rows.map((r) => ({
      seq: r.seq,
      ops: r.ops as Operation[],
      by: r.by,
      label: r.label,
      at: r.at,
      ...(r.operationId !== null && r.operationId !== undefined
        ? { operationId: r.operationId }
        : {}),
      ...(r.requestId !== null && r.requestId !== undefined ? { requestId: r.requestId } : {}),
      ...rowActor(r),
    }));
  }

  /** max(seq) in the index, without reading a single `ops` blob off the heap. */
  async latestSeq(boardId: string): Promise<number> {
    const rows = await this.target.db
      .select({ seq: sql<string>`coalesce(max(${opLog.seq}), 0)` })
      .from(opLog)
      .where(eq(opLog.boardId, boardId));
    return toNumber(rows[0]?.seq);
  }

  async latestSnapshot(boardId: string): Promise<BoardSnapshot | undefined> {
    const rows = await this.target.db
      .select()
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, boardId))
      .orderBy(desc(boardSnapshots.seq))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    // Same validation the board row gets: a snapshot written by an older build
    // must not reach a reducer unparsed (see `rowToStoredBoard`).
    return {
      seq: row.seq,
      workspace: parseWorkspaceOrDefault(row.workspace, `snapshot:${boardId}@${row.seq}`),
      createdAt: row.createdAt,
    };
  }

  async putSnapshot(
    boardId: string,
    seq: number,
    workspace: Workspace,
    at = Date.now(),
  ): Promise<void> {
    // Idempotent on (board_id, seq): the compaction timer and a room eviction can
    // both decide to snapshot the same seq, and neither should fail on the other.
    await this.target.db
      .insert(boardSnapshots)
      .values({ boardId, seq, workspace, createdAt: at })
      .onConflictDoUpdate({
        target: [boardSnapshots.boardId, boardSnapshots.seq],
        set: { workspace, createdAt: at },
      });
  }

  /**
   * The floor is computed inside the DELETE rather than read first: a snapshot
   * cannot be taken away mid-statement, and `coalesce(..., 0)` is what makes "no
   * snapshot" prune nothing (seqs start at 1) instead of everything, which is the
   * failure mode that would cost a board its history.
   */
  async pruneLog(boardId: string, upToSeq: number, olderThan?: number): Promise<number> {
    const cutoff = olderThan ?? null;
    const result = await this.target.db.execute(sql`
      delete from ${opLog}
       where "board_id" = ${boardId}
         and "seq" <= least(
               ${upToSeq}::bigint,
               coalesce((select max("seq") from ${boardSnapshots} where "board_id" = ${boardId}), 0)
             )
         and (${cutoff}::bigint is null or "at" <= ${cutoff}::bigint)
      returning "seq"
    `);
    return result.rows.length;
  }

  async pruneSnapshots(boardId: string, keep: number): Promise<number> {
    if (keep < 1) return 0; // refuse to leave a board with no floor to prune against
    const result = await this.target.db.execute(sql`
      delete from ${boardSnapshots}
       where "board_id" = ${boardId}
         and "seq" < (
               select min(seq) from (
                 select "seq" as seq from ${boardSnapshots}
                  where "board_id" = ${boardId}
                  order by "seq" desc
                  limit ${keep}
               ) newest
             )
      returning "seq"
    `);
    return result.rows.length;
  }

  async reconcile(id: string): Promise<StoredBoard | undefined> {
    const board = await this.get(id);
    if (!board) return undefined;
    const snapshot = await this.latestSnapshot(id);
    let base = snapshot ? snapshot.workspace : emptyWorkspace(board.name);
    const fromSeq = snapshot ? snapshot.seq : 0;
    const log = await this.loadLog(id, fromSeq);
    for (const entry of log) {
      base = applyOperations(base, entry.ops);
    }
    const updated: StoredBoard = { ...board, workspace: base, updatedAt: Date.now() };
    await this.put(updated);
    return updated;
  }
}

function rowToStoredBoard(row: typeof boards.$inferSelect): StoredBoard {
  // Validate older JSONB blobs through the same schema the POST /api/boards
  // route uses (M0.5). Without this, a board stored by an older build with
  // a missing field lands on the client as-is and crashes the reducer on
  // first edit. parseWorkspaceOrDefault logs and falls back to an empty
  // workspace when the JSONB is too broken to coerce.
  const ws = parseWorkspaceOrDefault(row.workspace, `board:${row.id}`);
  return {
    id: row.id,
    orgId: row.orgId,
    ownerId: row.ownerId,
    name: row.name,
    // NULL (a board from before the column) means internal: the field is
    // omitted rather than written as a value, so `classificationOf`'s default
    // stays the single source of the answer.
    ...(row.classification ? { classification: row.classification } : {}),
    workspace: ws,
    ...(row.publicToken ? { publicToken: row.publicToken } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToShareLink(row: typeof boardShareLinks.$inferSelect): ShareLink {
  return {
    token: row.token,
    boardId: row.boardId,
    role: row.role as ShareLink["role"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * `count(*)` is int8. node-postgres hands int8 back as a string rather than
 * risk a silent precision loss past 2^53, so every count in this file parses
 * defensively instead of trusting the driver's type. Deliberately duplicated in
 * each pg-* store rather than shared: a one-line parse is not worth an import
 * edge between store modules.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Assemble the actor record off a log row, collapsing "no actor columns" (a
 * pre-Stage-B row the backfill upgraded) into the equivalent human actor so
 * callers never see a partial shape. `by` remains the authorship truth; the
 * actor defaults to it, which is exactly what the migration backfilled.
 */
function rowActor(r: {
  actorType: string | null;
  actorId: string | null;
  initiatedBy: string | null;
  approvedBy: string | null;
  by: string;
}): {
  actor: {
    actorType: "user" | "ai" | "system";
    actorId: string;
    initiatedBy?: string;
    approvedBy?: string;
  };
} {
  const type = (r.actorType ?? "user") as "user" | "ai" | "system";
  const actorId = r.actorId ?? r.by;
  return {
    actor: {
      actorType: type,
      actorId,
      ...(r.initiatedBy !== null && r.initiatedBy !== undefined
        ? { initiatedBy: r.initiatedBy }
        : { initiatedBy: actorId }),
      ...(r.approvedBy !== null && r.approvedBy !== undefined ? { approvedBy: r.approvedBy } : {}),
    },
  };
}
