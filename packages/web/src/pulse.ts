import type { Node, StatementKind, StatementStatus, Workspace } from "@lucent/core";
import {
  actionNodes,
  blockingChains,
  derivedExecution,
  executionRollup,
  isOverdueUnfinished,
  statementNodes,
  topicsAreVariants,
} from "@lucent/core";
import { inboxItems } from "./intelligence.js";

/**
 * The workspace pulse — what Home renders: *what needs me, what changed,
 * where do I pick up*, across every board this browser can read.
 *
 * A PROJECTION, like Intelligence and Execution: pure over the boards it is
 * handed and a `now`, never fetching, never storing, never inventing. The
 * caller passes what it already holds — the live current board, local
 * projects read from storage, and server boards it hasn't loaded, which come
 * either with their statements from the workspace index (`indexed`, ADR 0046)
 * or by name only (both null), appearing in the recent list without items.
 * Every item carries the board and node it came from, so every row on Home is
 * one click from the thing itself.
 */

/**
 * A statement as the workspace index serves it (orgProjects.ts) — enough for
 * a pulse row without the board's workspace.
 */
export interface IndexedPulseRow {
  id: string;
  kind: StatementKind;
  status: StatementStatus;
  label: string;
  blocked: boolean;
  assignee?: string;
  dueDate?: string;
  executionStatus?: string;
  provenance?: { meetingId: string; turnRange?: [number, number] };
}

export interface PulseBoardInput {
  /** Stable board key (the caller maps it back to how the board opens). */
  id: string;
  name: string;
  updatedAt: number;
  /** Null when only the name is known (a server board not fetched here). */
  workspace: Workspace | null;
  /**
   * A server board's statements from the workspace index, when its workspace
   * isn't loaded here. Rows only: no blocking chains or topic notices, which
   * need the board itself.
   */
  indexed?: readonly IndexedPulseRow[] | null;
  isCurrent: boolean;
}

/** Why an item needs someone: the strongest signal it carries. */
export type PulseSignal = "overdue" | "blocked" | "pending" | "open";

export interface PulseItem {
  boardId: string;
  boardName: string;
  /** The item lives on the board that is open right now. */
  isCurrent: boolean;
  /** The node — the reveal target. */
  nodeId: string;
  kind: StatementKind;
  status: StatementStatus;
  label: string;
  signal: PulseSignal;
  assignee?: string;
  /** ISO YYYY-MM-DD, when the work carries a deadline. */
  dueDate?: string;
  /** The work's execution status (issue.status), for actions. */
  executionStatus?: string;
  /** Actions only: blocked by hand or by an upstream (derived). An overdue
   * action can be blocked too — `signal` names the stronger of the two. */
  blocked?: boolean;
  /** The meeting this statement came from, when it has meeting evidence. */
  fromMeeting?: string;
  turnRange?: [number, number];
  /** Conversation evidence (ADR 0042): Lucent made this from a request typed
   * or spoken to the board, outside a meeting. Absent when a meeting is. */
  fromRequest?: { at: number; by?: string };
}

export interface PulseCounts {
  openQuestions: number;
  /** Open decisions — judgment calls not yet made. */
  pendingDecisions: number;
  openProposals: number;
  /** Executable actions (owner/status tracked) that are not finished. */
  openActions: number;
  overdue: number;
  blocked: number;
  openRisks: number;
}

/** One board as the "pick up where you left off" list shows it. */
export interface PulseBoardSummary {
  id: string;
  name: string;
  updatedAt: number;
  isCurrent: boolean;
  /** False only when the workspace is known and empty; null when unknown. */
  hasContent: boolean | null;
  nodes: number | null;
  statements: number | null;
  /** Items from this board in the pulse; null when the contents are unknown. */
  openItems: number | null;
  actions: { total: number; completed: number } | null;
}

/**
 * What Lucent noticed: signals derived from the boards themselves — a
 * blocking chain, the oldest overdue action, a question left open on a
 * topic that already has a decision, a topic authored two ways. Never a
 * canned sentence: no signal, no notice.
 */
