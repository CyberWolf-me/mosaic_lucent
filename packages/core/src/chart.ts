import * as z from "zod/v4";
import type { TableData } from "./table.js";

/**
 * Data charts (docs/26 §6.1 V4). A `chart` object kind carries structured DATA
 * — a type, labels and numeric series — on a shape's `chart` field, the same
 * way `table` rides `shape.table`. It is bound to tabular data: `chartFromTable`
 * turns a table (or imported CSV) into a chart, satisfying "CSV/table → chart".
 *
 * The DRAWN TRUTH is one function: `chartGeometry` turns the data + a box into a
 * flat list of primitives (rects, lines, slices, text). The canvas renderer and
 * the SVG export both build from that list, so what is measured is what is
 * drawn — the same discipline the edge router follows.
 */

export type ChartType = "bar" | "line" | "pie";

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  type: ChartType;
  title?: string;
  /** Category labels (x-axis for bar/line, slice names for pie). */
  labels: string[];
  series: ChartSeries[];
}

export const CHART_LIMITS = {
  labels: 60,
  series: 12,
  nameChars: 120,
  titleChars: 200,
} as const;

const finite = z.number().refine(Number.isFinite, "not a finite number");

export const chartDataSchema = z.object({
  type: z.enum(["bar", "line", "pie"]),
  title: z.string().max(CHART_LIMITS.titleChars).optional(),
  labels: z.array(z.string().max(CHART_LIMITS.nameChars)).max(CHART_LIMITS.labels),
  series: z
    .array(
      z.object({
        name: z.string().max(CHART_LIMITS.nameChars),
        values: z.array(finite).max(CHART_LIMITS.labels),
      }),
    )
    .min(1)
    .max(CHART_LIMITS.series),
});

/** The default categorical palette — distinct hues, stable order. */
export const CHART_PALETTE = [
  "#4f8cff",
  "#ff8f4f",
  "#43c59e",
  "#c74fff",
  "#ffcf4f",
  "#ff5f7e",
  "#4fd0ff",
  "#9bce43",
  "#b18cff",
  "#ff6f4f",
  "#4fbf8f",
  "#e0637f",
] as const;

export function chartColor(i: number): string {
  return CHART_PALETTE[i % CHART_PALETTE.length]!;
}

/**
 * Parse a number out of a cell: strips thousands separators, currency and
 * percent signs. Returns null when the cell isn't numeric.
 */
