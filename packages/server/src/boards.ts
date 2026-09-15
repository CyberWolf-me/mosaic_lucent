import { randomBytes } from "node:crypto";
import type { Workspace } from "@lucent/core";
import { createWorkspace } from "@lucent/core";
import { effectiveBoardRole, type Role } from "./identity.js";
import type { BoardClassification } from "./classification.js";

/**
 * Server-side board storage (docs/06, docs/07 -- PostgreSQL/S3 are the
 * production target; this is the interface they must satisfy).
 *
 * This is the piece that makes the validator *authoritative*. Until boards live
 * server-side, `handleGenerate` validates against a workspace reconstructed from
 * whatever the client claims -- advisory validation. With a stored board it
 * validates against real state and can genuinely reject an operation like
 * "connect to a node that was deleted a moment ago".
 *
 * Access control lives here too. A board id is not a capability: reaching a
 * board requires an explicit membership row, or redeeming a share link that
 * creates one. The owner is implied by `ownerId` and needs no row, so an
 * existing board keeps working with no backfill.
 *
 * In-memory per process: correct for single-instance dev, replaced by Postgres in
 * production behind this exact shape.
 */

export interface StoredBoard {
  id: string;
  /** Tenant boundary (M2.1). Every board lives in exactly one org. */
  orgId: string;
  ownerId: string;
  name: string;
  /**
   * Governance tier (docs/23 S1, docs/24 Phase A). Absent means `internal` —
   * every board written before this field existed, and every board whose owner
   * never touched the setting, behaves exactly as it did. The gates read it
   * through `classificationOf` so the default lives in one place.
   *
   * Deliberately NOT part of `workspace`: classification is a governance
   * attribute of the board RECORD, and the workspace is the projection the
   * op log mutates. An operation must never be able to change it — that is
   * the difference between a policy and a suggestion.
   */
  classification?: BoardClassification;
  workspace: Workspace;
  createdAt: number;
  updatedAt: number;
}

/** An explicit grant of access to one board. */
export interface BoardMember {
  boardId: string;
  userId: string;
  role: Role;
  /** Who granted it: a user id, or null when redeemed from a link. */
  invitedBy: string | null;
  createdAt: number;
}

/** Roles a share link may grant. Ownership is never transferable by link. */
export type ShareRole = Exclude<Role, "owner">;

export interface ShareLink {
  /** The capability itself: 32 random bytes, base64url. */
  token: string;
  boardId: string;
  role: ShareRole;
  createdBy: string;
  createdAt: number;
  /** Epoch ms after which the link stops working; null means no expiry. */
  expiresAt: number | null;
  /** Epoch ms it was revoked; null while live. */
  revokedAt: number | null;
}

export interface LoggedOpEntry {
  seq: number;
  ops: import("@lucent/core").Operation[];
  by: string;
  label: string;
  at: number;
  /** Server-generated batch id (`op_…`), present on every Stage B row. */
  operationId?: string;
  /** The idempotency key the submit carried, when it had one. */
  requestId?: string;
  /** Who/what produced the batch; `by` remains the authorship stamp. */
  actor?: OperationActor;
}

/**
 * The three-part accountability split (Stage B, per the approved actor model):
 *
 *   actor       — WHO/WHAT produced the operations.
 *   initiatedBy — WHO ASKED for them (the user behind the meeting or prompt).
 *   approvedBy  — WHO AUTHORIZED the change (for review-gated AI proposals).
 *
 * They are often the same person, but not always: Alex asks, Lucent
 * generates, Sarah approves. The history can then honestly say both things —
 * "✦ Lucent created 4 nodes" and "initiated by Alex, approved by Sarah" —
 * where a single `by` column could only ever say one of them, and said the
 * wrong one (the approver) for every gated commit.
 *
 * `by` on the workspace side (comments/votes/reactions authorship) is
 * unchanged: `stampAuthorship` stamps the connection's user, and the reserved
 * `assistant` id stays the AI's workspace-level author. The actor model is
 * LOG-level accountability and deliberately does not migrate workspace data.
 */
