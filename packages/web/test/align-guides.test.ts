import { describe, it, expect } from "vitest";
import type { Shape } from "@lucent/core";
import { alignGuides, snapPosition } from "../src/board/geometry.js";

const shape = (id: string, x: number, y: number, w = 100, h = 60): Shape => ({
  id,
  kind: "rect",
  position: { x, y },
  size: { width: w, height: h },
});

describe("snapPosition with centre/right matching", () => {
  it("snaps left edge to another shape's left edge", () => {
    const p = snapPosition(203, 500, [shape("a", 200, 0)], 6, 8, { width: 100, height: 60 });
    expect(p.x).toBe(200);
  });

  it("snaps right edge to another shape's right edge", () => {
    // Other spans 200..300. Moving shape is 100 wide, so left=200 aligns rights.
    const p = snapPosition(198, 500, [shape("a", 200, 0)], 6, 8, { width: 100, height: 60 });
    expect(p.x).toBe(200);
  });

  it("snaps centres together — impossible before the size argument existed", () => {
    // Other spans 200..300, centre 250. A 40-wide shape centres at left=230.
    const p = snapPosition(232, 500, [shape("a", 200, 0)], 6, 8, { width: 40, height: 20 });
    expect(p.x).toBe(230);
  });

  it("snaps vertical middles together", () => {
    // Other spans y 100..160, middle 130. A 20-tall shape centres at top=120.
    const p = snapPosition(900, 123, [shape("a", 0, 100)], 6, 8, { width: 20, height: 20 });
    expect(p.y).toBe(120);
  });

  it("falls back to the 8px grid when nothing is near", () => {
    const p = snapPosition(103, 45, [], 6, 8, { width: 10, height: 10 });
    expect(p).toEqual({ x: 104, y: 48 });
  });

  it("still works without a size (legacy callers)", () => {
    const p = snapPosition(203, 500, [shape("a", 200, 0)]);
    expect(p.x).toBe(200);
  });
});

describe("alignGuides", () => {
  it("emits a vertical guide when left edges line up", () => {
    const g = alignGuides({ x: 200, y: 400, width: 100, height: 60 }, [shape("a", 200, 0)]);
    const v = g.filter((x) => x.axis === "v");
    expect(v.length).toBeGreaterThan(0);
    expect(v[0]!.at).toBe(200);
  });

  it("spans the guide across both objects", () => {
    const g = alignGuides({ x: 200, y: 400, width: 100, height: 60 }, [
      shape("a", 200, 0, 100, 60),
    ]);
    const v = g.find((x) => x.axis === "v")!;
    expect(v.from).toBe(0);
    expect(v.to).toBe(460);
  });

  it("emits a horizontal guide when middles line up", () => {
    // Other y 100..160 (middle 130); moving 20 tall at y=120 → middle 130.
    const g = alignGuides({ x: 900, y: 120, width: 20, height: 20 }, [shape("a", 0, 100)]);
    expect(g.some((x) => x.axis === "h" && Math.round(x.at) === 130)).toBe(true);
  });

  it("emits nothing when nothing aligns", () => {
    const g = alignGuides({ x: 37, y: 91, width: 100, height: 60 }, [shape("a", 200, 400)]);
    expect(g).toEqual([]);
  });

  it("deduplicates guides on the same axis and coordinate", () => {
    // Two shapes both with left edge 200 → one merged vertical guide.
    const g = alignGuides({ x: 200, y: 400, width: 100, height: 60 }, [
      shape("a", 200, 0),
      shape("b", 200, 700),
    ]);
    const v = g.filter((x) => x.axis === "v" && Math.round(x.at) === 200);
    expect(v).toHaveLength(1);
    // Merged span covers both neighbours.
    expect(v[0]!.from).toBe(0);
    expect(v[0]!.to).toBe(760);
  });
});
