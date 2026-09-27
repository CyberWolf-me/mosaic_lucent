import {
  isBlockedRow,
  statementRows,
  type StatementKind,
  type StatementRow,
  type StatementStatus,
} from "@lucent/core";
import type { BoardStore, StoredBoard } from "./boards.js";

/**
 * The workspace intelligence index (docs/26 J3, ADR 0046).
 *
 * Every board's statements, derived by core's `statementRows` — the same rows
 * the board's own Intelligence view renders — kept per board with the board
 * revision they came from. It is a projection (ADR 0040): no route writes it,
 * a board's rows are replaced wholesale on every re-derivation, and the whole
 * thing can be dropped and rebuilt from the boards.
 *
 * Reads never go around board access: the routes hand in the boards the
 * caller can read, and the index answers only from those.
 */

/** One indexed statement: the core row plus where it lives. */
export interface IndexedStatement extends StatementRow {
  boardId: string;
  orgId: string;
  /** Blocked itself, or waiting on blocked work (stored, so it filters). */
  blocked: boolean;
}

export interface IndexFilter {
  kinds?: readonly StatementKind[];
  statuses?: readonly StatementStatus[];
}

export interface StatementIndexStore {
  /** Replace a board's rows and record the revision they derive from. */
  replaceBoard(
    boardId: string,
    orgId: string,
    rows: readonly StatementRow[],
    sourceAt: number,
    indexedAt: number,
  ): Promise<void>;
  /** Forget a board (deleted). */
  dropBoard(boardId: string): Promise<void>;
  /** The revision each board was derived from; missing = never indexed. */
  sourcesFor(boardIds: readonly string[]): Promise<Map<string, number>>;
  /** Rows on these boards, board by board in insertion order. */
  query(boardIds: readonly string[], filter?: IndexFilter): Promise<IndexedStatement[]>;
  /** Drop an org's whole index (the rebuild's first half). */
  clearOrg(orgId: string): Promise<void>;
}

/**
 * The stored form. `blockedBy` names upstream nodes on the board; the index
 * keeps only whether the work is blocked (the board resolves the rest), in
 * both stores alike.
 */
function toIndexed(row: StatementRow, boardId: string, orgId: string): IndexedStatement {
  const { blockedBy: _upstream, ...rest } = row;
  return { ...rest, boardId, orgId, blocked: isBlockedRow(row) };
}

function matches(row: IndexedStatement, filter: IndexFilter): boolean {
  if (filter.kinds?.length && !filter.kinds.includes(row.kind)) return false;
  if (filter.statuses?.length && !filter.statuses.includes(row.status)) return false;
  return true;
}

export class InMemoryStatementIndexStore implements StatementIndexStore {
  private readonly rows = new Map<string, IndexedStatement[]>();
  private readonly state = new Map<string, { orgId: string; sourceAt: number }>();

  async replaceBoard(
    boardId: string,
    orgId: string,
    rows: readonly StatementRow[],
    sourceAt: number,
  ): Promise<void> {
    this.rows.set(
      boardId,
      rows.map((r) => toIndexed(r, boardId, orgId)),
    );
    this.state.set(boardId, { orgId, sourceAt });
  }

  async dropBoard(boardId: string): Promise<void> {
    this.rows.delete(boardId);
    this.state.delete(boardId);
  }

  async sourcesFor(boardIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const id of boardIds) {
      const s = this.state.get(id);
      if (s) out.set(id, s.sourceAt);
    }
    return out;
  }

  async query(boardIds: readonly string[], filter: IndexFilter = {}) {
    const out: IndexedStatement[] = [];
    for (const id of boardIds) {
      for (const row of this.rows.get(id) ?? []) if (matches(row, filter)) out.push({ ...row });
    }
    return out;
  }

  async clearOrg(orgId: string): Promise<void> {
    for (const [id, s] of this.state) {
      if (s.orgId === orgId) {
        this.state.delete(id);
        this.rows.delete(id);
      }
    }
  }
}

/** How long a board's changes settle before it's re-derived. */
export const REINDEX_DEBOUNCE_MS = 750;
/** How many stale boards one read re-derives before answering. */
export const FRESHEN_BUDGET = 50;

