import type { Operation } from "@lucent/core";
import type { BoardStore, LoggedOpEntry, OperationActor } from "./boards.js";
import type { UserStore } from "./accounts.js";
import type { ProposalStore, StoredProposal } from "./proposals.js";
import { historyWindow, loadLogFromSeq, windowedEntries } from "./historyWindow.js";
import type { HistoryWindow } from "./historyWindow.js";

/**
 * The read side of history (Stage C1): the shared view-assembly both the
 * history route and the ask route use, so the two can never disagree about
 * what a caller sees or how an entry is described.
 *
 * The op log is the record; everything here is derived from it on read. The
 * response is summarized per revision (actor, label, counts, touched ids, and
 * the proposal link) rather than dumping raw operation JSON at the UI — the
 * timeline answers "who did what when", and the operations themselves stay
 * one `getBoard`/MCP hop away for whoever needs the detail.
 */

/** The AI actor's fixed id in the log (boards.ts aiActor). */
const AI_ACTOR_ID = "lucent";

export interface HistoryActorView {
  type: OperationActor["actorType"];
  name: string;
  id: string;
  initiatedBy?: string;
  approvedBy?: string;
}

/** One revision as the timeline renders it. */
export interface HistoryItem {
  seq: number;
  at: number;
  label: string;
  operationId?: string;
  opCount: number;
  actor: HistoryActorView;
  /** Node/shape ids the batch references, capped; the "show on board" jump. */
  touched: string[];
  /** The Stage B3 proposal this revision applied, when it applied one. */
  proposal?: {
    id: string;
    meetingId: string | null;
    quote?: string;
    turnRange?: [number, number];
  };
}

/**
 * Read the caller's visible window of a board's log, in one call. Both routes
 * start here so the entitlement, the snapshot floor, and the ordering cannot
 * drift between the timeline and the answer context.
 */
export async function loadVisibleLog(
  boardStore: BoardStore,
  boardId: string,
  depth: number | null,
): Promise<{ window: HistoryWindow; entries: LoggedOpEntry[] }> {
  const [head, snapshot] = await Promise.all([
    boardStore.latestSeq(boardId),
    boardStore.latestSnapshot(boardId),
  ]);
  const window = historyWindow(head, depth, snapshot?.seq ?? 0);
  // loadLog reads seq > fromSeq-1 so the window's oldest entry is included.
  const log = await boardStore.loadLog(boardId, loadLogFromSeq(window));
  return { window, entries: windowedEntries(log, window) };
}

/**
 * Resolve display names for every actor in the window, in one batched pass.
 * `lucent` renders as "Lucent"; unknown ids (a deleted account) render as the
 * raw id rather than "Unknown" — the timeline stays honest about who acted.
 */
export async function actorNamesFor(
  userStore: UserStore,
  entries: readonly LoggedOpEntry[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.by);
    const actor = entry.actor;
    if (actor) {
      ids.add(actor.actorId);
      if (actor.initiatedBy) ids.add(actor.initiatedBy);
      if (actor.approvedBy) ids.add(actor.approvedBy);
    }
  }
  ids.delete(AI_ACTOR_ID);
  const names = new Map<string, string>();
  await Promise.all(
    [...ids].map(async (id) => {
      const user = await userStore.findById(id).catch(() => undefined);
      if (user?.name) names.set(id, user.name);
    }),
  );
  names.set(AI_ACTOR_ID, "Lucent");
  return names;
}

/** The id fields an operation can reference, by shape. */
function operationTargets(op: Operation): string[] {
  const record = op as unknown as Record<string, unknown>;
  const targets: string[] = [];
  for (const key of ["id", "source", "target", "parentId"]) {
    const value = record[key];
    if (typeof value === "string" && value) targets.push(value);
  }
  return targets;
}

/**
 * Node/object ids a batch touched, de-duplicated and capped. The cap keeps a
 * 200-op proposal from listing every id it created; the timeline's "show on
 * board" uses the FIRST id, which the oldest op in dependency order produced
 * — the node the batch was most clearly about.
 */
export function touchedIds(entry: LoggedOpEntry, cap = 10): string[] {
  const seen = new Set<string>();
  for (const op of entry.ops) {
    for (const id of operationTargets(op)) {
      if (!seen.has(id)) {
        seen.add(id);
        if (seen.size >= cap) return [...seen];
      }
    }
  }
  return [...seen];
}

/**
 * Join the visible window to the board's proposals by appliedSeq — the Stage
 * B3 link that lets a timeline entry say "this revision was Alex's proposal,
 * approved by Sarah, about the meeting on the 2nd".
 */
function proposalsByAppliedSeq(proposals: readonly StoredProposal[]): Map<number, StoredProposal> {
  const bySeq = new Map<number, StoredProposal>();
  for (const p of proposals) {
    if (p.appliedSeq !== null) bySeq.set(p.appliedSeq, p);
  }
  return bySeq;
}

/** Assemble the timeline items for the visible window. */
export function historyItems(
  entries: readonly LoggedOpEntry[],
  names: ReadonlyMap<string, string>,
  proposals: readonly StoredProposal[],
): HistoryItem[] {
  const bySeq = proposalsByAppliedSeq(proposals);
  return entries.map((entry) => {
    const actor = entry.actor;
    const actorId = actor?.actorId ?? entry.by;
    const name =
      actor?.actorType === "ai" || actorId === AI_ACTOR_ID
        ? "Lucent"
        : (names.get(actorId) ?? actorId);
    const proposal = bySeq.get(entry.seq);
    return {
      seq: entry.seq,
      at: entry.at,
      label: entry.label,
      ...(entry.operationId !== undefined ? { operationId: entry.operationId } : {}),
      opCount: entry.ops.length,
      actor: {
        type: actor?.actorType ?? "user",
        name,
        id: actorId,
        ...(actor?.initiatedBy
          ? { initiatedBy: names.get(actor.initiatedBy) ?? actor.initiatedBy }
          : {}),
        ...(actor?.approvedBy
          ? { approvedBy: names.get(actor.approvedBy) ?? actor.approvedBy }
          : {}),
      },
      touched: touchedIds(entry),
      ...(proposal
        ? {
            proposal: {
              id: proposal.id,
              meetingId: proposal.meetingId,
              ...(proposal.provenance?.quote !== undefined
                ? { quote: proposal.provenance.quote }
                : {}),
              ...(proposal.provenance?.turnRange !== undefined
                ? { turnRange: proposal.provenance.turnRange }
                : {}),
            },
          }
        : {}),
    };
  });
}
