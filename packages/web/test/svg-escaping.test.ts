import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  type Operation,
} from "@lucent/core";
import { buildBoardSvg, escapeAttr } from "../src/board/geometry.js";

/**
 * SVG export sink safety (M0.5).
 *
 * The operation schema refuses hostile colours and paths, but a workspace can
 * also arrive from an older build's localStorage or an imported JSON file
 * where the schema never ran. The export path therefore escapes every
 * interpolated attribute rather than trusting its input.
 */

describe("escapeAttr", () => {
  it("neutralises the characters that break out of an attribute value", () => {
    expect(escapeAttr('a"b')).not.toContain('"');
    expect(escapeAttr("a'b")).not.toContain("'");
    expect(escapeAttr("a<b>c")).not.toContain("<");
    expect(escapeAttr("a&b")).toBe("a&amp;b");
  });

  it("leaves a legitimate colour untouched in meaning", () => {
    expect(escapeAttr("#ffcc00")).toBe("#ffcc00");
    expect(escapeAttr("rgb(1,2,3)")).toBe("rgb(1,2,3)");
  });
});

describe("buildBoardSvg escapes attributes from stored shapes", () => {
  /** Construct a workspace by hand, bypassing the op schema, the way a stale
   * localStorage blob or a hand-edited JSON import would. */
  function boardWithRawShape(shape: Record<string, unknown>) {
    const ws = createWorkspace({ name: "Export" });
    return {
      ...ws,
      shapes: { s1: { id: "s1", ...shape } as never },
    };
  }

  it("escapes a hostile fill so no attribute break-out reaches the output", () => {
    const ws = boardWithRawShape({
      kind: "rect",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 50 },
      style: { fill: 'red" onload="alert(1)' },
    });
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain('onload="alert(1)"');
    expect(svg).toContain("&quot;");
  });

  it("escapes a hostile stroke", () => {
    const ws = boardWithRawShape({
      kind: "rect",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 50 },
      style: { stroke: '#000" onmouseover="x' },
    });
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain('onmouseover="x"');
  });

  it("escapes a hostile draw path", () => {
    const ws = boardWithRawShape({
      kind: "draw",
      position: { x: 0, y: 0 },
      size: { width: 100, height: 50 },
      path: 'M0 0" onfocus="alert(1)',
      style: { stroke: "#eee" },
    });
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain('onfocus="alert(1)"');
  });

  it("escapes hostile fill on a triangle and a star", () => {
    for (const kind of ["triangle", "star"]) {
      const ws = boardWithRawShape({
        kind,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { fill: 'y" onerror="boom' },
      });
      const svg = buildBoardSvg(ws);
      expect(svg, `${kind} leaked an attribute`).not.toContain('onerror="boom"');
    }
  });

  it("still renders a legitimate board correctly", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "Hello" },
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 50 },
        style: { fill: "#ffcc00" },
      },
    ];
    // Nodes are only drawn once the layout pass has given them coordinates;
    // the export deliberately skips unpositioned nodes.
    const laid = applyLayout(
      applyOperations(createWorkspace({ name: "Fine" }), ops),
      computeLayout(applyOperations(createWorkspace({ name: "Fine" }), ops)),
    );
    const svg = buildBoardSvg(laid);
    expect(svg).toContain("<svg");
    expect(svg).toContain("#ffcc00");
    expect(svg).toContain("Hello");
  });
});
