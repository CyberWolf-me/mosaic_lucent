import type { Operation } from "@lucent/core";

/**
 * Default geometry/text for a freshly dropped shape kind. Centralizes the shape
 * factory so CanvasView just emits a CREATE_SHAPE operation (docs/13).
 */

/** Kinds the toolbar can drop directly (draw/image come from other flows). */
export type DropKind =
  | "rect"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "star"
  | "sticky"
  | "text"
  | "frame";

const STICKY_TEXT = [
  "Try one-click checkout",
  "Ask: what happens if Stripe fails?",
  "Move payment above shipping",
  "Add SSO for enterprise",
  "Consider magic link",
  "Cache session in Redis",
];

const STICKY_COLORS = [
  "oklch(0.90 0.11 92)",
  "oklch(0.86 0.08 235)",
  "oklch(0.86 0.10 10)",
  "oklch(0.87 0.09 145)",
];

const SIZES: Record<DropKind, { width: number; height: number }> = {
  rect: { width: 150, height: 72 },
  ellipse: { width: 150, height: 90 },
  diamond: { width: 110, height: 110 },
  triangle: { width: 120, height: 100 },
  star: { width: 110, height: 110 },
  sticky: { width: 160, height: 120 },
  text: { width: 180, height: 32 },
  frame: { width: 320, height: 220 },
};

export function shapeId(): string {
  return `shape_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

/**
 * Z-order lives in a small integer band. This used to be `Date.now()` (~1.7e12),
 * which exceeds the CSS `z-index` maximum (2147483647): every shape clamped to
 * the very top of the stacking context and covered the transparent draw/marquee
 * overlays, so new shapes could not be placed once one shape existed.
 */
export const Z_MAX = 10_000;

/**
 * Interaction overlays (draw-to-place, pen, marquee) must sit above every shape
 * so a click always reaches the tool rather than a shape underneath. Keeping
 * these above Z_MAX makes that ordering explicit instead of a coincidence of
 * whichever number each layer happened to pick.
 */
export const Z_OVERLAY_PEN = Z_MAX + 10;
export const Z_OVERLAY_DRAW = Z_MAX + 20;

/** Coerce any stored z (including legacy timestamps) into the legal band. */
export function normalizeZ(z: number | undefined): number {
  if (z === undefined || !Number.isFinite(z)) return 0;
  if (z <= 0) return 0;
  return Math.min(Math.round(z), Z_MAX);
}

/** Next z above every existing shape, clamped into the legal band. */
export function nextZ(shapes: { z?: number }[]): number {
  const top = shapes.reduce((m, s) => Math.max(m, normalizeZ(s.z)), 0);
  return Math.min(top + 1, Z_MAX);
}

export function createShapeOp(
  kind: DropKind,
  x: number,
  y: number,
  size?: { width: number; height: number },
  z = 1,
): Extract<Operation, { op: "CREATE_SHAPE" }> {
  const id = shapeId();
  const base = {
    op: "CREATE_SHAPE" as const,
    id,
    kind,
    position: { x, y },
    size: size ?? SIZES[kind],
    z: normalizeZ(z),
  };
  if (kind === "sticky") {
    return {
      ...base,
      text: STICKY_TEXT[Math.floor(Math.random() * STICKY_TEXT.length)]!,
      rotation: Math.random() * 4 - 2,
      style: { fill: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)]! },
    };
  }
  if (kind === "frame") {
    // Frames sit behind the shapes they contain.
    return { ...base, text: "Frame", z: 0 };
  }
  return base;
}
