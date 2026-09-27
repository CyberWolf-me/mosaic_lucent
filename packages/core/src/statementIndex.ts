import type { StatementKind, StatementStatus, StatementTrust, Workspace } from "./model.js";
import { actionsFromDecision, derivedExecution, statementNodes } from "./model.js";

/**
 * One statement as the workspace sees it (docs/26 J3, ADR 0046): the rows the
 * board's own Intelligence view renders and the server's cross-board index
 * stores come from this one derivation, so the two can never disagree.
 *
 * Everything here follows from the board alone. Anything that also depends
 * on the calendar ("overdue" — `isOverdueUnfinished` — or "at risk because an
 * upstream is overdue") is left to the reader, which knows what day it is; an
 * index row derived last week must not claim today's lateness.
 */
export interface StatementRow {
  kind: StatementKind;
  /** The node — the reveal target. */
  id: string;
  label: string;
  status: StatementStatus;
  /** The authored topic key, exactly as the board holds it. */
  topic?: string;
  /** Nodes this statement supersedes (the C3 chain). */
  supersedes?: string[];
  /** Work-tracking fields when the node also carries an issue. */
  assignee?: string;
  /** The work's deadline (ISO YYYY-MM-DD). */
  dueDate?: string;
  /** The issue's execution status — a lifecycle separate from `status`. */
  executionStatus?: string;
  /**
   * Upstream work whose status is blocked, directly or through the chain
   * (Stage D3) — computed from the board, never stored on it.
   */
  blockedBy?: string[];
  /** How many actions this decision drives (Stage E1 drives edges). */
  drivesActions?: number;
  /** Creation evidence: the meeting and turns it came from. */
  provenance?: { meetingId: string; turnRange?: [number, number] };
  /** How it came to be trusted (ADR 0047); absent before trust existed. */
  trust?: StatementTrust;
}

/** Is this row's work blocked — marked so itself, or waiting on blocked work? */
export function isBlockedRow(row: StatementRow): boolean {
  return row.executionStatus === "blocked" || (row.blockedBy?.length ?? 0) > 0;
}

/** Every statement on the board, in insertion order. */
export function statementRows(workspace: Workspace): StatementRow[] {
  // `now` only feeds atRiskBy, which this derivation deliberately leaves out.
  const derived = derivedExecution(workspace, 0);
  return statementNodes(workspace).map((node) => {
    const statement = node.statement!;
    const prov = node.provenance ?? statement.provenance;
    const blockedBy = derived.get(node.id)?.blockedBy ?? [];
    const drives =
      statement.kind === "decision" ? actionsFromDecision(workspace, node.id).length : 0;
    return {
      kind: statement.kind,
      id: node.id,
      label: node.label,
      status: statement.status,
      ...(statement.topic ? { topic: statement.topic } : {}),
      ...(statement.trust ? { trust: statement.trust } : {}),
      ...(statement.supersedes?.length ? { supersedes: [...statement.supersedes] } : {}),
      ...(node.issue?.assignee ? { assignee: node.issue.assignee } : {}),
      ...(node.issue?.dueDate ? { dueDate: node.issue.dueDate } : {}),
      ...(node.issue ? { executionStatus: node.issue.status } : {}),
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      ...(drives > 0 ? { drivesActions: drives } : {}),
      ...(prov?.meetingId
        ? {
            provenance: {
              meetingId: prov.meetingId,
              ...(prov.turnRange ? { turnRange: prov.turnRange } : {}),
            },
          }
        : {}),
    };
  });
}
