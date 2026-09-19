import type { Node, Operation, StatementKind, StatementStatus, Workspace } from "@lucent/core";
import { actionsFromDecision, derivedExecution, statementNodes } from "@lucent/core";
import { canonicalizeTopic, possibleDuplicateTopics, topicsAreVariants } from "@lucent/core";

/**
 * The Intelligence projection (Stage C6, ADR 0026).
 *
 * INTELLIGENCE IS A PROJECTION OF THE CURRENT SEMANTIC WORKSPACE; IT DOES NOT
 * CREATE NEW TRUTH, MUTATE STATE WITHOUT APPROVAL, OR REPLACE HISTORY AS
 * THE SOURCE FOR TEMPORAL ANALYSIS.
 *
 * Everything here is pure over the workspace the client already holds —
 * shared boards converge on it through the room (statements ride the same
 * ops), local boards hold it in state. No fetches, no routes, no stores:
 * the six sections, the topic grouping, the recommendation inbox, and the
 * merge batch are all derived per render, exactly as ADR 0021 promised
 * ("projections over statementNodes(), no migration when they arrive").
 *
 * The surface division this view completes: Board → what it looks like,
 * Meeting → what was said, History → what happened when, Intelligence →
 * what is true now, ⌘K → find, Ask → explain.
 */

/** The per-kind row glyph — every kind visually distinct, none merely text. */
export const KIND_GLYPH: Record<StatementKind, string> = {
  decision: "✓",
  proposal: "💭",
  question: "?",
  action: "→",
  requirement: "◆",
  risk: "⚠",
};

/** The fixed section order: decided things first, obligations last. */
export const SECTION_ORDER: StatementKind[] = [
  "decision",
  "proposal",
  "question",
  "action",
  "requirement",
  "risk",
];

/** A statement lifecycle that has settled — rendered dimmed, never deleted. */
export function isSettled(status: StatementStatus): boolean {
  return status !== "open";
}

/** One statement row as the view renders it. */
export interface IntelligenceRow {
  kind: StatementKind;
  /** The node — the reveal target. */
  id: string;
  label: string;
  status: StatementStatus;
  /** The authored topic key, exactly as the board holds it. */
  topic?: string;
  /** Nodes this statement supersedes (the C3 chain, visible per row). */
  supersedes?: string[];
  /** Work-tracking fields when the node ALSO carries an issue — the Board
   * bridge made visible (assignee, and the Stage D1 execution fields),
   * never duplicated. */
  assignee?: string;
  /** Stage D1: the work's deadline (ISO YYYY-MM-DD), when the issue carries one. */
  dueDate?: string;
  /** Stage D1: the issue's execution status — a separate lifecycle from
   * the statement `status` (semantic) above; neither derives from the other. */
  executionStatus?: string;
  /** Stage D3: upstream ids whose manual status is blocked (or that are
   * themselves derived-blocked) — computed project truth, never stored. */
  blockedBy?: string[];
  /** Stage D3: upstream ids that are overdue-unfinished — an analytical
   * signal, never a status. */
  atRiskBy?: string[];
  /** Stage E1: how many actions this decision drives — the causal count,
   * from drives edges (0/undefined = the decision drove no work). */
  drivesActions?: number;
  /** Creation evidence — the ✦ jump's source. */
  provenance?: { meetingId: string; turnRange?: [number, number] };
}

export interface IntelligenceSection {
  kind: StatementKind;
  rows: IntelligenceRow[];
}

function rowOf(node: Node): IntelligenceRow {
  const statement = node.statement!;
  const prov = node.provenance ?? statement.provenance;
  return {
    kind: statement.kind,
    id: node.id,
    label: node.label,
    status: statement.status,
    ...(statement.topic ? { topic: statement.topic } : {}),
    ...(statement.supersedes?.length ? { supersedes: statement.supersedes } : {}),
    ...(node.issue?.assignee ? { assignee: node.issue.assignee } : {}),
    ...(node.issue?.dueDate ? { dueDate: node.issue.dueDate } : {}),
    ...(node.issue ? { executionStatus: node.issue.status } : {}),
    ...(prov?.meetingId
      ? {
          provenance: {
            meetingId: prov.meetingId,
            ...(prov.turnRange ? { turnRange: prov.turnRange } : {}),
          },
        }
      : {}),
  };
}

/**
 * Stage D1: is the work overdue? Rendered, computed, never persisted — a
 * due date past `now` on work that is not completed/cancelled. Pure so the
 * overdue tint is testable without the DOM.
 */
export function isOverdue(
  dueDate: string | undefined,
  executionStatus: string | undefined,
  now: number,
): boolean {
  if (!dueDate) return false;
  if (executionStatus === "completed" || executionStatus === "cancelled") return false;
  // The due date counts as overdue the day AFTER it: compare date strings
  // against today's ISO date — timezone-naive by design (the field is a
  // calendar date, not an instant; ADR 0027's no-timezone rule).
  const today = new Date(now);
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return dueDate < todayIso;
}

/**
 * The six sections in the fixed order. Within each: OPEN statements first
 * in insertion order (the live work), settled statements after (the record,
 * dimmed — the lifecycle stays visible, not deleted).
 */
