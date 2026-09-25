import type { Node, Workspace } from "@lucent/core";

/**
 * Derive an entity-relationship model from the semantic graph (docs/15 Phase D).
 * Nodes become entities; each entity's attributes come from its details (V4 —
 * the columns the model lists, "id PK", "user_id FK"), or, on a node without
 * details, are inferred from its metadata plus a synthetic id. Edges become
 * relationships with simple cardinality guessed from fan-out. Pure and
 * unit-testable.
 */
export interface ErAttribute {
  name: string;
  key?: boolean;
}
export interface ErEntity {
  id: string;
  label: string;
  attributes: ErAttribute[];
}
export interface ErRelationship {
  source: string;
  target: string;
  label: string;
  cardinality: string;
}
export interface ErModel {
  entities: ErEntity[];
  relationships: ErRelationship[];
}

/** A primary-key marker in a column line: "id PK", "id (pk)", "id primary key". */
const PRIMARY_KEY = /(?:^|[\s([])(?:pk|primary\s+key)(?=$|[\s)\]])/i;

/**
 * The column lines of an entity's details: the first section titled Columns
 * or Attributes when there is one (an entity may also carry, say, an
 * "Indexes" section that is not columns), otherwise every item of every
 * section — details written without headings are still a column list.
 */
export function detailColumns(node: Pick<Node, "details">): string[] | null {
  const sections = node.details?.sections;
  if (!sections || sections.length === 0) return null;
  const titled = sections.find((s) => /^(columns|attributes)$/i.test(s.title?.trim() ?? ""));
  const items = titled ? titled.items : sections.flatMap((s) => s.items);
  return items.filter((i) => i.trim().length > 0);
}

/**
 * One column line as an attribute. The PK marker becomes the key flag (the
 * lens draws it as a key), so "id PK" reads "id"; everything else — types, FK
 * markers — is the column's own text and stays.
 */
function columnAttribute(line: string): ErAttribute {
  if (!PRIMARY_KEY.test(line)) return { name: line.trim() };
  const name = line
    .replace(/[([]\s*(?:pk|primary\s+key)\s*[)\]]/gi, " ")
    .replace(/(^|\s)(?:pk|primary\s+key)(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name: name || line.trim(), key: true };
}

export function toEr(ws: Workspace): ErModel {
  const nodes = Object.values(ws.nodes);
  const edges = Object.values(ws.edges);

  // Fan-out per source: a source with multiple targets implies "1..*".
  const outCount = new Map<string, number>();
  for (const e of edges) outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);

  const entities: ErEntity[] = nodes.map((n) => {
    const columns = detailColumns(n);
    if (columns && columns.length > 0) {
      // Details are what the entity says it has — no synthetic id on top.
      return { id: n.id, label: n.label, attributes: columns.map(columnAttribute) };
    }
    const meta = n.metadata ?? {};
    const metaAttrs = Object.keys(meta).map((k) => ({ name: k }));
    return {
      id: n.id,
      label: n.label,
      attributes: [{ name: "id", key: true }, ...metaAttrs],
    };
  });

  const relationships: ErRelationship[] = edges.map((e) => ({
    source: e.source,
    target: e.target,
    label: e.relationship,
    cardinality: (outCount.get(e.source) ?? 1) > 1 ? "1..*" : "1..1",
  }));

  return { entities, relationships };
}
