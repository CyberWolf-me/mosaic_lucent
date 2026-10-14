import { applyOperations, type Operation } from "@lucent/core";
import type { OperationActor, StoredBoard } from "./boards.js";
import type { Role } from "./identity.js";
import type { RouteServices } from "./routes/context.js";

/**
 * Commit a validated batch to a stored board from an HTTP route — the second
 * half of `POST /api/boards/:id/ops`, shared with the review actions (ADR
 * 0047) and the orchestrator so all land the same way:
 *
 *   the live room when there is one (every open canvas sees it; the room
 *   re-validates against its own head, broadcasts, and saves its own state)
 *   → the op log directly only when no room is live.
 *
 * The caller has already parsed, stamped, repaired and validated the batch
 * against `board.workspace`.
 */
export type CommitOutcome =
  | { ok: true; seq: number; operationId?: string; duplicate?: boolean }
  | { ok: false; reason: string; head?: number };

export async function commitBatch(
  s: Pick<RouteServices, "commitForBoard" | "boardStore">,
  board: StoredBoard,
  userId: string,
  operations: Operation[],
  label: string,
  actor: OperationActor,
  options: { expectedSeq?: number; requestId?: string; role?: Role } = {},
): Promise<CommitOutcome> {
  // Room-first (found live: 2026-09-10): a batch written only to the store
  // bypassed every live socket, and a later room eviction snapshotted the
  // stale state over it. No expectedSeq to the room: it validates against its
  // own head, fresher than anything the HTTP caller read. The route's
  // authorized role seeds the room for a caller with no socket in it (an
  // agent, an MCP client), so their batch goes through the room too.
  const roomResult = await s.commitForBoard(board.id, userId, operations, label, {
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    actor,
    ...(options.role ? { role: options.role } : {}),
  });
  if (roomResult) {
    // The room broadcast the entry and saved ITS state — the board as it is
    // now. This used to write back `board.workspace` (what this request read)
    // plus the batch, erasing from the stored board everything committed
    // while the request was in flight. A refusal from a live room is the
    // answer; nothing is written behind its back.
    if (roomResult.ok && roomResult.duplicate) {
      return { ok: true, seq: roomResult.head ?? 0, duplicate: true };
    }
    if (roomResult.ok && roomResult.entry) {
      return {
        ok: true,
        seq: roomResult.entry.seq,
        ...(roomResult.entry.operationId !== undefined
          ? { operationId: roomResult.entry.operationId }
          : {}),
      };
    }
    return {
      ok: false,
      reason: roomResult.detail ?? roomResult.error ?? "refused",
      ...(roomResult.head !== undefined ? { head: roomResult.head } : {}),
    };
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
  const current = (await s.boardStore.get(board.id)) ?? board;
  await s.boardStore.put({
    ...current,
    workspace: applyOperations(current.workspace, operations),
    updatedAt: Date.now(),
  });
  return {
    ok: true,
    seq: append.seq,
    ...(append.operationId !== undefined ? { operationId: append.operationId } : {}),
  };
}
