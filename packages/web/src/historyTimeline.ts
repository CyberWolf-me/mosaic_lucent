import type { BoardHistoryItem } from "./boards.js";

/**
 * Server-timeline presentation helpers (Stage C1). Pure, node-tested — the
 * web suite runs without a DOM, so everything the history view decides it
 * renders lives here and the component only lays it out.
 */

export interface HistoryDay {
  /** Sort key: the UTC date the entries fall on, `YYYY-MM-DD`. */
  key: string;
  /** Human label: Today / Yesterday / the date. */
  label: string;
  items: BoardHistoryItem[];
}

/**
 * Group the timeline by calendar day, newest day first, entries newest-first
 * within a day (the order the route already returns). Local-time day
 * boundaries — "yesterday's meeting" is a wall-clock question, and the
 * timeline's reader is in that timezone, not UTC.
 */
export function groupHistoryByDay(items: BoardHistoryItem[], now = Date.now()): HistoryDay[] {
  const dayKey = (at: number) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  };
  const labelFor = (key: string): string => {
    const [y, m, d] = key.split("-").map(Number);
    const today = new Date(now);
    const todayKey = dayKey(now);
    const yesterday = new Date(now);
    yesterday.setDate(today.getDate() - 1);
    if (key === todayKey) return "Today";
    if (key === dayOf(yesterday)) return "Yesterday";
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const thisYear = y === today.getFullYear();
    return `${months[(m ?? 1) - 1]} ${d}${thisYear ? "" : `, ${y}`}`;
  };
  const dayOf = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(
      2,
      "0",
    )}`;

  const byDay = new Map<string, BoardHistoryItem[]>();
  for (const item of items) {
    const key = dayKey(item.at);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, dayItems]) => ({ key, label: labelFor(key), items: dayItems }));
}

/**
 * The depth banner's copy (Stage C1's honest-window contract, as UI): says
 * what is visible, what the plan allows, and where the rest went — never
 * "the board begins here". Null when the window is the whole log.
 */
export function depthBanner(history: {
  hasMore: boolean;
  historyDepth: number | null;
  items: unknown[];
}): string | null {
  if (!history.hasMore) return null;
  const depth = history.historyDepth;
  if (depth === null) return null; // unlimited plan: nothing is hidden
  return `You're seeing the latest ${depth} revisions of this board. Older history is kept — upgrade your plan to see further back.`;
}

/**
 * Map a citation to its jump action (the same mapping workspace.onCitation
 * performs; exported so tests pin the contract the chips and the history
 * rows share). `null` for a kind the view cannot navigate.
 */
export function citationTarget(citation: {
  kind: string;
  id: string;
  turnRange?: [number, number];
}):
  | { view: "canvas"; param: ["reveal", string] }
  | { view: "meeting"; params: [string, string][] }
  | { view: "history"; param: ["rev", string] }
  | null {
  if (citation.kind === "node") return { view: "canvas", param: ["reveal", citation.id] };
  if (citation.kind === "meeting") {
    const params: [string, string][] = [["meeting", citation.id]];
    if (citation.turnRange) params.push(["turn", String(citation.turnRange[0])]);
    return { view: "meeting", params };
  }
  if (citation.kind === "revision") return { view: "history", param: ["rev", citation.id] };
  return null;
}

/* -------------------------------------------------------------------------- */
/* The merged project chronology (Stage C3)                                   */
/* -------------------------------------------------------------------------- */

import type { MeetingTranscript } from "./meetings.js";

/** One row of the merged chronology: a revision, a meeting, or a statement event. */
export type ChronologyRow =
  | { kind: "revision"; at: number; item: BoardHistoryItem }
  | { kind: "meeting"; at: number; meeting: MeetingTranscript }
  | { kind: "statement"; at: number; item: BoardHistoryItem };

/**
 * Merge the three streams of a project's life into one newest-first
 * chronology: revision rows (the timeline as C1 shipped it), meeting markers
 * (a meeting happened — its turns live behind the row), and statement rows
 * (a revision whose ops attached or changed a statement, rendered as its
 * own semantic event — "decision made" — in addition to the plain revision).
 *
 * A statement-carrying revision yields TWO rows: the semantic one first
 * (newest-first: the statement event is the point of the revision, the
 * revision line the detail), then the revision itself. Pure over its
 * inputs; the view only lays the rows out.
 */
export function mergeChronology(
  items: BoardHistoryItem[],
  meetings: MeetingTranscript[],
): ChronologyRow[] {
  const rows: ChronologyRow[] = [];
  for (const item of items) {
    if (item.statementEvent) {
      rows.push({ kind: "statement", at: item.at, item });
    }
    rows.push({ kind: "revision", at: item.at, item });
  }
  for (const meeting of meetings) {
    rows.push({ kind: "meeting", at: meeting.startedAt, meeting });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/**
 * Group a chronology by local calendar day — the same day boundaries and
 * labels as groupHistoryByDay, over the merged rows. Reuses the label
 * logic; the row order inside a day is the merge order (newest first).
 */
export function chronologyByDay(
  rows: ChronologyRow[],
  now = Date.now(),
): Array<{ key: string; label: string; rows: ChronologyRow[] }> {
  const dayKey = (at: number) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  };
  const dayOf = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(
      2,
      "0",
    )}`;
  const labelFor = (key: string): string => {
    const [y, m, d] = key.split("-").map(Number);
    const today = new Date(now);
    if (key === dayOf(today)) return "Today";
    const yesterday = new Date(now);
    yesterday.setDate(today.getDate() - 1);
    if (key === dayOf(yesterday)) return "Yesterday";
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    return `${months[(m ?? 1) - 1]} ${d}${y === today.getFullYear() ? "" : `, ${y}`}`;
  };
  const byDay = new Map<string, ChronologyRow[]>();
  for (const row of rows) {
    const key = dayKey(row.at);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, dayRows]) => ({ key, label: labelFor(key), rows: dayRows }));
}

/** The count of classified turns in a meeting, for the meeting row's sub-line. */
export function classifiedTurns(meeting: MeetingTranscript): number {
  return meeting.turns.filter((t) => t.kind).length;
}
