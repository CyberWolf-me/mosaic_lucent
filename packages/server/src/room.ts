import {
  applyOperations,
  validateOperations,
  isHumanOnlyOperation,
  stampAuthorship,
  type Operation,
  type Workspace,
} from "@lucent/core";
import type { Role } from "./identity.js";
import { roleAtLeast } from "./identity.js";
import type { AppendResult, BoardSnapshot } from "./boards.js";
/**
 * A collaboration room: the server-authoritative sync engine for one board
 * (docs/03, docs/12). Transport-free on purpose — it takes operations and
 * presence in, returns what to broadcast, and never touches a socket. The
 * WebSocket layer (realtime.ts) is a thin adapter over this, and these mechanics
 * are unit-testable without a network.
 *
 * The model chosen (per the design discussion) is a validated operation log, not
 * a CRDT: each op is validated against real server state and assigned a sequence
 * number, so a conflicting edit — "connect to a node someone just deleted" — is
 * rejected rather than silently merged into an invalid board.
 */

export interface LoggedOp {
  /** Monotonic sequence number; the client's cursor into the log. */
  seq: number;
  ops: Operation[];
  by: string;
  label: string;
  at: number;
  /** Server-generated batch id; what an ack names (Stage B). */
  operationId?: string;
  /** The idempotency key the submit carried, when it had one. */
  requestId?: string;
}

/** A participant's live presence: cursor, viewport hint, and selection. */
export interface Presence {
  userId: string;
  name: string;
  /** Cursor in content coordinates; null when off-canvas. */
  cursor: { x: number; y: number } | null;
  /** Object ids the participant currently has selected. */
  selection: string[];
  color: string;
  updatedAt: number;
}

export interface CommitResult {
  ok: boolean;
  /** The accepted, sequenced entry to broadcast (on success). */
  entry?: LoggedOp;
  /** Why it was refused (on failure). */
  error?: "permission" | "validation" | "empty" | "stale";
  detail?: string;
  /**
   * Entries written by another instance that this commit pulled in to catch up
   * before retrying. The caller has to broadcast them: local clients have never
   * seen them, and a room that quietly advanced past them would leave every
   * socket on this instance a few seqs behind with no way to notice.
   */
  absorbed?: LoggedOp[];
  /** The log head as the losing append saw it (on `stale`). */
  head?: number;
  /**
   * The idempotency key this commit carried, echoed back on every answer.
   * On `duplicate`, the entry's original seq rides `head` (there is no fresh
   * entry to name it).
   */
  requestId?: string;
  /**
   * True when the allocator already wrote the entry to durable state. The
   * caller then skips its own `appendOp` — running both would write the batch
   * twice. False for the default local allocator (tests, single-process dev),
   * where persistence stays the caller's job.
   */
  persisted?: boolean;
  /**
   * True when this submit was a REPLAY of a requestId the log already holds
   * (Stage B idempotency): nothing was applied and no entry exists to
   * broadcast — `entry` is the caller's own batch echoed back so the ack can
   * name the original seq. Callers must not re-broadcast on duplicate.
   */
  duplicate?: boolean;
}

/**
 * Allocates the next seq durably and writes the entry there (M3).
 *
 * This is the whole reason `commit` is async. It used to compute
 * `this.log.length + 1`, which is a correct sequence only while one process owns
 * the board; the number has to come from wherever uniqueness is enforced, so the
 * room asks for it and finds out whether it got it.
 */
export type OpAllocator = (
  entry: Omit<LoggedOp, "seq"> & { expectedSeq: number },
) => Promise<AppendResult>;

/** Fetches entries after `fromSeq`, so a losing commit can catch up and retry. */
export type OpFetcher = (fromSeq: number) => Promise<LoggedOp[]>;

export interface RoomOptions {
  /** Durable allocator. Omitted: the room allocates locally (single process). */
  append?: OpAllocator;
  /** Reader for entries another writer added. Omitted: a losing commit cannot retry. */
  fetch?: OpFetcher;
  /**
   * The seq the initial workspace is the state after -- a snapshot's seq, or the
   * head of a log whose entries were pruned. Below it the room cannot produce
   * catchup and says so (`canCatchUp`), which is what makes a reseed possible
   * instead of a silently truncated replay.
   */
  baseSeq?: number;
  /** How many times a losing commit re-validates against the winner. Default 1. */
  maxRetries?: number;
}

