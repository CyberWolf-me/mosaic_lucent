/**
 * THE ATTENTION LAYER (Phase 3, the 2026-09 review's §10/§20): one surface
 * answering "What needs my attention?" — composed deterministically from
 * the machinery that already exists (the execution graph, statements,
 * provenance) rather than a new store or a notification firehose.
 *
 * Every item carries the EVIDENCE POINTER the review asked for: clicking
 * takes the user to the thing itself (a node id on the board, a decision's
 * statement, the meeting a statement came from). Deliberately NOT here:
 * counts without pointers, cross-board aggregation, or any persistence —
 * pure over (workspace, now), the same projection stance as the rollup.
 */

import {
  actionNodes,
  derivedExecution,
  isOverdueUnfinished,
  type Workspace,
} from "./model.js";

export type AttentionKind = "blocked" | "overdue" | "openDecision" | "newStatement";

export interface AttentionItem {
  kind: AttentionKind;
  /** The node the user clicks through to. */
  nodeId: string;
  /** What to show in the list. */
  label: string;
  /** Why it needs attention, one clause. */
  reason: string;
  /** The meeting the item came from, when it has one (the evidence trail). */
  meetingId?: string;
}

export interface NeedsAttention {
  items: AttentionItem[];
  /** Per-kind counts, in the dashboard's display order. */
  counts: Record<AttentionKind, number>;
}

/** Hard cap per kind: a surface, not a firehose. */
const PER_KIND_LIMIT = 8;

/** Where an item's meeting evidence lives: CREATE_NODE provenance is
 * top-level, SET_STATEMENT provenance nests inside the statement — both are
 * real boards' shapes, so the attention layer reads both. */
function meetingOf(workspace: Workspace, nodeId: string): string | undefined {
  const node = workspace.nodes[nodeId];
  return node?.provenance?.meetingId ?? node?.statement?.provenance?.meetingId;
}

/**
 * What needs attention right now. Deterministic ordering: kind priority
 * (blocked → overdue → open decisions → newest statements), then label
 * order inside a kind — the same board always yields the same list.
 */
export function needsAttention(workspace: Workspace, now: number): NeedsAttention {
  const derived = derivedExecution(workspace, now);
  const actions = actionNodes(workspace);

  const blocked: AttentionItem[] = [];
  const overdue: AttentionItem[] = [];
  for (const node of actions) {
    const issue = node.issue!;
    if (issue.statusCategory === "done") continue;
    const d = derived.get(node.id);
    if (issue.status === "blocked" || (d?.blockedBy.length ?? 0) > 0) {
      blocked.push({
        kind: "blocked",
        nodeId: node.id,
        label: node.label,
        reason:
          issue.status === "blocked"
            ? "marked blocked"
            : `blocked by ${d!.blockedBy.length} upstream ${d!.blockedBy.length === 1 ? "action" : "actions"}`,
      });
    }
    if (isOverdueUnfinished(issue.dueDate, issue.status, now)) {
      overdue.push({
        kind: "overdue",
        nodeId: node.id,
        label: node.label,
        reason: `due ${issue.dueDate}`,
      });
    }
  }

  // Open decisions: statements kind=decision that are still unresolved —
  // the board's pending judgment calls, not work items.
  const openDecisions: AttentionItem[] = [];
  for (const node of Object.values(workspace.nodes)) {
    if (node.statement?.kind === "decision" && node.statement.status === "open") {
      const meetingId = meetingOf(workspace, node.id);
      openDecisions.push({
        kind: "openDecision",
        nodeId: node.id,
        label: node.label,
        reason: "decision still open",
        ...(meetingId ? { meetingId } : {}),
      });
    }
  }

  // New statements from meetings: provenance-bearing nodes, newest meeting
  // first (id sort stands in for creation order — ids are monotonic).
  const statements = Object.values(workspace.nodes)
    .filter((n) => n.statement && meetingOf(workspace, n.id))
    .sort((a, b) => {
      const ma = meetingOf(workspace, a.id) ?? "";
      const mb = meetingOf(workspace, b.id) ?? "";
      return mb.localeCompare(ma);
    })
    .slice(0, PER_KIND_LIMIT)
    .map((n) => ({
      kind: "newStatement" as const,
      nodeId: n.id,
      label: n.label,
      reason: "from a meeting",
      meetingId: meetingOf(workspace, n.id)!,
    }));

  const items = [
    ...blocked.slice(0, PER_KIND_LIMIT),
    ...overdue.slice(0, PER_KIND_LIMIT),
    ...openDecisions.slice(0, PER_KIND_LIMIT),
    ...statements,
  ];
  return {
    items,
    counts: {
      blocked: blocked.length,
      overdue: overdue.length,
      openDecision: openDecisions.length,
      newStatement: statements.length,
    },
  };
}
