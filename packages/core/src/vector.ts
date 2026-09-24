import * as z from "zod/v4";
import { cssColor } from "./schemaPrimitives.js";

/**
 * Vector Studio's model (docs/26 §6.3, V2): an editable vector is STRUCTURED
 * PATHS, never markup.
 *
 * A `vector` shape carries `{ viewBox, paths[] }`. Each path is normalized
 * path data (absolute M/L/C/Q/Z only, rounded numbers) plus a small closed set
 * of paint fields, every colour through the same grammar as every other board
 * colour. The renderer draws React `<path>` elements from it; nothing is ever
 * inserted into the DOM as SVG text, so a hostile file can at worst draw ugly
 * shapes. That property is what lets the same data come from a pasted file,
 * an icon, a traced photo, a sketch, a model or a vendor API.
 *
 * The importer below is the one door SVG text comes in through: parse → keep
 * an allowlist of drawable elements → resolve styles (attributes, inline
 * style, simple <style> rules, inheritance) → flatten transforms and <use> →
 * structured paths. Scripts, foreignObject, event handlers, external
 * references, images, text, masks and filters are dropped — there is no field
 * they could land in.
 */

// ---------------------------------------------------------------------------
// Model + schema
// ---------------------------------------------------------------------------

export interface VectorPath {
  /** Normalized path data: absolute M, L, C, Q, Z. */
  d: string;
  /** A colour, "none", or absent = the shape's ink (currentColor). */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fillRule?: "nonzero" | "evenodd";
  opacity?: number;
  cap?: "butt" | "round" | "square";
  join?: "miter" | "round" | "bevel";
}

export type VectorGenerator = "import" | "icon" | "trace" | "sketch" | "recraft" | "llm";

export interface VectorData {
  /** [minX, minY, width, height] of the paths' own coordinate space. */
  viewBox: [number, number, number, number];
  paths: VectorPath[];
  /** Where it came from — provenance, never used to render. */
  source?: { generator: VectorGenerator; ref?: string; prompt?: string; model?: string };
}

/** Normalized path data: commands and plain decimals, nothing that could be markup. */
const VECTOR_PATH_GRAMMAR = /^[MLCQZmlcqzHVSTAhvsta][MLCQZmlcqzHVSTAhvsta0-9.,\-\s]*$/;
export const VECTOR_LIMITS = {
  paths: 2_000,
  pathChars: 60_000,
  totalChars: 400_000,
} as const;

const paint = z.union([cssColor, z.literal("none"), z.literal("currentColor")]);

export const vectorPathSchema = z.object({
  d: z
    .string()
    .min(1)
    .max(VECTOR_LIMITS.pathChars, "vector path exceeds the maximum length")
    .refine((s) => VECTOR_PATH_GRAMMAR.test(s), "vector path is not normalized path data"),
  fill: paint.optional(),
  stroke: paint.optional(),
  strokeWidth: z.number().min(0).max(1_000).optional(),
  fillRule: z.enum(["nonzero", "evenodd"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  cap: z.enum(["butt", "round", "square"]).optional(),
  join: z.enum(["miter", "round", "bevel"]).optional(),
});

const finite = z.number().refine(Number.isFinite, "not a finite number");

export const vectorDataSchema = z
  .object({
    viewBox: z.tuple([finite, finite, finite.refine((n) => n > 0), finite.refine((n) => n > 0)]),
    paths: z.array(vectorPathSchema).min(1).max(VECTOR_LIMITS.paths),
    source: z
      .object({
        generator: z.enum(["import", "icon", "trace", "sketch", "recraft", "llm"]),
        ref: z.string().max(200).optional(),
        prompt: z.string().max(1_000).optional(),
        model: z.string().max(100).optional(),
      })
      .optional(),
  })
  .refine(
    (v) => v.paths.reduce((n, p) => n + p.d.length, 0) <= VECTOR_LIMITS.totalChars,
    "vector is too detailed (total path data over the limit)",
  );

// ---------------------------------------------------------------------------
// Path data: parse → absolute segments → (transform) → normalized string
// ---------------------------------------------------------------------------

type Seg =
  | { t: "M"; x: number; y: number }
  | { t: "L"; x: number; y: number }
  | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: "Q"; x1: number; y1: number; x: number; y: number }
  | { t: "Z" };

const PARAMS: Record<string, number> = {
  m: 2,
  l: 2,
  h: 1,
  v: 1,
  c: 6,
  s: 4,
  q: 4,
  t: 2,
  a: 7,
  z: 0,
};
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Tokenize path data; arc flags are single characters, so "a1 1 0 01.5.5" parses. */
function tokenize(d: string): Array<string | number> | null {
  const out: Array<string | number> = [];
  let i = 0;
  let cmd = "";
  let argIndex = 0;
  while (i < d.length) {
    const ch = d[i]!;
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      out.push(ch);
      cmd = ch.toLowerCase();
      argIndex = 0;
      i++;
      continue;
    }
    if (cmd === "a" && (argIndex % 7 === 3 || argIndex % 7 === 4)) {
      if (ch !== "0" && ch !== "1") return null;
      out.push(ch === "1" ? 1 : 0);
      argIndex++;
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) return null;
    out.push(Number.parseFloat(m[0]));
    argIndex++;
    i = NUMBER.lastIndex;
  }
  return out;
}

