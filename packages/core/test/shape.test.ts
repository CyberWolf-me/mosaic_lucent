import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { validateOperations } from "../src/validator.js";
import type { Operation } from "../src/operations.js";

const mk = (over: Partial<Extract<Operation, { op: "CREATE_SHAPE" }>> = {}): Operation => ({
  op: "CREATE_SHAPE",
  id: "s1",
  kind: "rect",
  position: { x: 10, y: 20 },
  size: { width: 120, height: 60 },
  ...over,
});

describe("shape operations", () => {
  it("creates, updates, and deletes a shape", () => {
    const created = applyOperations(createWorkspace(), [mk({ text: "Hello" })]);
    expect(created.shapes.s1).toMatchObject({
      kind: "rect",
      text: "Hello",
      position: { x: 10, y: 20 },
    });

    const moved = applyOperations(created, [
      { op: "UPDATE_SHAPE", id: "s1", position: { x: 99, y: 99 }, style: { fill: "#f00" } },
    ]);
    expect(moved.shapes.s1?.position).toEqual({ x: 99, y: 99 });
    expect(moved.shapes.s1?.style?.fill).toBe("#f00");

    const deleted = applyOperations(moved, [{ op: "DELETE_SHAPE", id: "s1" }]);
    expect(deleted.shapes.s1).toBeUndefined();
  });

  it("merges style on update rather than replacing it", () => {
    const created = applyOperations(createWorkspace(), [
      mk({ style: { fill: "#000", opacity: 0.5 } }),
    ]);
    const updated = applyOperations(created, [
      { op: "UPDATE_SHAPE", id: "s1", style: { stroke: "#fff" } },
    ]);
    expect(updated.shapes.s1?.style).toEqual({ fill: "#000", opacity: 0.5, stroke: "#fff" });
  });

  it("connects two shapes and drops links when a shape is deleted", () => {
    const ws = applyOperations(createWorkspace(), [
      mk({ id: "a" }),
      mk({ id: "b", position: { x: 300, y: 20 } }),
      { op: "CONNECT_SHAPES", id: "l1", source: "a", target: "b", label: "flows" },
    ]);
    expect(Object.keys(ws.shapeLinks)).toEqual(["l1"]);

    const afterDelete = applyOperations(ws, [{ op: "DELETE_SHAPE", id: "a" }]);
    expect(Object.keys(afterDelete.shapeLinks)).toEqual([]);
  });

  it("updates a connector's variant and double-arrow flag", () => {
    const ws = applyOperations(createWorkspace(), [
      mk({ id: "a" }),
      mk({ id: "b", position: { x: 300, y: 20 } }),
      { op: "CONNECT_SHAPES", id: "l1", source: "a", target: "b", variant: "curved" },
      { op: "UPDATE_LINK", id: "l1", variant: "elbow", doubleArrow: true, label: "sync" },
    ]);
    expect(ws.shapeLinks.l1).toMatchObject({ variant: "elbow", doubleArrow: true, label: "sync" });
  });

  it("clears groupId when update passes null", () => {
    const ws = applyOperations(createWorkspace(), [mk({ groupId: "g1" })]);
    expect(ws.shapes.s1?.groupId).toBe("g1");
    const cleared = applyOperations(ws, [{ op: "UPDATE_SHAPE", id: "s1", groupId: null }]);
    expect(cleared.shapes.s1?.groupId).toBeUndefined();
  });

  it("validates duplicate create, missing update, and dangling links", () => {
    const ws = applyOperations(createWorkspace(), [mk()]);
    expect(validateOperations(ws, [mk()])[0]?.message).toMatch(/already exists/);
    expect(validateOperations(ws, [{ op: "UPDATE_SHAPE", id: "nope" }])[0]?.message).toMatch(
      /does not exist/,
    );
    expect(
      validateOperations(ws, [{ op: "CONNECT_SHAPES", id: "l1", source: "s1", target: "ghost" }])[0]
        ?.message,
    ).toMatch(/target "ghost" is not a shape or node/);
  });
});
