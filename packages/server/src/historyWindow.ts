import type { LoggedOpEntry } from "./boards.js";

/**
 * The visible-history window (Stage C1): one piece of arithmetic shared by the
 * history route and the ask route, so the two can never disagree about what a
 * caller may see.
 *
 * The window is an ACCESS BOUNDARY, not a retention policy (ADR 0019):
 * `history.depth` (Free 25 / Pro 500 / unlimited) bounds what a caller may
 * READ, while the op log itself keeps everything above the newest snapshot
 * floor. Nothing is deleted to enforce a plan, so an upgrade reveals older
 * history instantly — the model the reviewer approved over destructive caps.
 *
 * `seq` IS the revision number, and the log is dense above the snapshot floor:
 * prefix pruning (ADR 0010) removes only entries at/below the newest
 * snapshot's seq, so the surviving log is exactly the seqs in
 * `(baseSeq, head]`. That makes window math subtraction rather than a scan,
 * and makes "hasMore" exact — the count of excluded-but-existing revisions is
 * `fromSeq - baseSeq - 1`.
 */

/**
 * The response ceiling when the plan is unlimited. Not a product limit — a
 * bound on one HTTP response, so a never-pruned 50k-entry log cannot become a
 * single giant payload. Ask digests cap lower still (askContext); the history
 * UI receives at most this many entries per request.
 */
export const MAX_HISTORY_WINDOW = 2000;

/** What the caller may see, once computed. */
export interface HistoryWindow {
  /** The newest seq the caller may see (= the board's head). */
  head: number;
  /** The oldest seq the caller may see. */
  fromSeq: number;
  /** The plan's depth that produced this window; null when unlimited. */
  depth: number | null;
  /** The effective window size (depth, or MAX_HISTORY_WINDOW when unlimited). */
  limit: number;
  /** True when revisions exist that this window excludes. */
  hasMore: boolean;
  /** The seq of the newest snapshot — the log's floor. Entries at/below it are compacted. */
  baseSeq: number;
}

/**
 * Compute the window. `depth` is the entitlement's limit (`null` =
 * unlimited); `baseSeq` is the newest snapshot's seq (0 when none), i.e. the
 * log's floor; `head` is `latestSeq`.
 */
export function historyWindow(head: number, depth: number | null, baseSeq: number): HistoryWindow {
  const limit = depth !== null ? Math.min(depth, MAX_HISTORY_WINDOW) : MAX_HISTORY_WINDOW;
  const newest = Math.max(0, head);
  // A snapshot at (or past) the head means the claimed floor sits AHEAD of
  // every entry that exists (found live: 2026-09-10). Room eviction
  // snapshots the current head on last-peer-leave while the in-memory store
  // never prunes — so baseSeq == head, `firstExisting` lands at head + 1,
  // and a window computed from it starts past the head: loadLog(fromSeq - 1)
  // returns NOTHING and History/Ask rendered an empty timeline over a
  // 7-entry log. The density assumption below ("everything at/below the
  // snapshot was pruned") is simply false here; the log still holds every
  // revision. Fall back to the whole surviving log, capped by `limit`.
  const floorPastHead = Math.max(0, baseSeq) >= newest && newest > 0;
  if (floorPastHead) {
    const fallbackFrom = Math.max(1, newest - limit + 1);
    return {
      head,
      fromSeq: fallbackFrom,
      depth,
      limit,
      // Dense from 1 to head in this branch, so `hasMore` is exact: entries
      // before the fallback start exist and this window excludes them.
      hasMore: fallbackFrom > 1,
      baseSeq,
    };
  }
  // Oldest seq that still exists in the log: everything at/below the newest
  // snapshot was pruned away, so the first survivor is baseSeq + 1.
  const firstExisting = Math.max(0, baseSeq) + 1;
  // The oldest seq the caller may see: no further back than the log goes,
  // and no further forward than `limit` revisions behind the head.
  const fromSeq = Math.max(firstExisting, newest - limit + 1);
  // Exact because of density: everything in [fromSeq-1 ... firstExisting) exists
  // and is excluded. Entries at/below baseSeq are compacted, not hidden — they
  // are nobody's older history, so they never count toward hasMore.
  const hasMore = fromSeq > firstExisting;
  return { head, fromSeq, depth, limit, hasMore, baseSeq };
}

/**
 * The `fromSeq` to hand `loadLog` so the window's oldest entry is included:
 * `loadLog` reads entries with seq STRICTLY greater than its argument, so a
 * window starting at `fromSeq` must load from `fromSeq - 1`. `fromSeq - 1`
 * is never negative (fromSeq >= 1) and 0 means "from the beginning", which
 * is what loadLog already does when given 0.
 */
export function loadLogFromSeq(window: HistoryWindow): number {
  return Math.max(0, window.fromSeq - 1);
}

/**
 * Slice the loaded log to the window, newest first. `loadLog` already returns
 * ascending entries inside the window, so this only trims any overflow (a
 * race between window computation and the read) and reverses to newest-first
 * — the order both the API response and the model's context want.
 */
export function windowedEntries(log: LoggedOpEntry[], window: HistoryWindow): LoggedOpEntry[] {
  const inWindow = log.filter((e) => e.seq >= window.fromSeq && e.seq <= window.head);
  const tail = inWindow.slice(Math.max(0, inWindow.length - window.limit));
  return tail.reverse();
}
