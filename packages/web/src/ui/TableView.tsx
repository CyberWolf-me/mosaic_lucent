import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { setTableCell, TABLE_LIMITS, tableChars, type Shape, type TableData } from "@lucent/core";
import { useWorkspaceOptional } from "../workspace.js";

/** A cell address; `row` -1 is the header row. */
export interface TableCell {
  row: number;
  col: number;
}

// ---- The table cursor: the last cell touched in each table ----------------
//
// The inspector's row/column controls act on it ("delete THIS row", "add a
// column right of this one"). The table on the canvas and the inspector beside
// it are rendered far apart, so the cursor lives in a tiny store keyed by
// shape id rather than being threaded through CanvasView as props.

const cursors = new Map<string, TableCell>();
const cursorListeners = new Set<() => void>();

function subscribeCursor(cb: () => void): () => void {
  cursorListeners.add(cb);
  return () => cursorListeners.delete(cb);
}

/** Set (or clear, with null) the cursor of a table shape. */
export function setTableCursor(shapeId: string, cell: TableCell | null): void {
  const prev = cursors.get(shapeId);
  if (cell ? prev?.row === cell.row && prev.col === cell.col : !prev) return;
  if (cell) cursors.set(shapeId, cell);
  else cursors.delete(shapeId);
  for (const l of cursorListeners) l();
}

/** The cursor of a table shape, re-rendering when it moves. */
export function useTableCursor(shapeId: string | undefined): TableCell | null {
  return useSyncExternalStore(subscribeCursor, () =>
    shapeId ? (cursors.get(shapeId) ?? null) : null,
  );
}

const valueAt = (t: TableData, c: TableCell): string =>
  c.row === -1 ? (t.columns[c.col]?.header ?? "") : (t.rows[c.row]?.cells[c.col] ?? "");

/** The cell Tab (dir 1) or Shift+Tab (dir -1) moves to: across, then down; null past either end. */
export function nextTableCell(t: TableData, cell: TableCell, dir: 1 | -1): TableCell | null {
  const w = t.columns.length;
  const flat = (cell.row + 1) * w + cell.col + dir;
  if (flat < 0 || flat >= (t.rows.length + 1) * w) return null;
  return { row: Math.floor(flat / w) - 1, col: flat % w };
}

/**
 * The shape this table belongs to. The host should pass `shapeId`; until it
 * does, the shape whose `table` IS this object is used — but only when exactly
 * one shape holds it (a duplicate shares the object until one is edited), so
 * an edit can never land on the wrong copy. Unresolved means read-only.
 */
function useOwningShape(table: TableData, shapeId: string | undefined): Shape | null {
  const ws = useWorkspaceOptional();
  const shapes = ws?.workspace.shapes;
  return useMemo(() => {
    if (!shapes) return null;
    if (shapeId) return shapes[shapeId] ?? null;
    let found: Shape | null = null;
    for (const s of Object.values(shapes)) {
      if (s.table !== table) continue;
      if (found) return null;
      found = s;
    }
    return found;
  }, [shapes, shapeId, table]);
}

const editorStyle: React.CSSProperties = {
  font: "inherit",
  color: "inherit",
  background: "transparent",
  border: "none",
  outline: "none",
  padding: 0,
  margin: 0,
  width: "100%",
  minWidth: 48,
  textAlign: "inherit",
};

const CURSOR_RING = "inset 0 0 0 2px var(--bloom-2, #6b8cff)";

/**
 * Renders a `table` shape's data as an HTML table (docs/26 §6.1). The data is
 * plain strings, set as text nodes — never markup — so a cell can only ever
 * show text. Columns come from `table.columns`; each row is padded or clipped
 * to the column count so a ragged row never breaks the grid.
 *
 * Double-click a cell or header to edit it in place: Enter or leaving the
 * field commits, Escape cancels, Tab / Shift+Tab commit and move to the next /
 * previous cell. Each commit is one `UPDATE_SHAPE { id, table }` through
 * `applyManual` — validated, undoable and shared like any manual edit — so a
 * locked shape or a read-only board refuses it the same way it refuses a
 * move. Typing stops at the per-field cap and at what the table-wide
 * character cap leaves, so a commit never builds a table the schema rejects.
 */
