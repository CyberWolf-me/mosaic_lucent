import type { Operation, Workspace } from "@lucent/core";
import { commentThreads, openCommentCounts, openMentions, parseMentions } from "@lucent/core";
import { getSessionUser } from "../session.js";

/**
 * Comment helpers (docs/12 collaboration).
 *
 * Comments are model operations like votes and reactions, so a thread persists,
 * undoes as one step, and is visible to the AI.
 *
 * The hardcoded "me" placeholder is gone: every authored op the client emits
 * carries the signed-in user's id, and Room.commit's stampAuthorship pass
 * fills any blank that slips through (e.g. ops pasted from another tool).
 * Offline drafts still carry a literal `ME` id (see `OFFLINE_AUTHOR`) so they
 * survive a reload, and stampAuthorship rewrites them to the real id once the
 * user is signed in.
 */

/** The "offline me" placeholder used when no session is available. */
export const ME = "me";
const OFFLINE_AUTHOR = ME;

function commentId(): string {
  return `cmt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

/** Resolve the by id to stamp onto locally emitted authored ops. */
function authorId(): string {
  return getSessionUser()?.id ?? OFFLINE_AUTHOR;
}

/** Start a thread anchored to a node or shape. */
export function addCommentOps(targetId: string, body: string): Operation[] {
  const text = body.trim();
  if (!text) return [];
  return [{ op: "ADD_COMMENT", id: commentId(), targetId, body: text, by: authorId() }];
}

/** Reply within an existing thread. */
export function replyCommentOps(parentId: string, body: string): Operation[] {
  const text = body.trim();
  if (!text) return [];
  return [{ op: "REPLY_COMMENT", id: commentId(), parentId, body: text, by: authorId() }];
}

/** Resolve or reopen a thread. */
export function resolveCommentOps(id: string, resolved: boolean): Operation[] {
  return [{ op: "RESOLVE_COMMENT", id, resolved }];
}

export function deleteCommentOps(id: string): Operation[] {
  return [{ op: "DELETE_COMMENT", id }];
}

/**
 * Split a body into plain text and @mention segments so the thread view can
 * highlight mentions without dangerously rendering HTML.
 */
export function mentionSegments(body: string): Array<{ text: string; mention: boolean }> {
  const out: Array<{ text: string; mention: boolean }> = [];
  const re = /@[\w.-]+/g;
  let last = 0;
  for (const match of body.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ text: body.slice(last, start), mention: false });
    out.push({ text: match[0], mention: true });
    last = start + match[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out;
}

/** Names already used on this board, to suggest in the composer. */
export function knownMentionNames(workspace: Workspace): string[] {
  const names = new Set<string>();
  for (const c of Object.values(workspace.comments ?? {})) {
    for (const m of c.mentions ?? []) names.add(m);
  }
  return [...names].sort();
}

/** Total unresolved threads on the board, for the toolbar badge. */
export function openThreadCount(workspace: Workspace): number {
  return Object.values(openCommentCounts(workspace)).reduce((sum, n) => sum + n, 0);
}

/** A readable anchor label for a thread, for the all-comments list. */
export function commentAnchorLabel(workspace: Workspace, targetId: string): string {
  const node = workspace.nodes[targetId];
  if (node) return node.label;
  const shape = workspace.shapes[targetId];
  if (shape) return shape.text?.split("\n")[0] || shape.kind;
  return targetId;
}

export { commentThreads, openCommentCounts, openMentions, parseMentions };
