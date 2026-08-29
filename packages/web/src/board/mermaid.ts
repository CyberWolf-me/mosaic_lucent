import type { Operation, Workspace } from "@lucent/core";

/**
 * Mermaid interop (docs/08 "basic integrations").
 *
 * Mermaid is the lingua franca for diagrams-as-text: GitHub, GitLab, Notion, and
 * Obsidian all render it inline. Exporting it means a Lucent board can be pasted
 * into a README or a ticket; importing it means an existing diagram in a repo can
 * be pulled onto the board as real semantic nodes.
 *
 * Both directions are pure string <-> operation transforms, so they are testable
 * without a DOM and reuse the same validated operation contract as everything else.
 */

/** Mermaid graph direction per diagram kind: trees read top-down, processes left-right. */
function mermaidDirection(kind: Workspace["diagramKind"]): "TD" | "LR" {
  return kind === "process" || kind === "journey" ? "LR" : "TD";
}

/** Mermaid node shape that matches the semantics of a node type. */
function shapeFor(nodeType: string, label: string): string {
  const t = nodeType.toLowerCase();
  const safe = label.replace(/["\n]/g, " ").trim();
  if (t === "decision" || t === "condition") return `{"${safe}"}`;
  if (t === "start" || t === "end") return `(["${safe}"])`;
  if (t === "database" || t === "cache") return `[("${safe}")]`;
  if (t === "actor" || t === "person" || t === "role") return `(("${safe}"))`;
  return `["${safe}"]`;
}

/** Mermaid ids must be identifier-safe; keep a stable mapping. */
function mermaidId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

/**
 * Export the semantic graph as a Mermaid flowchart, with groups as subgraphs.
 * Sticky notes and shapes are omitted: Mermaid has no equivalent, and inventing
 * nodes for them would make the round trip lossy in a confusing way.
 */
export function boardToMermaid(ws: Workspace): string {
  const nodes = Object.values(ws.nodes);
  if (nodes.length === 0) return "flowchart TD\n  %% empty board\n";

  const lines: string[] = [`flowchart ${mermaidDirection(ws.diagramKind)}`];
  const declared = new Set<string>();

  // Grouped nodes go inside a subgraph so the structure survives the export.
  for (const group of Object.values(ws.groups)) {
    const members = nodes.filter((n) => n.groupId === group.id);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${mermaidId(group.id)}["${group.label.replace(/"/g, "'")}"]`);
    for (const n of members) {
      lines.push(`    ${mermaidId(n.id)}${shapeFor(n.nodeType, n.label)}`);
      declared.add(n.id);
    }
    lines.push("  end");
  }

  for (const n of nodes) {
    if (declared.has(n.id)) continue;
    lines.push(`  ${mermaidId(n.id)}${shapeFor(n.nodeType, n.label)}`);
  }

  for (const e of Object.values(ws.edges)) {
    if (!ws.nodes[e.source] || !ws.nodes[e.target]) continue;
    const label = e.relationship.replace(/[|\n]/g, " ").trim();
    lines.push(`  ${mermaidId(e.source)} -->|${label}| ${mermaidId(e.target)}`);
  }

  return lines.join("\n") + "\n";
}

/** Node type inferred from the Mermaid bracket shape, so an import stays semantic. */
function typeForShape(open: string): string {
  if (open.startsWith("{")) return "decision";
  if (open.startsWith("([")) return "start";
  if (open.startsWith("[(")) return "database";
  if (open.startsWith("((")) return "actor";
  return "step";
}

const stripQuotes = (s: string) => s.replace(/^["']|["']$/g, "").trim();

interface ParsedMermaid {
  direction: "TD" | "LR";
  nodes: Array<{ id: string; label: string; nodeType: string; groupId?: string }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
  groups: Array<{ id: string; label: string }>;
}

/**
 * Parse a Mermaid flowchart into semantic pieces.
 *
 * Deliberately scoped to `flowchart`/`graph` syntax — the node shapes, labelled
 * arrows, and subgraphs that actually appear in READMEs. Anything it doesn't
 * recognize is skipped rather than guessed at, and the caller reports when
 * nothing was found.
 */
export function parseMermaid(text: string): ParsedMermaid {
  const nodes = new Map<
    string,
    { id: string; label: string; nodeType: string; groupId?: string }
  >();
  const edges: ParsedMermaid["edges"] = [];
  const groups: ParsedMermaid["groups"] = [];
  let direction: "TD" | "LR" = "TD";
  const groupStack: string[] = [];

  const declare = (id: string, label?: string, nodeType?: string) => {
    const existing = nodes.get(id);
    if (existing) {
      if (label) existing.label = label;
      if (nodeType && existing.nodeType === "step") existing.nodeType = nodeType;
      return;
    }
    nodes.set(id, {
      id,
      label: label ?? id,
      nodeType: nodeType ?? "step",
      ...(groupStack.length ? { groupId: groupStack[groupStack.length - 1]! } : {}),
    });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;

    const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(line);
    if (header) {
      const d = (header[1] ?? "TD").toUpperCase();
      direction = d === "LR" || d === "RL" ? "LR" : "TD";
      continue;
    }

    const subgraph = /^subgraph\s+([A-Za-z0-9_]+)\s*(?:\[(.+)\])?/.exec(line);
    if (subgraph) {
      const id = subgraph[1]!;
      groups.push({ id, label: stripQuotes(subgraph[2] ?? id) });
      groupStack.push(id);
      continue;
    }
    if (/^end$/i.test(line)) {
      groupStack.pop();
      continue;
    }

    // A --> B, A -->|label| B, A -- label --> B
    const edge =
      /^([A-Za-z0-9_]+)\s*(\{[^}]*\}|\(\[[^\]]*\]\)|\[\([^)]*\)\]|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\))?\s*-{2,3}>?\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)\s*(\{[^}]*\}|\(\[[^\]]*\]\)|\[\([^)]*\)\]|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\))?/.exec(
        line,
      );
    if (edge) {
      const [, sourceId, sourceShape, edgeLabel, targetId, targetShape] = edge;
      if (sourceShape) {
        declare(
          sourceId!,
          stripQuotes(sourceShape.slice(1, -1).replace(/^[[(]|[)\]]$/g, "")),
          typeForShape(sourceShape),
        );
      } else {
        declare(sourceId!);
      }
      if (targetShape) {
        declare(
          targetId!,
          stripQuotes(targetShape.slice(1, -1).replace(/^[[(]|[)\]]$/g, "")),
          typeForShape(targetShape),
        );
      } else {
        declare(targetId!);
      }
      edges.push({
        source: sourceId!,
        target: targetId!,
        relationship: (edgeLabel ?? "").trim() || "next",
      });
      continue;
    }

    // A standalone declaration: A["Label"] / A{Decision} / A(Rounded)
    const decl =
      /^([A-Za-z0-9_]+)\s*(\{[^}]*\}|\(\[[^\]]*\]\)|\[\([^)]*\)\]|\(\([^)]*\)\)|\[[^\]]*\]|\([^)]*\))\s*$/.exec(
        line,
      );
    if (decl) {
      const shape = decl[2]!;
      declare(
        decl[1]!,
        stripQuotes(shape.slice(1, -1).replace(/^[[(]|[)\]]$/g, "")),
        typeForShape(shape),
      );
    }
  }

  return { direction, nodes: [...nodes.values()], edges, groups };
}

/**
 * Convert Mermaid text into operations. Groups are declared before the nodes
 * that reference them, and edges last, so the batch passes validation in order.
 */
export function mermaidToOps(text: string): Operation[] {
  const parsed = parseMermaid(text);
  if (parsed.nodes.length === 0) return [];

  const usedGroups = new Set(parsed.nodes.map((n) => n.groupId).filter(Boolean) as string[]);

  return [
    // LR reads as a process map; TD as a flowchart.
    { op: "CREATE_DIAGRAM", kind: parsed.direction === "LR" ? "process" : "flowchart" },
    ...parsed.groups
      .filter((g) => usedGroups.has(g.id))
      .map((g) => ({ op: "CREATE_GROUP" as const, id: g.id, label: g.label, children: [] })),
    ...parsed.nodes.map((n) => ({
      op: "CREATE_NODE" as const,
      id: n.id,
      nodeType: n.nodeType,
      label: n.label,
      ...(n.groupId ? { groupId: n.groupId } : {}),
    })),
    ...parsed.edges.map((e) => ({
      op: "CONNECT_NODES" as const,
      source: e.source,
      target: e.target,
      relationship: e.relationship,
    })),
  ];
}
