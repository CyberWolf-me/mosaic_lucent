import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations, validateOperations } from "@lucent/core";
import {
  createShapeOp,
  nextZ,
  normalizeZ,
  Z_MAX,
  Z_OVERLAY_DRAW,
  Z_OVERLAY_PEN,
  inkOn,
  zOrderOps,
} from "../src/shapes.js";
import type { Shape } from "@lucent/core";
import { TEMPLATES } from "../src/templates.js";

/**
 * Shape z used to be Date.now(), which overflows the CSS z-index ceiling
 * (2147483647). Every shape then painted above the transparent draw/pen
 * overlays, so once a board had one shape no further shape could be placed.
 */
describe("shape z-order", () => {
  it("keeps a new shape's z inside the CSS-legal band", () => {
    const op = createShapeOp("rect", 10, 20);
    expect(op.z).toBeLessThanOrEqual(Z_MAX);
    expect(op.z).toBeGreaterThanOrEqual(0);
  });

  it("stacks a new shape above existing ones", () => {
    const existing = [{ z: 3 }, { z: 7 }, { z: 1 }];
    expect(nextZ(existing)).toBe(8);
  });

  it("collapses a legacy timestamp z into the band", () => {
    expect(normalizeZ(1_700_000_000_000)).toBe(Z_MAX);
    expect(nextZ([{ z: 1_700_000_000_000 }])).toBe(Z_MAX);
  });

  it("treats missing or negative z as the floor", () => {
    expect(normalizeZ(undefined)).toBe(0);
    expect(normalizeZ(-5)).toBe(0);
    expect(normalizeZ(Number.NaN)).toBe(0);
  });

  it("keeps tool overlays above every shape", () => {
    expect(Z_OVERLAY_PEN).toBeGreaterThan(Z_MAX);
    expect(Z_OVERLAY_DRAW).toBeGreaterThan(Z_MAX);
    expect(createShapeOp("sticky", 0, 0, undefined, Z_MAX).z).toBeLessThan(Z_OVERLAY_PEN);
  });

  it("places frames behind other shapes", () => {
    expect(createShapeOp("frame", 0, 0).z).toBe(0);
  });
});

/**
 * Templates carried fixed ids, so inserting the same template twice collided
 * ("shape already exists"), failed validation, and silently did nothing.
 */
/**
 * docs/26 §6.4: one-step and all-the-way stacking moves, over the order the
 * canvas actually paints (z, then insertion order for ties).
 */
describe("zOrderOps", () => {
  const board = (zs: Array<[string, number | undefined]>): Record<string, Shape> =>
    Object.fromEntries(
      zs.map(([id, z]) => [
        id,
        {
          id,
          kind: "rect",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
          ...(z === undefined ? {} : { z }),
        } as Shape,
      ]),
    );
  const order = (
    all: Record<string, Shape>,
    ids: string[],
    move: Parameters<typeof zOrderOps>[2],
  ) => {
    const next = { ...all };
    for (const op of zOrderOps(all, ids, move)) next[op.id] = { ...next[op.id]!, z: op.z! };
    return Object.values(next)
      .map((s, i) => ({ id: s.id, z: normalizeZ(s.z), i }))
      .sort((a, b) => a.z - b.z || a.i - b.i)
      .map((x) => x.id)
      .join("");
  };

  it("steps one place at a time, past unselected neighbours only", () => {
    const all = board([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    expect(order(all, ["b"], "forward")).toBe("acbd");
    expect(order(all, ["c"], "backward")).toBe("acbd");
    // A selected block moves together.
    expect(order(all, ["a", "b"], "forward")).toBe("cabd");
  });

  it("moves to front and back as a block, keeping the selection's own order", () => {
    const all = board([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    expect(order(all, ["a", "c"], "front")).toBe("bdac");
    expect(order(all, ["b", "d"], "back")).toBe("bdac");
  });

  it("really sends to the back — the old min-1 went negative and clamped into a tie", () => {
    const all = board([
      ["a", 0],
      ["b", 0],
      ["c", 0],
    ]);
    expect(order(all, ["c"], "back")).toBe("cab");
  });

  it("does nothing when nothing would change", () => {
    const all = board([
      ["a", 1],
      ["b", 2],
    ]);
    expect(zOrderOps(all, ["b"], "front")).toEqual([]);
    expect(zOrderOps(all, ["b"], "forward")).toEqual([]);
    expect(zOrderOps(all, ["a"], "back")).toEqual([]);
    expect(zOrderOps(all, ["missing"], "front")).toEqual([]);
  });
});

describe("templates", () => {
  it("produces a valid batch against an empty board", () => {
    for (const t of TEMPLATES) {
      expect(validateOperations(createWorkspace(), t.build()), t.name).toHaveLength(0);
    }
  });

  it("can be inserted twice without id collisions", () => {
    for (const t of TEMPLATES) {
      let ws = createWorkspace();
      const first = t.build();
      expect(validateOperations(ws, first), `${t.name} first`).toHaveLength(0);
      ws = applyOperations(ws, first);
      const second = t.build();
      expect(validateOperations(ws, second), `${t.name} second`).toHaveLength(0);
      ws = applyOperations(ws, second);
    }
  });

  it("uses only legal z values", () => {
    for (const t of TEMPLATES) {
      for (const op of t.build()) {
        if (op.op === "CREATE_SHAPE" && op.z !== undefined) {
          expect(op.z, t.name).toBeLessThanOrEqual(Z_MAX);
        }
      }
    }
  });
});

/** Shape text follows its fill, not the theme: dark mode used to put near-white text on pastel fills. */
describe("inkOn", () => {
  it("dark ink on light fills, light ink on dark ones, in every literal form", () => {
    const DARK = "oklch(0.20 0.030 45)";
    const LIGHT = "oklch(0.96 0.014 82)";
    expect(inkOn("oklch(0.86 0.08 235)")).toBe(DARK);
    expect(inkOn("oklch(35% 0.1 250)")).toBe(LIGHT);
    expect(inkOn("#f8dc86")).toBe(DARK);
    expect(inkOn("#fff")).toBe(DARK);
    expect(inkOn("#1a1a1a")).toBe(LIGHT);
    expect(inkOn("rgb(20, 40, 90)")).toBe(LIGHT);
  });

  it("stays out of it when it can't tell", () => {
    expect(inkOn(undefined)).toBeUndefined();
    expect(inkOn("hsl(200 50% 50%)")).toBeUndefined();
  });
});