/** Stable per-user cursor colour, so a participant looks the same to everyone. */
const PRESENCE_COLORS = [
  "oklch(0.72 0.15 25)",
  "oklch(0.72 0.11 235)",
  "oklch(0.78 0.11 155)",
  "oklch(0.72 0.13 300)",
  "oklch(0.80 0.13 75)",
  "oklch(0.75 0.10 190)",
];

export function colorForUser(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]!;
}

export class Room {
  readonly boardId: string;
  private workspace: Workspace;
  private readonly log: LoggedOp[] = [];
  /** userId → role, for permission checks. */
  private readonly roles = new Map<string, Role>();
  /** Highest seq this room has applied. */
  private head: number;
  /** Lowest seq the log can still serve; below it only a reseed is honest. */
  private readonly baseSeq: number;
  private readonly append: OpAllocator;
  private readonly fetch: OpFetcher;
  private readonly maxRetries: number;
  /** Whether the allocator persists (governs the caller's duplicate-write guard). */
  private readonly durable: boolean;
  /** Serialises `commit` — see the comment there. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * In-memory presence index keyed by userId. The migration
   * `0010_high_morph.sql` provisions a Postgres `presence` table for the
   * scale-out work (M3); threading `PresenceStore` through the constructor
   * is the planned follow-up, but the in-memory map keeps the WS seam
   * working in the meantime and the unit tests green.
   */
  private readonly presence = new Map<string, Presence>();
  /**
   * requestId → the seq it committed at (Stage B). The replay guard: a retried
   * submit is recognized by its KEY, not by re-validating its ops — the world
   * has moved since the original landed, so a retried CREATE would fail
   * validation ("already exists") and a retried MOVE would double-apply. The
   * map is seeded from the replayed log at construction and updated on every
   * commit, so a room that restarts mid-board still recognizes replays of
   * anything in its log.
   */
  private readonly committedRequests = new Map<string, number>();

  constructor(
    boardId: string,
    initial: Workspace,
    ownerId: string,
    initialLog?: LoggedOp[],
    options: RoomOptions = {},
  ) {
    this.boardId = boardId;
    this.workspace = initial;
    this.roles.set(ownerId, "owner");
    this.baseSeq = options.baseSeq ?? 0;
    this.head = this.baseSeq;
    if (initialLog && initialLog.length > 0) {
      // Replay the persisted log so the room's internal cursor matches the
      // durable state. Entries are already validated and applied at write
      // time, so we just trust the workspace snapshot + log ordering.
      for (const entry of initialLog) {
        this.log.push(entry);
        if (entry.requestId !== undefined) this.committedRequests.set(entry.requestId, entry.seq);
      }
      this.head = Math.max(this.head, initialLog[initialLog.length - 1]?.seq ?? 0);
    }
    this.maxRetries = options.maxRetries ?? 1;
    // Default allocator: local, monotonic, and correct for exactly one process.
    // Unit tests and single-instance dev use it; anything with a database passes
    // the store's, which is where the uniqueness constraint lives.
    this.append = options.append ?? (async () => ({ ok: true as const, seq: this.head + 1 }));
    // With the default allocator nothing durable was written — persistence
    // stays the caller's job (realtime.ts appends after a successful commit).
    // With a real allocator the entry is already in the store when commit
    // returns, and the caller must not write it a second time.
    this.durable = options.append !== undefined;
    // Default fetcher: nothing to catch up to, because nobody else is writing.
    this.fetch = options.fetch ?? (async () => []);
  }

  /**
   * Rebuild a room from a snapshot plus the entries after it (M3).
   *
   * The point of snapshots: a board with 50k entries used to replay all 50k on
   * the first join. Here the workspace starts at the snapshot and only the tail
   * is applied, and `baseSeq` records that entries below the snapshot are gone --
   * so a client asking for catchup from before it gets a reseed rather than a
   * replay with a hole in it.
   */
  static fromSnapshot(
    boardId: string,
    snapshot: BoardSnapshot,
    after: LoggedOp[],
    ownerId: string,
    options: RoomOptions = {},
  ): Room {
    const room = new Room(boardId, snapshot.workspace, ownerId, after, {
      ...options,
      baseSeq: snapshot.seq,
    });
    return room;
  }

