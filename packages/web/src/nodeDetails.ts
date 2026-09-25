import { clampNodeDetails, type NodeDetails, type Operation } from "@lucent/core";

/**
 * The node inspector's details editor, as pure text <-> structure helpers
 * (V4 compartments). One textarea is the whole editor: `## Title` starts a
 * section, every other non-blank line is an item. Plain text because a UML
 * member list or a column list is typed, pasted and reordered as lines — a
 * row-per-item form would make the common edit ("add three columns") slow.
 *
 * Kept free of React so the round trip is node-testable: formatting a node's
 * details and parsing the text back yields the same details.
 */

/**
 * Text → details. Blank lines are ignored; lines before the first heading
 * form an untitled section; a bare `##` starts an untitled section (how an
 * untitled compartment after the first stays separate). The result is
 * clamped to NODE_DETAILS_LIMITS, so it always validates; null means the
 * text holds nothing — which SET_NODE_DETAILS spells "clear".
 */
export function parseDetailsText(text: string): NodeDetails | null {
  const sections: NodeDetails["sections"] = [];
  let current: NodeDetails["sections"][number] | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^##(?!#)\s*(.*)$/.exec(line);
    if (heading) {
      const title = heading[1]!.trim();
      current = { ...(title ? { title } : {}), items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { items: [] };
      sections.push(current);
    }
    current.items.push(line);
  }
  return clampNodeDetails(sections);
}

/** Details → the editor's text; the inverse of parseDetailsText. */
export function formatDetailsText(details: NodeDetails | null | undefined): string {
  if (!details) return "";
  return details.sections
    .map((s, i) => {
      const head = s.title ? [`## ${s.title}`] : i > 0 ? ["##"] : [];
      return [...head, ...s.items].join("\n");
    })
    .join("\n\n");
}

const same = (a: NodeDetails | null | undefined, b: NodeDetails | null | undefined) =>
  formatDetailsText(a) === formatDetailsText(b);

/**
 * The operations one blur of the editor means: nothing when the text says
 * what the node already has (focus in and out is not an edit, and must not
 * land an undo step), otherwise one SET_NODE_DETAILS — null when the text was
 * cleared.
 */
export function detailsEditOps(
  nodeId: string,
  prior: NodeDetails | null | undefined,
  text: string,
): Operation[] {
  if (text === formatDetailsText(prior)) return [];
  const details = parseDetailsText(text);
  if (same(details, prior)) return [];
  return [{ op: "SET_NODE_DETAILS", id: nodeId, details }];
}

/**
 * A hint of what details mean for this kind of node, shown in the empty
 * editor — the three families whose notation has compartments, then a
 * general one.
 */
export function detailsPlaceholder(nodeType: string): string {
  const t = nodeType.toLowerCase();
  if (t === "entity" || t === "table") return "## Columns\nid PK\nemail\nuser_id FK";
  if (t === "class" || t === "abstract" || t === "interface" || t === "enum")
    return "## Attributes\n+id: UUID\n## Operations\n+save(): void";
  if (["person", "system", "external_system", "container", "database", "component"].includes(t))
    return "[Technology]\nWhat it is responsible for";
  return "## Title\nOne line per item";
}
