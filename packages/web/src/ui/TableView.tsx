import type { TableData } from "@lucent/core";

/**
 * Renders a `table` shape's data as an HTML table (docs/26 §6.1). The data is
 * plain strings, set as text nodes — never markup — so a cell can only ever
 * show text. Columns come from `table.columns`; each row is padded or clipped
 * to the column count so a ragged row never breaks the grid.
 */
export function TableView({ table }: { table: TableData }) {
  const width = table.columns.length;
  const align = (i: number): "left" | "center" | "right" =>
    table.columns[i]?.align ?? "left";
  return (
    <div className="table-shape-scroll">
      <table className="table-shape">
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} style={{ textAlign: align(i) }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {Array.from({ length: width }, (_, i) => (
                <td key={i} style={{ textAlign: align(i) }}>
                  {row.cells[i] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
