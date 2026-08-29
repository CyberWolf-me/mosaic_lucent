import type { Workspace, Operation } from "@lucent/core";

/**
 * Board serializers for import/export (docs/15 Phase B). Pure string <-> data
 * transforms so they are unit-testable without a DOM.
 */

/** Export the board as a Markdown outline: nodes, edges, and sticky/text notes. */
export function boardToMarkdown(ws: Workspace): string {
  const lines: string[] = [`# ${ws.name || "Lucent board"}`, ""];

  const nodes = Object.values(ws.nodes);
  if (nodes.length) {
    lines.push(`## Diagram (${ws.diagramKind})`, "");
    for (const n of nodes) lines.push(`- **${n.label}** _(${n.nodeType})_`);
    const edges = Object.values(ws.edges);
    if (edges.length) {
      lines.push("", "### Connections", "");
      for (const e of edges) {
        const s = ws.nodes[e.source]?.label ?? e.source;
        const t = ws.nodes[e.target]?.label ?? e.target;
        lines.push(`- ${s} → ${t} _(${e.relationship})_`);
      }
    }
  }

  const notes = Object.values(ws.shapes).filter(
    (s) => (s.kind === "sticky" || s.kind === "text") && s.text,
  );
  if (notes.length) {
    lines.push("", "## Notes", "");
    for (const s of notes) lines.push(`- ${s.text!.replace(/\n/g, " ")}`);
  }
  return lines.join("\n") + "\n";
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Export the board's nodes as CSV rows (id,type,label + outgoing edges). */
export function boardToCsv(ws: Workspace): string {
  const rows: string[] = ["id,type,label,connects_to"];
  for (const n of Object.values(ws.nodes)) {
    const targets = Object.values(ws.edges)
      .filter((e) => e.source === n.id)
      .map((e) => ws.nodes[e.target]?.label ?? e.target)
      .join("; ");
    rows.push([n.id, n.nodeType, n.label, targets].map(csvCell).join(","));
  }
  return rows.join("\n") + "\n";
}

/** Parse CSV text into a grid of sticky-note CREATE_SHAPE operations. */
export function csvToStickyOps(csv: string, startX = 80, startY = 80): Operation[] {
  const rows = parseCsv(csv);
  const ops: Operation[] = [];
  const cellW = 170;
  const cellH = 90;
  rows.forEach((cols, r) => {
    cols.forEach((value, c) => {
      const text = value.trim();
      if (!text) return;
      ops.push({
        op: "CREATE_SHAPE",
        id: `csv_${r}_${c}_${Date.now().toString(36)}`,
        kind: "sticky",
        position: { x: startX + c * (cellW + 16), y: startY + r * (cellH + 16) },
        size: { width: cellW, height: cellH },
        text,
        style: r === 0 ? { fill: "oklch(0.86 0.08 235)" } : { fill: "oklch(0.90 0.11 92)" },
        // Small integer band: a timestamp here overflows the CSS z-index range
        // and would paint these above the canvas tool overlays.
        z: 1,
      });
    });
  });
  return ops;
}

/** Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}