/** Arc → cubic Béziers (SVG 1.1 implementation notes, F.6.5), ≤ 90° per piece. */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  fa: number,
  fs: number,
  x2: number,
  y2: number,
): Seg[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ t: "L", x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = Math.max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p);
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(num / den);
  if (fa === fs) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (len || 1))));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (fs && dtheta < 0) dtheta += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / pieces;
  const k = (4 / 3) * Math.tan(delta / 4);
  const map = (px: number, py: number) => ({
    x: cx + rx * px * cos - ry * py * sin,
    y: cy + rx * px * sin + ry * py * cos,
  });
  const out: Seg[] = [];
  let th = theta1;
  for (let i = 0; i < pieces; i++) {
    const c1 = Math.cos(th);
    const s1 = Math.sin(th);
    const c2 = Math.cos(th + delta);
    const s2 = Math.sin(th + delta);
    const p1 = map(c1 - k * s1, s1 + k * c1);
    const p2 = map(c2 + k * s2, s2 - k * c2);
    const p = i === pieces - 1 ? { x: x2, y: y2 } : map(c2, s2);
    out.push({ t: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y });
    th += delta;
  }
  return out;
}

/** Parse path data into absolute M/L/C/Q/Z segments; null for malformed data. */
export function parsePathData(d: string): Seg[] | null {
  const tokens = tokenize(d);
  if (!tokens || tokens.length === 0 || typeof tokens[0] !== "string") return null;
  const segs: Seg[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC: { x: number; y: number } | null = null;
  let lastQ: { x: number; y: number } | null = null;
  let i = 0;
  while (i < tokens.length) {
    const cmdTok = tokens[i++];
    if (typeof cmdTok !== "string") return null;
    const rel = cmdTok === cmdTok.toLowerCase();
    let cmd = cmdTok.toLowerCase();
    const n = PARAMS[cmd]!;
    if (cmd === "z") {
      segs.push({ t: "Z" });
      cx = sx;
      cy = sy;
      lastC = lastQ = null;
      continue;
    }
    let first = true;
    do {
      const args: number[] = [];
      for (let j = 0; j < n; j++) {
        const v = tokens[i++];
        if (typeof v !== "number") return null;
        args.push(v);
      }
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      let nextC: { x: number; y: number } | null = null;
      let nextQ: { x: number; y: number } | null = null;
      switch (cmd) {
        case "m": {
          cx = args[0]! + ox;
          cy = args[1]! + oy;
          if (first) {
            segs.push({ t: "M", x: cx, y: cy });
            sx = cx;
            sy = cy;
          } else segs.push({ t: "L", x: cx, y: cy });
          break;
        }
        case "l":
          cx = args[0]! + ox;
          cy = args[1]! + oy;
          segs.push({ t: "L", x: cx, y: cy });
          break;
        case "h":
          cx = args[0]! + ox;
          segs.push({ t: "L", x: cx, y: cy });
          break;
        case "v":
          cy = args[0]! + oy;
          segs.push({ t: "L", x: cx, y: cy });
          break;
        case "c": {
          const s: Seg = {
            t: "C",
            x1: args[0]! + ox,
            y1: args[1]! + oy,
            x2: args[2]! + ox,
            y2: args[3]! + oy,
            x: args[4]! + ox,
            y: args[5]! + oy,
          };
          segs.push(s);
          nextC = { x: s.x2, y: s.y2 };
          cx = s.x;
          cy = s.y;
          break;
        }
        case "s": {
          const x1: number = lastC ? 2 * cx - lastC.x : cx;
          const y1: number = lastC ? 2 * cy - lastC.y : cy;
          const s: Seg = {
            t: "C",
            x1,
            y1,
            x2: args[0]! + ox,
            y2: args[1]! + oy,
            x: args[2]! + ox,
            y: args[3]! + oy,
          };
          segs.push(s);
          nextC = { x: s.x2, y: s.y2 };
          cx = s.x;
          cy = s.y;
          break;
        }
        case "q": {
          const s: Seg = {
            t: "Q",
            x1: args[0]! + ox,
            y1: args[1]! + oy,
            x: args[2]! + ox,
            y: args[3]! + oy,
          };
          segs.push(s);
          nextQ = { x: s.x1, y: s.y1 };
          cx = s.x;
          cy = s.y;
          break;
        }
        case "t": {
          const x1: number = lastQ ? 2 * cx - lastQ.x : cx;
          const y1: number = lastQ ? 2 * cy - lastQ.y : cy;
          const s: Seg = { t: "Q", x1, y1, x: args[0]! + ox, y: args[1]! + oy };
          segs.push(s);
          nextQ = { x: x1, y: y1 };
          cx = s.x;
          cy = s.y;
          break;
        }
        case "a": {
          const x = args[5]! + ox;
          const y = args[6]! + oy;
          segs.push(...arcToCubics(cx, cy, args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, x, y));
          cx = x;
          cy = y;
          break;
        }
      }
      lastC = nextC;
      lastQ = nextQ;
      first = false;
      if (cmd === "m") cmd = "l";
    } while (i < tokens.length && typeof tokens[i] === "number");
  }
  return segs;
}

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Parse an SVG transform list into one matrix; unknown functions are ignored. */
export function parseTransform(text: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!text) return m;
  for (const [, fn, raw] of text.matchAll(
    /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g,
  )) {
    const a = (raw ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (a.some((v) => !Number.isFinite(v))) continue;
    let t: Matrix = IDENTITY;
    switch (fn) {
      case "matrix":
        if (a.length === 6) t = a as Matrix;
        break;
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const rot: Matrix = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
        const cx = a[1] ?? 0;
        const cy = a[2] ?? 0;
        t = multiply(multiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, t);
  }
  return m;
}

function transformSegs(segs: Seg[], m: Matrix): Seg[] {
  if (m === IDENTITY) return segs;
  const px = (x: number, y: number) => m[0] * x + m[2] * y + m[4];
  const py = (x: number, y: number) => m[1] * x + m[3] * y + m[5];
  return segs.map((s): Seg => {
    switch (s.t) {
      case "M":
      case "L":
        return { t: s.t, x: px(s.x, s.y), y: py(s.x, s.y) };
      case "C":
        return {
          t: "C",
          x1: px(s.x1, s.y1),
          y1: py(s.x1, s.y1),
          x2: px(s.x2, s.y2),
          y2: py(s.x2, s.y2),
          x: px(s.x, s.y),
          y: py(s.x, s.y),
        };
      case "Q":
        return { t: "Q", x1: px(s.x1, s.y1), y1: py(s.x1, s.y1), x: px(s.x, s.y), y: py(s.x, s.y) };
      case "Z":
        return s;
    }
  });
}

/** Decimal places that keep a path sub-pixel accurate at any sane display size. */
export function precisionFor(extent: number): number {
  if (extent <= 64) return 2;
  if (extent <= 1_024) return 1;
  return 0;
}

function fmt(n: number, k: number): string {
  const r = Math.round(n * k) / k;
  return Object.is(r, -0) ? "0" : String(r);
}

/** Serialize segments as normalized path data. */
export function serializeSegs(segs: Seg[], decimals: number): string {
  const k = 10 ** decimals;
  const f = (n: number) => fmt(n, k);
  let out = "";
  for (const s of segs) {
    switch (s.t) {
      case "M":
      case "L":
        out += `${s.t}${f(s.x)} ${f(s.y)}`;
        break;
      case "C":
        out += `C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}`;
        break;
      case "Q":
        out += `Q${f(s.x1)} ${f(s.y1)} ${f(s.x)} ${f(s.y)}`;
        break;
      case "Z":
        out += "Z";
        break;
    }
  }
  return out;
}

/** Normalize arbitrary path data (optionally transformed) to M/L/C/Q/Z; null if malformed. */
export function normalizePathData(d: string, m: Matrix = IDENTITY, decimals = 2): string | null {
  const segs = parsePathData(d);
  if (!segs || segs.length === 0) return null;
  const out = serializeSegs(transformSegs(segs, m), decimals);
  return /[LCQ]/.test(out) ? out : null;
}

/** Bounding box of path data's anchor and control points (a safe over-estimate). */
export function pathBounds(
  d: string,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const segs = parsePathData(d);
  if (!segs) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const s of segs) {
    if (s.t === "Z") continue;
    add(s.x, s.y);
    if (s.t === "C") {
      add(s.x1, s.y1);
      add(s.x2, s.y2);
    } else if (s.t === "Q") add(s.x1, s.y1);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ---------------------------------------------------------------------------
// The sanitizing importer
// ---------------------------------------------------------------------------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const DRAWABLE = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const CONTAINERS = new Set(["svg", "g", "a", "defs", "symbol", "switch"]);
/** Elements whose subtree is never looked at — the dangerous and the unrenderable. */
const KEEP = new Set([
  ...DRAWABLE,
  ...CONTAINERS,
  "use",
  "style",
  "linearGradient",
  "radialGradient",
  "stop",
]);

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    const code = k.startsWith("#x")
      ? Number.parseInt(k.slice(2), 16)
      : Number.parseInt(k.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

/**
 * A deliberately small XML reader for the SVG subset: no DTDs, no custom
 * entities (so no entity-expansion bombs), no namespaces beyond stripping the
 * prefix. Anything outside the allowlist is skipped with its whole subtree.
 */
function parseXml(src: string): XmlNode | null {
  const text = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) =>
      inner.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
  const root: XmlNode = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  /** Depth inside an element we are skipping (0 = not skipping). */
  let skip = 0;
  const tagRe =
    /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  for (const m of text.matchAll(tagRe)) {
    const between = text.slice(last, m.index);
    last = m.index + m[0].length;
    if (!skip && between.trim()) stack[stack.length - 1]!.text += decodeEntities(between);
    const closing = m[1] === "/";
    const tag = m[2]!.replace(/^.*:/, "");
    const selfClosing = m[4] === "/";
    if (closing) {
      if (skip) {
        skip--;
        continue;
      }
      if (stack.length > 1 && stack[stack.length - 1]!.tag === tag) stack.pop();
      continue;
    }
    if (skip || !KEEP.has(tag)) {
      if (!selfClosing) skip++;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      const name = a[1]!.toLowerCase().replace(/^xlink:/, "");
      attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const node: XmlNode = { tag, attrs, children: [], text: "" };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  const svg = root.children.find((c) => c.tag === "svg");
  return svg ?? null;
}

/** Declarations "a: b; c: d" → map (lowercased properties). */
function parseDecls(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const v = part
      .slice(i + 1)
      .replace(/!important/i, "")
      .trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** Simple stylesheet: tag, .class and #id selectors (comma lists); everything else ignored. */
interface Sheet {
  tag: Map<string, Record<string, string>>;
  cls: Map<string, Record<string, string>>;
  id: Map<string, Record<string, string>>;
}

function parseSheet(css: string): Sheet {
  const sheet: Sheet = { tag: new Map(), cls: new Map(), id: new Map() };
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, sel, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = parseDecls(body);
    for (const raw of (sel ?? "").split(",")) {
      const s = raw.trim();
      const bucket = /^\.[\w-]+$/.test(s)
        ? sheet.cls
        : /^#[\w-]+$/.test(s)
          ? sheet.id
          : /^[a-zA-Z]+$/.test(s)
            ? sheet.tag
            : null;
      if (!bucket) continue;
      const key = s.replace(/^[.#]/, "");
      bucket.set(key, { ...(bucket.get(key) ?? {}), ...decls });
    }
  }
  return sheet;
}

const PAINT_PROPS = [
  "fill",
  "stroke",
  "stroke-width",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "display",
  "visibility",
  "stop-color",
  "stop-opacity",
] as const;
type Style = Partial<Record<(typeof PAINT_PROPS)[number], string>>;
const INHERITED: Array<keyof Style> = [
  "fill",
  "stroke",
  "stroke-width",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "visibility",
];

/** Presentation attribute < tag rule < class rule < id rule < inline style. */
function ownStyle(node: XmlNode, sheet: Sheet): Style {
  const out: Style = {};
  const put = (src: Record<string, string> | undefined) => {
    if (!src) return;
    for (const p of PAINT_PROPS) if (src[p] !== undefined) out[p] = src[p];
  };
  put(node.attrs);
  put(sheet.tag.get(node.tag));
  for (const c of (node.attrs.class ?? "").split(/\s+/).filter(Boolean)) put(sheet.cls.get(c));
  if (node.attrs.id) put(sheet.id.get(node.attrs.id));
  put(parseDecls(node.attrs.style));
  return out;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  cyan: "#00ffff",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  coral: "#ff7f50",
  salmon: "#fa8072",
  tomato: "#ff6347",
  crimson: "#dc143c",
  khaki: "#f0e68c",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  lavender: "#e6e6fa",
  tan: "#d2b48c",
  turquoise: "#40e0d0",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkblue: "#00008b",
  darkgreen: "#006400",
  darkred: "#8b0000",
  lightblue: "#add8e6",
  lightgreen: "#90ee90",
  skyblue: "#87ceeb",
  steelblue: "#4682b4",
  royalblue: "#4169e1",
  slategray: "#708090",
  slategrey: "#708090",
  dimgray: "#696969",
  dimgrey: "#696969",
  whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc",
  orangered: "#ff4500",
  seagreen: "#2e8b57",
  forestgreen: "#228b22",
  firebrick: "#b22222",
  chocolate: "#d2691e",
  goldenrod: "#daa520",
};

interface Gradient {
  stops: Array<{ color: string; opacity: number }>;
  href?: string;
}

/** Resolve a paint value to a stored colour, "none", "currentColor", or undefined (inherit/unknown). */
function resolvePaint(
  value: string | undefined,
  gradients: Map<string, Gradient>,
): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === "none" || lower === "transparent") return "none";
  if (lower === "currentcolor") return "currentColor";
  const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(v);
  if (url) {
    const g = resolveGradient(url[1]!, gradients, 0);
    const stop = g?.stops[Math.floor((g.stops.length - 1) / 2)];
    if (stop) return stop.color;
    return url[2] ? resolvePaint(url[2], gradients) : "none";
  }
  if (NAMED[lower]) return NAMED[lower];
  if (/^#[0-9a-f]{3,8}$/i.test(v) && [4, 5, 7, 9].includes(v.length)) return v.toLowerCase();
  const parsed = cssColor.safeParse(v.replace(/\s+/g, " "));
  return parsed.success ? parsed.data : undefined;
}

function resolveGradient(
  id: string,
  gradients: Map<string, Gradient>,
  depth: number,
): Gradient | undefined {
  const g = gradients.get(id);
  if (!g || depth > 4) return undefined;
  if (g.stops.length === 0 && g.href) return resolveGradient(g.href, gradients, depth + 1);
  return g;
}

const num = (v: string | undefined, fallback = 0): number => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
};

/** Basic shapes → path data (then the same parser/transform path as <path>). */
function shapeToPath(node: XmlNode): string | null {
  const a = node.attrs;
  switch (node.tag) {
    case "path":
      return a.d ?? null;
    case "rect": {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      if (w <= 0 || h <= 0) return null;
      let rx = a.rx !== undefined ? num(a.rx) : a.ry !== undefined ? num(a.ry) : 0;
      let ry = a.ry !== undefined ? num(a.ry) : rx;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case "circle":
    case "ellipse": {
      const cx = num(a.cx);
      const cy = num(a.cy);
      const rx = node.tag === "circle" ? num(a.r) : num(a.rx);
      const ry = node.tag === "circle" ? num(a.r) : num(a.ry);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line":
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case "polyline":
    case "polygon": {
      const pts = (a.points ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return node.tag === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

export type SvgImport =
  | {
      ok: true;
      vector: VectorData;
      /** Natural display size from width/height or the viewBox. */
      width: number;
      height: number;
      /** Element kinds that were dropped, for an honest "some parts were skipped" note. */
      dropped: string[];
    }
  | { ok: false; error: string };

/**
 * Import SVG text as an editable vector. Refuses rather than guesses: a file
 * with nothing drawable, or one too detailed for the board, answers an error
 * the caller can turn into "import it as an image instead".
 */
export function importSvg(svgText: string, source?: VectorData["source"]): SvgImport {
  if (svgText.length > 5_000_000) return { ok: false, error: "That SVG file is too large." };
  const svg = parseXml(svgText);
  if (!svg) return { ok: false, error: "That isn't an SVG document." };

  const dropped = new Set<string>();
  for (const m of svgText.matchAll(/<([a-zA-Z][\w:.-]*)/g)) {
    const tag = m[1]!.replace(/^.*:/, "");
    if (!KEEP.has(tag) && tag !== "title" && tag !== "desc" && tag !== "metadata") dropped.add(tag);
  }

  // Index: stylesheet, gradients and id'd elements (for <use>).
  let css = "";
  const gradients = new Map<string, Gradient>();
  const byId = new Map<string, XmlNode>();
  const walk = (n: XmlNode) => {
    if (n.attrs.id) byId.set(n.attrs.id, n);
    if (n.tag === "style") css += `${n.text}\n`;
    for (const c of n.children) walk(c);
  };
  walk(svg);
  const sheet = parseSheet(css);
  for (const [id, n] of byId) {
    if (n.tag !== "linearGradient" && n.tag !== "radialGradient") continue;
    const stops = n.children
      .filter((c) => c.tag === "stop")
      .map((s) => {
        const st = ownStyle(s, sheet);
        const color = resolvePaint(st["stop-color"] ?? "#000000", new Map());
        return {
          color: color && color !== "none" ? color : "#000000",
          opacity: num(st["stop-opacity"], 1),
        };
      });
    const href = n.attrs.href?.startsWith("#") ? n.attrs.href.slice(1) : undefined;
    gradients.set(id, { stops, ...(href ? { href } : {}) });
  }

  // viewBox: the file's own, else its width/height, else the drawing's bounds.
  const vb = (svg.attrs.viewbox ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const w0 = num(svg.attrs.width?.replace(/px$/, ""), NaN);
  const h0 = num(svg.attrs.height?.replace(/px$/, ""), NaN);
  let viewBox: [number, number, number, number] | null =
    vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
      ? (vb as [number, number, number, number])
      : Number.isFinite(w0) &&
          Number.isFinite(h0) &&
          w0 > 0 &&
          h0 > 0 &&
          !/%/.test(svg.attrs.width ?? "")
        ? [0, 0, w0, h0]
        : null;
  const decimals = precisionFor(viewBox ? Math.max(viewBox[2], viewBox[3]) : 1_000);

  const paths: VectorPath[] = [];
  type Ctx = { style: Style; opacity: number; m: Matrix; depth: number; via: Set<string> };

  const visit = (node: XmlNode, ctx: Ctx, inDefs: boolean) => {
    if (paths.length > VECTOR_LIMITS.paths) return;
    const own = ownStyle(node, sheet);
    if (own.display === "none") return;
    const style: Style = {};
    for (const p of INHERITED) {
      const v = own[p] ?? ctx.style[p];
      if (v !== undefined) style[p] = v;
    }
    const opacity = ctx.opacity * Math.min(1, Math.max(0, num(own.opacity, 1)));
    const m =
      node.tag === "svg" && node === svg
        ? ctx.m
        : multiply(ctx.m, parseTransform(node.attrs.transform));
    const next: Ctx = { style, opacity, m, depth: ctx.depth, via: ctx.via };

    if (
      node.tag === "defs" ||
      node.tag === "symbol" ||
      node.tag === "linearGradient" ||
      node.tag === "radialGradient" ||
      node.tag === "style"
    ) {
      return; // only reachable through <use> / paint references
    }
    if (inDefs) return;

    if (node.tag === "use") {
      const ref = node.attrs.href;
      // Local references only: an external file ("other.svg#x") or a
      // javascript:/data: URL has nowhere to go.
      if (!ref?.startsWith("#") || ctx.depth > 8 || ctx.via.has(ref)) return;
      const target = byId.get(ref.slice(1));
      if (!target) return;
      const shifted: Ctx = {
        ...next,
        m: multiply(next.m, [1, 0, 0, 1, num(node.attrs.x), num(node.attrs.y)]),
        depth: ctx.depth + 1,
        via: new Set([...ctx.via, ref]),
      };
      if (target.tag === "symbol") for (const c of target.children) visit(c, shifted, false);
      else visit(target, shifted, false);
      return;
    }

    if (DRAWABLE.has(node.tag)) {
      if (style.visibility === "hidden") return;
      const raw = shapeToPath(node);
      if (!raw) return;
      const d = normalizePathData(raw, m, decimals);
      if (!d) return;
      let fill = resolvePaint(style.fill, gradients);
      let stroke = resolvePaint(style.stroke, gradients);
      // Lines and polylines have no area: an unset fill paints nothing there.
      if (fill === undefined && (node.tag === "line" || node.tag === "polyline") && stroke)
        fill = "none";
      if (stroke === undefined) stroke = "none";
      if (fill === "none" && stroke === "none") return;
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
      const sw = num(style["stroke-width"], 1) * scale;
      const alpha =
        opacity * num(fill !== "none" ? style["fill-opacity"] : style["stroke-opacity"], 1);
      const cap = style["stroke-linecap"];
      const join = style["stroke-linejoin"];
      const path: VectorPath = {
        d,
        ...(fill !== undefined ? { fill } : {}),
        ...(stroke !== "none" ? { stroke, strokeWidth: Math.round(sw * 100) / 100 } : {}),
        ...(style["fill-rule"] === "evenodd" ? { fillRule: "evenodd" as const } : {}),
        ...(alpha < 1 ? { opacity: Math.max(0, Math.round(alpha * 1000) / 1000) } : {}),
        ...(stroke !== "none" && (cap === "round" || cap === "square" || cap === "butt")
          ? { cap }
          : {}),
        ...(stroke !== "none" && (join === "round" || join === "bevel" || join === "miter")
          ? { join }
          : {}),
      };
      if (fill === undefined) delete path.fill;
      paths.push(path);
      return;
    }

    for (const c of node.children) visit(c, next, false);
  };

  visit(svg, { style: {}, opacity: 1, m: IDENTITY, depth: 0, via: new Set() }, false);

  if (paths.length === 0) return { ok: false, error: "Nothing drawable was found in that SVG." };
  if (paths.length > VECTOR_LIMITS.paths) {
    return {
      ok: false,
      error: `That SVG has more than ${VECTOR_LIMITS.paths} parts — too detailed to edit as a vector.`,
    };
  }

  if (!viewBox) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of paths) {
      const b = pathBounds(p.d);
      if (!b) continue;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    viewBox = [minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY)];
  }

  const vector: VectorData = { viewBox, paths, ...(source ? { source } : {}) };
  const checked = vectorDataSchema.safeParse(vector);
  if (!checked.success) {
    const tooBig = checked.error.issues.some((i) => /too detailed|maximum length/.test(i.message));
    return {
      ok: false,
      error: tooBig
        ? "That SVG is too detailed to edit as a vector."
        : "That SVG couldn't be converted into an editable vector.",
    };
  }
  const natural = {
    w: Number.isFinite(w0) && w0 > 0 ? w0 : viewBox[2],
    h: Number.isFinite(h0) && h0 > 0 ? h0 : viewBox[3],
  };
  return {
    ok: true,
    vector: checked.data as VectorData,
    width: natural.w,
    height: natural.h,
    dropped: [...dropped],
  };
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

/** The distinct paints a vector uses, most used first — the recolour palette. */
export function vectorPalette(v: VectorData): string[] {
  const count = new Map<string, number>();
  for (const p of v.paths) {
    for (const c of [p.fill ?? "currentColor", p.stroke]) {
      if (!c || c === "none") continue;
      count.set(c, (count.get(c) ?? 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/** Replace one paint everywhere it's used (fill and stroke). */
export function recolorVector(v: VectorData, from: string, to: string): VectorData {
  return {
    ...v,
    paths: v.paths.map((p) => {
      const next = { ...p };
      if ((p.fill ?? "currentColor") === from) {
        if (to === "currentColor") delete next.fill;
        else next.fill = to;
      }
      if (p.stroke === from) next.stroke = to;
      return next;
    }),
  };
}

/** Multiply every stroke width (the inspector's "stroke weight" control). */
export function scaleVectorStrokes(v: VectorData, factor: number): VectorData {
  return {
    ...v,
    paths: v.paths.map((p) =>
      p.strokeWidth !== undefined
        ? { ...p, strokeWidth: Math.min(1_000, Math.round(p.strokeWidth * factor * 100) / 100) }
        : p,
    ),
  };
}

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A vector's paths as SVG elements (escaped): shared by the download and the board export. */
export function vectorPathsMarkup(v: VectorData): string {
  return v.paths
    .map((p) => {
      const attrs = [
        `d="${escAttr(p.d)}"`,
        `fill="${escAttr(p.fill ?? "currentColor")}"`,
        ...(p.stroke
          ? [`stroke="${escAttr(p.stroke)}"`, `stroke-width="${p.strokeWidth ?? 1}"`]
          : []),
        ...(p.fillRule ? [`fill-rule="${p.fillRule}"`] : []),
        ...(p.opacity !== undefined ? [`opacity="${p.opacity}"`] : []),
        ...(p.cap ? [`stroke-linecap="${p.cap}"`] : []),
        ...(p.join ? [`stroke-linejoin="${p.join}"`] : []),
      ];
      return `<path ${attrs.join(" ")}/>`;
    })
    .join("");
}

/** Standalone SVG text for one vector (download / export). Attribute values are escaped. */
export function vectorToSvg(v: VectorData, width: number, height: number, ink = "#1a1a1a"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${v.viewBox.join(" ")}" color="${escAttr(ink)}">${vectorPathsMarkup(v)}</svg>`;
}

// ---------------------------------------------------------------------------
// Sketch → vector
// ---------------------------------------------------------------------------

/** Ramer–Douglas–Peucker: drop points within `eps` of the line through their neighbours. */
export function simplifyPoints(
  pts: Array<{ x: number; y: number }>,
  eps: number,
): Array<{ x: number; y: number }> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = pts[a]!;
    const pb = pts[b]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farD = eps;
    for (let i = a + 1; i < b; i++) {
      const p = pts[i]!;
      const dist = Math.abs(dy * p.x - dx * p.y + pb.x * pa.y - pb.y * pa.x) / len;
      if (dist > farD) {
        farD = dist;
        far = i;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Catmull-Rom through the points, as cubic Béziers: smooth, and through every kept point. */
function smoothPath(pts: Array<{ x: number; y: number }>, decimals: number): string {
  const k = 10 ** decimals;
  const f = (n: number) => fmt(n, k);
  if (pts.length === 1)
    return `M${f(pts[0]!.x)} ${f(pts[0]!.y)}L${f(pts[0]!.x + 0.01)} ${f(pts[0]!.y)}`;
  let d = `M${f(pts[0]!.x)} ${f(pts[0]!.y)}`;
  if (pts.length === 2) return `${d}L${f(pts[1]!.x)} ${f(pts[1]!.y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    d += `C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

export interface SketchStroke {
  /** The draw shape's own path data, relative to its position. */
  d: string;
  x: number;
  y: number;
  stroke?: string;
  strokeWidth?: number;
}

/**
 * Pen strokes → one smooth vector: each stroke's points are simplified and
 * re-drawn as Catmull-Rom curves, in a shared viewBox at the strokes' bounds.
 * Returns the vector and where the new shape goes, or null for no usable ink.
 */
export function sketchToVector(
  strokes: SketchStroke[],
  eps = 1.2,
): { vector: VectorData; x: number; y: number; width: number; height: number } | null {
  const lines: Array<{ pts: Array<{ x: number; y: number }>; s: SketchStroke }> = [];
  for (const s of strokes) {
    const segs = parsePathData(s.d);
    if (!segs) continue;
    const pts = segs
      .filter((g): g is Extract<Seg, { x: number }> => g.t !== "Z")
      .map((g) => ({ x: g.x + s.x, y: g.y + s.y }));
    if (pts.length) lines.push({ pts, s });
  }
  if (lines.length === 0) return null;
  const pad = Math.max(...lines.map((l) => l.s.strokeWidth ?? 2));
  const all = lines.flatMap((l) => l.pts);
  const minX = Math.min(...all.map((p) => p.x)) - pad;
  const minY = Math.min(...all.map((p) => p.y)) - pad;
  const maxX = Math.max(...all.map((p) => p.x)) + pad;
  const maxY = Math.max(...all.map((p) => p.y)) + pad;
  const width = Math.max(4, maxX - minX);
  const height = Math.max(4, maxY - minY);
  const decimals = precisionFor(Math.max(width, height));
  const paths: VectorPath[] = lines.map(({ pts, s }) => ({
    d: smoothPath(
      simplifyPoints(
        pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
        eps,
      ),
      decimals,
    ),
    fill: "none",
    stroke: s.stroke ?? "currentColor",
    strokeWidth: s.strokeWidth ?? 2,
    cap: "round",
    join: "round",
  }));
  return {
    vector: { viewBox: [0, 0, width, height], paths, source: { generator: "sketch" } },
    x: minX,
    y: minY,
    width,
    height,
  };
}
