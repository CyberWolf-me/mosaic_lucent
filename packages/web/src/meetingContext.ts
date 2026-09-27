import type { Workspace } from "@lucent/core";
import type { MeetingTranscript } from "./meetings.js";

/**
 * The context brief (docs/28 S3, spec §122): what a scheduled meeting walks
 * into — the board's open actions, unresolved questions and risks, what has
 * been decided, and what the last meeting on this board ended with. Read
 * straight off the board and the stored summary, like the meeting brief
 * (meetingBrief.ts): no model call, nothing a person can't click through to.
 */

export interface ContextItem {
  nodeId: string;
  label: string;
  assignee?: string;
  dueDate?: string;
  /** The meeting that produced it, when one did — a click to its words. */
  meetingId?: string;
}

export interface ContextBrief {
  actions: ContextItem[];
  questions: ContextItem[];
  risks: ContextItem[];
  /** The latest decisions, newest first. */
  decisions: ContextItem[];
  /** The last meeting on this board that has a summary, with its first lines. */
  lastTime: { meetingId: string; title: string | null; at: number; lines: string[] } | null;
  total: number;
}

/** How much of each list the page shows; the board holds the rest. */
export const CONTEXT_LIMIT = 6;

export function contextBrief(
  workspace: Workspace,
  meetings: ReadonlyArray<
    Pick<MeetingTranscript, "id" | "title" | "startedAt" | "endedAt" | "recap">
  >,
): ContextBrief {
  const actions: ContextItem[] = [];
  const questions: ContextItem[] = [];
  const risks: ContextItem[] = [];
  const decisions: ContextItem[] = [];
  for (const node of Object.values(workspace.nodes)) {
    const s = node.statement;
    if (!s) continue;
    const meetingId = s.provenance?.meetingId ?? node.provenance?.meetingId;
    const item: ContextItem = {
      nodeId: node.id,
      label: node.label,
      ...(node.issue?.assignee ? { assignee: node.issue.assignee } : {}),
      ...(node.issue?.dueDate ? { dueDate: node.issue.dueDate } : {}),
      ...(meetingId ? { meetingId } : {}),
    };
    if (s.kind === "decision" && s.status === "resolved") decisions.push(item);
    if (s.status !== "open") continue;
    if (s.kind === "action") actions.push(item);
    else if (s.kind === "question") questions.push(item);
    else if (s.kind === "risk") risks.push(item);
  }
  // Actions with a due date first, soonest first; the rest in board order.
  actions.sort((a, b) =>
    a.dueDate && b.dueDate
      ? a.dueDate.localeCompare(b.dueDate)
      : a.dueDate
        ? -1
        : b.dueDate
          ? 1
          : 0,
  );
  const last = [...meetings]
    .filter((m) => m.endedAt !== null && m.recap)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const lastTime = last?.recap
    ? {
        meetingId: last.id,
        title: last.title ?? null,
        at: last.startedAt,
        lines: last.recap.sections
          .flatMap((section) => section.items.map((i) => i.text))
          .slice(0, 4),
      }
    : null;
  const cap = <T>(list: T[]) => list.slice(0, CONTEXT_LIMIT);
  return {
    actions: cap(actions),
    questions: cap(questions),
    risks: cap(risks),
    decisions: cap(decisions.reverse()),
    lastTime,
    total: actions.length + questions.length + risks.length + decisions.length,
  };
}
