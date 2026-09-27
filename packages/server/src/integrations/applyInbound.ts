import { applyOperations, validateOperations, type Operation } from "@lucent/core";
import type { OperationActor, StoredBoard } from "../boards.js";
import type { RouteServices } from "../routes/context.js";
import type { InboundChangeRecord } from "./inbound.js";

/**
 * Apply one pending inbound change to its board (Stage D7, ADR 0033): the
 * second half of accept, shared by the person who accepts it and by the
 * external-close automation (docs/26 A5) — both land the same SET_ISSUE,
 * the same op-log actor (the integration, as the system), the same link
 * bookkeeping and the same decided record. Only who decided differs.
 *
 * The caller has checked the board's integration boundary and that the
 * record is pending and translatable.
 */
export type ApplyInboundOutcome =
  | {
      ok: true;
      change: InboundChangeRecord | undefined;
      applied: number;
      seq: number;
      persistedByRoom: boolean;
    }
  | {
      ok: false;
      status: 409 | 422;
      error: string;
      detail?: string;
      head?: number;
      reason?: string;
    };

export async function applyInboundChange(
  s: Pick<RouteServices, "commitForBoard" | "broadcastProposal" | "boardStore" | "integrations">,
  board: StoredBoard,
  record: InboundChangeRecord & { mappedValue: NonNullable<InboundChangeRecord["mappedValue"]> },
  decider: {
    /** The op log's `by`: the accepting user, or "system" for an automation. */
    by: string;
    /** Recorded on the change as its decider. */
    decidedBy: string;
    /** The person behind it, when there is one. */
    initiatedBy?: string;
    label?: string;
  },
): Promise<ApplyInboundOutcome> {
  const integrations = s.integrations!;
  const inbound = integrations.inbound!;

  // Apply the REVIEWED SNAPSHOT: a SET_ISSUE carrying the mapped value on
  // the record's field. The system actor — the timeline honestly shows
  // "Lucent ← the provider", accepted by whoever decided.
  const node = board.workspace.nodes[record.nodeId];
  const ops: Operation[] = [
    {
      op: "SET_ISSUE",
      id: record.nodeId,
      issue: issueWith(
        node?.issue as Record<string, unknown> | undefined,
        record.field,
        record.mappedValue,
      ),
    } as Operation,
  ];
  const errors = validateOperations(board.workspace, ops);
  if (errors.length > 0) {
    return {
      ok: false,
      status: 422,
      error: "the inbound change no longer applies to this board",
      detail: errors.map((e) => `${e.op}: ${e.message}`).join("; "),
    };
  }

  const requestId = `inb_${record.id}`;
  const actor: OperationActor = {
    actorType: "system",
    actorId: record.provider,
    ...(decider.initiatedBy ? { initiatedBy: decider.initiatedBy } : {}),
  };
  const label = decider.label ?? `sync from ${record.provider}`;
  let seq: number;
  let persistedByRoom = false;
  const roomResult = await s.commitForBoard(board.id, decider.by, ops, label, {
    requestId,
    actor,
  });
  if (roomResult?.ok && roomResult.entry) {
    seq = roomResult.entry.seq;
    persistedByRoom = true;
    for (const absorbed of roomResult.absorbed ?? []) {
      s.broadcastProposal(board.id, { type: "op", entry: absorbed });
    }
    s.broadcastProposal(board.id, { type: "op", entry: roomResult.entry });
  } else {
    const append = await s.boardStore.appendOp({
      boardId: board.id,
      ops,
      by: decider.by,
      label,
      at: Date.now(),
      requestId,
      actor,
    });
    if (!append.ok) {
      return {
        ok: false,
        status: 409,
        error: "stale board",
        reason: append.reason,
        ...(append.head !== undefined ? { head: append.head } : {}),
      };
    }
    seq = append.seq;
    persistedByRoom = append.duplicate === true;
    if (!persistedByRoom) {
      const updated = applyOperations(board.workspace, ops);
      await s.boardStore.put({ ...board, workspace: updated, updatedAt: Date.now() });
    }
  }

  // What the provider said is a fact about the provider: applying records
  // it on the link (the board now agrees with the provider).
  await recordProviderValue(integrations.store, board.orgId, record);

  const change = await inbound.decide(
    board.id,
    record.id,
    "applied",
    decider.decidedBy,
    Date.now(),
    {
      appliedSeq: seq,
    },
  );
  s.broadcastProposal(board.id, {
    type: "integrations-inbound",
    id: record.id,
    status: "applied",
    by: decider.decidedBy,
  });
  return { ok: true, change, applied: ops.length, seq, persistedByRoom };
}

/** The node's issue with one field set from an inbound change ("" clears it). */
export function issueWith(
  current: Record<string, unknown> | undefined,
  field: InboundChangeRecord["field"],
  value: string,
): Record<string, unknown> {
  const issue: Record<string, unknown> = current
    ? { ...current }
    : { type: "task", status: "open" };
  if (field === "status") issue.status = value;
  else if (value === "") delete issue[field];
  else issue[field] = value;
  return issue;
}

/**
 * Record on the link what the provider said for the record's field — after
 * an accept or a dismiss alike: it's the baseline the next change is news
 * against (docs/26 A5), not what the board agreed to.
 */
export async function recordProviderValue(
  store: NonNullable<RouteServices["integrations"]>["store"],
  orgId: string,
  record: InboundChangeRecord,
): Promise<void> {
  const link = (await store.linksForNode(record.boardId, record.nodeId)).find(
    (l) => l.provider === record.provider,
  );
  if (!link) return;
  await store.linkTask(
    {
      orgId,
      boardId: record.boardId,
      nodeId: record.nodeId,
      provider: record.provider,
      externalId: link.externalId,
      ...(link.url !== undefined ? { url: link.url } : {}),
      lastSyncedStatus: record.field === "status" ? record.externalValue : link.lastSyncedStatus,
      ...(record.field !== "status"
        ? { lastSyncedFields: { [record.field]: record.externalValue } }
        : {}),
    },
    Date.now(),
  );
}
