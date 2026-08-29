import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import type { Operation } from "../src/operations.js";

const rect = (id: string): Operation => ({
  op: "CREATE_SHAPE",
  id,
  kind: "rect",
  position: { x: 0, y: 0 },
  size: { width: 100, height: 60 },
});

describe("shape visibility & file kind (Phase A)", () => {
  it("toggles the hidden flag via UPDATE_SHAPE", () => {
    const ws = applyOperations(createWorkspace(), [
      rect("a"),
      { op: "UPDATE_SHAPE", id: "a", hidden: true },
    ]);
    expect(ws.shapes.a?.hidden).toBe(true);
    // hidden:false is stored as absence — the canonical "not hidden" — which the
    // renderer treats identically and which lets undo restore a shape exactly.
    const shown = applyOperations(ws, [{ op: "UPDATE_SHAPE", id: "a", hidden: false }]);
    expect(shown.shapes.a?.hidden).toBeUndefined();
  });

  it("creates a file-kind shape carrying a filename", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "f",
        kind: "file",
        position: { x: 10, y: 10 },
        size: { width: 200, height: 44 },
        text: "spec.pdf",
      },
    ]);
    expect(ws.shapes.f).toMatchObject({ kind: "file", text: "spec.pdf" });
  });

  it("creates an embed-kind shape with a src", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "e",
        kind: "embed",
        position: { x: 0, y: 0 },
        size: { width: 400, height: 260 },
        src: "https://x/embed",
        style: { fill: "iframe" },
      },
    ]);
    expect(ws.shapes.e?.kind).toBe("embed");
    expect(ws.shapes.e?.src).toBe("https://x/embed");
  });
});
