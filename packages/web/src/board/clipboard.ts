import {
  safeParseProgrammaticOperations,
  type Operation,
  type Shape,
  type ShapeLink,
  type Workspace,
} from "@lucent/core";
import { resolveEmbed } from "../embed.js";
import { cloneShapeOp, normalizeZ, shapeId } from "../shapes.js";

/**
 * The system clipboard for the canvas (docs/26 §6.4).
 *
 * Copy writes two formats: a Lucent payload under a custom MIME type (shapes,
 * nodes, and the edges and links among them), and plain text for every other
 * app. Paste reads, in order: a Lucent payload, then an image, SVG, a URL, and
 * plain text. So a selection moves between boards and tabs, and a screenshot,
 * a logo, a link or a paragraph from anywhere lands as the right object.
 *
 * Anything on the clipboard is untrusted: any page can write this MIME type.
 * A payload therefore becomes operations that must pass the strict op schema
 * (`safeParseProgrammaticOperations`), the same gate the server's ops route
 * applies, before the caller commits them.
 */

export const LUCENT_CLIP_MIME = "application/x-lucent-board+json";

export interface ClipNode {
  id: string;
  label: string;
  nodeType: string;
  icon?: string;
}

export interface ClipPayload {
  v: 1;
  /** The board it was copied from: pasting back offsets, elsewhere recentres. */
  from: string;
  shapes: Shape[];
  links: ShapeLink[];
  nodes: ClipNode[];
  edges: Array<{ source: string; target: string; relationship: string }>;
}

/** What the selection copies as: shapes and nodes, and only the ties between them. */
export function clipFromSelection(
  ws: Workspace,
  shapeIds: Iterable<string>,
  nodeIds: Iterable<string>,
): ClipPayload | null {
  const shapes = [...shapeIds].map((id) => ws.shapes[id]).filter((s): s is Shape => Boolean(s));
  const nodeSet = new Set([...nodeIds].filter((id) => ws.nodes[id]));
  if (shapes.length === 0 && nodeSet.size === 0) return null;
  const shapeSet = new Set(shapes.map((s) => s.id));
  return {
    v: 1,
    from: ws.id,
    shapes,
    links: Object.values(ws.shapeLinks).filter(
      (l) => shapeSet.has(l.source) && shapeSet.has(l.target),
    ),
    nodes: [...nodeSet].map((id) => {
      const n = ws.nodes[id]!;
      // A copy is a new object: meaning and icon travel, evidence doesn't —
      // the original's meeting turns are not the copy's.
      return { id, label: n.label, nodeType: n.nodeType, ...(n.icon ? { icon: n.icon } : {}) };
    }),
    edges: Object.values(ws.edges)
      .filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, relationship: e.relationship })),
  };
}

/** The selection as text, for every app that isn't Lucent. */
export function clipText(p: ClipPayload): string {
  const lines = [
    ...p.nodes.map((n) => n.label),
    ...p.shapes.map((s) => s.text?.trim()).filter((t): t is string => Boolean(t)),
  ];
  return lines.join("\n");
}

/** Read a payload back, or null for anything that isn't one. Shape only — the op schema is the real gate. */
export function parseClip(raw: string | undefined | null): ClipPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ClipPayload>;
    if (p?.v !== 1 || typeof p.from !== "string") return null;
    if (![p.shapes, p.links, p.nodes, p.edges].every(Array.isArray)) return null;
    return p as ClipPayload;
  } catch {
    return null;
  }
}

function freeNodeId(ws: Workspace, taken: Set<string>, id: string): string {
  if (!ws.nodes[id] && !taken.has(id)) return id;
  for (let i = 2; ; i++) {
    const next = `${id}-${i}`;
    if (!ws.nodes[next] && !taken.has(next)) return next;
  }
}

export interface PastePlan {
  ops: Operation[];
  shapeIds: string[];
  nodeIds: string[];
}

/**
 * The operations that paste a payload into `ws`, schema-checked. Pasted back
 * into its own board it lands 24px down-right, like a duplicate; into another
 * board it centres on `at` (the viewport). Nodes get the layout engine's
 * placement, as they always do. Returns null when the payload doesn't survive
 * the schema, so a hostile or corrupt clipboard is refused as a whole.
 */
export function planPaste(
  ws: Workspace,
  p: ClipPayload,
  at: { x: number; y: number },
): PastePlan | null {
  try {
    return buildPaste(ws, p, at);
  } catch {
    // A malformed payload (a shape without a position, say) can throw while
    // the plan is computed, before the schema ever sees it.
    return null;
  }
}