export type PulseNotice =
  | {
      kind: "blocked-chain";
      boardId: string;
      boardName: string;
      /** The blocked target (last in the chain). */
      nodeId: string;
      /** Blocker-first: the manually blocked root → … → the target. */
      chain: Array<{ id: string; label: string }>;
    }
  | {
      kind: "overdue";
      boardId: string;
      boardName: string;
      nodeId: string;
      label: string;
      dueDate: string;
      assignee?: string;
      /** Other overdue actions across the boards, beyond this one. */
      others: number;
    }
  | {
      kind: "open-on-decided-topic";
      boardId: string;
      boardName: string;
      questionId: string;
      question: string;
      decisionId: string;
      decision: string;
      topic: string;
    }
  | {
      kind: "duplicate-topic";
      boardId: string;
      boardName: string;
      dup: string;
      existing: string;
      statements: number;
    };

export interface WorkspacePulse {
  /** Everything open, strongest signal first. */
  items: PulseItem[];
  counts: PulseCounts;
  /** Boards that contribute at least one item. */
  boardsWithItems: number;
  /** Boards whose contents are known and non-empty. */
  boardsWithContent: number;
  /** Every board, most recently edited first (the current board leads ties). */
  boards: PulseBoardSummary[];
  noticed: PulseNotice[];
}

/** How many notices Home shows: a card, not a feed. */
export const NOTICE_LIMIT = 3;

/** Signal priority: late work first, then calls awaiting judgment, then the rest. */
function rank(item: PulseItem): number {
  if (item.signal === "overdue") return 0;
  if (item.signal === "blocked") return 1;
  switch (item.kind) {
    case "decision":
      return 2;
    case "question":
      return 3;
    case "proposal":
      return 4;
    case "risk":
      return 5;
    default:
      return 6;
  }
}

function meetingOf(node: Node): { meetingId?: string; turnRange?: [number, number] } {
  const prov = node.provenance?.meetingId ? node.provenance : node.statement?.provenance;
  if (!prov?.meetingId) return {};
  return { meetingId: prov.meetingId, ...(prov.turnRange ? { turnRange: prov.turnRange } : {}) };
}

/** Conversation origin (ADR 0042), node-level first like meeting evidence. */
function requestOf(node: Node): { at: number; by?: string } | undefined {
  return node.provenance?.conversation ?? node.statement?.provenance?.conversation;
}

function hasContent(ws: Workspace): boolean {
  return Object.keys(ws.nodes).length + Object.keys(ws.shapes ?? {}).length > 0;
}

