import * as z from "zod/v4";
import { createTable, tableToMarkdown, type TableData } from "./table.js";

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

/**
 * A chart's data as Markdown: the title (or "Chart") and type as a heading
 * line, then a table of labels × series — what a text export of the board
 * shows, since a chart's meaning is its numbers, not its drawing.
 */
export function chartToMarkdown(chart: ChartData): string {
  const n = Math.max(chart.labels.length, ...chart.series.map((s) => s.values.length));
  const rows = Array.from({ length: n }, (_, i) => [
    chart.labels[i] ?? "",
    ...chart.series.map((s) => (s.values[i] === undefined ? "" : String(s.values[i]))),
  ]);
  const table = createTable(["Label", ...chart.series.map((s) => s.name)], rows);
  const title = (chart.title ?? "").replace(/\s+/g, " ").trim() || "Chart";
  return `**${title}** _(${chart.type} chart)_\n\n${tableToMarkdown(table)}`;
}

// ---------------------------------------------------------------------------
// Drawn truth: one geometry, two consumers (canvas render + SVG export)
// ---------------------------------------------------------------------------

/**
 * What a primitive is part of. Consumers draw every role the same way; the tag
 * exists so the layout's promises (the legend never overlaps the title or the
 * plot) are checkable rather than eyeballed.
 */
export type ChartRole = "title" | "legend" | "axis" | "grid" | "tick" | "label" | "mark" | "note";

export type ChartPrimitive =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string; role?: ChartRole }
  | {
      kind: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      width: number;
      role?: ChartRole;
    }
  | {
      kind: "polyline";
      points: Array<[number, number]>;
      stroke: string;
      width: number;
      role?: ChartRole;
    }
  | { kind: "path"; d: string; fill: string; role?: ChartRole }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      anchor: "start" | "middle" | "end";
      fill: string;
      size: number;
      weight?: number;
      /** The untruncated text when `text` was shortened with an ellipsis. */
      full?: string;
      role?: ChartRole;
    };

/** A reserved band of the chart box. */
export interface ChartBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the title, legend and plot sit — reserved up front, so none overlaps. */
export interface ChartLayout {
  title?: ChartBox;
  legend?: ChartBox;
  plot: ChartBox;
}

const AXIS = "#5a5a62";
const GRID = "#33333a";
const LABEL = "#b8b8c0";
const MUTED = "#85858f";

const PAD = 8;
const TITLE_SIZE = 13;
const TITLE_H = 18;
const SMALL = 9;
const SWATCH = 8;
const LEGEND_ROW_H = 14;
const X_LABEL_H = 16;
/**
 * A legend entry's name is cut to this many characters. A series name may be
 * 120 characters (CHART_LIMITS.nameChars); the legend used to print it whole,
 * running over the plot and off the box.
 */
export const LEGEND_NAME_CHARS = 20;
/**
 * Average glyph advance as a fraction of the font size. Deliberately generous
 * for a sans-serif: geometry is computed without a DOM, so an estimate that
 * errs wide leaves slack instead of an overlap.
 */
const CHAR_W = 0.6;

const textWidth = (s: string, size: number) => s.length * size * CHAR_W;