function buildPaste(ws: Workspace, p: ClipPayload, at: { x: number; y: number }): PastePlan | null {
  const ops: Operation[] = [];
  const shapeIds: string[] = [];
  const nodeIds: string[] = [];

  if (p.shapes.length > 0) {
    let dx = 24;
    let dy = 24;
    if (p.from !== ws.id) {
      const minX = Math.min(...p.shapes.map((s) => s.position.x));
      const minY = Math.min(...p.shapes.map((s) => s.position.y));
      const maxX = Math.max(...p.shapes.map((s) => s.position.x + s.size.width));
      const maxY = Math.max(...p.shapes.map((s) => s.position.y + s.size.height));
      dx = Math.round(at.x - (minX + maxX) / 2);
      dy = Math.round(at.y - (minY + maxY) / 2);
    }
    const top = Object.values(ws.shapes).reduce((m, s) => Math.max(m, normalizeZ(s.z)), 0);
    const idMap = new Map<string, string>();
    [...p.shapes]
      .sort((a, b) => normalizeZ(a.z) - normalizeZ(b.z))
      .forEach((s, i) => {
        const nid = shapeId();
        idMap.set(s.id, nid);
        shapeIds.push(nid);
        const op = cloneShapeOp(s, nid, 0, top + 1 + i);
        op.position = { x: s.position.x + dx, y: s.position.y + dy };
        ops.push(op);
      });
    for (const l of p.links) {
      const source = idMap.get(l.source);
      const target = idMap.get(l.target);
      if (!source || !target) continue;
      ops.push({
        op: "CONNECT_SHAPES",
        id: `lnk_${shapeId()}`,
        source,
        target,
        ...(l.label !== undefined ? { label: l.label } : {}),
        ...(l.variant !== undefined ? { variant: l.variant } : {}),
        ...(l.doubleArrow !== undefined ? { doubleArrow: l.doubleArrow } : {}),
      });
    }
  }

  if (p.nodes.length > 0) {
    const taken = new Set<string>();
    const idMap = new Map<string, string>();
    for (const n of p.nodes) {
      const id = freeNodeId(ws, taken, n.id);
      taken.add(id);
      idMap.set(n.id, id);
      nodeIds.push(id);
      ops.push({
        op: "CREATE_NODE",
        id,
        nodeType: n.nodeType,
        label: n.label,
        ...(n.icon ? { icon: n.icon } : {}),
      });
    }
    for (const e of p.edges) {
      const source = idMap.get(e.source);
      const target = idMap.get(e.target);
      if (source && target)
        ops.push({ op: "CONNECT_NODES", source, target, relationship: e.relationship });
    }
  }

  if (ops.length === 0) return null;
  const parsed = safeParseProgrammaticOperations(ops);
  return parsed.success ? { ops: parsed.data, shapeIds, nodeIds } : null;
}

/** An SVG document pasted as text — shown as an image until Vector Studio (§6.3) imports it. */
export function svgTextToDataUrl(text: string): string | null {
  const t = text.trim();
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(t) || !/<\/svg>\s*$/i.test(t)) return null;
  // base64, because the schema's image grammar refuses percent-encoded data
  // URLs; an <img> never runs an SVG's scripts, and the export embeds it the
  // same way.
  const bytes = new TextEncoder().encode(t);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

/** An SVG's drawn size from width/height or its viewBox, fitted within 320px. */
export function svgSize(text: string): { width: number; height: number } {
  const num = (re: RegExp) => Number.parseFloat(re.exec(text)?.[1] ?? "");
  const vb = /viewBox="\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(text);
  let w = num(/<svg[^>]*\swidth="([0-9.]+)/i);
  let h = num(/<svg[^>]*\sheight="([0-9.]+)/i);
  if (!(w > 0 && h > 0) && vb) {
    w = Number.parseFloat(vb[1]!);
    h = Number.parseFloat(vb[2]!);
  }
  if (!(w > 0 && h > 0)) return { width: 200, height: 200 };
  const k = Math.min(1, 320 / Math.max(w, h));
  return { width: Math.max(16, Math.round(w * k)), height: Math.max(16, Math.round(h * k)) };
}

/**
 * The shape one line (or paragraph) of pasted text becomes: an embed for a
 * link Lucent knows how to show, otherwise a text object sized to the words.
 */
export function textPasteOp(
  text: string,
  at: { x: number; y: number },
  z: number,
): Extract<Operation, { op: "CREATE_SHAPE" }> | null {
  const t = text.trim().slice(0, 4_000);
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) {
    const embed = resolveEmbed(t);
    if (embed) {
      const size =
        embed.mode === "iframe" ? { width: 400, height: 260 } : { width: 260, height: 200 };
      return {
        op: "CREATE_SHAPE",
        id: shapeId(),
        kind: "embed",
        position: { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) },
        size,
        src: embed.src,
        z: normalizeZ(z),
      };
    }
  }
  const lines = t.split(/\r?\n/);
  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.min(480, Math.max(120, Math.round(longest * 7.4) + 24));
  const perLine = Math.max(1, Math.floor((width - 24) / 7.4));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const height = Math.max(36, rows * 20 + 16);
  return {
    op: "CREATE_SHAPE",
    id: shapeId(),
    kind: "text",
    position: { x: Math.round(at.x - width / 2), y: Math.round(at.y - height / 2) },
    size: { width, height },
    text: t,
    z: normalizeZ(z),
  };
}