export function parseNumericCell(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const cleaned = cell.replace(/[,$£€%\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bind a table to a chart. The first column supplies labels; every other column
 * whose cells are mostly numeric becomes a series named by its header. Returns
 * null when no numeric column is found (nothing to plot).
 */
export function chartFromTable(
  table: TableData,
  opts: { type?: ChartType; title?: string; labelColumn?: number } = {},
): ChartData | null {
  const type = opts.type ?? "bar";
  const cols = table.columns.length;
  if (cols === 0) return null;
  const labelCol = Math.min(Math.max(0, opts.labelColumn ?? 0), cols - 1);
  const labels = table.rows.map((r) => r.cells[labelCol] ?? "").slice(0, CHART_LIMITS.labels);

  const series: ChartSeries[] = [];
  for (let c = 0; c < cols && series.length < CHART_LIMITS.series; c++) {
    if (c === labelCol) continue;
    const parsed = table.rows.map((r) => parseNumericCell(r.cells[c]));
    const numericCount = parsed.filter((v) => v !== null).length;
    // A column is a series only if at least half its cells are numbers.
    if (numericCount === 0 || numericCount * 2 < parsed.length) continue;
    series.push({
      name: (table.columns[c]?.header ?? `Series ${c}`).slice(0, CHART_LIMITS.nameChars),
      values: parsed.slice(0, CHART_LIMITS.labels).map((v) => v ?? 0),
    });
  }
  if (series.length === 0) return null;
  return {
    type,
    ...(opts.title ? { title: opts.title.slice(0, CHART_LIMITS.titleChars) } : {}),
    labels,
    series,
  };
}

// ---------------------------------------------------------------------------
// Drawn truth: one geometry, two consumers (canvas render + SVG export)
// ---------------------------------------------------------------------------

export type ChartPrimitive =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }
  | { kind: "polyline"; points: Array<[number, number]>; stroke: string; width: number }
  | { kind: "path"; d: string; fill: string }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      anchor: "start" | "middle" | "end";
      fill: string;
      size: number;
      weight?: number;
    };

const AXIS = "#5a5a62";
const GRID = "#33333a";
const LABEL = "#b8b8c0";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Produce the drawn primitives for a chart in a `w`×`h` box. Pure/deterministic. */
export function chartGeometry(data: ChartData, w: number, h: number): ChartPrimitive[] {
  if (data.type === "pie") return pieGeometry(data, w, h);
  return axisGeometry(data, w, h);
}

function axisGeometry(data: ChartData, w: number, h: number): ChartPrimitive[] {
  const out: ChartPrimitive[] = [];
  const padL = 40;
  const padR = 12;
  const padT = data.title ? 26 : 12;
  const padB = 28;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const x0 = padL;
  const y0 = padT + plotH;

  if (data.title) {
    out.push({ kind: "text", x: w / 2, y: 16, text: data.title, anchor: "middle", fill: LABEL, size: 13, weight: 600 });
  }

  const allValues = data.series.flatMap((s) => s.values);
  const rawMax = Math.max(1, ...allValues.map((v) => Math.max(0, v)));
  const max = niceMax(rawMax);

  // Axes + a couple of gridlines.
  out.push({ kind: "line", x1: x0, y1: padT, x2: x0, y2: y0, stroke: AXIS, width: 1 });
  out.push({ kind: "line", x1: x0, y1: y0, x2: x0 + plotW, y2: y0, stroke: AXIS, width: 1 });
  for (let g = 1; g <= 2; g++) {
    const gy = y0 - (plotH * g) / 2;
    out.push({ kind: "line", x1: x0, y1: gy, x2: x0 + plotW, y2: gy, stroke: GRID, width: 1 });
    out.push({
      kind: "text",
      x: x0 - 5,
      y: gy + 3,
      text: String(Math.round((max * g) / 2)),
      anchor: "end",
      fill: LABEL,
      size: 9,
    });
  }

  const n = Math.max(1, data.labels.length || Math.max(...data.series.map((s) => s.values.length)));
  const slot = plotW / n;

  if (data.type === "bar") {
    const groups = data.series.length;
    const groupW = slot * 0.7;
    const barW = groupW / groups;
    for (let i = 0; i < n; i++) {
      const cx = x0 + slot * i + (slot - groupW) / 2;
      data.series.forEach((s, si) => {
        const v = Math.max(0, s.values[i] ?? 0);
        const bh = (v / max) * plotH;
        out.push({ kind: "rect", x: cx + barW * si, y: y0 - bh, w: Math.max(1, barW - 1), h: bh, fill: chartColor(si) });
      });
      const label = data.labels[i];
      if (label) out.push({ kind: "text", x: x0 + slot * i + slot / 2, y: y0 + 14, text: label, anchor: "middle", fill: LABEL, size: 9 });
    }
  } else {
    // line
    data.series.forEach((s, si) => {
      const points: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const v = Math.max(0, s.values[i] ?? 0);
        points.push([x0 + slot * i + slot / 2, y0 - (v / max) * plotH]);
      }
      out.push({ kind: "polyline", points, stroke: chartColor(si), width: 2 });
    });
    for (let i = 0; i < n; i++) {
      const label = data.labels[i];
      if (label) out.push({ kind: "text", x: x0 + slot * i + slot / 2, y: y0 + 14, text: label, anchor: "middle", fill: LABEL, size: 9 });
    }
  }

  // Legend for multi-series.
  if (data.series.length > 1) {
    let lx = x0;
    const ly = padT - 4;
    for (const [si, s] of data.series.entries()) {
      out.push({ kind: "rect", x: lx, y: ly, w: 8, h: 8, fill: chartColor(si) });
      out.push({ kind: "text", x: lx + 11, y: ly + 8, text: s.name, anchor: "start", fill: LABEL, size: 9 });
      lx += 12 + s.name.length * 5.2 + 10;
    }
  }
  return out;
}

function pieGeometry(data: ChartData, w: number, h: number): ChartPrimitive[] {
  const out: ChartPrimitive[] = [];
  const padT = data.title ? 24 : 8;
  if (data.title) {
    out.push({ kind: "text", x: w / 2, y: 15, text: data.title, anchor: "middle", fill: LABEL, size: 13, weight: 600 });
  }
  const s = data.series[0];
  const values = (s?.values ?? []).map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = w / 2;
  const cy = padT + (h - padT) / 2;
  const r = Math.max(1, Math.min(w, h - padT) / 2 - 8);
  if (total <= 0) return out;

  let angle = -Math.PI / 2;
  values.forEach((v, i) => {
    const frac = v / total;
    const next = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(next);
    const y2 = cy + r * Math.sin(next);
    const large = frac > 0.5 ? 1 : 0;
    const round = (n: number) => Math.round(n * 100) / 100;
    // Full circle as one slice would collapse to a zero-length arc; nudge it.
    const d =
      frac >= 0.999
        ? `M${round(cx)} ${round(cy - r)}A${round(r)} ${round(r)} 0 1 1 ${round(cx - 0.01)} ${round(cy - r)}Z`
        : `M${round(cx)} ${round(cy)}L${round(x1)} ${round(y1)}A${round(r)} ${round(r)} 0 ${large} 1 ${round(x2)} ${round(y2)}Z`;
    out.push({ kind: "path", d, fill: chartColor(i) });
    // Percent label at the slice mid-angle.
    const mid = (angle + next) / 2;
    const lx = cx + r * 0.62 * Math.cos(mid);
    const ly = cy + r * 0.62 * Math.sin(mid);
    if (frac > 0.04) {
      out.push({ kind: "text", x: lx, y: ly + 3, text: `${Math.round(frac * 100)}%`, anchor: "middle", fill: "#101014", size: 10, weight: 600 });
    }
    angle = next;
  });

  // Legend down the right edge.
  let ly = cy - values.length * 7;
  data.labels.slice(0, values.length).forEach((label, i) => {
    out.push({ kind: "rect", x: w - 90, y: ly, w: 8, h: 8, fill: chartColor(i) });
    out.push({ kind: "text", x: w - 78, y: ly + 8, text: label, anchor: "start", fill: LABEL, size: 9 });
    ly += 14;
  });
  return out;
}
