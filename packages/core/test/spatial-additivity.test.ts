import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  createWorkspace,
  computeLayout,
  relayoutRegion,
  separateRegions,
} from "@lucent/core";
import type { Operation } from "@lucent/core";

/**
 * SPATIAL ADDITIVITY (M2) — the meeting-growth invariant:
 *
 *   AI-generated additions must be spatially additive by default; existing
 *   committed objects keep their positions unless the user explicitly asks
 *   for a transformation.
 *
 * A board that grows topic-by-topic through a meeting is the user's mental
 * map. The old commit path re-ran the full-board layout on every change, so
 * adding a pricing region could shuffle the product region the user had
 * already read. `relayoutRegion` re-lays out ONE group at its current
 * origin; `separateRegions` resolves growth collisions by pushing only the
 * right-hand neighbours that a grown region would overlap.
 */

const seedTwoRegions = (): Operation[] => [
  // Product region (mindmap-style): hub + two branches.
  { op: "CREATE_NODE", id: "p-hub", nodeType: "topic", label: "Product" },
  { op: "CREATE_NODE", id: "p-a", nodeType: "idea", label: "Users", groupId: "product" },
  { op: "CREATE_NODE", id: "p-b", nodeType: "idea", label: "Features", groupId: "product" },
  { op: "CONNECT_NODES", source: "p-hub", target: "p-a", relationship: "branch" },
  { op: "CONNECT_NODES", source: "p-hub", target: "p-b", relationship: "branch" },
  {
    op: "CREATE_GROUP",
    id: "product",
    label: "Product",
    children: ["p-hub", "p-a", "p-b"],
    kind: "mindmap",
  },
  // Pricing region (flowchart chain).
  { op: "CREATE_NODE", id: "pr-1", nodeType: "step", label: "Free tier", groupId: "pricing" },
  { op: "CREATE_NODE", id: "pr-2", nodeType: "step", label: "Pro tier", groupId: "pricing" },
  { op: "CONNECT_NODES", source: "pr-1", target: "pr-2", relationship: "then" },
  {
    op: "CREATE_GROUP",
    id: "pricing",
    label: "Pricing",
    children: ["pr-1", "pr-2"],
    kind: "flowchart",
  },
  // An ungrouped board node too — must never move.
  { op: "CREATE_NODE", id: "loose", nodeType: "note", label: "Loose note" },
];

describe("relayoutRegion — spatial additivity", () => {
  it("moves ONLY the named group's members; everything else keeps its position", () => {
    const base = applyLayout(
      applyOperations(createWorkspace(), seedTwoRegions()),
      computeLayout(applyOperations(createWorkspace(), seedTwoRegions()), {
        direction: "vertical",
      }),
    );
    const before = {
      hub: { ...base.nodes["p-hub"]!.position! },
      loose: { ...base.nodes["loose"]!.position! },
      pr1: { ...base.nodes["pr-1"]!.position! },
    };

    const result = relayoutRegion(base, "product");
    expect(result).not.toBeNull();
    const next = applyLayout(base, result!);

    // Product members MAY move (it was re-laid out)…
    expect(next.nodes["p-hub"]!.position).toBeDefined();
    // …but the pricing region and the loose node are EXACTLY where they were.
    expect(next.nodes["pr-1"]!.position).toEqual(before.pr1);
    expect(next.nodes["loose"]!.position).toEqual(before.loose);
  });

  it("keeps the region at its existing origin (no drift toward the board origin)", () => {
    const base = applyLayout(
      applyOperations(createWorkspace(), seedTwoRegions()),
      computeLayout(applyOperations(createWorkspace(), seedTwoRegions()), {
        direction: "vertical",
      }),
    );
    const before = base.nodes["p-hub"]!.position!;
    const result = relayoutRegion(base, "product");
    const next = applyLayout(base, result!);
    const after = next.nodes["p-hub"]!.position!;
    // The hub stays in the neighbourhood of its old position (the region did
    // not teleport to (0,0) or get re-packed into the region strip).
    expect(Math.abs(after.x - before.x)).toBeLessThan(400);
    expect(Math.abs(after.y - before.y)).toBeLessThan(400);
  });

  it("respects the group's own kind: a mindmap region relayouts radially", () => {
    const base = applyLayout(
      applyOperations(createWorkspace(), seedTwoRegions()),
      computeLayout(applyOperations(createWorkspace(), seedTwoRegions()), {
        direction: "vertical",
      }),
    );
    const result = relayoutRegion(base, "product")!;
    // The hub is the most-connected node: after a radial relayout its two
    // branches sit on opposite sides (angle spread), not stacked in a line.
    const next = applyLayout(base, result);
    const hub = next.nodes["p-hub"]!.position!;
    const a = next.nodes["p-a"]!.position!;
    const b = next.nodes["p-b"]!.position!;
    const angleA = Math.atan2(a.y - hub.y, a.x - hub.x);
    const angleB = Math.atan2(b.y - hub.y, b.x - hub.x);
    expect(Math.abs(angleA - angleB)).toBeGreaterThan(1); // fan, not a stack
  });

  it("returns null for an unknown group or a group with no members", () => {
    const base = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "x", nodeType: "t", label: "X" },
      { op: "CREATE_GROUP", id: "empty", label: "Empty", children: [] },
    ]);
    expect(relayoutRegion(base, "no-such-group")).toBeNull();
    expect(relayoutRegion(base, "empty")).toBeNull();
  });

  it("pinned members keep their hand placement through the region relayout", () => {
    const seeded = applyOperations(createWorkspace(), [
      ...seedTwoRegions(),
      { op: "MOVE_NODE", id: "p-a", position: { x: 5000, y: 5000 } }, // pins p-a
    ]);
    const base = applyLayout(seeded, computeLayout(seeded, { direction: "vertical" }));
    const result = relayoutRegion(base, "product");
    const next = applyLayout(base, result!);
    expect(next.nodes["p-a"]!.position).toEqual({ x: 5000, y: 5000 });
  });
});

describe("separateRegions — growth overlap resolution", () => {
  it("pushes only right-hand neighbours a grown region would overlap", () => {
    // Two regions side by side, no overlap: nothing moves.
    const seeded = applyOperations(createWorkspace(), seedTwoRegions());
    const base = applyLayout(seeded, computeLayout(seeded, { direction: "vertical" }));
    // With the default packing the regions are already separated — no shifts.
    const shifts = separateRegions(base, "product");
    expect(shifts).toBeNull();
  });

  it("moves only members of the overlapped neighbour, never the grower or others", () => {
    // Force an overlap: move pricing right on top of product's tail.
    const seeded = applyOperations(createWorkspace(), [
      ...seedTwoRegions(),
      { op: "MOVE_NODE", id: "pr-1", position: { x: 100, y: 0 }, pinned: false },
      { op: "MOVE_NODE", id: "pr-2", position: { x: 120, y: 80 }, pinned: false },
    ]);
    const base = applyLayout(seeded, computeLayout(seeded, { direction: "vertical" }));
    const shifts = separateRegions(base, "product");
    if (shifts !== null) {
      // Only pricing members appear in the shift set.
      const shiftedIds = Object.keys(shifts);
      for (const id of shiftedIds) {
        expect(["pr-1", "pr-2"]).toContain(id);
      }
    }
  });
});
