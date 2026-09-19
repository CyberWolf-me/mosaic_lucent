import type { Shape, Workspace } from "@lucent/core";
import { routeStyleFor, routedVertices } from "@lucent/core";
import { DIAGRAM_LABELS } from "../scene.js";

/**
 * Pure board geometry helpers, extracted from CanvasView so they can be unit
 * tested without a DOM (docs/13). No React, no side effects.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Snap a moving shape's top-left to nearby shape edges, falling back to a grid.
 * `others` excludes the shape being moved.
 *
 * Matches left/right/centre on X and top/bottom/middle on Y, like Figma — the
 * old version only compared left and top edges, so two shapes could look
 * centre-aligned and be a pixel apart.
 */
export function snapPosition(
  x: number,
  y: number,
  others: Shape[],
  snap = 6,
  grid = 8,
  /** Size of the moving shape; enables centre/right/bottom matching. */
  moving?: { width: number; height: number },
): { x: number; y: number } {
  const w = moving?.width ?? 0;
  const h = moving?.height ?? 0;
  let sx = x;
  let sy = y;
  let snappedX = false;
  let snappedY = false;
  for (const o of others) {
    const oL = o.position.x;
    const oR = o.position.x + o.size.width;
    const oC = o.position.x + o.size.width / 2;
    const oT = o.position.y;
    const oB = o.position.y + o.size.height;
    const oM = o.position.y + o.size.height / 2;

    // Candidate x values for the moving shape's left edge that would align some
    // pair of edges (left↔left, left↔right, right↔right, right↔left, centre↔centre).
    const candX = w > 0 ? [oL, oR, oL - w, oR - w, oC - w / 2] : [oL, oR];
    for (const cx of candX) {
      if (!snappedX && Math.abs(x - cx) < snap) {
        sx = cx;
        snappedX = true;
      }
    }
    const candY = h > 0 ? [oT, oB, oT - h, oB - h, oM - h / 2] : [oT, oB];
    for (const cy of candY) {
      if (!snappedY && Math.abs(y - cy) < snap) {
        sy = cy;
        snappedY = true;
      }
    }
  }
  if (!snappedX) sx = Math.round(x / grid) * grid;
  if (!snappedY) sy = Math.round(y / grid) * grid;
  return { x: sx, y: sy };
}

/** A guide line to draw while dragging: vertical at x, or horizontal at y. */
export interface AlignGuide {
  axis: "v" | "h";
  /** Content-space coordinate of the line. */
  at: number;
  /** Extent of the line along the other axis, so it spans both objects. */
  from: number;
  to: number;
}

/**
 * Guides for a shape resting at (x,y): which of its edges/centres currently line
 * up with another shape's. Purely derived from the snapped position, so a guide
 * appears exactly when the snap took effect.
 */
export function alignGuides(
  box: { x: number; y: number; width: number; height: number },
  others: Shape[],
  tolerance = 0.5,
): AlignGuide[] {
  const guides: AlignGuide[] = [];
  const mL = box.x;
  const mR = box.x + box.width;
  const mC = box.x + box.width / 2;
  const mT = box.y;
  const mB = box.y + box.height;
  const mM = box.y + box.height / 2;

  for (const o of others) {
    const oL = o.position.x;
    const oR = o.position.x + o.size.width;
    const oC = o.position.x + o.size.width / 2;
    const oT = o.position.y;
    const oB = o.position.y + o.size.height;
    const oM = o.position.y + o.size.height / 2;

    for (const [m, v] of [
      [mL, oL],
      [mL, oR],
      [mR, oL],
      [mR, oR],
      [mC, oC],
    ] as const) {
      if (Math.abs(m - v) <= tolerance) {
        guides.push({
          axis: "v",
          at: v,
          from: Math.min(mT, oT),
          to: Math.max(mB, oB),
        });
      }
    }
    for (const [m, v] of [
      [mT, oT],
      [mT, oB],
      [mB, oT],
      [mB, oB],
      [mM, oM],
    ] as const) {
      if (Math.abs(m - v) <= tolerance) {
        guides.push({
          axis: "h",
          at: v,
          from: Math.min(mL, oL),
          to: Math.max(mR, oR),
        });
      }
    }
  }

  // Collapse duplicates on the same axis+coordinate, keeping the widest span.
  const merged = new Map<string, AlignGuide>();
  for (const g of guides) {
    const key = `${g.axis}:${Math.round(g.at)}`;
    const prev = merged.get(key);
    if (!prev) merged.set(key, g);
    else
      merged.set(key, { ...prev, from: Math.min(prev.from, g.from), to: Math.max(prev.to, g.to) });
  }
  return [...merged.values()];
}