/** Boards in reading order: the open board first, then most recently edited. */
function ordered(boards: readonly PulseBoardInput[]): PulseBoardInput[] {
  return [...boards].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** The open items on one board, in insertion order. */
function boardItems(board: PulseBoardInput, ws: Workspace, now: number): PulseItem[] {
  const base = { boardId: board.id, boardName: board.name, isCurrent: board.isCurrent };
  const derived = derivedExecution(ws, now);
  const executable = new Set(actionNodes(ws).map((n) => n.id));
  const items: PulseItem[] = [];
  for (const node of statementNodes(ws)) {
    const statement = node.statement!;
    if (statement.status !== "open") continue;
    const meeting = meetingOf(node);
    const request = meeting.meetingId ? undefined : requestOf(node);
    const common = {
      ...base,
      nodeId: node.id,
      kind: statement.kind,
      status: statement.status,
      label: node.label,
      ...(node.issue?.assignee ? { assignee: node.issue.assignee } : {}),
      ...(node.issue?.dueDate ? { dueDate: node.issue.dueDate } : {}),
      ...(meeting.meetingId ? { fromMeeting: meeting.meetingId } : {}),
      ...(meeting.turnRange ? { turnRange: meeting.turnRange } : {}),
      ...(request ? { fromRequest: { ...request } } : {}),
    };
    if (statement.kind === "action") {
      // Only executable work counts (core's actionNodes: an action statement
      // that carries issue fields). A bare "we should…" is a statement, not
      // work — the same line the Execution view's rollup draws.
      if (!executable.has(node.id)) continue;
      const issue = node.issue!;
      if (issue.statusCategory === "done") continue;
      const d = derived.get(node.id);
      const blocked = issue.status === "blocked" || (d?.blockedBy.length ?? 0) > 0;
      const overdue = isOverdueUnfinished(issue.dueDate, issue.status, now);
      items.push({
        ...common,
        executionStatus: issue.status,
        ...(blocked ? { blocked } : {}),
        signal: overdue ? "overdue" : blocked ? "blocked" : "open",
      });
      continue;
    }
    if (statement.kind === "requirement") continue; // a standing need, not a call to make
    items.push({ ...common, signal: statement.kind === "decision" ? "pending" : "open" });
  }
  return items;
}

/** Work that is finished or dropped leaves the pulse (the index has no status category). */
const DONE_WORK = new Set(["completed", "cancelled"]);

/** The open items from a board's indexed rows — `boardItems`' rules, without the workspace. */
function indexedItems(
  board: PulseBoardInput,
  rows: readonly IndexedPulseRow[],
  now: number,
): PulseItem[] {
  const items: PulseItem[] = [];
  for (const row of rows) {
    if (row.status !== "open" || row.kind === "requirement") continue;
    const common = {
      boardId: board.id,
      boardName: board.name,
      isCurrent: board.isCurrent,
      nodeId: row.id,
      kind: row.kind,
      status: row.status,
      label: row.label,
      ...(row.assignee ? { assignee: row.assignee } : {}),
      ...(row.dueDate ? { dueDate: row.dueDate } : {}),
      ...(row.provenance?.meetingId ? { fromMeeting: row.provenance.meetingId } : {}),
      ...(row.provenance?.turnRange ? { turnRange: row.provenance.turnRange } : {}),
    };
    if (row.kind === "action") {
      // Executable work only, as on a loaded board: an action with issue fields.
      if (row.executionStatus === undefined || DONE_WORK.has(row.executionStatus)) continue;
      const overdue = isOverdueUnfinished(row.dueDate, row.executionStatus, now);
      items.push({
        ...common,
        executionStatus: row.executionStatus,
        ...(row.blocked ? { blocked: true } : {}),
        signal: overdue ? "overdue" : row.blocked ? "blocked" : "open",
      });
      continue;
    }
    items.push({ ...common, signal: row.kind === "decision" ? "pending" : "open" });
  }
  return items;
}

/**
 * The pulse across `boards` at `now`. Deterministic: the same boards and
 * the same `now` always produce the same pulse, in the same order.
 */
export function workspacePulse(boards: readonly PulseBoardInput[], now: number): WorkspacePulse {
  const inOrder = ordered(boards);
  const counts: PulseCounts = {
    openQuestions: 0,
    pendingDecisions: 0,
    openProposals: 0,
    openActions: 0,
    overdue: 0,
    blocked: 0,
    openRisks: 0,
  };
  const all: Array<{ item: PulseItem; seq: number }> = [];
  const summaries: PulseBoardSummary[] = [];
  const chainNotices: PulseNotice[] = [];
  const topicNotices: PulseNotice[] = [];
  const dupNotices: PulseNotice[] = [];
  let boardsWithContent = 0;
  const boardsWithItems = new Set<string>();

  const tally = (board: PulseBoardInput, items: readonly PulseItem[]) => {
    for (const item of items) {
      all.push({ item, seq: all.length });
      boardsWithItems.add(board.id);
      switch (item.kind) {
        case "question":
          counts.openQuestions += 1;
          break;
        case "decision":
          counts.pendingDecisions += 1;
          break;
        case "proposal":
          counts.openProposals += 1;
          break;
        case "risk":
          counts.openRisks += 1;
          break;
        case "action":
          counts.openActions += 1;
          if (item.signal === "overdue") counts.overdue += 1;
          // Overlapping, like the rollup: overdue AND blocked counts twice.
          if (item.blocked) counts.blocked += 1;
          break;
        default:
          break;
      }
    }
  };

  for (const board of inOrder) {
    const ws = board.workspace;
    if (!ws && board.indexed) {
      // Counted from the index: its statements, not its shapes, so a board
      // holding only sticky notes still reads as "unknown", not empty.
      const rows = board.indexed;
      const items = indexedItems(board, rows, now);
      tally(board, items);
      if (rows.length > 0) boardsWithContent += 1;
      const work = rows.filter((r) => r.kind === "action" && r.executionStatus !== undefined);
      summaries.push({
        id: board.id,
        name: board.name,
        updatedAt: board.updatedAt,
        isCurrent: board.isCurrent,
        hasContent: rows.length > 0 ? true : null,
        nodes: null,
        statements: rows.length,
        openItems: items.length,
        actions: {
          total: work.length,
          completed: work.filter((r) => r.executionStatus === "completed").length,
        },
      });
      continue;
    }
    if (!ws) {
      summaries.push({
        id: board.id,
        name: board.name,
        updatedAt: board.updatedAt,
        isCurrent: board.isCurrent,
        hasContent: null,
        nodes: null,
        statements: null,
        openItems: null,
        actions: null,
      });
      continue;
    }
    const content = hasContent(ws);
    if (content) boardsWithContent += 1;
    const items = boardItems(board, ws, now);
    tally(board, items);
    const rollup = executionRollup(ws, now);
    summaries.push({
      id: board.id,
      name: board.name,
      updatedAt: board.updatedAt,
      isCurrent: board.isCurrent,
      hasContent: content,
      nodes: Object.keys(ws.nodes).length,
      statements: statementNodes(ws).length,
      openItems: items.length,
      actions: { total: rollup.total, completed: rollup.completed },
    });

    // Signals. A blocking chain is a story ("Design is blocked → QA waits"),
    // so keep the longest per board.
    const chains = blockingChains(ws, now);
    const longest = chains.reduce<(typeof chains)[number] | undefined>(
      (best, c) => (!best || c.chain.length > best.chain.length ? c : best),
      undefined,
    );
    if (longest && longest.chain.length > 1) {
      chainNotices.push({
        kind: "blocked-chain",
        boardId: board.id,
        boardName: board.name,
        nodeId: longest.nodeId,
        chain: longest.chain.map((n) => ({ id: n.id, label: n.label })),
      });
    }
    // An open question on a topic the board has already decided — the
    // question may be answered already, or it may reopen the decision.
    const statements = statementNodes(ws);
    for (const q of statements) {
      if (q.statement!.kind !== "question" || q.statement!.status !== "open") continue;
      const topic = q.statement!.topic;
      if (!topic) continue;
      const decided = statements.find(
        (d) =>
          d.statement!.kind === "decision" &&
          d.statement!.status === "resolved" &&
          topicsAreVariants(d.statement!.topic ?? "", topic),
      );
      if (decided) {
        topicNotices.push({
          kind: "open-on-decided-topic",
          boardId: board.id,
          boardName: board.name,
          questionId: q.id,
          question: q.label,
          decisionId: decided.id,
          decision: decided.label,
          topic,
        });
        break; // one per board: a notice, not a list
      }
    }
    const dup = inboxItems(ws)[0];
    if (dup) {
      dupNotices.push({
        kind: "duplicate-topic",
        boardId: board.id,
        boardName: board.name,
        dup: dup.dup,
        existing: dup.existing,
        statements: dup.dupStatements + dup.existingStatements,
      });
    }
  }

  const items = all
    .sort((a, b) => rank(a.item) - rank(b.item) || a.seq - b.seq)
    .map((entry) => entry.item);

  // The oldest overdue action is the one to name; the rest are a count. An
  // action a chain notice already tells the story of is not named twice.
  const chainTargets = new Set(
    chainNotices.map((n) => (n.kind === "blocked-chain" ? `${n.boardId}:${n.nodeId}` : "")),
  );
  const overdueItems = items.filter(
    (i) => i.signal === "overdue" && i.dueDate && !chainTargets.has(`${i.boardId}:${i.nodeId}`),
  );
  const oldest = overdueItems.reduce<PulseItem | undefined>(
    (best, i) => (!best || i.dueDate! < best.dueDate! ? i : best),
    undefined,
  );
  const overdueNotices: PulseNotice[] = oldest
    ? [
        {
          kind: "overdue",
          boardId: oldest.boardId,
          boardName: oldest.boardName,
          nodeId: oldest.nodeId,
          label: oldest.label,
          dueDate: oldest.dueDate!,
          ...(oldest.assignee ? { assignee: oldest.assignee } : {}),
          others: counts.overdue - 1,
        },
      ]
    : [];

  const boardsSorted = [...summaries].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.isCurrent === b.isCurrent ? 0 : a.isCurrent ? -1 : 1;
  });

  return {
    items,
    counts,
    boardsWithItems: boardsWithItems.size,
    boardsWithContent,
    boards: boardsSorted,
    noticed: [...chainNotices, ...overdueNotices, ...topicNotices, ...dupNotices].slice(
      0,
      NOTICE_LIMIT,
    ),
  };
}

