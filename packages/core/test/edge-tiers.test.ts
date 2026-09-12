/**
 * RELATIONSHIP TIERS + ZOOM DENSITY (V2/V3, 2026-09): the derivation is
 * deterministic off the workspace alone — routed/cross-region edges are
 * secondary, execution edges quiet, everything else primary — and the
 * density policy turns tiers into opacity/hidden per zoom. Pinned: tier
 * classification, the policy's three bands, and the overview invariant
 * (far out, ONLY primary edges draw).
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyOperations,
  applyRoutes,
  computeLayoutWithRoutes,
  densityBand,
  edgeDensity,
  edgeTier,
  edgeTiers,
  type Edge,
  type Operation,
} from "../src/index.js";
import { createWorkspace } from "../src/model.js";

function board(
  nodes: Array<{ id: string; groupId?: string }>,
  edges: Array<{ s: string; t: string; relationship?: string }>,
) {
  const ws = createWorkspace({ diagramKind: "flowchart" });
  const ops: Operation[] = nodes.map((n) => ({
    op: "CREATE_NODE" as const,
    id: n.id,
    nodeType: "process",
    label: n.id,
    ...(n.groupId ? { groupId: n.groupId } : {}),
  }));
  if (nodes.some((n) => n.groupId)) {
    const groups = [...new Set(nodes.filter((n) => n.groupId).map((n) => n.groupId!))];
    for (const gid of groups) {
      ops.push({
        op: "CREATE_GROUP" as const,
        id: gid,
        label: gid,
        children: nodes.filter((n) => n.groupId === gid).map((n) => n.id),
      });
    }
  }
  for (const e of edges) {
    ops.push({
      op: "CONNECT_NODES" as const,
      source: e.s,
      target: e.t,
      relationship: e.relationship ?? "calls",
    });
  }
  return applyOperations(ws, ops);
}

/** Look up an edge by its endpoint pair (the reducer mints edge ids). */
function edgeOf(ws: ReturnType<typeof createWorkspace>, s: string, t: string, rel?: string): Edge {
  const found = Object.values(ws.edges).find(
    (e) => e.source === s && e.target === t && (rel === undefined || e.relationship === rel),
  );
  if (!found) throw new Error(`no edge ${s}->${t}${rel ? ` (${rel})` : ""}`);
  return found;
}

describe("tier classification", () => {
  it("execution edges are quiet; plain same-group flow is primary", () => {
    const ws = board(
      [{ id: "a" }, { id: "b" }],
      [
        { s: "a", t: "b", relationship: "calls" },
        { s: "a", t: "b", relationship: "depends_on" },
        { s: "a", t: "b", relationship: "drives" },
      ],
    );
    expect(edgeTier(ws, edgeOf(ws, "a", "b", "calls"))).toBe("primary");
    expect(edgeTier(ws, edgeOf(ws, "a", "b", "depends_on"))).toBe("quiet");
    expect(edgeTier(ws, edgeOf(ws, "a", "b", "drives"))).toBe("quiet");
  });

  it("cross-region edges are secondary; a missing endpoint never reads primary", () => {
    const ws = board(
      [{ id: "a", groupId: "g1" }, { id: "b", groupId: "g2" }, { id: "c" }],
      [{ s: "a", t: "b" }, { s: "a", t: "c" }],
    );
    expect(edgeTier(ws, edgeOf(ws, "a", "b"))).toBe("secondary");
    expect(edgeTier(ws, edgeOf(ws, "a", "c"))).toBe("secondary"); // grouped → ungrouped
    const dangling: Edge = { id: "dx", source: "a", target: "ghost", relationship: "calls" };
    expect(edgeTier(ws, dangling)).toBe("secondary");
  });

  it("a ROUTED edge is secondary — the V5 corridor is the classifier", () => {
    // a→b→c→d chain plus the a→d skip: only the skip gets a route.
    const ws = board(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        { s: "a", t: "b" },
        { s: "b", t: "c" },
        { s: "c", t: "d" },
        { s: "a", t: "d" },
      ],
    );
    const { layout, routes } = computeLayoutWithRoutes(ws);
    const laid = applyRoutes(applyLayout(ws, layout), routes);
    expect(Object.keys(routes).length).toBe(1);
    expect(edgeTier(laid, edgeOf(laid, "a", "d"))).toBe("secondary");
    expect(edgeTier(laid, edgeOf(laid, "a", "b"))).toBe("primary");
    // The one-pass map agrees.
    const tiers = edgeTiers(laid);
    expect(tiers[edgeOf(laid, "a", "d").id]).toBe("secondary");
    expect(tiers[edgeOf(laid, "a", "b").id]).toBe("primary");
  });

  it("derivation is deterministic", () => {
    const ws = board(
      [{ id: "a", groupId: "g" }, { id: "b", groupId: "g" }],
      [{ s: "a", t: "b" }, { s: "b", t: "a", relationship: "blocks" }],
    );
    expect(edgeTiers(ws)).toEqual(edgeTiers(ws));
  });
});

