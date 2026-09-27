import type { ExecutionRollup, Node, Workspace } from "./model.js";
import {
  actionNodes,
  blockingChains,
  decisionsBehindAction,
  derivedExecution,
  executionRollup,
  isOverdueUnfinished,
} from "./model.js";

/**
 * A project's execution, across its boards (docs/26 §8 "project dashboard"):
 * how far along it is, how each workstream is doing, and every blocker told as
 * a story — the blocked work, what it waits on and who owns each step, the
 * decision that drove it, and the meeting turns that decision came from. Pure
 * over the boards and `now`, like the per-board rollup it sums; nothing here
 * is stored.
 */

export interface ProjectBoardInput {
  id: string;
  name: string;
  workspace: Workspace;
}

export interface Evidence {
  meetingId: string;
  turnRange?: [number, number];
}

export interface StoryStep {
  id: string;
  label: string;
  owner?: string;
  status?: string;
}

export interface BlockerStory {
  boardId: string;
  boardName: string;
  /** The blocked work this story explains. */
  target: StoryStep;
  /** Blocker-first: the manually blocked root → … → the work before target. */
  waitsOn: StoryStep[];
  /** The decisions that drove the blocked work, with where they were made. */
  decisions: Array<{ id: string; label: string; evidence?: Evidence }>;
  /** Where the blocked work itself came from, when it came from a meeting. */
  evidence?: Evidence;
}

export interface Workstream {
  boardId: string;
  boardName: string;
  /** The region (group) it is; null for a board's work outside any region. */
  groupId: string | null;
  label: string;
  total: number;
  completed: number;
  percent: number;
  blocked: number;
  overdue: number;
}

export interface OverdueWork {
  boardId: string;
  boardName: string;
  id: string;
  label: string;
  owner?: string;
  dueDate: string;
}

export interface ProjectExecution {
  rollup: ExecutionRollup;
  boards: Array<{ boardId: string; boardName: string; rollup: ExecutionRollup }>;
  workstreams: Workstream[];
  blockers: BlockerStory[];
  overdue: OverdueWork[];
}

const step = (node: Node): StoryStep => ({
  id: node.id,
  label: node.label,
  ...(node.issue?.assignee ? { owner: node.issue.assignee } : {}),
  ...(node.issue?.status ? { status: node.issue.status } : {}),
});

function evidenceOf(node: Node): Evidence | undefined {
  const prov = node.provenance?.meetingId ? node.provenance : node.statement?.provenance;
  if (!prov?.meetingId) return undefined;
  return { meetingId: prov.meetingId, ...(prov.turnRange ? { turnRange: prov.turnRange } : {}) };
}

export function projectExecution(
  boards: readonly ProjectBoardInput[],
  now: number,
): ProjectExecution {
  const rollup: ExecutionRollup = {
    total: 0,
    completed: 0,
    inProgress: 0,
    blocked: 0,
    atRisk: 0,
    overdue: 0,
    percent: 0,
  };
  const perBoard: ProjectExecution["boards"] = [];
  const workstreams: Workstream[] = [];
  const blockers: BlockerStory[] = [];
  const overdue: OverdueWork[] = [];

  for (const board of boards) {
    const ws = board.workspace;
    const r = executionRollup(ws, now);
    perBoard.push({ boardId: board.id, boardName: board.name, rollup: r });
    for (const key of [
      "total",
      "completed",
      "inProgress",
      "blocked",
      "atRisk",
      "overdue",
    ] as const) {
      rollup[key] += r[key];
    }

    const actions = actionNodes(ws);
    if (actions.length === 0) continue;
    const derived = derivedExecution(ws, now);
    const isBlocked = (n: Node) =>
      n.issue!.statusCategory !== "done" &&
      (n.issue!.status === "blocked" || (derived.get(n.id)?.blockedBy.length ?? 0) > 0);
    const isDone = (n: Node) => n.issue!.statusCategory === "done";
    const isLate = (n: Node) =>
      !isDone(n) && isOverdueUnfinished(n.issue!.dueDate, n.issue!.status, now);

    // Workstreams: each region with work in it, and the work outside any region.
    const inGroup = new Set<string>();
    for (const group of Object.values(ws.groups)) {
      const members = actions.filter((a) => group.children.includes(a.id));
      if (members.length === 0) continue;
      members.forEach((m) => inGroup.add(m.id));
      const completed = members.filter(isDone).length;
      workstreams.push({
        boardId: board.id,
        boardName: board.name,
        groupId: group.id,
        label: group.label,
        total: members.length,
        completed,
        percent: Math.round((100 * completed) / members.length),
        blocked: members.filter(isBlocked).length,
        overdue: members.filter(isLate).length,
      });
    }
    const loose = actions.filter((a) => !inGroup.has(a.id));
    if (loose.length > 0) {
      const completed = loose.filter(isDone).length;
      workstreams.push({
        boardId: board.id,
        boardName: board.name,
        groupId: null,
        label: inGroup.size > 0 ? `${board.name} — outside any workstream` : board.name,
        total: loose.length,
        completed,
        percent: Math.round((100 * completed) / loose.length),
        blocked: loose.filter(isBlocked).length,
        overdue: loose.filter(isLate).length,
      });
    }

    // Blockers: the derived chains, plus work blocked by hand with nothing behind it.
    const chains = new Map(blockingChains(ws, now).map((c) => [c.nodeId, c.chain] as const));
    for (const action of actions) {
      if (!isBlocked(action)) continue;
      const chain = chains.get(action.id) ?? [];
      const evidence = evidenceOf(action);
      blockers.push({
        boardId: board.id,
        boardName: board.name,
        target: step(action),
        waitsOn: chain.filter((n) => n.id !== action.id).map(step),
        decisions: decisionsBehindAction(ws, action.id).map((d) => {
          const e = evidenceOf(d);
          return { id: d.id, label: d.label, ...(e ? { evidence: e } : {}) };
        }),
        ...(evidence ? { evidence } : {}),
      });
    }

    for (const action of actions) {
      if (!isLate(action)) continue;
      overdue.push({
        boardId: board.id,
        boardName: board.name,
        id: action.id,
        label: action.label,
        ...(action.issue!.assignee ? { owner: action.issue!.assignee } : {}),
        dueDate: action.issue!.dueDate!,
      });
    }
  }

  rollup.percent = rollup.total === 0 ? 0 : Math.round((100 * rollup.completed) / rollup.total);
  overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { rollup, boards: perBoard, workstreams, blockers, overdue };
}
