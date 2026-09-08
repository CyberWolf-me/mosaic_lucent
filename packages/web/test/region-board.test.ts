import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, applyLayout, computeLayout } from "@lucent/core";
import { diagramScene } from "../src/board/culling.js";
import { buildBoardSvg } from "../src/board/geometry.js";

const regionBoard = applyLayout(
  applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "hub", nodeType: "topic", label: "Pricing" },
    { op: "CREATE_NODE", id: "b1", nodeType: "idea", label: "Free tier" },
    { op: "CONNECT_NODES", source: "hub", target: "b1", relationship: "branch" },
    {
      op: "CREATE_GROUP",
      id: "region",
      label: "Pricing",
      children: ["hub", "b1"],
      kind: "mindmap",
    },
  ]),
  computeLayout(
    applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "hub", nodeType: "topic", label: "Pricing" },
      { op: "CREATE_NODE", id: "b1", nodeType: "idea", label: "Free tier" },
      { op: "CONNECT_NODES", source: "hub", target: "b1", relationship: "branch" },
      {
        op: "CREATE_GROUP",
        id: "region",
        label: "Pricing",
        children: ["hub", "b1"],
        kind: "mindmap",
      },
    ]),
    { direction: "vertical" },
  ),
);

describe("diagram regions on the board", () => {
  it("groupRegions carries the region's kind", () => {
    const scene = diagramScene(regionBoard);
    const region = scene.groups.find((g) => g.id === "region");
    expect(region?.kind).toBe("mindmap");
    expect(region?.label).toBe("Pricing");
    // The box is measured over real member positions, not the origin.
    expect(region!.width).toBeGreaterThan(0);
    expect(region!.height).toBeGreaterThan(0);
  });

  it("a kindless group renders without a kind field", () => {
    const ws = applyLayout(
      applyOperations(createWorkspace(), [
        { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
        { op: "CREATE_GROUP", id: "g", label: "G", children: ["a"] },
      ]),
      computeLayout(
        applyOperations(createWorkspace(), [
          { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
          { op: "CREATE_GROUP", id: "g", label: "G", children: ["a"] },
        ]),
        { direction: "vertical" },
      ),
    );
    const scene = diagramScene(ws);
    const g = scene.groups.find((x) => x.id === "g");
    expect(g?.kind).toBeUndefined();
    expect("kind" in (g ?? {})).toBe(false);
  });

  it("SVG export labels the region box with its kind", () => {
    const svg = buildBoardSvg(regionBoard);
    // The display vocabulary (DIAGRAM_LABELS), matching the canvas pill —
    // not the raw kind string.
    expect(svg).toContain("Pricing · Mind map");
    // The region rect sits behind the nodes (drawn first).
    const regionIdx = svg.indexOf("Pricing · Mind map");
    const nodeIdx = svg.indexOf("Pricing</text>");
    expect(regionIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(regionIdx);
  });
});
