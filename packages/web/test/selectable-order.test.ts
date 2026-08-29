import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { selectableOrder, nextSelectable } from "../src/board/geometry.js";

function withNodes(coords: Array<[string, number, number]>) {
  const ws = createWorkspace();
  const ops: Operation[] = [];
  for (const [id] of coords) ops.push({ op: "CREATE_NODE", id, nodeType: "service", label: id });
  for (const [id, x, y] of coords) ops.push({ op: "MOVE_NODE", id, position: { x, y } });
  return applyOperations(ws, ops);
}

describe("selectableOrder", () => {
  it("orders nodes top-to-bottom then left-to-right", () => {
    const ws = withNodes([
      ["c", 0, 300],
      ["a", 0, 0],
      ["b", 200, 0],
    ]);
    expect(selectableOrder(ws).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("treats a near-aligned row as one row (tolerance band)", () => {
    const ws = withNodes([
      ["right", 400, 8],
      ["left", 0, 0],
    ]);
    expect(selectableOrder(ws).map((r) => r.id)).toEqual(["left", "right"]);
  });

  it("includes shapes and skips hidden ones", () => {
    let ws = withNodes([["n", 0, 0]]);
    ws = applyOperations(ws, [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 100, y: 0 },
        size: { width: 50, height: 50 },
      },
      {
        op: "CREATE_SHAPE",
        id: "s2",
        kind: "rect",
        position: { x: 200, y: 0 },
        size: { width: 50, height: 50 },
      },
      { op: "UPDATE_SHAPE", id: "s2", hidden: true },
    ]);
    const ids = selectableOrder(ws).map((r) => r.id);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
  });

  it("tags each ref with its kind", () => {
    let ws = withNodes([["n", 0, 0]]);
    ws = applyOperations(ws, [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 100, y: 0 },
        size: { width: 50, height: 50 },
      },
    ]);
    const order = selectableOrder(ws);
    expect(order.find((r) => r.id === "n")!.kind).toBe("node");
    expect(order.find((r) => r.id === "s1")!.kind).toBe("shape");
  });

  it("is stable (same input → same order)", () => {
    const ws = withNodes([
      ["a", 0, 0],
      ["b", 200, 0],
      ["c", 100, 0],
    ]);
    expect(selectableOrder(ws)).toEqual(selectableOrder(ws));
  });
});

describe("nextSelectable", () => {
  const ws = withNodes([
    ["a", 0, 0],
    ["b", 200, 0],
    ["c", 400, 0],
  ]);

  it("starts at the first object when nothing is selected (Tab)", () => {
    expect(nextSelectable(ws, null, 1)!.id).toBe("a");
  });
  it("starts at the last object when nothing is selected (Shift+Tab)", () => {
    expect(nextSelectable(ws, null, -1)!.id).toBe("c");
  });
  it("advances forward", () => {
    expect(nextSelectable(ws, "a", 1)!.id).toBe("b");
  });
  it("wraps forward past the end", () => {
    expect(nextSelectable(ws, "c", 1)!.id).toBe("a");
  });
  it("wraps backward past the start", () => {
    expect(nextSelectable(ws, "a", -1)!.id).toBe("c");
  });
  it("returns null on an empty board", () => {
    expect(nextSelectable(createWorkspace(), null, 1)).toBeNull();
  });
});
