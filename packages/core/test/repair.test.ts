import { describe, it, expect } from "vitest";
import { repairOperations } from "../src/repair.js";
import { validateOperations } from "../src/validator.js";
import { applyOperations } from "../src/reducer.js";
import { createWorkspace } from "../src/model.js";
import type { Operation } from "../src/operations.js";

describe("repairOperations", () => {
  it("moves CREATE_GROUP ahead of nodes that reference it", () => {
    const raw: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A", groupId: "g" },
      { op: "CREATE_GROUP", id: "g", label: "Group", children: [] },
    ];
    const fixed = repairOperations(raw);
    expect(fixed[0]?.op).toBe("CREATE_GROUP");
    // The reordered batch now validates cleanly.
    expect(validateOperations(createWorkspace(), fixed)).toHaveLength(0);
  });

  it("puts diagram + group creation before connects", () => {
    const raw: Operation[] = [
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "s", label: "B" },
      { op: "CREATE_DIAGRAM", kind: "flowchart" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual([
      "CREATE_DIAGRAM",
      "CREATE_NODE",
      "CREATE_NODE",
      "CONNECT_NODES",
    ]);
    expect(validateOperations(createWorkspace(), fixed)).toHaveLength(0);
  });

  it("is stable within a bucket and never drops operations", () => {
    const raw: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "s", label: "B" },
      { op: "CREATE_NODE", id: "c", nodeType: "s", label: "C" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed).toHaveLength(3);
    expect(fixed.map((o) => (o as { id: string }).id)).toEqual(["a", "b", "c"]);
  });

  /**
   * The probe case (M0.5). Hoisting every CREATE above every non-create turned
   * a valid delete-then-recreate batch into `node "a" already exists`: the
   * CREATE jumped ahead of the DELETE, so by the time the DELETE ran the node
   * it wanted was the freshly-created one, and the CREATE had collided with
   * the pre-existing node. A CREATE whose id is destroyed later in the same
   * batch must keep its original position relative to that destruction.
   */
  it("does not hoist a CREATE_NODE above a DELETE_NODE of the same id", () => {
    const existing = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "Old A" },
    ]);
    const raw: Operation[] = [
      { op: "DELETE_NODE", id: "a" },
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "New A" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual(["DELETE_NODE", "CREATE_NODE"]);
    expect(validateOperations(existing, fixed)).toHaveLength(0);
  });

  it("still hoists an unrelated CREATE_NODE in a batch containing a delete", () => {
    const existing = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "old", nodeType: "s", label: "Old" },
    ]);
    const raw: Operation[] = [
      { op: "CONNECT_NODES", source: "fresh", target: "old", relationship: "next" },
      { op: "DELETE_NODE", id: "old" },
      { op: "CREATE_NODE", id: "fresh", nodeType: "s", label: "Fresh" },
    ];
    const fixed = repairOperations(raw);
    // "fresh" is not deleted in this batch, so it hoists ahead of the connect.
    expect(fixed[0]?.op).toBe("CREATE_NODE");
    expect((fixed[0] as { id: string }).id).toBe("fresh");
    expect(validateOperations(existing, fixed)).toHaveLength(0);
  });

  it("applies the same rule to shapes and wireframes", () => {
    const raw: Operation[] = [
      { op: "DELETE_SHAPE", id: "s1" },
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual(["DELETE_SHAPE", "CREATE_SHAPE"]);
  });

  /**
   * The mirror image of the probe case, and the bug the bucket-4 tag caused: a
   * scratch node the caller creates and then deletes in the same batch. Tagging
   * the create with a bucket that sorted *after* the deletes flipped the batch
   * into a delete-then-recreate, so the DELETE ran against a node that did not
   * exist yet and "a" was left on the board instead of removed.
   */
  it("keeps a CREATE_NODE ahead of a later DELETE_NODE of the same id", () => {
    const raw: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "Scratch A" },
      { op: "DELETE_NODE", id: "a" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual(["CREATE_NODE", "DELETE_NODE"]);
    expect(validateOperations(createWorkspace(), fixed)).toHaveLength(0);
    // The point of the batch: "a" is gone once it has been applied.
    expect(applyOperations(createWorkspace(), fixed).nodes).not.toHaveProperty("a");
  });

  it("never reorders a create/delete pair of the same id in either direction", () => {
    const create: Operation = { op: "CREATE_NODE", id: "a", nodeType: "s", label: "A" };
    const remove: Operation = { op: "DELETE_NODE", id: "a" };
    expect(repairOperations([create, remove])).toEqual([create, remove]);
    expect(repairOperations([remove, create])).toEqual([remove, create]);
  });

  it("preserves create-then-delete order across intervening operations", () => {
    const raw: Operation[] = [
      { op: "CREATE_NODE", id: "tmp", nodeType: "s", label: "Temp" },
      { op: "CREATE_NODE", id: "keep", nodeType: "s", label: "Keep" },
      { op: "CONNECT_NODES", source: "tmp", target: "keep", relationship: "next" },
      { op: "DELETE_NODE", id: "tmp" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual([
      "CREATE_NODE",
      "CREATE_NODE",
      "CONNECT_NODES",
      "DELETE_NODE",
    ]);
    expect(validateOperations(createWorkspace(), fixed)).toHaveLength(0);
  });

  // CREATE_GROUP hoists two buckets, so it had the same inversion.
  it("applies the same rule to a group recreate", () => {
    const existing = applyOperations(createWorkspace(), [
      { op: "CREATE_GROUP", id: "g", label: "Old G", children: [] },
    ]);
    const raw: Operation[] = [
      { op: "DELETE_GROUP", id: "g" },
      { op: "CREATE_GROUP", id: "g", label: "New G", children: [] },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual(["DELETE_GROUP", "CREATE_GROUP"]);
    expect(validateOperations(existing, fixed)).toHaveLength(0);
  });

  // Ids are unique per entity kind, so a deleted shape must not pin a node.
  it("does not pin a CREATE_NODE because a shape with the same id is deleted", () => {
    const existing = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "a",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      },
    ]);
    const raw: Operation[] = [
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
      { op: "DELETE_SHAPE", id: "a" },
      { op: "CREATE_NODE", id: "a", nodeType: "s", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "s", label: "B" },
    ];
    const fixed = repairOperations(raw);
    expect(fixed.map((o) => o.op)).toEqual([
      "CREATE_NODE",
      "CREATE_NODE",
      "CONNECT_NODES",
      "DELETE_SHAPE",
    ]);
    expect(validateOperations(existing, fixed)).toHaveLength(0);
  });
});