/** Ids of shapes whose box intersects the marquee rectangle. */
export function marqueeHits(
  rect: { x0: number; y0: number; x1: number; y1: number },
  shapes: Shape[],
): Set<string> {
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  const hit = new Set<string>();
  for (const s of shapes) {
    const sr = s.position.x + s.size.width;
    const sb = s.position.y + s.size.height;
    if (s.position.x < maxX && sr > minX && s.position.y < maxY && sb > minY) hit.add(s.id);
  }
  return hit;
}

/** Bounding box over all nodes and shapes; null when the board is empty.
 * Unplaced nodes use the same defaults the live renderer applies (`toScene`),
 * so a server-adopted board exports instead of collapsing to "Empty board". */
export function contentBounds(workspace: Workspace): Box | null {
  const boxes: Box[] = [];
  for (const n of Object.values(workspace.nodes)) {
    boxes.push({
      x: n.position?.x ?? 0,
      y: n.position?.y ?? 0,
      width: n.size?.width ?? 160,
      height: n.size?.height ?? 64,
    });
  }
  for (const s of Object.values(workspace.shapes)) {
    boxes.push({ x: s.position.x, y: s.position.y, width: s.size.width, height: s.size.height });
  }
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A single selectable canvas object, tagged by kind. Used to give keyboard users
 * a deterministic Tab order over nodes and shapes (WCAG 2.1.1): the canvas is a
 * 2-D surface, so "reading order" is top-to-bottom then left-to-right by the
 * object's top-left corner. Ties break by id so the order is stable.
 */
export interface SelectableRef {
  id: string;
  kind: "node" | "shape";
  x: number;
  y: number;
}

/**
 * Every node and un-hidden shape in keyboard-navigation order. Nodes without a
 * computed position (not yet laid out) sort last but are still included so they
 * are reachable.
 */
export function selectableOrder(workspace: Workspace): SelectableRef[] {
  const refs: SelectableRef[] = [];
  for (const n of Object.values(workspace.nodes)) {
    refs.push({
      id: n.id,
      kind: "node",
      x: n.position?.x ?? Infinity,
      y: n.position?.y ?? Infinity,
    });
  }
  for (const s of Object.values(workspace.shapes)) {
    if (s.hidden) continue;
    refs.push({ id: s.id, kind: "shape", x: s.position.x, y: s.position.y });
  }
  // Row-major with a tolerance band so a slightly-misaligned row still reads
  // left-to-right rather than zig-zagging.
  const ROW = 40;
  refs.sort((a, b) => {
    if (Math.abs(a.y - b.y) > ROW) return a.y - b.y;
    if (a.x !== b.x) return a.x - b.x;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return refs;
}

/**
 * The next selectable after `currentId` when cycling with Tab (dir 1) or
 * Shift+Tab (dir -1). Wraps around, and starts at the first/last object when
 * nothing is selected yet. Returns null only for an empty board.
 */
export function nextSelectable(
  workspace: Workspace,
  currentId: string | null,
  dir: 1 | -1,
): SelectableRef | null {
  const order = selectableOrder(workspace);
  if (order.length === 0) return null;
  const idx = currentId ? order.findIndex((r) => r.id === currentId) : -1;
  if (idx === -1) return dir === 1 ? order[0]! : order[order.length - 1]!;
  const next = (idx + dir + order.length) % order.length;
  return order[next]!;
}

const escapeXml = (t: string) =>
  t.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );

/**
 * Escape a string for inclusion inside an SVG attribute value (M0.5). The XML
 * escaper above is correct for *element bodies*; attributes additionally need
 * to refuse the few characters that can break out of the quoted value: `"`,
 * `'`, `<`, `>`, `&`. The same rule applies to the html-inline paths the
 * export-PDF renderer builds, so we share one helper.
 */
export const escapeAttr = (t: string): string => escapeXml(t);

/** Serialize the board (nodes + manual shapes) to a standalone SVG string. */
export function buildBoardSvg(workspace: Workspace, pad = 40): string {
  const bounds = contentBounds(workspace);
  if (!bounds) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><text x="20" y="40" font-family="sans-serif" font-size="14">Empty board</text></svg>`;
  }
  const minX = bounds.x - pad;
  const minY = bounds.y - pad;
  const w = bounds.width + pad * 2;
  const h = bounds.height + pad * 2;
  const parts: string[] = [];

  // Diagram regions first, so their boxes sit behind their member nodes. A
  // region is a kind-bearing group; its box is measured over placed members.
  // The label carries the region's kind so a mixed-board export still reads
  // "this part is the mind map" without the app open.
  const regionBoxes: string[] = [];
  for (const g of Object.values(workspace.groups)) {
    let minX2 = Infinity;
    let minY2 = Infinity;
    let maxX2 = -Infinity;
    let maxY2 = -Infinity;
    let members = 0;
    for (const id of g.children) {
      const n = workspace.nodes[id];
      if (!n) continue;
      members++;
      // Same position/size defaults as the node loop and the live renderer —
      // an unplaced member still bounds its region.
      const nx = n.position?.x ?? 0;
      const ny = n.position?.y ?? 0;
      const nw = n.size?.width ?? 160;
      const nh = n.size?.height ?? 64;
      if (nx < minX2) minX2 = nx;
      if (ny < minY2) minY2 = ny;
      if (nx + nw > maxX2) maxX2 = nx + nw;
      if (ny + nh > maxY2) maxY2 = ny + nh;
    }
    if (members === 0) continue;
    const gp = 22;
    // The same display vocabulary the live canvas uses for the region pill
    // (DIAGRAM_LABELS), not the raw kind string.
    const label = g.kind ? `${g.label} · ${DIAGRAM_LABELS[g.kind]}` : g.label;
    regionBoxes.push(
      `<rect x="${minX2 - gp}" y="${minY2 - gp}" width="${maxX2 - minX2 + gp * 2}" height="${maxY2 - minY2 + gp * 2}" rx="12" fill="#1a1a1d" stroke="#3a3a3e"/>` +
        `<text x="${minX2 - gp + 12}" y="${minY2 - gp + 16}" fill="#8a8a90" font-family="sans-serif" font-size="11">${escapeXml(label)}</text>`,
    );
  }
  parts.push(regionBoxes.join(""));

  // Connectors — the live canvas layers them under the cards, so the export
  // does too. Center-to-center lines with an arrowhead marker; endpoints use
  // the same position/size defaults as `toScene` so an unplaced endpoint still
  // draws (the serializer used to skip unplaced nodes entirely and never drew
  // edges at all — the exported file was cards-without-links or worse).
  // A routed edge (V5) exports its drawn corridor — matching what the canvas
  // shows — via points=, through the SAME routedVertices the canvas and the
  // benchmark use (Phase 5: an ortho board exports squared corners); route-
  // less edges keep the <line> form.
  let connectorSvg = "";
  for (const e of Object.values(workspace.edges)) {
    const s = workspace.nodes[e.source];
    const t = workspace.nodes[e.target];
    if (!s || !t) continue;
    const x1 = (s.position?.x ?? 0) + (s.size?.width ?? 160) / 2;
    const y1 = (s.position?.y ?? 0) + (s.size?.height ?? 64) / 2;
    const x2 = (t.position?.x ?? 0) + (t.size?.width ?? 160) / 2;
    const y2 = (t.position?.y ?? 0) + (t.size?.height ?? 64) / 2;
    if (e.route && e.route.length > 0) {
      const pts = routedVertices(
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        e.route,
        routeStyleFor(workspace.diagramKind),
      );
      connectorSvg +=
        `<polyline points="${pts.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#8a8a90" stroke-width="1.5" marker-end="url(#export-arrow)"/>`;
    } else {
      connectorSvg +=
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#8a8a90" stroke-width="1.5" marker-end="url(#export-arrow)"/>`;
    }
  }
  parts.push(connectorSvg);

  for (const n of Object.values(workspace.nodes)) {
    const x = n.position?.x ?? 0;
    const y = n.position?.y ?? 0;
    const width = n.size?.width ?? 160;
    const height = n.size?.height ?? 64;
    parts.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="#1b1b1e" stroke="#555"/>` +
        `<text x="${x + width / 2}" y="${y + height / 2}" fill="#eee" font-family="sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle">${escapeXml(n.label)}</text>`,
    );
  }
  for (const s of Object.values(workspace.shapes)) {
    if (s.kind === "draw" && s.path) {
      // `path` is SVG path data validated by the schema; still escapeAttr so a
      // future model that smuggles a `"` can't break out of the attribute (M0.5).
      parts.push(
        `<path transform="translate(${s.position.x},${s.position.y})" d="${escapeAttr(s.path)}" fill="none" stroke="${escapeAttr(s.style?.stroke ?? "#eee")}" stroke-width="${s.style?.strokeWidth ?? 2}"/>`,
      );
    } else if (s.kind === "frame") {
      parts.push(
        `<rect x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" rx="10" fill="none" stroke="#777" stroke-dasharray="6 4"/>` +
          (s.text
            ? `<text x="${s.position.x + 10}" y="${s.position.y + 18}" fill="#aaa" font-family="monospace" font-size="11">${escapeXml(s.text)}</text>`
            : ""),
      );
    } else if (s.kind === "triangle") {
      const fill = s.style?.fill ?? "#f5c542";
      const { x, y } = s.position;
      const { width: sw, height: sh } = s.size;
      parts.push(
        `<polygon points="${x + sw / 2},${y} ${x + sw},${y + sh} ${x},${y + sh}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(s.style?.stroke ?? "#0000")}"/>`,
      );
    } else if (s.kind === "star") {
      const fill = s.style?.fill ?? "#f5c542";
      const { x, y } = s.position;
      const { width: sw, height: sh } = s.size;
      const cx = x + sw / 2;
      const cy = y + sh / 2;
      const rO = Math.min(sw, sh) / 2;
      const rI = rO * 0.42;
      const pts: string[] = [];
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? rO : rI;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
      }
      parts.push(
        `<polygon points="${pts.join(" ")}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(s.style?.stroke ?? "#0000")}"/>`,
      );
    } else if (s.kind === "image") {
      // Data-URL images embed directly; a remote src would need CORS at
      // rasterization time, so it is drawn as a labelled placeholder instead.
      if (s.src?.startsWith("data:")) {
        parts.push(
          `<image x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" href="${escapeXml(s.src)}" preserveAspectRatio="xMidYMid slice"/>`,
        );
      } else {
        parts.push(
          `<rect x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" rx="8" fill="#1b1b1e" stroke="#555"/>` +
            `<text x="${s.position.x + s.size.width / 2}" y="${s.position.y + s.size.height / 2}" fill="#aaa" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="middle">Linked image</text>`,
        );
      }
    } else if (s.kind === "embed") {
      // An embed is live content; a static export can only show a placeholder,
      // but it should at least be visible rather than silently dropped.
      const label = s.src?.startsWith("data:")
        ? "Embedded media"
        : escapeXml(s.src ?? "Embedded media");
      parts.push(
        `<rect x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" rx="8" fill="#1b1b1e" stroke="#555"/>` +
          `<text x="${s.position.x + s.size.width / 2}" y="${s.position.y + s.size.height / 2}" fill="#aaa" font-family="sans-serif" font-size="11" text-anchor="middle" dominant-baseline="middle">▶ ${label.slice(0, 48)}</text>`,
      );
    } else if (s.kind === "file") {
      parts.push(
        `<rect x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" rx="6" fill="#232326" stroke="#555"/>` +
          `<text x="${s.position.x + 10}" y="${s.position.y + s.size.height / 2}" fill="#ddd" font-family="sans-serif" font-size="12" dominant-baseline="middle">${escapeXml(s.text ?? "Document")}</text>`,
      );
    } else {
      const fill = s.style?.fill ?? "#f5c542";
      parts.push(
        `<rect x="${s.position.x}" y="${s.position.y}" width="${s.size.width}" height="${s.size.height}" rx="${s.kind === "ellipse" ? s.size.height / 2 : 6}" fill="${escapeAttr(fill)}" stroke="${escapeAttr(s.style?.stroke ?? "#0000")}"/>` +
          (s.text
            ? wrappedSvgText(s.text, s.position.x + 10, s.position.y + 22, s.size.width - 20)
            : ""),
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}"><defs><marker id="export-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8a8a90"/></marker></defs><rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#141416"/>${parts.join("")}</svg>`;
}

/**
 * Wrap sticky/shape text across lines so long notes don't run off the shape in
 * an export. Approximates character width rather than measuring, which is close
 * enough for a static snapshot and needs no DOM.
 */
function wrappedSvgText(
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  fontSize = 12,
): string {
  const charsPerLine = Math.max(8, Math.floor(maxWidth / (fontSize * 0.55)));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > charsPerLine && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
    if (lines.length > 8) break;
  }
  return lines
    .slice(0, 8)
    .map(
      (l, i) =>
        `<text x="${x}" y="${y + i * (fontSize + 3)}" fill="#222" font-family="sans-serif" font-size="${fontSize}">${escapeXml(l)}</text>`,
    )
    .join("");
}

/** Shape ids fully contained within a frame's box (for frame drag-together). */
export function shapesInFrame(frame: Shape, shapes: Shape[]): string[] {
  const fx = frame.position.x;
  const fy = frame.position.y;
  const fr = fx + frame.size.width;
  const fb = fy + frame.size.height;
  return shapes
    .filter((s) => s.id !== frame.id && s.kind !== "frame")
    .filter(
      (s) =>
        s.position.x >= fx &&
        s.position.y >= fy &&
        s.position.x + s.size.width <= fr &&
        s.position.y + s.size.height <= fb,
    )
    .map((s) => s.id);
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Compute new top-left positions to align a set of shapes to a common edge or
 * center (FigJam/Miro alignment). Returns id -> {x,y} for shapes that move.
 */
export function alignPositions(
  shapes: Shape[],
  mode: AlignMode,
): Record<string, { x: number; y: number }> {
  if (shapes.length < 2) return {};
  const left = Math.min(...shapes.map((s) => s.position.x));
  const right = Math.max(...shapes.map((s) => s.position.x + s.size.width));
  const top = Math.min(...shapes.map((s) => s.position.y));
  const bottom = Math.max(...shapes.map((s) => s.position.y + s.size.height));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const out: Record<string, { x: number; y: number }> = {};
  for (const s of shapes) {
    let x = s.position.x;
    let y = s.position.y;
    if (mode === "left") x = left;
    else if (mode === "right") x = right - s.size.width;
    else if (mode === "hcenter") x = cx - s.size.width / 2;
    else if (mode === "top") y = top;
    else if (mode === "bottom") y = bottom - s.size.height;
    else if (mode === "vcenter") y = cy - s.size.height / 2;
    out[s.id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/**
 * Evenly distribute shapes along an axis so the gaps between them are equal
 * (needs 3+ shapes). Returns id -> {x,y} for shapes that move.
 */
export function distributePositions(
  shapes: Shape[],
  axis: "h" | "v",
): Record<string, { x: number; y: number }> {
  if (shapes.length < 3) return {};
  const sorted = [...shapes].sort((a, b) =>
    axis === "h" ? a.position.x - b.position.x : a.position.y - b.position.y,
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const out: Record<string, { x: number; y: number }> = {};
  if (axis === "h") {
    const span = last.position.x - first.position.x;
    const step = span / (sorted.length - 1);
    sorted.forEach((s, i) => {
      out[s.id] = { x: Math.round(first.position.x + step * i), y: s.position.y };
    });
  } else {
    const span = last.position.y - first.position.y;
    const step = span / (sorted.length - 1);
    sorted.forEach((s, i) => {
      out[s.id] = { x: s.position.x, y: Math.round(first.position.y + step * i) };
    });
  }
  return out;
}