export interface OperationActor {
  /** "user" (human or their agent), "ai" (Lucent's extraction), "system". */
  actorType: "user" | "ai" | "system";
  /** The actor's stable id: usr_… for users, "lucent" for the AI. */
  actorId: string;
  /** Who asked for the batch; the user behind a meeting/prompt for AI acts. */
  initiatedBy?: string;
  /** Who approved a review-gated batch; null for direct edits. */
  approvedBy?: string;
}

/** The ordinary case: a human edited the board directly. */
export function userActor(userId: string): OperationActor {
  return { actorType: "user", actorId: userId, initiatedBy: userId };
}

/**
 * An AI act: Lucent generated the operations from `initiatedBy`'s meeting or
 * prompt, and (for review-gated proposals) `approvedBy` authorized the commit.
 */
export function aiActor(initiatedBy: string, approvedBy?: string): OperationActor {
  return { actorType: "ai", actorId: "lucent", initiatedBy, ...(approvedBy ? { approvedBy } : {}) };
}

/**
 * An op batch as a caller submits it: everything a log entry has *except* the
 * seq, because the seq is the store's to assign (M3).
 *
 * `expectedSeq` is an optimistic-concurrency guard, not the seq being written:
 * pass `version + 1` and the append is refused when the log has moved on since
 * the caller validated its ops. Omit it and the batch lands at whatever the head
 * happens to be -- right for a replay or a backfill, wrong for a commit, which
 * validated against one specific state.
 *
 * `requestId` is the Stage B idempotency key: when a row with the same
 * (boardId, requestId) already exists, the append answers with THAT row's seq
 * and `duplicate: true` instead of writing a second effect — a network retry
 * must never apply an edit twice. Omitted by callers with no retry semantics
 * (legacy rows, log rewrites).
 */
export type OpAppend = Omit<LoggedOpEntry, "seq"> & {
  boardId: string;
  expectedSeq?: number;
  /**
   * The board's owning org, when known (P2). It rides the outbox event this
   * append writes (`BoardOperationCommitted`), so a consumer that needs to
   * scope by tenant — an email, a usage rollup — reads it from the event
   * instead of looking the board up again.
   */
  orgId?: string;
};

/**
 * The outcome of an append.
 *
 * A failure here is not an error: with two instances writing one board, two
 * commits racing for the same seq is ordinary traffic and exactly one of them
 * has to be told it lost. The two failures are different facts about the caller.
 * `conflict` means it was already stale when it asked -- the head had moved past
 * `expectedSeq` before the statement ran. `lost` means it was current and
 * another writer took the seq between reading the head and inserting the row.
 *
 * Neither wrote anything, so both are safely retryable once the caller has
 * caught up to `head` and re-validated against it. `head` is the log's seq as
 * the losing statement observed it, which saves the retry a round trip.
 */
export type AppendResult =
  | { ok: true; seq: number; duplicate?: boolean; operationId?: string }
  | { ok: false; reason: "lost" | "conflict"; head: number };

/**
 * A new operation id (`op_…`). Server-generated, one per committed batch: the
 * thing an ack names, so a client can correlate "the server accepted my
 * request" with a specific entry in the log without knowing its seq.
 */
