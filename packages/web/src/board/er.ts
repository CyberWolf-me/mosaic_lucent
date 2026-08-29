import type { Workspace } from "@lucent/core";

/**
 * Derive an entity-relationship model from the semantic graph (docs/15 Phase D).
 * Nodes become entities; each entity's attributes are inferred from its
 * metadata (if present) plus a synthetic id. Edges become relationships with
 * simple cardinality guessed from fan-out. Pure and unit-testable.
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

export function toEr(ws: Workspace): ErModel {
  const nodes = Object.values(ws.nodes);
  const edges = Object.values(ws.edges);

  // Fan-out per source: a source with multiple targets implies "1..*".
  const outCount = new Map<string, number>();
  for (const e of edges) outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1);

  const entities: ErEntity[] = nodes.map((n) => {
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
