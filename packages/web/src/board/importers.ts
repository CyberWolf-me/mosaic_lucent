import type { Operation } from "@lucent/core";
import { nextZ, shapeId } from "../shapes.js";

/**
 * Importers for documents and vector art (docs/15 Phase B).
 *
 * Each turns a file's text into board operations, so an import lands as one
 * undoable commit and every imported object is a first-class shape the AI can
 * read and edit. Nothing is rasterized: a document becomes real sticky notes and
 * an SVG becomes real shapes, not a picture of one.
 *
 * PDF text extraction is deliberately dependency-free — it reads the text-showing
 * operators out of uncompressed content streams. That covers text-based PDFs
 * (exported specs, generated reports) and honestly reports failure on scanned or
 * fully-compressed ones rather than importing garbage.
 */

const GRID = { x: 80, y: 80, stepX: 190, stepY: 150, perRow: 5 } as const;

function gridPosition(index: number): { x: number; y: number } {
  return {
    x: GRID.x + (index % GRID.perRow) * GRID.stepX,
    y: GRID.y + Math.floor(index / GRID.perRow) * GRID.stepY,
  };
}

const STICKY_FILLS = [
  "oklch(0.90 0.11 92)",
  "oklch(0.86 0.08 235)",
  "oklch(0.87 0.09 145)",
  "oklch(0.86 0.10 10)",
];

/** One sticky per block of text, laid out in a grid. */
function stickyOps(blocks: string[], baseZ: number): Operation[] {
  return blocks.map((text, i) => ({
    op: "CREATE_SHAPE" as const,
    id: shapeId(),
    kind: "sticky" as const,
    position: gridPosition(i),
    size: { width: 170, height: 130 },
    text,
    style: { fill: STICKY_FILLS[i % STICKY_FILLS.length]! },
    z: baseZ,
  }));
}

/**
 * Split prose into board-sized blocks. Headings and list items become their own
 * note; long paragraphs are clipped rather than producing a wall of text.
 */
