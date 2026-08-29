import type { Operation } from "./operations.js";

/**
 * Best-effort repair of a raw AI operation batch so well-intentioned but
 * mis-ordered output still validates (docs/15 Phase C). Frontier models often
 * emit a CREATE_NODE that references a group before the CREATE_GROUP, or a
 * CONNECT_NODES before both endpoints exist. We reorder deterministically into
 * buckets, lowest bucket first:
 *
 *   0. CREATE_DIAGRAM / TRANSFORM_DIAGRAM
 *   1. CREATE_GROUP
 *   2. CREATE_NODE / CREATE_SHAPE / CREATE_WIREFRAME
 *   3. everything else (connect, change, move, delete, group/ungroup...)
 *
 * Within each bucket the model's original order is preserved (stable). This
 * never invents or drops operations — it only reorders — so behavior stays
 * deterministic and the validator remains the source of truth.
 *
 * M0.5: hoisting must not move a create across a delete of the *same* entity in
 * either direction, because the two orderings mean opposite things and both are
 * legitimate. Delete-then-recreate replaces an entity; create-then-delete is a
 * scratch entity that must be gone by the end of the batch. Swapping either one
 * for the other yields a batch the validator rejects ("already exists" one way,
 * "does not exist" the other) and, when it slips through, leaves the board in
 * the state the caller did not ask for. So a create the caller wrote *after* a
 * delete of its own id gives up its hoist and stays in bucket 3 alongside the
 * deletes, where the stable index tiebreak keeps it behind that delete. A
 * create written *before* the delete needs no special case: its own bucket
 * already sorts ahead of bucket 3.
 */

/**
 * Where everything that is not a create lands, deletes included. A create
 * pinned here is ordered against those deletes by its original index.
 */
const TRAILING_BUCKET = 3;

/**
 * Identity of the entity an op creates or destroys, or undefined for ops that
 * do neither. The kind belongs in the key because ids are only unique per kind:
 * a DELETE_SHAPE "a" says nothing about a CREATE_NODE "a".
 */
const entityKey = (op: Operation): string | undefined => {
  switch (op.op) {
    case "CREATE_NODE":
    case "DELETE_NODE":
      return `node:${op.id}`;
    case "CREATE_GROUP":
    case "DELETE_GROUP":
      return `group:${op.id}`;
    case "CREATE_SHAPE":
    case "DELETE_SHAPE":
      return `shape:${op.id}`;
    case "CREATE_WIREFRAME":
    case "DELETE_WIREFRAME":
      return `wireframe:${op.id}`;
    default:
      return undefined;
  }
};

const isCreate = (op: Operation): boolean =>
  op.op === "CREATE_NODE" ||
  op.op === "CREATE_GROUP" ||
  op.op === "CREATE_SHAPE" ||
  op.op === "CREATE_WIREFRAME";

export function repairOperations(ops: Operation[]): Operation[] {
  const bucket = (op: Operation): number => {
    switch (op.op) {
      case "CREATE_DIAGRAM":
      case "TRANSFORM_DIAGRAM":
        return 0;
      case "CREATE_GROUP":
        return 1;
      case "CREATE_NODE":
      case "CREATE_SHAPE":
      case "CREATE_WIREFRAME":
        return 2;
      default:
        return TRAILING_BUCKET;
    }
  };
  // Earliest index at which each entity is destroyed. Only creates and deletes
  // have an entity key, so a keyed op that is not a create is a delete.
  const destroyedAt = new Map<string, number>();
  ops.forEach((op, i) => {
    const key = isCreate(op) ? undefined : entityKey(op);
    if (key !== undefined && !destroyedAt.has(key)) destroyedAt.set(key, i);
  });
  return ops
    .map((op, i) => {
      const key = isCreate(op) ? entityKey(op) : undefined;
      // A create preceded by a delete of the same entity is a recreate: pinning
      // it to the trailing bucket leaves it exactly where the caller put it.
      const isRecreate = key !== undefined && (destroyedAt.get(key) ?? Infinity) < i;
      return { op, i, b: isRecreate ? TRAILING_BUCKET : bucket(op) };
    })
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.op);
}
