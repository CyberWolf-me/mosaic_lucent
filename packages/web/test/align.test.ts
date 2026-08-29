import { describe, it, expect } from "vitest";
import type { Shape } from "@lucent/core";
import { alignPositions, distributePositions } from "../src/board/geometry.js";

const shape = (id: string, x: number, y: number, w = 100, h = 60): Shape => ({
  id,
  kind: "rect",
  position: { x, y },
  size: { width: w, height: h },
});

describe("alignment & distribution", () => {
  it("aligns shapes to the left edge", () => {
    const out = alignPositions(
      [shape("a", 10, 0), shape("b", 200, 50), shape("c", 90, 120)],
      "left",
    );
    expect(out.a!.x).toBe(10);
    expect(out.b!.x).toBe(10);
    expect(out.c!.x).toBe(10);
  });

  it("aligns shapes to horizontal center", () => {
    // extent x: 0..300 -> center 150; a 100-wide box centers at x=100
    const out = alignPositions([shape("a", 0, 0), shape("b", 200, 0)], "hcenter");
    expect(out.a!.x).toBe(100);
    expect(out.b!.x).toBe(100);
  });

  it("returns nothing for a single shape", () => {
    expect(alignPositions([shape("a", 0, 0)], "left")).toEqual({});
  });

  it("distributes shapes evenly on the horizontal axis", () => {
    const out = distributePositions([shape("a", 0, 0), shape("b", 40, 0), shape("c", 300, 0)], "h");
    // first stays 0, last stays 300, middle lands halfway = 150
    expect(out.a!.x).toBe(0);
    expect(out.b!.x).toBe(150);
    expect(out.c!.x).toBe(300);
  });

  it("needs at least 3 shapes to distribute", () => {
    expect(distributePositions([shape("a", 0, 0), shape("b", 100, 0)], "h")).toEqual({});
  });
});