export function documentToBlocks(text: string, maxBlocks = 60): string[] {
  const blocks: string[] = [];
  for (const raw of text.split(/\r?\n\s*\r?\n|\r?\n(?=[#*\-\d])/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    // Strip Markdown decoration so the note reads as content, not syntax.
    const clean = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[*\-+]\s*/, "")
      .trim();
    if (!clean) continue;
    blocks.push(clean.length > 220 ? `${clean.slice(0, 219)}…` : clean);
    if (blocks.length >= maxBlocks) break;
  }
  return blocks;
}

/** Import a plain-text / Markdown document as a grid of sticky notes. */
export function documentToOps(text: string, existing: { z?: number }[] = []): Operation[] {
  const blocks = documentToBlocks(text);
  if (blocks.length === 0) return [];
  return stickyOps(blocks, nextZ(existing));
}

/**
 * Extract readable text from a PDF's content streams.
 *
 * Handles the two text-showing forms that matter: `(literal) Tj` and
 * `[(a) (b)] TJ`. Returns an empty array when the PDF's streams are compressed
 * (FlateDecode) or contain no text, which the caller reports honestly instead of
 * importing nothing silently.
 */
export function pdfToBlocks(raw: string): string[] {
  const out: string[] = [];

  const unescape = (s: string) =>
    s
      .replace(
        /\\([nrtbf])/g,
        (_, c: string) => ({ n: "\n", r: "", t: " ", b: "", f: "" })[c] ?? "",
      )
      .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\([()\\])/g, "$1");

  // [(chunk) -3 (chunk)] TJ — one line assembled from several pieces.
  for (const match of raw.matchAll(/\[((?:[^\][\\]|\\.)*)\]\s*TJ/g)) {
    const pieces = [...(match[1] ?? "").matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((m) =>
      unescape(m[1] ?? ""),
    );
    const line = pieces.join("").replace(/\s+/g, " ").trim();
    if (line) out.push(line);
  }

  // (chunk) Tj — a whole line in one operator.
  for (const match of raw.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
    const line = unescape(match[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) out.push(line);
  }

  // Merge into paragraph-ish blocks so each note carries a readable amount.
  const blocks: string[] = [];
  let current = "";
  for (const line of out) {
    if (current.length + line.length > 200) {
      blocks.push(current.trim());
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
    if (blocks.length >= 60) break;
  }
  if (current.trim()) blocks.push(current.trim());
  return blocks;
}

/** True when a PDF's content streams are compressed, so text can't be read. */
export function pdfIsCompressed(raw: string): boolean {
  return /\/Filter\s*\/(FlateDecode|LZWDecode|DCTDecode)/.test(raw);
}

export function pdfToOps(raw: string, existing: { z?: number }[] = []): Operation[] {
  const blocks = pdfToBlocks(raw);
  if (blocks.length === 0) return [];
  return stickyOps(blocks, nextZ(existing));
}

interface SvgElement {
  tag: string;
  attrs: Record<string, string>;
}

/** Parse the flat list of drawable SVG elements out of markup. */
export function parseSvgElements(svg: string): SvgElement[] {
  const out: SvgElement[] = [];
  for (const match of svg.matchAll(/<(rect|circle|ellipse|line|text|polygon|path)\b([^>]*)>/gi)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs: Record<string, string> = {};
    for (const attr of (match[2] ?? "").matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[(attr[1] ?? "").toLowerCase()] = attr[2] ?? "";
    }
    out.push({ tag, attrs });
  }
  // <text>label</text> content sits between tags, so pair it up separately.
  const texts = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((m) =>
    (m[1] ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  let textIndex = 0;
  for (const el of out) {
    if (el.tag === "text") {
      el.attrs.__content = texts[textIndex++] ?? "";
    }
  }
  return out;
}

const num = (v: string | undefined, fallback = 0): number => {
  const parsed = Number.parseFloat(v ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Import an SVG as editable shapes rather than an embedded image.
 *
 * Rect/circle/ellipse/line/text map onto real shape kinds. A `path` becomes a
 * `draw` shape carrying its own path data, so freehand and vector art survive a
 * round trip through the board.
 */
export function svgToOps(svg: string, existing: { z?: number }[] = []): Operation[] {
  const elements = parseSvgElements(svg);
  const ops: Operation[] = [];
  const baseZ = nextZ(existing);

  for (const { tag, attrs } of elements) {
    const stroke = attrs.stroke && attrs.stroke !== "none" ? attrs.stroke : undefined;
    const fill = attrs.fill && attrs.fill !== "none" ? attrs.fill : undefined;
    const style = {
      ...(fill ? { fill } : {}),
      ...(stroke ? { stroke } : {}),
      ...(attrs["stroke-width"] ? { strokeWidth: num(attrs["stroke-width"], 1) } : {}),
    };
    const common = { id: shapeId(), z: baseZ, ...(Object.keys(style).length ? { style } : {}) };

    if (tag === "rect") {
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "rect",
        position: { x: num(attrs.x), y: num(attrs.y) },
        size: {
          width: Math.max(1, num(attrs.width, 100)),
          height: Math.max(1, num(attrs.height, 60)),
        },
        ...(attrs.rx ? { style: { ...style, radius: num(attrs.rx) } } : {}),
      });
    } else if (tag === "circle") {
      const r = Math.max(1, num(attrs.r, 30));
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "ellipse",
        position: { x: num(attrs.cx) - r, y: num(attrs.cy) - r },
        size: { width: r * 2, height: r * 2 },
      });
    } else if (tag === "ellipse") {
      const rx = Math.max(1, num(attrs.rx, 40));
      const ry = Math.max(1, num(attrs.ry, 25));
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "ellipse",
        position: { x: num(attrs.cx) - rx, y: num(attrs.cy) - ry },
        size: { width: rx * 2, height: ry * 2 },
      });
    } else if (tag === "line") {
      // A straight line is a one-segment drawing, kept as vector data.
      const x1 = num(attrs.x1);
      const y1 = num(attrs.y1);
      const x2 = num(attrs.x2);
      const y2 = num(attrs.y2);
      const minX = Math.min(x1, x2);
      const minY = Math.min(y1, y2);
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "draw",
        position: { x: minX, y: minY },
        size: { width: Math.max(1, Math.abs(x2 - x1)), height: Math.max(1, Math.abs(y2 - y1)) },
        path: `M ${x1 - minX} ${y1 - minY} L ${x2 - minX} ${y2 - minY}`,
      });
    } else if (tag === "text") {
      const content = attrs.__content;
      if (!content) continue;
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "text",
        position: { x: num(attrs.x), y: num(attrs.y) - num(attrs["font-size"], 14) },
        size: { width: Math.max(60, content.length * 8), height: 32 },
        text: content,
      });
    } else if (tag === "polygon" || tag === "path") {
      const points = attrs.points;
      const d = attrs.d;
      const data = d ?? (points ? `M ${points.trim().replace(/\s+/g, " L ")} Z` : "");
      if (!data) continue;
      // Bounds from the numbers in the path data: enough for a draggable box.
      const coords = [...data.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      const xs = coords.filter((_, i) => i % 2 === 0);
      const ys = coords.filter((_, i) => i % 2 === 1);
      const minX = xs.length ? Math.min(...xs) : 0;
      const minY = ys.length ? Math.min(...ys) : 0;
      const maxX = xs.length ? Math.max(...xs) : 100;
      const maxY = ys.length ? Math.max(...ys) : 100;
      ops.push({
        op: "CREATE_SHAPE",
        ...common,
        kind: "draw",
        position: { x: minX, y: minY },
        size: { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
        path: data,
      });
    }
  }

  return ops;
}

export type ImportKind = "json" | "csv" | "svg" | "pdf" | "document" | "image" | "unknown";
/** Classify a file by extension, falling back to its MIME type. */
export function classifyImport(fileName: string, mimeType = ""): ImportKind {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "json") return "json";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "svg") return "svg";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "txt", "text", "rtf"].includes(ext)) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) return "image";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/")) return "document";
  return "unknown";
}

/**
 * Turn the current selection into AI attachments.
 *
 * A selected image shape becomes a vision attachment (so "redraw this
 * screenshot" has something to look at) and a selected sticky/text/file becomes
 * a document. Only data-URL images travel: a remote src would ask the provider
 * to fetch on our behalf, which we don't do.
 */
export function collectAttachments(
  workspace: { shapes: Record<string, { id: string; kind: string; text?: string; src?: string }> },
  selection: string[],
): {
  images?: Array<{ data: string; mediaType: string }>;
  documents?: Array<{ name: string; text: string }>;
} {
  const images: Array<{ data: string; mediaType: string }> = [];
  const documents: Array<{ name: string; text: string }> = [];

  for (const id of selection) {
    const shape = workspace.shapes[id];
    if (!shape) continue;

    if (shape.kind === "image" && shape.src?.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(shape.src);
      if (!match) continue;
      const mediaType = match[1]!;
      // Only formats the providers accept; anything else is skipped rather than
      // sent and rejected.
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) continue;
      if (images.length < 4) images.push({ data: match[2]!, mediaType });
    } else if (shape.text && shape.text.length > 40) {
      // A long note reads as a document; a short label is already in the summary.
      if (documents.length < 4) {
        documents.push({ name: shape.id, text: shape.text.slice(0, 20_000) });
      }
    }
  }

  return {
    ...(images.length ? { images } : {}),
    ...(documents.length ? { documents } : {}),
  };
}