  /** Grant or change a member's role. */
  setRole(userId: string, role: Role): void {
    this.roles.set(userId, role);
  }

  roleOf(userId: string): Role | undefined {
    return this.roles.get(userId);
  }

  current(): Workspace {
    return this.workspace;
  }

  /** Current sequence number; a client with this cursor is up to date. */
  version(): number {
    // The head, not the log length: entries absorbed from another instance
    // (and any pruned below a snapshot) make the two diverge, and the cursor
    // a client reports is a seq, which only the head means.
    return this.head;
  }

  /**
   * Commit a batch from one participant. Validates against live state, asks the
   * allocator for a sequence number, and returns the entry to broadcast.
   * Editing requires at least the editor role; a viewer is refused.
   *
   * Async, and routed through the allocator, because a sequence number is a
   * fact about the durable log, not about this process's memory: with two
   * instances serving one board, `log.length + 1` is a guess that loses to
   * whoever commits first (M3). On a conflict the loser pulls the winner's
   * entries in through the fetcher, applies them, re-validates its own ops
   * against the state that actually won, and retries — so a batch is refused
   * only when it is genuinely invalid against the merged state, never merely
   * because someone else got there first.
   */
  async commit(
    userId: string,
    ops: Operation[],
    label = "",
    meta?: { requestId?: string },
  ): Promise<CommitResult> {
    const role = this.roles.get(userId);
    if (!role || !roleAtLeast(role, "editor")) {
      return { ok: false, error: "permission", detail: "editor role required" };
    }
    // The replay guard runs BEFORE validation, on the queue: the world has
    // moved since the original landed, so recognizing a retry by re-checking
    // its ops would answer a retried CREATE with "already exists" and
    // double-apply a retried MOVE. The KEY is the identity of the request;
    // its outcome is already in the log, and the answer is that outcome.
    // (The allocator's own duplicate handling stays as the durable backstop
    // for a two-instance race this room's map cannot see.)
    if (meta?.requestId !== undefined) {
      const seq = this.committedRequests.get(meta.requestId);
      if (seq !== undefined) {
        const run = this.queue.then(() =>
          Promise.resolve({
            ok: true as const,
            persisted: true,
            duplicate: true as const,
            head: seq,
            requestId: meta.requestId,
          }),
        );
        this.queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }
    }
    // The AI-only guard also applies to humans: coordinates come from layout,
    // except MOVE_NODE which is explicitly a human op and allowed here.
    const filtered = ops.filter((op) => op.op === "MOVE_NODE" || !isHumanOnlyOperation(op.op));
    if (filtered.length === 0) return { ok: false, error: "empty" };

    // Stamp authorship: the connection's user owns every authored op in the
    // batch, whatever `by` the client sent, so comments/votes/reactions are
    // attributable end-to-end and nobody can post as a peer (M0.4).
    const authored = stampAuthorship(filtered, userId);

    // One commit at a time: between the validation and the append the room's
    // state must not move under us. The chain keeps commits in arrival order;
    // a rejected commit must not poison the chain, hence the catch-and-drop.
    const run = this.queue.then(() => this.commitQueued(authored, userId, label, meta));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The awaited body of `commit`; all state access happens on the queue. */
  private async commitQueued(
    authored: Operation[],
    userId: string,
    label: string,
    meta?: { requestId?: string },
  ): Promise<CommitResult> {
    const absorbed: LoggedOp[] = [];
    for (let attempt = 0; ; attempt += 1) {
      // Re-validated every round: after absorbing a winner's entries the
      // state this batch was checked against no longer exists.
      const errors = validateOperations(this.workspace, authored);
      if (errors.length > 0) {
        return {
          ok: false,
          error: "validation",
          detail: errors[0]?.message,
          // The head at refusal: without it a rejected submitter cannot tell
          // how stale the state it validated against was. On validation the
          // room has not moved during this attempt, so this.head IS the head.
          head: this.head,
          ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
        };
      }

      const result = await this.append({
        ops: authored,
        by: userId,
        label,
        at: Date.now(),
        expectedSeq: this.head + 1,
        ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
      });

      if (result.ok) {
        // A replayed requestId: the log already holds this batch at its own
        // seq. Nothing to apply (it is in the room's replayed state wherever
        // the room was built from the log), nothing to broadcast (peers saw
        // the original), and the caller's ack must name the ORIGINAL seq so
        // the retrying client learns where its edit actually landed.
        if (result.duplicate) {
          return {
            ok: true,
            persisted: true,
            duplicate: true,
            head: result.seq,
            ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
            ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
          };
        }
        const entry: LoggedOp = {
          seq: result.seq,
          ops: authored,
          by: userId,
          label,
          at: Date.now(),
          ...(result.operationId !== undefined ? { operationId: result.operationId } : {}),
          ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
        };
        this.workspace = applyOperations(this.workspace, authored);
        this.log.push(entry);
        this.head = result.seq;
        if (entry.requestId !== undefined) {
          this.committedRequests.set(entry.requestId, entry.seq);
        }
        return {
          ok: true,
          entry,
          persisted: this.durable,
          ...(absorbed.length > 0 ? { absorbed } : {}),
          ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
        };
      }

      if (attempt >= this.maxRetries) {
        return {
          ok: false,
          error: "stale",
          head: result.head,
          ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
        };
      }

      // Someone else owns `head + 1`. Pull in everything we lack, advance,
      // and let the next round's validation decide whether our batch still
      // makes sense against the state that actually won.
      const remote = await this.fetch(this.head);
      for (const entry of remote) {
        if (entry.seq <= this.head) continue; // we already have it
        this.workspace = applyOperations(this.workspace, entry.ops);
        this.log.push(entry);
        this.head = entry.seq;
        absorbed.push(entry);
      }
    }
  }

  /** Log entries a client needs to catch up from its cursor. */
  since(seq: number): LoggedOp[] {
    return this.log.filter((e) => e.seq > seq);
  }

  /**
   * Pull entries another instance wrote, apply them, and hand them back for
   * broadcast. This is the receiving half of the fanout contract: a bus
   * message only says "the log moved" — the entries come from the store
   * through the same fetcher a losing commit uses, so notification and
   * replay agree on where the truth lives. Runs on the commit queue, so it
   * cannot interleave with a commit's validate-append-retry rounds.
   */
  async pullRemote(): Promise<LoggedOp[]> {
    const run = this.queue.then(() => this.pullRemoteQueued());
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pullRemoteQueued(): Promise<LoggedOp[]> {
    const remote = await this.fetch(this.head);
    const absorbed: LoggedOp[] = [];
    for (const entry of remote) {
      if (entry.seq <= this.head) continue; // already applied
      this.workspace = applyOperations(this.workspace, entry.ops);
      this.log.push(entry);
      this.head = entry.seq;
      absorbed.push(entry);
    }
    return absorbed;
  }

  /**
   * Append a pre-validated entry to the log without going through `commit`.
   * Used when reconstructing the room from a persisted log at cold start —
   * the entries are already sequenced and applied to the workspace, so we
   * just need them indexed for catchup.
   */
  replay(entry: LoggedOp): void {
    this.log.push(entry);
  }

  /** Record or clear a participant's presence; returns the merged record. */
  updatePresence(
    userId: string,
    name: string,
    update: { cursor?: { x: number; y: number } | null; selection?: string[] },
  ): Presence {
    const existing = this.presence.get(userId);
    const next: Presence = {
      userId,
      name,
      cursor: update.cursor !== undefined ? update.cursor : (existing?.cursor ?? null),
      selection: update.selection ?? existing?.selection ?? [],
      color: existing?.color ?? colorForUser(userId),
      updatedAt: Date.now(),
    };
    this.presence.set(userId, next);
    return next;
  }

  removePresence(userId: string): void {
    this.presence.delete(userId);
  }

  /** Everyone currently present, optionally excluding one user. */
  peers(exceptUserId?: string): Presence[] {
    return [...this.presence.values()].filter((p) => p.userId !== exceptUserId);
  }

  /** True when nobody is present — the room can be evicted. */
  isEmpty(): boolean {
    return this.presence.size === 0;
  }
}