export function newOperationId(): string {
  return `op_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

/**
 * A cached workspace at a known point in the log (M3). Never a second source of
 * truth: it can always be discarded and recomputed, which is exactly what makes
 * pruning the log below it safe.
 */
export interface BoardSnapshot {
  /** The seq this workspace is the state *after*. */
  seq: number;
  workspace: Workspace;
  createdAt: number;
}

export interface BoardStore {
  get(id: string): Promise<StoredBoard | undefined>;
  /**
   * Every board in this org, ignoring board membership. Tenant-scoped: it
   * never returns a board from another org, which is the property M2's
   * cross-tenant leakage tests verify. Kept for the org admin console, which
   * legitimately shows the whole tenant -- it is *not* the default for a
   * user-facing list.
   */
  listForOrg(orgId: string): Promise<StoredBoard[]>;
  /**
   * The caller-facing default for listing boards: those in this org the user
   * owns or holds a membership row on. `listForOrg` would show every org
   * member every board in the org, contradicting the rule above that a board
   * id is not a capability and reaching one takes an explicit grant.
   *
   * Deliberately not escalated by org role: `memberRole` resolves an org owner
   * to "owner" on every board in the org, so they can open one by id, but the
   * default listing stays membership-scoped -- "boards I work on" should not
   * silently become "everything in the tenant". `listForOrg` is that view.
   */
  listForUser(orgId: string, userId: string): Promise<StoredBoard[]>;
  /**
   * How many boards the org holds. Separate from `listForOrg().length` because
   * M4's `boards` entitlement is checked on every board create, and the row
   * this count lives in carries the whole workspace JSONB: counting by listing
   * would read every diagram in the tenant to answer "how many are there".
   */
  countForOrg(orgId: string): Promise<number>;
  put(board: StoredBoard): Promise<void>;
  delete(id: string): Promise<void>;

  /**
   * The user's effective role on a board (M2.2): max of their org-level
   * role (via `lookupOrgRole`) and their board-level role. An org owner
   * always resolves to "owner" on every board in the org. The default
   * `lookupOrgRole` returns undefined (board-only); the PG implementation
   * reads the `memberships` row.
   */
  memberRole(
    boardId: string,
    userId: string,
    lookupOrgRole?: (userId: string) => Promise<Role | undefined>,
  ): Promise<Role | undefined>;
  /** Explicit membership rows, excluding the implied owner. */
  members(boardId: string): Promise<BoardMember[]>;
  /** Insert or update one membership row. */
  setMember(member: BoardMember): Promise<void>;
  removeMember(boardId: string, userId: string): Promise<void>;

  createShareLink(link: ShareLink): Promise<void>;
  shareLinkByToken(token: string): Promise<ShareLink | undefined>;
  shareLinks(boardId: string): Promise<ShareLink[]>;
  /** Revoke one link, or every live link on the board when token is omitted. */
  revokeShareLinks(boardId: string, at: number, token?: string): Promise<number>;

  /**
   * Append one op batch to the durable log, allocating its seq (M3).
   *
   * The seq is assigned here rather than by the caller. `Room.commit` used to
   * compute `log.length + 1`, which is only correct while exactly one process
   * owns the board: two instances doing that arithmetic independently produce
   * the same number for different ops, and the INSERT that lands second either
   * dies on the primary key or overwrites an edit. Allocation belongs where the
   * uniqueness constraint is.
   *
   * Never throws on contention -- see `AppendResult`.
   */
  appendOp(entry: OpAppend): Promise<AppendResult>;
  /**
   * The log entry a requestId committed, if any (Stage B idempotency). This is
   * the pre-validation replay check: a retried submit must be recognized by
   * its KEY, because re-validating its ops against the moved world would
   * refuse a retried CREATE ("already exists") or double-apply a MOVE.
   */
  findRequest(boardId: string, requestId: string): Promise<LoggedOpEntry | undefined>;
  /**
   * Load a board's op log ordered by seq ascending, optionally only the entries
   * *after* `fromSeq`. Used when a Room is constructed from a cold start so
   * reconnecting clients get the same catchup they'd get from a hot Room.
   *
   * `fromSeq` is what makes snapshots pay: a cold room passes the snapshot's seq
   * and replays the tail instead of the board's whole history.
   */
  loadLog(boardId: string, fromSeq?: number): Promise<LoggedOpEntry[]>;
  /**
   * The board's durable version: the highest seq in its log, or 0 for a board
   * never edited over the wire.
   *
   * Not `loadLog().length` -- pruning leaves the count and the head disagreeing,
   * and a client seeded with a count would ask for catchup from the wrong place.
   * It is also what `GET /api/boards/:id` reports, so a first join can say where
   * it already is instead of asking for the log from the beginning.
   */
  latestSeq(boardId: string): Promise<number>;

  /** The newest snapshot, or undefined when the board has none. */
  latestSnapshot(boardId: string): Promise<BoardSnapshot | undefined>;
  /** Record the workspace as the state after `seq`. Idempotent on that seq. */
  putSnapshot(boardId: string, seq: number, workspace: Workspace, at?: number): Promise<void>;
  /**
   * Delete log entries this board no longer needs, returning how many went.
   *
   * Two floors, both enforced here rather than trusted to the caller, because
   * over-pruning is unrecoverable: nothing at or above the newest snapshot's seq
   * is ever deleted, and a board with no snapshot prunes nothing at all. A caller
   * asking to prune past the snapshot gets the snapshot's floor, not its request.
   * `olderThan` narrows further by wall-clock `at`, so retention can be stated as
   * a duration rather than a count.
   */
  pruneLog(boardId: string, upToSeq: number, olderThan?: number): Promise<number>;
  /** Keep the newest `keep` snapshots, delete the rest; returns how many went. */
  pruneSnapshots(boardId: string, keep: number): Promise<number>;
}

/** True when a share link is still redeemable at `now`. */
export function shareLinkUsable(link: ShareLink, now = Date.now()): boolean {
  if (link.revokedAt !== null) return false;
  if (link.expiresAt !== null && link.expiresAt <= now) return false;
  return true;
}

/** A share-link token: 256 bits of randomness, URL-safe. */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newBoardId(): string {
  return `brd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyWorkspace(name: string): Workspace {
  return { ...createWorkspace(), name };
}

export class InMemoryBoardStore implements BoardStore {
  private readonly boards = new Map<string, StoredBoard>();
  private readonly logs = new Map<string, LoggedOpEntry[]>();
  /** Per board, ordered by seq ascending. */
  private readonly snapshots = new Map<string, BoardSnapshot[]>();
  /** Keyed by board id and user id joined by a space. */
  private readonly memberRows = new Map<string, BoardMember>();
  private readonly links = new Map<string, ShareLink>();

  async get(id: string): Promise<StoredBoard | undefined> {
    return this.boards.get(id);
  }

  async listForOrg(orgId: string): Promise<StoredBoard[]> {
    return [...this.boards.values()]
      .filter((b) => b.orgId === orgId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async countForOrg(orgId: string): Promise<number> {
    let n = 0;
    for (const b of this.boards.values()) if (b.orgId === orgId) n += 1;
    return n;
  }

  /**
   * Boards in this org the user can actually reach. Ownership is implied by
   * `ownerId` -- an owner holds no row in the members map -- so both the owner
   * test and the row lookup are load-bearing.
   */
  async listForUser(orgId: string, userId: string): Promise<StoredBoard[]> {
    return [...this.boards.values()]
      .filter(
        (b) =>
          b.orgId === orgId &&
          (b.ownerId === userId || this.memberRows.has(memberKey(b.id, userId))),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async put(board: StoredBoard): Promise<void> {
    this.boards.set(board.id, board);
  }

  async delete(id: string): Promise<void> {
    this.boards.delete(id);
    this.logs.delete(id);
    this.snapshots.delete(id);
    for (const [key, member] of this.memberRows) {
      if (member.boardId === id) this.memberRows.delete(key);
    }
    for (const [token, link] of this.links) {
      if (link.boardId === id) this.links.delete(token);
    }
  }

  async memberRole(
    boardId: string,
    userId: string,
    lookupOrgRole?: (userId: string) => Promise<Role | undefined>,
  ): Promise<Role | undefined> {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    const orgRole = lookupOrgRole ? await lookupOrgRole(userId) : undefined;
    if (board.ownerId === userId || orgRole === "owner") return "owner";
    const boardRole = this.memberRows.get(memberKey(boardId, userId))?.role;
    return effectiveBoardRole(orgRole, boardRole);
  }

  async members(boardId: string): Promise<BoardMember[]> {
    return [...this.memberRows.values()]
      .filter((m) => m.boardId === boardId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async setMember(member: BoardMember): Promise<void> {
    this.memberRows.set(memberKey(member.boardId, member.userId), member);
  }

  async removeMember(boardId: string, userId: string): Promise<void> {
    this.memberRows.delete(memberKey(boardId, userId));
  }

  async createShareLink(link: ShareLink): Promise<void> {
    this.links.set(link.token, link);
  }

  async shareLinkByToken(token: string): Promise<ShareLink | undefined> {
    return this.links.get(token);
  }

  async shareLinks(boardId: string): Promise<ShareLink[]> {
    return [...this.links.values()]
      .filter((l) => l.boardId === boardId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async revokeShareLinks(boardId: string, at: number, token?: string): Promise<number> {
    let revoked = 0;
    for (const link of this.links.values()) {
      if (link.boardId !== boardId) continue;
      if (token !== undefined && link.token !== token) continue;
      if (link.revokedAt !== null) continue;
      this.links.set(link.token, { ...link, revokedAt: at });
      revoked += 1;
    }
    return revoked;
  }

  /**
   * Allocates the seq the same way Postgres does, including the losing-write
   * answer. There is no primary-key race to lose inside one event loop, so
   * `lost` is unreachable here and every stale caller comes back as `conflict`
   * -- which is the point: two Rooms sharing one of these stores reproduce
   * contention, and the code paths that handle it, with no database in the test.
   *
   * Stage B idempotency mirrors the Postgres partial unique index: a replayed
   * requestId returns the original seq with `duplicate: true` and writes
   * nothing — the retry of a network call must not become a second edit.
   */
  async appendOp(entry: OpAppend): Promise<AppendResult> {
    if (entry.requestId !== undefined) {
      const list0 = this.logs.get(entry.boardId) ?? [];
      const existing = list0.find((e) => e.requestId === entry.requestId);
      if (existing) {
        return { ok: true, seq: existing.seq, duplicate: true, operationId: existing.operationId };
      }
    }
    const list = this.logs.get(entry.boardId) ?? [];
    const head = list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
    const seq = head + 1;
    if (entry.expectedSeq !== undefined && entry.expectedSeq !== seq) {
      return { ok: false, reason: "conflict", head };
    }
    const operationId = entry.operationId ?? newOperationId();
    list.push({
      seq,
      ops: entry.ops,
      by: entry.by,
      label: entry.label,
      at: entry.at,
      ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
      operationId,
      actor: entry.actor ?? { actorType: "user", actorId: entry.by, initiatedBy: entry.by },
    });
    this.logs.set(entry.boardId, list);
    return { ok: true, seq, operationId };
  }

  async loadLog(boardId: string, fromSeq?: number): Promise<LoggedOpEntry[]> {
    const list = this.logs.get(boardId) ?? [];
    const from = fromSeq ?? 0;
    return from > 0 ? list.filter((e) => e.seq > from) : list.slice();
  }

  async findRequest(boardId: string, requestId: string): Promise<LoggedOpEntry | undefined> {
    const list = this.logs.get(boardId) ?? [];
    return list.find((e) => e.requestId === requestId);
  }

  async latestSeq(boardId: string): Promise<number> {
    const list = this.logs.get(boardId) ?? [];
    return list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
  }

  async latestSnapshot(boardId: string): Promise<BoardSnapshot | undefined> {
    const list = this.snapshots.get(boardId);
    if (!list || list.length === 0) return undefined;
    return list.reduce((best, s) => (s.seq > best.seq ? s : best));
  }

  async putSnapshot(
    boardId: string,
    seq: number,
    workspace: Workspace,
    at = Date.now(),
  ): Promise<void> {
    const list = (this.snapshots.get(boardId) ?? []).filter((s) => s.seq !== seq);
    list.push({ seq, workspace, createdAt: at });
    list.sort((a, b) => a.seq - b.seq);
    this.snapshots.set(boardId, list);
  }

  async pruneLog(boardId: string, upToSeq: number, olderThan?: number): Promise<number> {
    const snapshot = await this.latestSnapshot(boardId);
    if (!snapshot) return 0; // no snapshot, no floor, nothing may go
    const floor = Math.min(upToSeq, snapshot.seq);
    const list = this.logs.get(boardId) ?? [];
    const kept = list.filter(
      (e) => !(e.seq <= floor && (olderThan === undefined || e.at <= olderThan)),
    );
    this.logs.set(boardId, kept);
    return list.length - kept.length;
  }

  async pruneSnapshots(boardId: string, keep: number): Promise<number> {
    const list = this.snapshots.get(boardId) ?? [];
    if (list.length <= keep) return 0;
    this.snapshots.set(boardId, list.slice(list.length - keep));
    return list.length - keep;
  }
}

function memberKey(boardId: string, userId: string): string {
  return `${boardId} ${userId}`;
}
