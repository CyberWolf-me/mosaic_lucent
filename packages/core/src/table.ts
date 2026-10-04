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
  const columns: TableColumn[] = headers.slice(0, TABLE_LIMITS.columns).map((header, i) => ({
    header: header.slice(0, TABLE_LIMITS.headerChars),
    ...(aligns[i] ? { align: aligns[i] } : {}),
  }));
  return {
    columns: columns.length ? columns : [{ header: "" }],
    rows: rows.slice(0, TABLE_LIMITS.rows).map((r) => ({
      cells: r
        .slice(0, TABLE_LIMITS.columns)
        .map((c) => String(c).slice(0, TABLE_LIMITS.cellChars)),
    })),
  };
}

/** Line endings unified and trailing blank lines dropped — every reader's first step. */
function normalizeDelimited(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Tab if the first line has more tabs than commas, else comma. */
function detectDelimiter(src: string): string {
  const nl = src.indexOf("\n");
  const firstLine = nl === -1 ? src : src.slice(0, nl);
  return (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
}

/**
 * Split normalized text into records of raw fields (RFC 4180: quoted fields may
 * hold the delimiter, doubled quotes and newlines). Fields are NOT trimmed —
 * the paste sniffer reads the space after a comma as a sign of prose.
 */
function splitRecords(src: string, delim: string): string[][] {
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
  return records;
}

/** A delimited read, with what had to go to fit the table limits. */
export interface DelimitedRead {
  table: TableData;
  /** The delimiter the text was split on. */
  delimiter: string;
  /**
   * True when rows, columns or characters were dropped to fit TABLE_LIMITS —
   * so the caller can say so rather than import a silently shorter table.
   */
  truncated: boolean;
}

/**
 * Read delimited text (CSV or TSV) into a table that fits every limit, the
 * total-character cap included: rows past it are dropped from the end, so the
 * result always passes `tableDataSchema` and a big file lands as its first
 * part instead of an operation the validator refuses. The first row is the
 * header row. The delimiter is auto-detected unless one is given. Null when
 * there is no content.
 */
export function readDelimited(text: string, delimiter?: string): DelimitedRead | null {
  const src = normalizeDelimited(text);
  if (!src.trim()) return null;
  const delim = delimiter ?? detectDelimiter(src);
  const records = splitRecords(src, delim);
  const headers = records[0]!.map((h) => h.trim());
  const rows = records.slice(1);
  let truncated =
    headers.length > TABLE_LIMITS.columns ||
    headers.some((h) => h.length > TABLE_LIMITS.headerChars) ||
    rows.length > TABLE_LIMITS.rows ||
    rows.some(
      (r) => r.length > TABLE_LIMITS.columns || r.some((c) => c.length > TABLE_LIMITS.cellChars),
    );
  const table = createTable(headers, rows);
  let total = tableChars(table);
  let keep = table.rows.length;
  while (total > TABLE_LIMITS.totalChars && keep > 0) {
    keep--;
    for (const cell of table.rows[keep]!.cells) total -= cell.length;
  }
  if (keep < table.rows.length) {
    table.rows = table.rows.slice(0, keep);
    truncated = true;
  }
  return { table, delimiter: delim, truncated };
}

/**
 * Parse delimited text (CSV or TSV) into a table. The first row is taken as the
 * header row. Handles quoted fields with embedded delimiters, quotes ("") and
 * newlines, per RFC 4180. The delimiter is auto-detected (tab if the first line
 * has more tabs than commas, else comma) unless one is given. Returns null when
 * there is no parseable content. See `readDelimited` for what was dropped.
 */
export function parseDelimited(text: string, delimiter?: string): TableData | null {
  return readDelimited(text, delimiter)?.table ?? null;
}

/** A cell that reads as a number: "1,234", "$42", "87%", "-3.5". */
function looksNumeric(cell: string | undefined): boolean {
  const s = (cell ?? "").replace(/[,$£€%\s]/g, "");
  return s !== "" && Number.isFinite(Number(s));
}

/**
 * The paste sniffer: `readDelimited` for text that IS a grid — a spreadsheet
 * copy, a CSV snippet — and null for text that merely contains a delimiter.
 * Pasting "Hi Bob, how are you?" must stay a note, so the bar is deliberately
 * high:
 *
 * - at least two lines, and every line splits into the same number (≥ 2) of
 *   fields — prose doesn't keep a constant comma count, a grid does;
 * - no column is blank on every line — leading tabs are indentation and a
 *   trailing comma is punctuation, not a column;
 * - no line ends like code (`;`, `{`, `}`), which a pasted call list would.
 *
 * Tabs rarely occur in prose, so a tab grid passing those is a table. Commas
 * need more: most lines must not end like a sentence (`.`, `!`, `?`), and a
 * two-column grid whose every comma is followed by a space ("Smith, John") —
 * the shape of prose — counts only when a column is numeric ("Apples, 3").
 */
export function sniffDelimited(text: string): DelimitedRead | null {
  const src = normalizeDelimited(text);
  if (!src.includes("\n")) return null;
  for (const delim of ["\t", ","]) {
    if (!src.includes(delim)) continue;
    const records = splitRecords(src, delim);
    const k = records[0]!.length;
    if (records.length < 2 || k < 2 || records.some((r) => r.length !== k)) continue;
    const blankColumn = Array.from({ length: k }, (_, c) => c).some((c) =>
      records.every((r) => !r[c]!.trim()),
    );
    if (blankColumn) continue;
    const ends = records.map((r) => r[k - 1]!.trim().slice(-1));
    if (ends.some((ch) => ch === ";" || ch === "{" || ch === "}")) continue;
    if (delim === ",") {
      const sentenceEnds = ends.filter((ch) => ch === "." || ch === "!" || ch === "?").length;
      if (sentenceEnds * 2 > records.length) continue;
      const spaced = records.every((r) => r.slice(1).every((f) => /^\s/.test(f)));
      const data = records.slice(1);
      const numericColumn = Array.from({ length: k }, (_, c) => c).some((c) =>
        data.every((r) => looksNumeric(r[c])),
      );
      if (k === 2 && spaced && !numericColumn) continue;
    }
    return readDelimited(src, delim);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Edits. Each returns the NEXT table (tables are immutable board data, applied
// as UPDATE_SHAPE { table }) or the reason it can't be made — so a control can
// refuse with a message instead of emitting an operation the schema rejects.
// ---------------------------------------------------------------------------

export type TableEdit = { ok: true; table: TableData } | { ok: false; error: string };

function withinTotal(table: TableData): TableEdit {
  return tableChars(table) <= TABLE_LIMITS.totalChars
    ? { ok: true, table }
    : {
        ok: false,
        error: `A table holds at most ${TABLE_LIMITS.totalChars.toLocaleString("en-US")} characters.`,
      };
}

/** A row's cells padded to `width` — the grid the renderer shows. */
function padCells(cells: string[], width: number): string[] {
  return Array.from({ length: Math.max(width, cells.length) }, (_, i) => cells[i] ?? "");
}

/**
 * Set one cell; `row` -1 is the header row. The text is clipped to the
 * per-field cap; the table-wide cap is refused, not clipped, since clipping
 * someone else's cell to make room would lose data.
 */
export function setTableCell(t: TableData, row: number, col: number, value: string): TableEdit {
  if (!Number.isInteger(col) || col < 0 || col >= t.columns.length) {
    return { ok: false, error: "That column no longer exists." };
  }
  if (row === -1) {
    const header = value.slice(0, TABLE_LIMITS.headerChars);
    return withinTotal({
      columns: t.columns.map((c, i) => (i === col ? { ...c, header } : c)),
      rows: t.rows,
    });
  }
  if (!Number.isInteger(row) || row < 0 || row >= t.rows.length) {
    return { ok: false, error: "That row no longer exists." };
  }
  const cell = value.slice(0, TABLE_LIMITS.cellChars);
  return withinTotal({
    columns: t.columns,
    rows: t.rows.map((r, i) => {
      if (i !== row) return r;
      const cells = padCells(r.cells, t.columns.length);
      cells[col] = cell;
      return { cells };
    }),
  });
}

const clampIndex = (i: number, max: number) => Math.min(Math.max(0, Math.floor(i)), max);

/** Insert an empty row at `at` (default: the end). */
export function insertTableRow(t: TableData, at = t.rows.length): TableEdit {
  if (t.rows.length >= TABLE_LIMITS.rows) {
    return { ok: false, error: `A table holds at most ${TABLE_LIMITS.rows} rows.` };
  }
  const i = clampIndex(at, t.rows.length);
  const blank = { cells: t.columns.map(() => "") };
  return {
    ok: true,
    table: { columns: t.columns, rows: [...t.rows.slice(0, i), blank, ...t.rows.slice(i)] },
  };
}

/** Delete row `index`. A table may have no body rows; the header stays. */
export function deleteTableRow(t: TableData, index: number): TableEdit {
  if (!Number.isInteger(index) || index < 0 || index >= t.rows.length) {
    return { ok: false, error: "That row no longer exists." };
  }
  return { ok: true, table: { columns: t.columns, rows: t.rows.filter((_, i) => i !== index) } };
}

/** "Column N", bumped past any header already using the name. */
function freshColumnName(t: TableData): string {
  const taken = new Set(t.columns.map((c) => c.header));
  let n = t.columns.length + 1;
  while (taken.has(`Column ${n}`)) n++;
  return `Column ${n}`;
}

/** Insert an empty column at `at` (default: the end). */
export function insertTableColumn(t: TableData, at = t.columns.length, header?: string): TableEdit {
  const width = t.columns.length;
  if (width >= TABLE_LIMITS.columns) {
    return { ok: false, error: `A table holds at most ${TABLE_LIMITS.columns} columns.` };
  }
  const i = clampIndex(at, width);
  const column: TableColumn = {
    header: (header ?? freshColumnName(t)).slice(0, TABLE_LIMITS.headerChars),
  };
  return withinTotal({
    columns: [...t.columns.slice(0, i), column, ...t.columns.slice(i)],
    rows: t.rows.map((r) => {
      // Pad first, so a short (ragged) row's later cells shift with their column.
      const cells = padCells(r.cells, width);
      cells.splice(i, 0, "");
      return { cells: cells.slice(0, TABLE_LIMITS.columns) };
    }),
  });
}

/** Delete column `index`. The schema needs one column, so the last one stays. */
export function deleteTableColumn(t: TableData, index: number): TableEdit {
  if (t.columns.length <= 1) return { ok: false, error: "A table keeps at least one column." };
  if (!Number.isInteger(index) || index < 0 || index >= t.columns.length) {
    return { ok: false, error: "That column no longer exists." };
  }
  return {
    ok: true,
    table: {
      columns: t.columns.filter((_, i) => i !== index),
      rows: t.rows.map((r) => ({ cells: r.cells.filter((_, i) => i !== index) })),
    },
  };
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
