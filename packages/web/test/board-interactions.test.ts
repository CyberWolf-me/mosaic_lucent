import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations, validateOperations } from "@lucent/core";
import {
  createShapeOp,
  nextZ,
  normalizeZ,
  Z_MAX,
  Z_OVERLAY_DRAW,
  Z_OVERLAY_PEN,
} from "../src/shapes.js";
import { TEMPLATES } from "../src/templates.js";
import { techMarkFor } from "../src/ui/techMarks.js";

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

describe("techMarkFor", () => {
  it("recognizes common technologies by label", () => {
    expect(techMarkFor("PostgreSQL")?.label).toBe("PostgreSQL");
    expect(techMarkFor("Redis cache")?.label).toBe("Redis");
    expect(techMarkFor("Stripe")?.label).toBe("Payments");
    expect(techMarkFor("Google OAuth")?.label).toBe("Google");
    expect(techMarkFor("Kubernetes cluster")?.label).toBe("Kubernetes");
  });

  it("prefers the more specific phrase", () => {
    // "google oauth" must win over the bare "google" key.
    expect(techMarkFor("Sign in with Google OAuth")?.label).toBe("Google");
    // "graph database" must not fall through to the generic database mark.
    expect(techMarkFor("Graph database")?.label).toBe("Graph");
  });

  it("matches whole words only", () => {
    expect(techMarkFor("Cardboard supplier")).toBeNull();
    expect(techMarkFor("Dbxyz")).toBeNull();
  });

  it("returns null for an unrecognized label", () => {
    expect(techMarkFor("Customer")).toBeNull();
    expect(techMarkFor("Review order summary")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(techMarkFor("REDIS")?.label).toBe("Redis");
    expect(techMarkFor("postgres")?.label).toBe("PostgreSQL");
  });
});