export function intelligenceSections(workspace: Workspace): IntelligenceSection[] {
  // Stage D3: the derived execution state — computed once per render, read
  // by every action row (the manual/derived split: manual state is
  // issue.status; blockedBy/atRiskBy are computed project truth).
  const derived = derivedExecution(workspace, Date.now());
  // Stage E1: the decision→action adjacency — one graph walk per decision
  // row's drives count.
  const driveGraph = new Map<string, number>();
  for (const n of statementNodes(workspace)) {
    if (n.statement!.kind === "decision") {
      const count = actionsFromDecision(workspace, n.id).length;
      if (count > 0) driveGraph.set(n.id, count);
    }
  }
  return SECTION_ORDER.map((kind) => {
    const all = statementNodes(workspace)
      .filter((n) => n.statement!.kind === kind)
      .map((n) => {
        const row = rowOf(n);
        const d = derived.get(n.id);
        return {
          ...row,
          ...(d && d.blockedBy.length > 0 ? { blockedBy: d.blockedBy } : {}),
          ...(d && d.atRiskBy.length > 0 ? { atRiskBy: d.atRiskBy } : {}),
          ...(driveGraph.has(n.id) ? { drivesActions: driveGraph.get(n.id) } : {}),
        };
      });
    const rows = [
      ...all.filter((r) => !isSettled(r.status)),
      ...all.filter((r) => isSettled(r.status)),
    ];
    return { kind, rows };
  });
}

/* -------------------------------------------------------------------------- */
/* Topic grouping (the C5 rule, reused)                                       */
/* -------------------------------------------------------------------------- */

export interface TopicGroup {
  /** The grouping header: the shortest canonical key of the group. */
  key: string;
  /** Every authored spelling in the group, as-authored. */
  authored: string[];
  rows: IntelligenceRow[];
}

/**
 * Group one section's rows by topic identity — C5's own equivalence
 * (canonicalizeTopic + topicsAreVariants), the same representative the fold
 * and the Ask digest choose. Statements without a topic group last, in a
 * group of their own (header "(none)"), authored keys shown as-authored.
 */
export function topicGroups(rows: readonly IntelligenceRow[]): TopicGroup[] {
  const groups: TopicGroup[] = [];
  const none: TopicGroup = { key: "(none)", authored: [], rows: [] };
  for (const row of rows) {
    if (!row.topic) {
      none.rows.push(row);
      continue;
    }
    const key = canonicalizeTopic(row.topic) || row.topic;
    const group = groups.find((g) => topicsAreVariants(g.key, key));
    if (group) {
      if (!group.authored.includes(row.topic)) group.authored.push(row.topic);
      group.rows.push(row);
    } else {
      groups.push({ key, authored: [row.topic], rows: [row] });
    }
  }
  if (none.rows.length) groups.push(none);
  return groups;
}

/* -------------------------------------------------------------------------- */
/* The recommendation inbox (ADR 0025's first real consumer)                  */
/* -------------------------------------------------------------------------- */

/** A possible duplicate, projected for the inbox card. */
export interface InboxItem {
  /** The stable pair key — also the suppression key's base. */
  id: string;
  /** The longer/variant key — the side a Merge re-topics. */
  dup: string;
  /** The existing authored key — the side a Merge converges onto. */
  existing: string;
  /** Evidence (rule 4): statements per side. */
  dupStatements: number;
  existingStatements: number;
  /** Evidence: the distinct meetings of origin across both sides. */
  meetings: string[];
}

export function inboxItems(workspace: Workspace): InboxItem[] {
  return possibleDuplicateTopics(workspace).map((dupe) => ({
    id: dupe.id,
    dup: dupe.targets[0].topic,
    existing: dupe.targets[1].topic,
    dupStatements: dupe.targets[0].statements,
    existingStatements: dupe.targets[1].statements,
    meetings: [...new Set([...dupe.targets[0].meetings, ...dupe.targets[1].meetings])],
  }));
}

/**
 * The change-aware suppression key: the pair PLUS its current fingerprints
 * (both authored keys, both statement counts). "Keep" suppresses exactly
 * this — an unchanged pair stays suppressed for the session; ANY statement
 * change on either side re-arms the recommendation, because a changed board
 * is a new question. Ephemeral by design; durable dismissal is the future
 * recommendation engine's problem (ADR 0025).
 */
export function suppressionKey(item: InboxItem): string {
  return `${item.id}|${item.dupStatements}|${item.existingStatements}`;
}

/** One node a Merge will re-topic: the node, its current key, the target. */
export interface MergeChange {
  nodeId: string;
  from: string;
  to: string;
}

/**
 * The Merge preview: every statement node carrying the dup-side authored
 * key, with the target key it will become. This is exactly what the
 * confirmed Merge commits — the preview and the ops are derived from the
 * same workspace, so the preview can never lie about the batch.
 */
export function mergePreview(
  workspace: Workspace,
  item: InboxItem,
): {
  changes: MergeChange[];
  /** The count line for the preview copy: N statements, nothing deleted. */
  statementCount: number;
} {
  const changes: MergeChange[] = [];
  for (const node of statementNodes(workspace)) {
    if (node.statement?.topic === item.dup) {
      changes.push({ nodeId: node.id, from: item.dup, to: item.existing });
    }
  }
  return { changes, statementCount: changes.length };
}

/**
 * The Merge batch: UPDATE_STATEMENT {id, topic} for every dup-side statement,
 * order-stable (workspace node order). Applied through applyManual — the
 * same validator, the same undo, the same history as any human edit; only
 * the explicit confirm click ever calls this (the C5 invariant).
 */
export function mergeOps(item: InboxItem, workspace: Workspace): Operation[] {
  return statementNodes(workspace)
    .filter((n) => n.statement?.topic === item.dup)
    .map((n) => ({ op: "UPDATE_STATEMENT" as const, id: n.id, topic: item.existing }));
}
