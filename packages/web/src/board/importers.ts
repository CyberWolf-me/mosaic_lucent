import {
  readDelimited,
  sniffDelimited,
  TABLE_LIMITS,
  type DelimitedRead,
  type Operation,
  type TableData,
} from "@lucent/core";
import { svgToVectorOp } from "../vector/ops.js";
import { nextZ, shapeId } from "../shapes.js";

/**
 * Importers for documents and vector art (docs/15 Phase B).
 *
 * Each turns a file's text into board operations, so an import lands as one
 * undoable commit and every imported object is a first-class shape the AI can
 * read and edit. Nothing is rasterized: a document becomes real sticky notes and
 * an SVG becomes one editable vector, not a picture of one.
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

/**
 * Import an SVG file as ONE editable vector (docs/26 §6.3, V2) through core's
 * sanitizing importer: styles, transforms and <use> resolved, scripts and
 * external references dropped, geometry kept exactly. It replaced a regex
 * pass that scattered primitives into loose rects and ellipses, ignored
 * transforms, and let any attribute value through as a colour.
 *
 * Empty when nothing drawable survives; the caller says so.
 */
export function svgToOps(
  svg: string,
  existing: { z?: number }[] = [],
  at: { x: number; y: number } = { x: 320, y: 240 },
): Operation[] {
  const r = svgToVectorOp(svg, at, nextZ(existing));
  return r.ok ? [r.op] : [];
}

// ---- delimited text → ONE table shape (docs/26 §6.1 V4) ----
//
// A CSV used to land as a grid of stickies, one per cell: a 20 × 5 sheet was
// 100 loose notes with no columns, and nothing a chart could bind to. It is a
// table now — a single shape the inspector can edit and chart.

/** Approximate glyph advance and cell padding of `.table-shape` (12 px text, 8 px side padding). */
const TABLE_CHAR_PX = 7;
const TABLE_CELL_PAD = 17;
const TABLE_ROW_PX = 25;

/**
 * A table shape's box, sized to its content so an import reads without a
 * resize: each column as wide as its longest text (within the renderer's
 * 240 px cell cap), one line per row — but capped, so a 500-row import doesn't
 * blanket the board. The shape scrolls inside.
 */
export function tableShapeSize(t: TableData): { width: number; height: number } {
  // The first 50 rows are a fair sample; measuring 500 × 26 cells buys nothing.
  const sample = t.rows.slice(0, 50);
  const width = t.columns.reduce((sum, c, i) => {
    const longest = Math.max(c.header.length, ...sample.map((r) => (r.cells[i] ?? "").length));
    return sum + Math.min(240 + TABLE_CELL_PAD, Math.max(56, longest * TABLE_CHAR_PX + TABLE_CELL_PAD));
  }, 0);
  return {
    width: Math.min(960, Math.max(200, Math.round(width))),
    height: Math.min(480, Math.max(64, (t.rows.length + 1) * TABLE_ROW_PX + 2)),
  };
}

export interface TableImport {
  op: Extract<Operation, { op: "CREATE_SHAPE" }>;
  /** Rows, columns or characters were dropped to fit the table limits. */
  truncated: boolean;
}

function tableImportOp(
  read: DelimitedRead,
  at: { x: number; y: number },
  z: number,
  anchor: "center" | "top-left",
): TableImport {
  const size = tableShapeSize(read.table);
  const position =
    anchor === "center"
      ? { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) }
      : { x: Math.round(at.x), y: Math.round(at.y) };
  return {
    op: { op: "CREATE_SHAPE", id: shapeId(), kind: "table", position, size, table: read.table, z },
    truncated: read.truncated,
  };
}

/**
 * A dropped .csv / .tsv file as one table shape, its top-left at `at`. The
 * file said what it is, so there is no sniffing: any content is a table.
 * Null when the file is empty.
 */
export function delimitedToTableOp(
  text: string,
  at: { x: number; y: number },
  z: number,
  delimiter?: string,
): TableImport | null {
  const read = readDelimited(text, delimiter);
  return read ? tableImportOp(read, at, z, "top-left") : null;
}

/**
 * Pasted text as a table shape centred on `at` — only when the text IS a grid
 * (a spreadsheet copy, a CSV snippet), per core's `sniffDelimited`. Null for
 * anything else, which then pastes as a note the way it always did.
 */
export function pastedTableOp(
  text: string,
  at: { x: number; y: number },
  z: number,
): TableImport | null {
  const read = sniffDelimited(text);
  return read ? tableImportOp(read, at, z, "center") : null;
}

/** What a truncated import says: the limits it was cut to. */
export const TABLE_TRIM_NOTE = `tables hold up to ${TABLE_LIMITS.rows} rows, ${TABLE_LIMITS.columns} columns and ${TABLE_LIMITS.totalChars.toLocaleString("en-US")} characters, so the rest was left out`;

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
