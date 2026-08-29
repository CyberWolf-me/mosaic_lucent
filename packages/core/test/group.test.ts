import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations } from "@lucent/core";
import type { Operation } from "@lucent/core";

const mk = (id: string, x = 0): Operation => ({
  op: "CREATE_SHAPE",
  id,
  kind: "rect",
  position: { x, y: 0 },
  size: { width: 100, height: 60 },
});

describe("shape grouping", () => {
  it("assigns a groupId to every member on GROUP_SHAPES", () => {
    const ws = applyOperations(createWorkspace(), [
      mk("a"),
      mk("b", 200),
      mk("c", 400),
      { op: "GROUP_SHAPES", groupId: "g1", ids: ["a", "b", "c"] },
    ]);
    expect(ws.shapes.a?.groupId).toBe("g1");
    expect(ws.shapes.b?.groupId).toBe("g1");
    expect(ws.shapes.c?.groupId).toBe("g1");
  });

  it("clears groupId from all members on UNGROUP_SHAPES", () => {
    const ws = applyOperations(createWorkspace(), [
      mk("a"),
      mk("b", 200),
      { op: "GROUP_SHAPES", groupId: "g1", ids: ["a", "b"] },
      { op: "UNGROUP_SHAPES", groupId: "g1" },
    ]);
    expect(ws.shapes.a?.groupId).toBeUndefined();
    expect(ws.shapes.b?.groupId).toBeUndefined();
  });

  it("toggles the locked flag via UPDATE_SHAPE", () => {
    const ws = applyOperations(createWorkspace(), [
      mk("a"),
      { op: "UPDATE_SHAPE", id: "a", locked: true },
    ]);
    expect(ws.shapes.a?.locked).toBe(true);
  });
});
