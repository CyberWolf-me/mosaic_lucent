import type { StatementTrust, Workspace } from "./model.js";
import type { Operation } from "./operations.js";

/**
 * The trust ladder at commit (docs/26 J5, ADR 0047). A statement's trust is
 * stamped by the party that knows who is acting — never by the model, never
 * raised by an agent. These are the stamping rules every committer shares,
 * pure over a batch (and, for evidence already on the board, the workspace).
 */

/**
 * Who is committing this batch:
 * - `requested` — AI output a person asked for and saw (a typed or spoken
 *   request, or a proposal they applied): `human-approved`, except a
 *   statement carrying meeting evidence, which stays `ai-suggested` until it
 *   is reviewed on its own.
 * - `manual` — a person's own edit: a new statement is `human-created`
 *   unless the op already names a trust (a review action does).
 * - `agent` — the voice agent, MCP, a server-applied meeting proposal:
 *   `ai-suggested`, whatever the batch claims, and no promotion passes.
 * - `system` — an integration's change: `system`, and no promotion passes.
 */
export type TrustCommitter = "requested" | "manual" | "agent" | "system";

/** The model's output, with any trust it tried to set removed. */
export function withoutTrust(ops: readonly Operation[]): Operation[] {
  return ops.map((op) => {
    if (op.op === "SET_STATEMENT" && op.statement && "trust" in op.statement) {
      const { trust: _claimed, ...statement } = op.statement;
      return { ...op, statement };
    }
    if (op.op === "UPDATE_STATEMENT" && "trust" in op) {
      const { trust: _claimed, ...rest } = op;
      return rest;
    }
    return op;
  });
}

/** Node ids in this batch (or already on the board) that carry meeting evidence. */
function meetingEvidence(
  ops: readonly Operation[],
  workspace?: Workspace,
): (id: string) => boolean {
  const fromBatch = new Set<string>();
  for (const op of ops) {
    if (op.op === "CREATE_NODE" && op.provenance?.meetingId) fromBatch.add(op.id);
  }
  return (id) =>
    fromBatch.has(id) ||
    Boolean(
      workspace?.nodes[id]?.provenance?.meetingId ??
        workspace?.nodes[id]?.statement?.provenance?.meetingId,
    );
}

/** Stamp a batch's statements for the party committing it. */
export function stampTrust(
  ops: readonly Operation[],
  committer: TrustCommitter,
  workspace?: Workspace,
): Operation[] {
  const fromMeeting = meetingEvidence(ops, workspace);
  return ops.map((op): Operation => {
    if (op.op === "SET_STATEMENT" && op.statement) {
      let trust: StatementTrust;
      switch (committer) {
        case "requested":
          trust =
            op.statement.provenance?.meetingId || fromMeeting(op.id)
              ? "ai-suggested"
              : "human-approved";
          break;
        case "manual":
          trust = op.statement.trust ?? "human-created";
          break;
        case "agent":
          trust = "ai-suggested";
          break;
        case "system":
          trust = "system";
          break;
      }
      return { ...op, statement: { ...op.statement, trust } };
    }
    if (op.op === "UPDATE_STATEMENT" && (committer === "agent" || committer === "system")) {
      if (!("trust" in op)) return op;
      const { trust: _raised, ...rest } = op;
      return rest;
    }
    return op;
  });
}

/**
 * A person relabelling a statement the AI suggested has changed what it
 * says: the batch gains the `human-edited` promotion for it (unless the batch
 * already sets that statement's trust).
 */
export function withEditTrust(ops: readonly Operation[], workspace: Workspace): Operation[] {
  const alreadySet = new Set(
    ops.flatMap((op) =>
      (op.op === "UPDATE_STATEMENT" && op.trust) || (op.op === "SET_STATEMENT" && op.statement)
        ? [op.id]
        : [],
    ),
  );
  const edited = new Set<string>();
  for (const op of ops) {
    if (op.op !== "CHANGE_TEXT" || alreadySet.has(op.id)) continue;
    const node = workspace.nodes[op.id];
    if (node?.statement?.trust === "ai-suggested" && op.text !== node.label) edited.add(op.id);
  }
  if (edited.size === 0) return [...ops];
  return [
    ...ops,
    ...[...edited].map((id): Operation => ({ op: "UPDATE_STATEMENT", id, trust: "human-edited" })),
  ];
}
