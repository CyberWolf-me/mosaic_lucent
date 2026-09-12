/**
 * The ELK candidate engine, pinned at the boundary (doc 18, Phase 2).
 *
 * Not golden numbers — ELK's geometry may change with its version (which is
 * exactly why doc 18 Phase 4 pins it). These are the structural invariants
 * any engine must hold on the shared fixtures: finite geometry for every
 * node, zero overlaps, deterministic output, and routes that exist for a
 * layered flowchart.
 */

import { describe, expect, it } from "vitest";
import { layeredBoard, radialBoard } from "@lucent/core";
import { applyLayout, applyRoutes, computeLayoutWithRoutes } from "@lucent/core";
import { measureVisualMetrics } from "@lucent/core";
import { ELK_LAYOUT_ENGINE } from "../src/diagram/elk/index.js";

describe("ELK layout engine (Phase 2 candidate)", () => {
  it("lays out a 20-node flowchart with finite geometry and zero overlaps", async () => {
    const built = layeredBoard(20);
    const { layout, routes } = await ELK_LAYOUT_ENGINE.layout({ workspace: built, options: {} });

    // Every node placed, finite coordinates.
    expect(Object.keys(layout).length).toBe(20);
    for (const entry of Object.values(layout)) {
      expect(Number.isFinite(entry.position.x)).toBe(true);
      expect(Number.isFinite(entry.position.y)).toBe(true);
    }

    // The standard measurement path sees a healthy board.
    const routed = applyRoutes(applyLayout(built, layout), routes);
    const metrics = measureVisualMetrics(routed);
    expect(metrics.nodeOverlaps).toBe(0);
    expect(metrics.offscreenEntries).toBe(0);
    expect(metrics.edgeCount).toBeGreaterThan(0);
  });

  it("produces routes for a layered flowchart", async () => {
    const built = layeredBoard(80);
    const { routes } = await ELK_LAYOUT_ENGINE.layout({ workspace: built, options: {} });
    // Orthogonal routing bends edges; the exact count is ELK's business.
    expect(Object.keys(routes).length).toBeGreaterThan(0);
  });

  it("is deterministic — same input, same geometry", async () => {
    const built = radialBoard(60);
    const a = await ELK_LAYOUT_ENGINE.layout({ workspace: built, options: {} });
    const b = await ELK_LAYOUT_ENGINE.layout({ workspace: built, options: {} });
    expect(a.layout).toEqual(b.layout);
    expect(a.routes).toEqual(b.routes);
  });

  it("handles compound groups without losing nodes", async () => {
    // The mixed-region shape exercises groups-as-compound-nodes; every node
    // must come back placed regardless of container nesting.
    const { mixedRegionBoard } = await import("@lucent/core");
    const built = mixedRegionBoard(80);
    const { layout } = await ELK_LAYOUT_ENGINE.layout({ workspace: built, options: {} });
    expect(Object.keys(layout).length).toBe(80);
  });

  it("the sync core seam is untouched by the async candidate", () => {
    // Documenting the constraint: computeLayoutWithRoutes stays synchronous
    // and routes through the built-in engine; the ELK engine is consumed by
    // awaiting it directly (the harness today, the worker in Phase 4).
    const built = layeredBoard(40);
    const direct = computeLayoutWithRoutes(built);
    expect(Object.keys(direct.layout).length).toBe(40);
  });
});
