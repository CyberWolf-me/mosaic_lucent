import {
  CHART_LIMITS,
  chartFromTable,
  createTable,
  type ChartType,
  type Operation,
  type Shape,
} from "@lucent/core";

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
  | "frame"
  | "table"
  | "chart";

const _STICKY_TEXT = [
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
  table: { width: 320, height: 140 },
  chart: { width: 320, height: 220 },
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

const INK_DARK = "oklch(0.20 0.030 45)";
const INK_LIGHT = "oklch(0.96 0.014 82)";

/**
 * Text colour that reads on a shape's own fill, whatever the theme. Shape text
 * used to take the theme's ink, so in dark mode every pastel sticky and
 * swatch fill carried near-white text. Fills are literal colours (the schema's
 * grammar), so lightness is readable straight off them: oklch/oklab's L, or
 * the relative luminance of hex and rgb(). Undefined when it can't tell
 * (hsl), and the theme ink stays.
 */
export function inkOn(fill: string | undefined): string | undefined {
  if (!fill) return undefined;
  const ok = /^okl(?:ch|ab)\(\s*([0-9.]+)(%?)/.exec(fill);
  if (ok) {
    const l = Number.parseFloat(ok[1]!) / (ok[2] ? 100 : 1);
    return l > 0.62 ? INK_DARK : INK_LIGHT;
  }
  let rgb: number[] | undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(fill);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/.exec(fill);
  if (fn) rgb = [fn[1], fn[2], fn[3]].map((v) => Number.parseFloat(v!));
  if (!rgb) return undefined;
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
  return y > 0.3 ? INK_DARK : INK_LIGHT;
}

export type ZMove = "front" | "forward" | "backward" | "back";

/**
 * The UPDATE_SHAPEs that move `ids` in the stacking order (docs/26 §6.4).
 *
 * The order is the one the canvas paints: z, then insertion order for ties. A
 * one-step move swaps each selected shape past its unselected neighbour; front
 * and back move the selection as a block, keeping its internal order. The new
 * order is then written as dense z values, touching only shapes whose z
 * changes, and nothing at all when the order doesn't change (already on top).
 *
 * This replaces "z = min - 1" for Send to back, which went negative and
 * clamped to 0 on render — tying with the other shapes and often not moving
 * anything.
 */
export function zOrderOps(
  all: Record<string, Shape>,
  ids: Iterable<string>,
  move: ZMove,
): Array<Extract<Operation, { op: "UPDATE_SHAPE" }>> {
  const sel = new Set([...ids].filter((id) => all[id]));
  if (sel.size === 0) return [];
  const order = Object.values(all)
    .map((s, i) => ({ id: s.id, z: normalizeZ(s.z), i }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((x) => x.id);
  let next: string[];
  if (move === "front") next = [...order.filter((id) => !sel.has(id)), ...order.filter((id) => sel.has(id))];
  else if (move === "back") next = [...order.filter((id) => sel.has(id)), ...order.filter((id) => !sel.has(id))];
  else {
    next = [...order];
    if (move === "forward") {
      for (let k = next.length - 2; k >= 0; k--) {
        if (sel.has(next[k]!) && !sel.has(next[k + 1]!)) [next[k], next[k + 1]] = [next[k + 1]!, next[k]!];
      }
    } else {
      for (let k = 1; k < next.length; k++) {
        if (sel.has(next[k]!) && !sel.has(next[k - 1]!)) [next[k], next[k - 1]] = [next[k - 1]!, next[k]!];
      }
    }
  }
  if (next.every((id, k) => id === order[k])) return [];
  const ops: Array<Extract<Operation, { op: "UPDATE_SHAPE" }>> = [];
  next.forEach((id, rank) => {
    const z = Math.min(rank + 1, Z_MAX);
    if (all[id]!.z !== z) ops.push({ op: "UPDATE_SHAPE", id, z });
  });
  return ops;
}

/** Next z above every existing shape, clamped into the legal band. */
export function nextZ(shapes: { z?: number }[]): number {
  const top = shapes.reduce((m, s) => Math.max(m, normalizeZ(s.z)), 0);
  return Math.min(top + 1, Z_MAX);
}

/**
 * The CREATE_SHAPE that copies `s` as a new shape `id`, offset by `offset`
 * px — the one definition every duplicate and paste uses. Content travels
 * whole (text, path, image src, style, rotation); state doesn't: a copy is
 * unlocked, visible and ungrouped, because it's something you just made and
 * are about to move. The inspector's duplicate used to hand-copy fields and
 * forgot `src`, so a duplicated image came out blank (docs/26 F10).
 */
export function cloneShapeOp(
  s: Shape,
  id: string,
  offset: number,
  z: number,
): Extract<Operation, { op: "CREATE_SHAPE" }> {
  return {
    op: "CREATE_SHAPE",
    id,
    kind: s.kind,
    position: { x: s.position.x + offset, y: s.position.y + offset },
    size: { ...s.size },
    ...(s.rotation !== undefined ? { rotation: s.rotation } : {}),
    ...(s.text !== undefined ? { text: s.text } : {}),
    ...(s.path !== undefined ? { path: s.path } : {}),
    ...(s.src !== undefined ? { src: s.src } : {}),
    ...(s.vector !== undefined ? { vector: s.vector } : {}),
    ...(s.table !== undefined ? { table: s.table } : {}),
    ...(s.chart !== undefined ? { chart: s.chart } : {}),
    ...(s.style ? { style: { ...s.style } } : {}),
    z: normalizeZ(z),
  };
}

/** Space between a table and the chart made from it. */
const CHART_GAP = 40;

/**
 * "Chart this table" (docs/26 §6.1): a chart shape bound to the table's data,
 * placed to its right with the tops aligned. The first column is the labels
 * and every mostly-numeric column a series (core's `chartFromTable`). A
 * single-series chart has no legend, so it takes the series' header as its
 * title — otherwise nothing on it says what the bars measure. Null when the
 * table has no numeric column to plot.
 */
export function chartBesideTableOp(
  table: Shape,
  z: number,
  type: ChartType = "bar",
): Extract<Operation, { op: "CREATE_SHAPE" }> | null {
  if (!table.table) return null;
  const chart = chartFromTable(table.table, { type });
  if (!chart) return null;
  const only = chart.series.length === 1 ? chart.series[0]!.name.trim() : "";
  return {
    op: "CREATE_SHAPE",
    id: shapeId(),
    kind: "chart",
    position: { x: table.position.x + table.size.width + CHART_GAP, y: table.position.y },
    size: { width: 360, height: Math.min(360, Math.max(SIZES.chart.height, table.size.height)) },
    chart: only ? { ...chart, title: only.slice(0, CHART_LIMITS.titleChars) } : chart,
    z: normalizeZ(z),
  };
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
      text: "",
      rotation: Math.random() * 2 - 1,
      style: { fill: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)]! },
    };
  }
  if (kind === "frame") {
    // Frames sit behind the shapes they contain.
    return { ...base, text: "Frame", z: 0 };
  }
  if (kind === "table") {
    // A starter 3-column, 2-row grid the user fills in.
    return {
      ...base,
      table: createTable(
        ["Column 1", "Column 2", "Column 3"],
        [
          ["", "", ""],
          ["", "", ""],
        ],
      ),
    };
  }
  if (kind === "chart") {
    // A starter bar chart bound to a small sample table, so it plots something
    // immediately and can be re-bound or edited.
    const sample = createTable(
      ["Category", "Value"],
      [
        ["A", "8"],
        ["B", "5"],
        ["C", "12"],
        ["D", "7"],
      ],
    );
    const chart = chartFromTable(sample, { type: "bar", title: "Chart" });
    return chart ? { ...base, chart } : base;
  }
  return base;
}