/** `s` cut to `max` characters with an ellipsis (by code point, so an emoji isn't split). */
function ellipsize(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  if (max <= 1) return max === 1 ? "…" : "";
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** A text primitive whose string fits `px`, keeping the full text when cut. */
function fittedText(
  base: Omit<Extract<ChartPrimitive, { kind: "text" }>, "kind" | "text" | "full">,
  text: string,
  px: number,
  capChars = Infinity,
): Extract<ChartPrimitive, { kind: "text" }> | null {
  // The epsilon keeps a width computed as exactly n characters from flooring
  // to n - 1 through float error.
  const max = Math.min(capChars, Math.floor(px / (base.size * CHAR_W) + 1e-6));
  const shown = ellipsize(text, max);
  if (!shown) return null;
  return { kind: "text", ...base, text: shown, ...(shown !== text ? { full: text } : {}) };
}

/** A compact tick label: 1500 → "1.5k", 2000000 → "2M", 0.25 → "0.25". */
export function formatChartValue(v: number): string {
  const trim = (n: number) => String(Number(n.toFixed(2)));
  const a = Math.abs(v);
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}k`;
  return trim(v);
}

/**
 * Round tick values covering [lo, hi] — both ends included, 0 always on a tick
 * when the range spans it (the ticks are multiples of the step).
 */
export function chartTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const raw = span / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
  const start = Math.floor(lo / step);
  const end = Math.ceil(hi / step);
  const ticks: number[] = [];
  // Multiples of the step, cleaned of float noise (0.30000000000000004).
  for (let k = start; k <= end; k++) ticks.push(Number((k * step).toPrecision(12)));
  return ticks;
}

interface LegendEntry {
  name: string;
  color: string;
}

/**
 * Lay legend entries into rows within `box.w`, at most `maxRows` rows. What
 * doesn't fit is counted into a final "+N more" entry, so the legend's size is
 * bounded by the box — never by how many series or how long their names are.
 */
function legendPrimitives(
  entries: LegendEntry[],
  box: { x: number; y: number; w: number },
  maxRows: number,
  flow: "row" | "column",
): { prims: ChartPrimitive[]; rows: number } {
  const GAP = 12;
  const gap = flow === "row" ? GAP : 0;
  // An entry is its swatch, its (capped) name and a gap — never wider than the box.
  const widthOf = (e: LegendEntry) =>
    flow === "column"
      ? box.w
      : Math.min(box.w, SWATCH + 4 + textWidth(ellipsize(e.name, LEGEND_NAME_CHARS), SMALL) + gap);

  // Greedy rows, stopping at the row cap.
  const rows: LegendEntry[][] = [];
  let used = 0;
  let placed = 0;
  for (const e of entries) {
    const ew = widthOf(e);
    if (rows.length === 0 || flow === "column" || used + ew > box.w) {
      if (rows.length === maxRows) break;
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(e);
    used += ew;
    placed++;
  }

  // Overflow: free room on the last row for the "+N more" note.
  let hidden = entries.length - placed;
  const last = rows[rows.length - 1];
  if (hidden > 0 && last) {
    const rowW = () => last.reduce((a, e) => a + widthOf(e), 0);
    while (last.length > 0 && rowW() + textWidth(`+${hidden} more`, SMALL) > box.w) {
      last.pop();
      hidden++;
    }
  }

  const prims: ChartPrimitive[] = [];
  rows.forEach((row, r) => {
    // A row is the text's em box (baseline at y + SMALL) with the swatch
    // inside it; the rest of LEGEND_ROW_H is room for descenders.
    const y = box.y + r * LEGEND_ROW_H;
    let x = box.x;
    for (const e of row) {
      const ew = widthOf(e);
      prims.push({
        kind: "rect",
        x,
        y: y + 1,
        w: SWATCH,
        h: SWATCH,
        fill: e.color,
        role: "legend",
      });
      const name = fittedText(
        {
          x: x + SWATCH + 4,
          y: y + SMALL,
          anchor: "start",
          fill: LABEL,
          size: SMALL,
          role: "legend",
        },
        e.name,
        ew - SWATCH - 4 - gap,
        LEGEND_NAME_CHARS,
      );
      if (name) prims.push(name);
      x += ew;
    }
    if (hidden > 0 && r === rows.length - 1) {
      const more = fittedText(
        { x, y: y + SMALL, anchor: "start", fill: MUTED, size: SMALL, role: "legend" },
        `+${hidden} more`,
        box.x + box.w - x,
      );
      if (more) prims.push(more);
    }
  });
  return { prims, rows: rows.length };
}

/** The title band, when there is a title: a centred, ellipsized heading. */
function titleBand(data: ChartData, w: number, out: ChartPrimitive[]): ChartBox | undefined {
  if (!data.title) return undefined;
  const box = { x: PAD, y: PAD, w: Math.max(1, w - 2 * PAD), h: TITLE_H };
  const t = fittedText(
    {
      x: w / 2,
      y: PAD + TITLE_SIZE,
      anchor: "middle",
      fill: LABEL,
      size: TITLE_SIZE,
      weight: 600,
      role: "title",
    },
    data.title,
    box.w,
  );
  if (t) out.push(t);
  return box;
}

/** Produce the drawn primitives for a chart in a `w`×`h` box. Pure/deterministic. */
export function chartGeometry(data: ChartData, w: number, h: number): ChartPrimitive[] {
  return chartScene(data, w, h).prims;
}

/** The primitives plus the reserved bands they were laid into. */
export function chartScene(
  data: ChartData,
  w: number,
  h: number,
): { prims: ChartPrimitive[]; layout: ChartLayout } {
  if (data.type === "pie") return pieGeometry(data, w, h);
  return axisGeometry(data, w, h);
}

function axisGeometry(
  data: ChartData,
  w: number,
  h: number,
): { prims: ChartPrimitive[]; layout: ChartLayout } {
  const out: ChartPrimitive[] = [];
  const title = titleBand(data, w, out);
  let top = title ? title.y + title.h + 4 : PAD;

  // Legend band under the title, reserved before the plot is sized: the plot
  // gets what's left, so the two can't overlap however many series there are.
  let legend: ChartBox | undefined;
  if (data.series.length > 1) {
    const maxRows = Math.max(1, Math.min(3, Math.floor((h * 0.3) / LEGEND_ROW_H)));
    const box = { x: PAD, y: top, w: Math.max(1, w - 2 * PAD) };
    const { prims, rows } = legendPrimitives(
      data.series.map((s, i) => ({ name: s.name, color: chartColor(i) })),
      box,
      maxRows,
      "row",
    );
    out.push(...prims);
    legend = { ...box, h: rows * LEGEND_ROW_H };
    top = legend.y + legend.h + 6;
  }

  // The value domain always includes zero: bars grow from the zero line, up
  // for positive values and DOWN for negative ones (they used to be clamped
  // to 0, silently drawing a loss as nothing).
  const values = data.series.flatMap((s) => s.values).filter(Number.isFinite);
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = 1;
  const plotBottom = Math.max(top + 1, h - PAD - X_LABEL_H);
  const plotH = plotBottom - top;
  const ticks = chartTicks(lo, hi, Math.max(2, Math.min(5, Math.floor(plotH / 28))));
  lo = ticks[0]!;
  hi = ticks[ticks.length - 1]!;
  const tickLabels = ticks.map(formatChartValue);
  const padL = Math.max(20, ...tickLabels.map((t) => textWidth(t, SMALL))) + 6;
  const plot: ChartBox = {
    x: PAD + padL,
    y: top,
    w: Math.max(1, w - PAD - (PAD + padL)),
    h: plotH,
  };
  const yOf = (v: number) => plot.y + plot.h - ((v - lo) / (hi - lo)) * plot.h;
  const zeroY = yOf(0);

  ticks.forEach((t, i) => {
    const gy = yOf(t);
    if (t !== 0)
      out.push({
        kind: "line",
        x1: plot.x,
        y1: gy,
        x2: plot.x + plot.w,
        y2: gy,
        stroke: GRID,
        width: 1,
        role: "grid",
      });
    out.push({
      kind: "text",
      x: plot.x - 5,
      y: gy + 3,
      text: tickLabels[i]!,
      anchor: "end",
      fill: LABEL,
      size: SMALL,
      role: "tick",
    });
  });
  out.push({
    kind: "line",
    x1: plot.x,
    y1: plot.y,
    x2: plot.x,
    y2: plot.y + plot.h,
    stroke: AXIS,
    width: 1,
    role: "axis",
  });
  // The category axis sits at zero, wherever zero falls in the range.
  out.push({
    kind: "line",
    x1: plot.x,
    y1: zeroY,
    x2: plot.x + plot.w,
    y2: zeroY,
    stroke: AXIS,
    width: 1,
    role: "axis",
  });

  const n = Math.max(1, data.labels.length, ...data.series.map((s) => s.values.length));
  const slot = plot.w / n;

  if (data.type === "bar") {
    const groupW = slot * 0.72;
    const barW = groupW / data.series.length;
    for (let i = 0; i < n; i++) {
      const gx = plot.x + slot * i + (slot - groupW) / 2;
      data.series.forEach((s, si) => {
        const v = s.values[i];
        if (v === undefined || !Number.isFinite(v)) return;
        const vy = yOf(v);
        out.push({
          kind: "rect",
          x: gx + barW * si,
          y: Math.min(vy, zeroY),
          w: Math.max(1, barW - 1),
          h: Math.abs(zeroY - vy),
          fill: chartColor(si),
          role: "mark",
        });
      });
    }
  } else {
    data.series.forEach((s, si) => {
      const points: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v !== undefined && Number.isFinite(v))
          points.push([plot.x + slot * i + slot / 2, yOf(v)]);
      }
      if (points.length)
        out.push({ kind: "polyline", points, stroke: chartColor(si), width: 2, role: "mark" });
    });
  }

  // Category labels under the plot (not at the zero line, where a negative bar
  // would run through them). When slots are too narrow for even a few
  // characters, every k-th label is shown instead of all of them overlapping.
  const minLabelPx = textWidth("Abc", SMALL) + 4;
  const stride = Math.max(1, Math.ceil(minLabelPx / slot));
  for (let i = 0; i < n; i += stride) {
    const label = data.labels[i];
    if (!label) continue;
    const t = fittedText(
      {
        x: plot.x + slot * i + slot / 2,
        y: plot.y + plot.h + 12,
        anchor: "middle",
        fill: LABEL,
        size: SMALL,
        role: "label",
      },
      label,
      slot * stride - 4,
    );
    if (t) out.push(t);
  }

  return {
    prims: out,
    layout: { ...(title ? { title } : {}), ...(legend ? { legend } : {}), plot },
  };
}

function pieGeometry(
  data: ChartData,
  w: number,
  h: number,
): { prims: ChartPrimitive[]; layout: ChartLayout } {
  const out: ChartPrimitive[] = [];
  const title = titleBand(data, w, out);
  const top = title ? title.y + title.h + 4 : PAD;
  const s = data.series[0];
  // A pie shows parts of a positive whole; a negative or missing value has no
  // slice. Those are left out AND said so in a note, rather than clamped to 0
  // without a word.
  const entries = (s?.values ?? []).map((v, i) => ({
    v,
    i,
    name: data.labels[i] || `Slice ${i + 1}`,
  }));
  const slices = entries.filter((e) => Number.isFinite(e.v) && e.v > 0);
  const skipped = entries.some((e) => !Number.isFinite(e.v) || e.v < 0);
  const noteH = skipped ? LEGEND_ROW_H : 0;
  const bottom = Math.max(top + 1, h - PAD - noteH);
  if (skipped) {
    const note = fittedText(
      { x: w / 2, y: h - PAD - 2, anchor: "middle", fill: MUTED, size: SMALL, role: "note" },
      "Negative values aren't shown in a pie",
      w - 2 * PAD,
    );
    if (note) out.push(note);
  }

  // Legend down the right, in its own reserved column: the pie is sized to
  // the space left of it, so the two never overlap.
  const legendW =
    w >= 180 && slices.length > 0
      ? Math.min(w * 0.42, SWATCH + 4 + textWidth("x".repeat(LEGEND_NAME_CHARS), SMALL))
      : 0;
  let legend: ChartBox | undefined;
  if (legendW > 0) {
    const maxRows = Math.max(1, Math.floor((bottom - top) / LEGEND_ROW_H));
    const rows = Math.min(maxRows, slices.length);
    const y = top + Math.max(0, (bottom - top - rows * LEGEND_ROW_H) / 2);
    const box = { x: w - PAD - legendW, y, w: legendW };
    const laid = legendPrimitives(
      slices.map((e) => ({ name: e.name, color: chartColor(e.i) })),
      box,
      maxRows,
      "column",
    );
    out.push(...laid.prims);
    legend = { ...box, h: laid.rows * LEGEND_ROW_H };
  }
  const areaW = Math.max(1, w - 2 * PAD - (legendW ? legendW + 8 : 0));
  const areaH = bottom - top;
  const plot: ChartBox = { x: PAD, y: top, w: areaW, h: areaH };
  const layout: ChartLayout = { ...(title ? { title } : {}), ...(legend ? { legend } : {}), plot };

  const total = slices.reduce((a, e) => a + e.v, 0);
  if (total <= 0) {
    const t = fittedText(
      {
        x: plot.x + plot.w / 2,
        y: plot.y + plot.h / 2,
        anchor: "middle",
        fill: MUTED,
        size: SMALL,
        role: "note",
      },
      "No positive values to plot",
      plot.w,
    );
    if (t) out.push(t);
    return { prims: out, layout };
  }
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const r = Math.max(1, Math.min(plot.w, plot.h) / 2 - 2);
  const round = (n: number) => Math.round(n * 100) / 100;

  let angle = -Math.PI / 2;
  for (const e of slices) {
    const frac = e.v / total;
    const next = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(next);
    const y2 = cy + r * Math.sin(next);
    const large = frac > 0.5 ? 1 : 0;
    // Full circle as one slice would collapse to a zero-length arc; nudge it.
    const d =
      frac >= 0.999
        ? `M${round(cx)} ${round(cy - r)}A${round(r)} ${round(r)} 0 1 1 ${round(cx - 0.01)} ${round(cy - r)}Z`
        : `M${round(cx)} ${round(cy)}L${round(x1)} ${round(y1)}A${round(r)} ${round(r)} 0 ${large} 1 ${round(x2)} ${round(y2)}Z`;
    out.push({ kind: "path", d, fill: chartColor(e.i), role: "mark" });
    // Percent label at the slice mid-angle.
    const mid = (angle + next) / 2;
    if (frac > 0.04) {
      out.push({
        kind: "text",
        x: cx + r * 0.62 * Math.cos(mid),
        y: cy + r * 0.62 * Math.sin(mid) + 3,
        text: `${Math.round(frac * 100)}%`,
        anchor: "middle",
        fill: "#101014",
        size: 10,
        weight: 600,
        role: "label",
      });
    }
    angle = next;
  }
  return { prims: out, layout };
}