interface IndexerOptions {
  debounceMs?: number;
  now?: () => number;
  onError?: (err: unknown, boardId: string) => void;
}

/**
 * Keeps the index in step with the boards. `observe` wraps a `BoardStore` so
 * every `put` — where the realtime room, the ops route, whole-board saves and
 * imports all end — schedules that board's re-derivation, and every `delete`
 * drops its rows. `freshen` is the read-time repair: whatever the observer
 * missed (a crash inside the debounce, a write through an unwrapped store, a
 * board from before the index existed) is re-derived when someone reads it.
 */
export class StatementIndexer {
  private readonly pending = new Map<string, { board: StoredBoard; timer: NodeJS.Timeout }>();
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown, boardId: string) => void;

  constructor(
    readonly store: StatementIndexStore,
    options: IndexerOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? REINDEX_DEBOUNCE_MS;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  /** A `BoardStore` that keeps this index current. Everything else passes through. */
  observe(boards: BoardStore): BoardStore {
    return new Proxy(boards, {
      get: (target, prop, receiver) => {
        if (prop === "put") {
          return async (board: StoredBoard) => {
            await target.put(board);
            this.schedule(board);
          };
        }
        if (prop === "delete") {
          return async (id: string) => {
            await target.delete(id);
            this.cancel(id);
            await this.store.dropBoard(id).catch((err) => this.onError(err, id));
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Re-derive this board once its changes settle. */
  schedule(board: StoredBoard): void {
    const existing = this.pending.get(board.id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(board.id);
      void this.indexBoard(board).catch((err) => this.onError(err, board.id));
    }, this.debounceMs);
    // A pending re-derivation must never hold the process open.
    timer.unref?.();
    this.pending.set(board.id, { board, timer });
  }

  private cancel(boardId: string): void {
    const existing = this.pending.get(boardId);
    if (existing) clearTimeout(existing.timer);
    this.pending.delete(boardId);
  }

  /**
   * Told what changed on a board that was already indexed — before and after,
   * in the stored form (ADR 0047's notifications). Never for a board indexed
   * for the first time: that is catching up, not news.
   */
  onChange?: (
    board: StoredBoard,
    before: readonly IndexedStatement[],
    after: readonly IndexedStatement[],
  ) => void;

  /** Derive and store one board's rows now. */
  async indexBoard(board: StoredBoard): Promise<void> {
    const rows = statementRows(board.workspace);
    const watching = this.onChange;
    const known = watching ? (await this.store.sourcesFor([board.id])).has(board.id) : false;
    const before = watching && known ? await this.store.query([board.id]) : [];
    await this.store.replaceBoard(board.id, board.orgId, rows, board.updatedAt, this.now());
    if (watching && known) {
      try {
        watching(board, before, await this.store.query([board.id]));
      } catch (err) {
        this.onError(err, board.id);
      }
    }
  }

  /** Run every pending re-derivation now (tests, shutdown). */
  async flush(): Promise<void> {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) clearTimeout(p.timer);
    for (const p of pending)
      await this.indexBoard(p.board).catch((err) => this.onError(err, p.board.id));
  }

  /**
   * Bring these boards' rows up to their current revision before a read:
   * re-derive any board never indexed, or indexed from an older revision, up
   * to `budget` boards. Returns how many were re-derived and how many stale
   * boards were left for the next read.
   */
  async freshen(
    boards: readonly StoredBoard[],
    budget = FRESHEN_BUDGET,
  ): Promise<{ reindexed: number; stale: number }> {
    const sources = await this.store.sourcesFor(boards.map((b) => b.id));
    const stale = boards.filter((b) => {
      const at = sources.get(b.id);
      return at === undefined || at < b.updatedAt;
    });
    const now = stale.slice(0, Math.max(0, budget));
    for (const board of now) {
      this.cancel(board.id);
      await this.indexBoard(board);
    }
    return { reindexed: now.length, stale: stale.length - now.length };
  }

  /** Drop an org's index and derive it again from these boards. */
  async rebuild(orgId: string, boards: readonly StoredBoard[]): Promise<number> {
    await this.store.clearOrg(orgId);
    for (const board of boards) await this.indexBoard(board);
    return boards.length;
  }
}
