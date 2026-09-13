/**
 * Layout intent (doc 18, Phase 5, advisory V7) — the op chain, the
 * deterministic layout consumption, and the doctrine boundary: the AI may
 * state intent, never position. No intent op in this file carries a
 * coordinate, and none may (the schema has no field for one).
 */

import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  inverseOperations,
  validateOperations,
  type Operation,
  type Workspace,
} from "../src/index.js";

/** A diamond-plus board: a→b, a→c, b→d, c→d, b→c, a→e-skip edge set. */
function diamond(): Workspace {
  let ws = createWorkspace();
  const ops: Operation[] = [];
  for (const id of ["a", "b", "c", "d", "e"]) {
    ops.push({ op: "CREATE_NODE", id, nodeType: "step", label: id.toUpperCase() });
  }
  for (const [s, t] of [
    ["a", "b"],
    ["a", "c"],
    ["b", "d"],
    ["c", "d"],
    ["b", "c"],
  ] as const) {
    ops.push({ op: "CONNECT_NODES", source: s, target: t, relationship: "then" });
  }
  return applyOperations(ws, ops);
}

describe("SET_LAYOUT_INTENT — the op contract", () => {
  it("sets a full intent through the validated reducer", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
      {
        op: "SET_LAYOUT_INTENT",
        direction: "horizontal",
        primaryFlow: ["a"],
        emphasis: ["a"],
      } satisfies Operation,
    ]);
    expect(ws.layoutIntent).toEqual({
      direction: "horizontal",
      primaryFlow: ["a"],
      emphasis: ["a"],
    });
  });

  it("is replace-whole: a later intent replaces, never merges", () => {
    const ws = applyOperations(diamond(), [
      { op: "SET_LAYOUT_INTENT", direction: "horizontal", primaryFlow: ["a", "d"] },
      { op: "SET_LAYOUT_INTENT", emphasis: ["b"] },
    ]);
    expect(ws.layoutIntent).toEqual({ emphasis: ["b"] });
  });

  it("an empty intent clears ({} deletes)", () => {
    const ws = applyOperations(diamond(), [
      { op: "SET_LAYOUT_INTENT", direction: "horizontal" },
      { op: "SET_LAYOUT_INTENT" },
    ]);
    expect(ws.layoutIntent).toBeUndefined();
  });

  it("rejects primaryFlow/emphasis ids that do not exist", () => {
    const errors = validateOperations(diamond(), [
      { op: "SET_LAYOUT_INTENT", primaryFlow: ["ghost"], emphasis: ["also-ghost"] },
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toContain("primaryFlow");
    expect(errors[1]!.message).toContain("emphasis");
  });

  it("accepts ids created earlier in the same batch (a fresh board's spine)", () => {
    const errors = validateOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
      { op: "SET_LAYOUT_INTENT", primaryFlow: ["a"] },
    ]);
    expect(errors).toEqual([]);
  });

  it("undo restores the prior intent exactly, including absent", () => {
    const before = diamond();
    const setIntent: Operation[] = [{ op: "SET_LAYOUT_INTENT", direction: "vertical", emphasis: ["a"] }];
    const after = applyOperations(before, setIntent);
    const undone = applyOperations(after, inverseOperations(setIntent, before));
    expect(undone.layoutIntent).toBeUndefined();

    // And intent-over-intent undo restores the FIRST intent.
    const second: Operation[] = [{ op: "SET_LAYOUT_INTENT", direction: "horizontal" }];
    const afterTwo = applyOperations(after, second);
    const undoneTwo = applyOperations(afterTwo, inverseOperations(second, after));
    expect(undoneTwo.layoutIntent).toEqual({ direction: "vertical", emphasis: ["a"] });
  });

  it("round-trips through the workspace schema (persisted boards keep it)", async () => {
    const { workspaceSchema } = await import("../src/workspaceSchema.js");
    const ws = applyOperations(diamond(), [{ op: "SET_LAYOUT_INTENT", direction: "horizontal" }]);
    const parsed = workspaceSchema.parse(ws);
    expect(parsed.layoutIntent).toEqual({ direction: "horizontal" });
    // A pre-intent board parses unchanged.
    const legacy = workspaceSchema.parse(diamond());
    expect(legacy.layoutIntent).toBeUndefined();
  });
});