export function TableView({ table, shapeId }: { table: TableData; shapeId?: string }) {
  const ws = useWorkspaceOptional();
  const shape = useOwningShape(table, shapeId);
  const id = shape?.id;
  const editable = Boolean(ws && shape && !ws.readOnly && !shape.locked);
  const cursor = useTableCursor(id);
  const [editing, setEditing] = useState<TableCell | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set while the editor is being closed or moved on purpose, so the blur
  // that follows doesn't commit a second time; the next editor's focus clears it.
  const leaving = useRef(false);

  // Locked or made read-only mid-edit (by a collaborator, a role change): the
  // draft can't be saved, so the editor closes rather than pretending.
  useEffect(() => {
    if (!editable) setEditing(null);
  }, [editable]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const used = useMemo(() => (editing ? tableChars(table) : 0), [editing, table]);

  const width = table.columns.length;
  const align = (i: number): "left" | "center" | "right" => table.columns[i]?.align ?? "left";

  const open = (cell: TableCell, from: TableData = table) => {
    if (!editable || !id) return;
    setEditing(cell);
    setDraft(valueAt(from, cell));
    setError(null);
    setTableCursor(id, cell);
  };

  const close = () => {
    leaving.current = true;
    setEditing(null);
  };

  /** Save the draft. The table after it (Tab reads the next cell from it), or null when refused. */
  const commit = (): TableData | null => {
    if (!editing || !ws || !id) return null;
    if (draft === valueAt(table, editing)) return table;
    const edit = setTableCell(table, editing.row, editing.col, draft);
    if (!edit.ok) {
      setError(edit.error);
      return null;
    }
    const label = editing.row === -1 ? "Edit table header" : "Edit table cell";
    if (!ws.applyManual([{ op: "UPDATE_SHAPE", id, table: edit.table }], label)) {
      setError("That edit couldn't be saved — the table may be locked or read-only.");
      return null;
    }
    return edit.table;
  };

  const editor = (cell: TableCell) => {
    const cap = cell.row === -1 ? TABLE_LIMITS.headerChars : TABLE_LIMITS.cellChars;
    // What the table-wide cap leaves for this field, the field's own text included.
    const room = TABLE_LIMITS.totalChars - (used - valueAt(table, cell).length);
    return (
      <input
        autoFocus
        aria-label={
          cell.row === -1
            ? `Column ${cell.col + 1} header`
            : `Row ${cell.row + 1}, column ${cell.col + 1}`
        }
        value={draft}
        maxLength={Math.max(0, Math.min(cap, room))}
        size={Math.max(1, Math.min(40, draft.length + 1))}
        style={editorStyle}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          leaving.current = false;
        }}
        onBlur={() => {
          if (leaving.current) return;
          commit();
          close();
        }}
        onKeyDown={(e) => {
          // The canvas's shortcuts (delete, nudge, tools) must not see typing.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            if (commit()) close();
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const after = commit();
            if (!after) return;
            const next = nextTableCell(after, cell, e.shiftKey ? -1 : 1);
            leaving.current = true;
            if (next) open(next, after);
            else close();
          }
        }}
        // Keep the gesture in the field: without these the shape underneath
        // would start a drag, or a double-click would reach the canvas.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  };

  const cellProps = (cell: TableCell) => {
    const isEditing = editing?.row === cell.row && editing.col === cell.col;
    const isCursor = cursor?.row === cell.row && cursor.col === cell.col;
    return {
      isEditing,
      style: {
        textAlign: align(cell.col),
        ...(isEditing || isCursor ? { boxShadow: CURSOR_RING } : {}),
      } as React.CSSProperties,
      ...(editable
        ? {
            onClick: () => id && setTableCursor(id, cell),
            onDoubleClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              open(cell);
            },
          }
        : {}),
    };
  };

  return (
    <div className="table-shape-scroll">
      {error && (
        <div
          role="alert"
          style={{
            padding: "4px 8px",
            fontSize: 11,
            color: "oklch(0.72 0.15 25)",
            background: "var(--surface-2, #2a2a30)",
          }}
        >
          {error}
        </div>
      )}
      <table className="table-shape">
        <thead>
          <tr>
            {table.columns.map((c, i) => {
              const { isEditing, ...props } = cellProps({ row: -1, col: i });
              return (
                <th key={i} {...props}>
                  {isEditing ? editor({ row: -1, col: i }) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: width }, (_, i) => {
                const { isEditing, ...props } = cellProps({ row: r, col: i });
                return (
                  <td key={i} {...props}>
                    {isEditing ? editor({ row: r, col: i }) : (row.cells[i] ?? "")}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