/**
 * The board to open for a tile: the one holding the most matching items,
 * the open board winning ties (no board switch when it would not help).
 * Null when nothing matches.
 */
export function busiestBoard(
  items: readonly PulseItem[],
  match: (item: PulseItem) => boolean,
): string | null {
  const tally = new Map<string, { n: number; current: boolean; first: number }>();
  items.forEach((item, i) => {
    if (!match(item)) return;
    const t = tally.get(item.boardId) ?? { n: 0, current: item.isCurrent, first: i };
    t.n += 1;
    tally.set(item.boardId, t);
  });
  let best: string | null = null;
  let bestT: { n: number; current: boolean; first: number } | null = null;
  for (const [id, t] of tally) {
    const better =
      !bestT ||
      t.n > bestT.n ||
      (t.n === bestT.n && t.current && !bestT.current) ||
      (t.n === bestT.n && t.current === bestT.current && t.first < bestT.first);
    if (better) {
      best = id;
      bestT = t;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Words                                                                      */
/* -------------------------------------------------------------------------- */

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The italic line under the greeting, from real counts only. Null when no
 * board has content yet — the caller shows its first-run line instead.
 */
export function pulseLede(pulse: WorkspacePulse): string | null {
  if (pulse.boardsWithContent === 0) return null;
  const c = pulse.counts;
  const parts = [
    c.openQuestions ? plural(c.openQuestions, "open question") : "",
    c.pendingDecisions + c.openProposals
      ? plural(c.pendingDecisions + c.openProposals, "pending decision")
      : "",
    c.overdue ? plural(c.overdue, "overdue action") : "",
    c.blocked ? plural(c.blocked, "blocked action") : "",
    c.openRisks ? plural(c.openRisks, "open risk") : "",
  ].filter(Boolean);
  if (parts.length === 0 && c.openActions) parts.push(plural(c.openActions, "open action"));
  const where = (n: number) => {
    if (n === 1) {
      const only = pulse.items[0]?.boardName ?? pulse.boards.find((b) => b.hasContent)?.name;
      return only ? `on “${only}”` : "on one board";
    }
    return `across ${n} boards`;
  };
  if (parts.length === 0) {
    return `Nothing is waiting on you ${where(pulse.boardsWithContent)} — no open questions, pending decisions or late work.`;
  }
  return `${joinParts(parts.slice(0, 3))} ${where(pulse.boardsWithItems)}.`;
}

/** Morning before noon, afternoon until six, evening after (and before five). */
export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

/** A polite build request ("can you draw…") is a description, not a question. */
const POLITE_BUILD =
  /^(can|could|would|will)\s+you\s+(please\s+)?(draw|make|create|build|design|sketch|map|add|generate|turn|show|lay\s*out|diagram|outline)\b/i;
const QUESTION_START =
  /^(who|whom|whose|what|when|where|why|how|which|did|does|is|are|was|were|has|have|had|should|shall)\b/i;

/**
 * Does the composer text ask about existing work (→ Ask) or describe
 * something to build (→ a new board)? A deterministic heuristic, shown to
 * the user before they press Enter, with both routes one click away.
 */
export function isQuestionText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (POLITE_BUILD.test(t)) return false;
  if (/^what\s+if\b/i.test(t)) return false; // "what if we…" proposes, it does not ask
  return t.endsWith("?") || QUESTION_START.test(t);
}

/** "just now", "12m ago", "3h ago", "yesterday", "4d ago", then a date. */
export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  const then = new Date(ts);
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** A calendar due date as a person reads it ("due Sep 12", "due today"). */
export function dueLabel(dueDate: string, now: number): string {
  const [y, mo, d] = dueDate.split("-").map(Number);
  if (!y || !mo || !d) return `due ${dueDate}`;
  const due = new Date(y, mo - 1, d);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days === -1) return "due yesterday";
  // A date from another year says so: "was due 13 Jun" a year late reads as weeks.
  const date = due.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(due.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
  return days < 0 ? `was due ${date}` : `due ${date}`;
}
