import type { Operation, Workspace } from "@lucent/core";
import { reactionTally, voteRanking, voteTally } from "@lucent/core";

/**
 * Voting and reactions helpers (docs/14 §workshop features).
 *
 * Both are model operations rather than UI-only state, so a tally survives
 * reload, undoes as one step, and is visible to the AI ("which idea won the
 * vote?"). These helpers own the id minting and the toggle semantics so the
 * views stay declarative.
 */

/** Local participant id. Multiplayer identity replaces this without a schema change. */
export const ME = "me";

/** Emoji offered in the reaction picker. Deliberately small and unambiguous. */
export const REACTION_EMOJI = ["👍", "❤️", "🎉", "🤔", "⚠️"] as const;

function annotationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

/** The current participant's vote for a target, if any. */
export function myVoteFor(workspace: Workspace, targetId: string): string | null {
  const found = Object.values(workspace.votes ?? {}).find(
    (v) => v.targetId === targetId && v.by === ME,
  );
  return found?.id ?? null;
}

/**
 * Toggle this participant's vote on a target. One vote per person per object, so
 * clicking again withdraws it rather than stacking duplicates.
 */
export function toggleVoteOps(workspace: Workspace, targetId: string): Operation[] {
  const existing = myVoteFor(workspace, targetId);
  if (existing) return [{ op: "REMOVE_VOTE", id: existing }];
  return [{ op: "ADD_VOTE", id: annotationId("vote"), targetId, by: ME }];
}

/** Clear a whole round; omit targetId to reset every vote on the board. */
export function clearVotesOps(targetId?: string): Operation[] {
  return [{ op: "CLEAR_VOTES", ...(targetId ? { targetId } : {}) }];
}

/** This participant's reaction of a given emoji on a target, if any. */
export function myReactionFor(
  workspace: Workspace,
  targetId: string,
  emoji: string,
): string | null {
  const found = Object.values(workspace.reactions ?? {}).find(
    (r) => r.targetId === targetId && r.emoji === emoji && r.by === ME,
  );
  return found?.id ?? null;
}

/** Toggle one emoji reaction for this participant on a target. */
export function toggleReactionOps(
  workspace: Workspace,
  targetId: string,
  emoji: string,
): Operation[] {
  const existing = myReactionFor(workspace, targetId, emoji);
  if (existing) return [{ op: "REMOVE_REACTION", id: existing }];
  return [{ op: "ADD_REACTION", id: annotationId("react"), targetId, emoji, by: ME }];
}

/** A readable label for a voted/reacted object, for the results list. */
export function targetLabel(workspace: Workspace, targetId: string): string {
  const node = workspace.nodes[targetId];
  if (node) return node.label;
  const shape = workspace.shapes[targetId];
  if (shape) return shape.text?.split("\n")[0] || shape.kind;
  return targetId;
}

/** Vote results, highest first, with display labels resolved. */
export function voteResults(
  workspace: Workspace,
): Array<{ targetId: string; label: string; votes: number }> {
  return voteRanking(workspace).map((r) => ({
    ...r,
    label: targetLabel(workspace, r.targetId),
  }));
}

export { reactionTally, voteTally };