describe("the zoom-density policy", () => {
  it("zoomed in: everything draws at full weight", () => {
    for (const tier of ["primary", "secondary", "quiet"] as const) {
      const d = edgeDensity(tier, 1);
      expect(d).toEqual({ opacity: 1, hidden: false });
    }
  });

  it("mid zoom: secondary recedes to 0.45; primary and quiet hold", () => {
    expect(edgeDensity("secondary", 0.4)).toEqual({ opacity: 0.45, hidden: false });
    expect(edgeDensity("primary", 0.4)).toEqual({ opacity: 1, hidden: false });
    expect(edgeDensity("quiet", 0.4)).toEqual({ opacity: 1, hidden: false });
  });

  it("far out: ONLY primary draws — the overview invariant", () => {
    expect(edgeDensity("primary", 0.2)).toEqual({ opacity: 1, hidden: false });
    expect(edgeDensity("secondary", 0.2)).toEqual({ opacity: 0, hidden: true });
    expect(edgeDensity("quiet", 0.2)).toEqual({ opacity: 0, hidden: true });
  });

  it("the bands are monotone in zoom", () => {
    for (const tier of ["primary", "secondary", "quiet"] as const) {
      for (let z = 0.05; z < 1.2; z += 0.05) {
        const lo = edgeDensity(tier, z);
        const hi = edgeDensity(tier, z + 0.05);
        // Visibility never decreases as you zoom IN.
        const visLo = lo.hidden ? 0 : lo.opacity;
        const visHi = hi.hidden ? 0 : hi.opacity;
        expect(visHi).toBeGreaterThanOrEqual(visLo);
      }
    }
  });
});

describe("density bands (doc 18 Phase 5)", () => {
  it("bands follow the advisory's node-count boundaries", () => {
    expect(densityBand(1)).toBe("intimate");
    expect(densityBand(30)).toBe("intimate");
    expect(densityBand(31)).toBe("grouped");
    expect(densityBand(80)).toBe("grouped");
    expect(densityBand(81)).toBe("regional");
    expect(densityBand(150)).toBe("regional");
    expect(densityBand(151)).toBe("overview");
    expect(densityBand(300)).toBe("overview");
    expect(densityBand(301)).toBe("atlas");
  });

  it("the intimate band is exactly the pre-band behavior", () => {
    for (const zoom of [1, 0.6, 0.55, 0.4, 0.29, 0.1]) {
      for (const tier of ["primary", "secondary", "quiet"] as const) {
        expect(edgeDensity(tier, zoom, "intimate")).toEqual(edgeDensity(tier, zoom));
      }
    }
  });

  it("a grouped board subdues secondary edges even at full zoom; primary never recedes", () => {
    expect(edgeDensity("secondary", 1, "grouped")).toEqual({ opacity: 0.45, hidden: false });
    expect(edgeDensity("secondary", 1, "regional")).toEqual({ opacity: 0.45, hidden: false });
    expect(edgeDensity("primary", 1, "atlas")).toEqual({ opacity: 1, hidden: false });
  });

  it("overview and atlas boards keep only primary structure at full zoom", () => {
    expect(edgeDensity("secondary", 1, "overview")).toEqual({ opacity: 0, hidden: true });
    expect(edgeDensity("quiet", 1, "atlas")).toEqual({ opacity: 0, hidden: true });
    // Zooming in cannot outrun the band: the cap is a ceiling.
    expect(edgeDensity("secondary", 3, "overview")).toEqual({ opacity: 0, hidden: true });
  });
});
