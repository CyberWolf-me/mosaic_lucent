import { describe, it, expect } from "vitest";
import { parseWorkspace, parseWorkspaceOrDefault } from "../src/workspaceSchema.js";
import { safeParseOperations } from "../src/operations.js";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { validateOperations } from "../src/validator.js";
import type { Operation } from "../src/operations.js";

/**
 * M0.5 contract-level validation.
 *
 * The operation union and the workspace schema are the two gates a hostile
 * string has to pass to reach a renderer. These tests pin what each refuses,
 * and confirm the tolerant paths (older boards, missing collections) still
 * load rather than throwing.
 */

describe("operation schema refuses sink-hostile strings", () => {
  const baseShape = {
    op: "CREATE_SHAPE" as const,
    id: "s1",
    kind: "rect" as const,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
  };

  it("accepts a well-formed SVG path", () => {
    const result = safeParseOperations([{ ...baseShape, kind: "draw", path: "M0 0 L10 10 Z" }]);
    expect(result.success).toBe(true);
  });

  it("refuses a path carrying an attribute break-out", () => {
    const result = safeParseOperations([
      { ...baseShape, kind: "draw", path: 'M0 0" onload="alert(1)' },
    ]);
    expect(result.success).toBe(false);
  });

  it("refuses a path over the length cap", () => {
    const result = safeParseOperations([
      { ...baseShape, kind: "draw", path: `M0 0 ${"L1 1 ".repeat(2000)}` },
    ]);
    expect(result.success).toBe(false);
  });

  it("accepts hex, rgb, and hsl colours", () => {
    for (const fill of ["#fff", "#ffcc00", "rgb(1,2,3)", "rgba(1,2,3,0.5)", "hsl(200 50% 50%)"]) {
      const result = safeParseOperations([{ ...baseShape, style: { fill } }]);
      expect(result.success, `expected ${fill} to parse`).toBe(true);
    }
  });

  it("refuses a colour that is really markup", () => {
    const result = safeParseOperations([
      { ...baseShape, style: { fill: 'red" onmouseover="alert(1)' } },
    ]);
    expect(result.success).toBe(false);
  });

  it("refuses a named colour, because the pattern is a whitelist not a blocklist", () => {
    // Deliberate: allowing bare identifiers reopens the sink. The UI emits
    // hex, so this costs nothing in practice.
    expect(safeParseOperations([{ ...baseShape, style: { fill: "red" } }]).success).toBe(false);
  });

  it("accepts an https src and refuses javascript:/data: URLs", () => {
    expect(
      safeParseOperations([{ ...baseShape, kind: "embed", src: "https://example.com/x" }]).success,
    ).toBe(true);
    expect(
      safeParseOperations([{ ...baseShape, kind: "embed", src: "javascript:alert(1)" }]).success,
    ).toBe(false);
    expect(
      safeParseOperations([{ ...baseShape, kind: "embed", src: "data:text/html,<script>" }])
        .success,
    ).toBe(false);
  });
});

describe("parseWorkspace", () => {
  it("round-trips an empty workspace", () => {
    const result = parseWorkspace(createWorkspace({ name: "Board", id: "ws1" }));
    expect(result.ok).toBe(true);
    expect(result.workspace?.name).toBe("Board");
  });

  it("fills missing collections rather than refusing an older board", () => {
    const older = {
      id: "ws1",
      name: "Old",
      diagramKind: "flowchart",
      nodes: {},
      edges: {},
      groups: {},
      // wireframes / shapes / shapeLinks / votes / reactions / comments absent
    };
    const result = parseWorkspace(older);
    expect(result.ok).toBe(true);
    expect(result.workspace?.shapes).toEqual({});
    expect(result.workspace?.comments).toEqual({});
  });

  it("refuses a non-object and an array", () => {
    expect(parseWorkspace(null).ok).toBe(false);
    expect(parseWorkspace("nope").ok).toBe(false);
    expect(parseWorkspace([]).ok).toBe(false);
  });

  it("refuses a collection that is not an object, naming the field", () => {
    const result = parseWorkspace({ ...createWorkspace(), nodes: "not-an-object" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("nodes");
  });

  it("refuses a stored shape whose fill is hostile", () => {
    const ws = {
      ...createWorkspace(),
      shapes: {
        s1: {
          id: "s1",
          kind: "rect",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          style: { fill: 'red" onload="x' },
        },
      },
    };
    expect(parseWorkspace(ws).ok).toBe(false);
  });

  it("parseWorkspaceOrDefault returns an empty board instead of throwing", () => {
    const ws = parseWorkspaceOrDefault({ totally: "wrong" }, "test");
    expect(Object.keys(ws.nodes)).toHaveLength(0);
    expect(ws.diagramKind).toBe("flowchart");
  });
});

describe("validator enforces the locked flag on shapes", () => {
  function boardWithLockedShape() {
    return applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "locked",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        locked: true,
      },
      {
        op: "CREATE_SHAPE",
        id: "free",
        kind: "rect",
        position: { x: 50, y: 0 },
        size: { width: 10, height: 10 },
      },
    ]);
  }

  it("refuses to move a locked shape", () => {
    const ops: Operation[] = [{ op: "UPDATE_SHAPE", id: "locked", position: { x: 99, y: 99 } }];
    const errors = validateOperations(boardWithLockedShape(), ops);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("locked");
  });

  it("refuses to delete a locked shape", () => {
    const errors = validateOperations(boardWithLockedShape(), [
      { op: "DELETE_SHAPE", id: "locked" },
    ]);
    expect(errors).toHaveLength(1);
  });

  it("refuses to group a locked shape", () => {
    const errors = validateOperations(boardWithLockedShape(), [
      { op: "GROUP_SHAPES", groupId: "g1", ids: ["locked", "free"] },
    ]);
    expect(errors).toHaveLength(1);
  });

  it("allows an update that clears the lock", () => {
    const errors = validateOperations(boardWithLockedShape(), [
      { op: "UPDATE_SHAPE", id: "locked", locked: false },
    ]);
    expect(errors).toHaveLength(0);
  });

  it("allows unlock-then-move as one batch", () => {
    const errors = validateOperations(boardWithLockedShape(), [
      { op: "UPDATE_SHAPE", id: "locked", locked: false },
      { op: "UPDATE_SHAPE", id: "locked", position: { x: 99, y: 99 } },
    ]);
    expect(errors).toHaveLength(0);
  });

  it("leaves unlocked shapes fully editable", () => {
    const errors = validateOperations(boardWithLockedShape(), [
      { op: "UPDATE_SHAPE", id: "free", position: { x: 99, y: 99 } },
      { op: "DELETE_SHAPE", id: "free" },
    ]);
    expect(errors).toHaveLength(0);
  });

  it("locks a shape created as locked within the same batch", () => {
    const errors = validateOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        locked: true,
      },
      { op: "UPDATE_SHAPE", id: "s1", position: { x: 5, y: 5 } },
    ]);
    expect(errors).toHaveLength(1);
  });
});
