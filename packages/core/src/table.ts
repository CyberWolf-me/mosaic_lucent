import * as z from "zod/v4";

/**
 * The `table` object kind (docs/26 §6.1 V4). A structured grid of text —
 * columns with headers and rows of cells — carried on a shape's `table` field,
 * the same way an editable vector rides `shape.vector`. It is DATA, never
 * markup: the renderer builds an HTML/SVG table from it, so nothing a cell
 * contains can escape into the DOM as an element.
 *
 * A table is also the natural landing place for "extract this into a table"
 * and the input a data chart binds to, so the delimited-text parser here is
 * shared: CSV/TSV in, a validated `TableData` out.
 */

export type TableAlign = "left" | "center" | "right";

export interface TableColumn {
  header: string;
  align?: TableAlign;
}

export interface TableRow {
  /** One string per column; short rows are padded and long rows clipped by the renderer. */
  cells: string[];
}

export interface TableData {
  columns: TableColumn[];
  rows: TableRow[];
}

export const TABLE_LIMITS = {
  columns: 26,
  rows: 500,
  cellChars: 2_000,
  headerChars: 200,
  /**
   * Every header and cell together. The per-field caps alone allowed a
   * 26 × 500 × 2,000-character table — a single 26 MB operation in the op log,
   * replayed to every peer. 200k matches the vector object's total cap: a big
   * spreadsheet belongs in an attached file, not on the board.
   */
  totalChars: 200_000,
} as const;

/** Characters a table carries in headers and cells — what `totalChars` caps. */
export function tableChars(data: TableData): number {
  let n = 0;
  for (const c of data.columns) n += c.header.length;
  for (const r of data.rows) for (const cell of r.cells) n += cell.length;
  return n;
}

const tableColumnSchema = z.object({
  header: z.string().max(TABLE_LIMITS.headerChars),
  align: z.enum(["left", "center", "right"]).optional(),
});

export const tableDataSchema = z
  .object({
    columns: z.array(tableColumnSchema).min(1).max(TABLE_LIMITS.columns),
    rows: z
      .array(
        z.object({
          cells: z.array(z.string().max(TABLE_LIMITS.cellChars)).max(TABLE_LIMITS.columns),
        }),
      )
      .max(TABLE_LIMITS.rows),
  })
  .refine((t) => tableChars(t) <= TABLE_LIMITS.totalChars, {
    message: `a table holds at most ${TABLE_LIMITS.totalChars} characters in total`,
  });

/** Build a `TableData` from plain headers and rows, clamped to the limits. */
export function createTable(
  headers: string[],
  rows: string[][] = [],
  aligns: (TableAlign | undefined)[] = [],
): TableData {
  const columns: TableColumn[] = headers
    .slice(0, TABLE_LIMITS.columns)
    .map((header, i) => ({
      header: header.slice(0, TABLE_LIMITS.headerChars),
      ...(aligns[i] ? { align: aligns[i] } : {}),
    }));
  return {
    columns: columns.length ? columns : [{ header: "" }],
    rows: rows.slice(0, TABLE_LIMITS.rows).map((r) => ({
      cells: r.slice(0, TABLE_LIMITS.columns).map((c) => String(c).slice(0, TABLE_LIMITS.cellChars)),
    })),
  };
}

/**
 * Parse delimited text (CSV or TSV) into a table. The first row is taken as the
 * header row. Handles quoted fields with embedded delimiters, quotes ("") and
 * newlines, per RFC 4180. The delimiter is auto-detected (tab if the first line
 * has more tabs than commas, else comma) unless one is given. Returns null when
 * there is no parseable content.
 */
export function parseDelimited(text: string, delimiter?: string): TableData | null {
  const src = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!src.trim()) return null;
  const firstLine = src.slice(0, src.indexOf("\n") === -1 ? src.length : src.indexOf("\n"));
  const delim =
    delimiter ??
    ((firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",");

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  record.push(field);
  records.push(record);

  if (records.length === 0) return null;
  const headers = records[0]!.map((h) => h.trim());
  const rows = records.slice(1).map((r) => r.map((c) => c));
  return createTable(headers, rows);
}

/** GitHub-flavoured Markdown for a table — used by serialization/export. */
export function tableToMarkdown(t: TableData): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const width = t.columns.length;
  const header = `| ${t.columns.map((c) => esc(c.header)).join(" | ")} |`;
  const rule = `| ${t.columns
    .map((c) => (c.align === "center" ? ":---:" : c.align === "right" ? "---:" : "---"))
    .join(" | ")} |`;
  const body = t.rows
    .map((r) => {
      const cells = Array.from({ length: width }, (_, i) => esc(r.cells[i] ?? ""));
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  return body ? `${header}\n${rule}\n${body}` : `${header}\n${rule}`;
}
