import { applyOperations, type Operation } from "@lucent/core";
import type { OperationActor, StoredBoard } from "./boards.js";
import type { RouteServices } from "./routes/context.js";

/**
 * Commit a validated batch to a stored board from an HTTP route — the second
 * half of `POST /api/boards/:id/ops`, shared with the review actions (ADR
 * 0047) so both land the same way:
 *
 *   the live room first (so every open canvas sees it; the room re-validates
 *   against its own head) → the op log directly when no room is live →
 *   persist the projection.
 *
 * The caller has already parsed, stamped, repaired and validated the batch
 * against `board.workspace`.
 */
export type CommitOutcome =
  | { ok: true; seq: number; operationId?: string; duplicate?: boolean }
  | { ok: false; reason: string; head?: number };

export async function commitBatch(
  s: Pick<RouteServices, "commitForBoard" | "broadcastProposal" | "boardStore">,
  board: StoredBoard,
  userId: string,
  operations: Operation[],
  label: string,
  actor: OperationActor,
  options: { expectedSeq?: number; requestId?: string } = {},
): Promise<CommitOutcome> {
  // Room-first (found live: 2026-09-10): a batch written only to the store
  // bypassed every live socket, and a later room eviction snapshotted the
  // stale state over it. No expectedSeq to the room: it validates against its
  // own head, fresher than anything the HTTP caller read.
  const roomResult = await s.commitForBoard(board.id, userId, operations, label, {
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    actor,
  });
  if (roomResult?.ok && roomResult.entry) {
    for (const absorbed of roomResult.absorbed ?? []) {
      s.broadcastProposal(board.id, { type: "op", entry: absorbed });
    }
    s.broadcastProposal(board.id, { type: "op", entry: roomResult.entry });
    const updated = applyOperations(board.workspace, operations);
    await s.boardStore.put({ ...board, workspace: updated, updatedAt: Date.now() });
    return {
      ok: true,
      seq: roomResult.entry.seq,
      ...(roomResult.entry.operationId !== undefined
        ? { operationId: roomResult.entry.operationId }
        : {}),
    };
  }
  if (roomResult && !roomResult.ok && roomResult.head !== undefined) {
    return { ok: false, reason: roomResult.error ?? "stale", head: roomResult.head };
  }
  const append = await s.boardStore.appendOp({
    boardId: board.id,
    ops: operations,
    by: userId,
    label,
    at: Date.now(),
    ...(options.expectedSeq !== undefined ? { expectedSeq: options.expectedSeq } : {}),
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    actor,
  });
  if (!append.ok) return { ok: false, reason: append.reason, head: append.head };
  if (append.duplicate) return { ok: true, seq: append.seq, duplicate: true };
  const updated = applyOperations(board.workspace, operations);
  await s.boardStore.put({ ...board, workspace: updated, updatedAt: Date.now() });
  return {
    ok: true,
    seq: append.seq,
    ...(append.operationId !== undefined ? { operationId: append.operationId } : {}),
  };
}
