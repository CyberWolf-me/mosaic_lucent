import type { Workspace } from "@lucent/core";

/**
 * Selection focus (P1, docs/15 M3.1): the pure half of "selected + related
 * objects highlighted, everything else subdued."
 *
 * Pure on purpose — the helper is the testable contract; the render layer
 * only decides what opacity an id gets. No data changes, no layout changes,
 * no AI changes: the focus set is derived per render from the graph.
 */
export interface FocusSet {
  /** The selected node itself. */
  selected: string;
  /** Everything prominent: the selected node plus its direct neighbours. */
  prominent: ReadonlySet<string>;
}

/**
 * The ids that stay at full strength when `selectedId` is focused: the node
 * itself and every node sharing an edge with it (either direction — a
 * relationship is symmetric for reading purposes). Null when there is no
 * selection (nothing is subdued).
 */
export function focusSet(workspace: Workspace, selectedId: string | null): FocusSet | null {
  if (!selectedId || !workspace.nodes[selectedId]) return null;
  const prominent = new Set<string>([selectedId]);
  for (const edge of Object.values(workspace.edges)) {
    if (edge.source === selectedId) prominent.add(edge.target);
    if (edge.target === selectedId) prominent.add(edge.source);
  }
  return { selected: selectedId, prominent };
}

/**
 * The render decision for a NODE: full strength when prominent, softly
 * subdued otherwise (visibly present, clearly secondary). Edges are graded
 * by endpoint prominence via focusEdgeOpacity — an edge's own id is not in
 * the prominence set, which holds node ids.
 */
export function focusOpacity(focus: FocusSet | null, nodeId: string): number {
  if (!focus) return 1;
  return focus.prominent.has(nodeId) ? 1 : 0.35;
}

/**
 * The render decision for an EDGE: fully drawn when either endpoint is
 * prominent — the selected node's relationships must stay readable — and
 * deeply subdued when both endpoints sit outside the focus set, so the
 * focused neighbourhood visually dominates.
 */
export function focusEdgeOpacity(
  focus: FocusSet | null,
  sourceId: string,
  targetId: string,
): number {
  if (!focus) return 1;
  return focus.prominent.has(sourceId) || focus.prominent.has(targetId) ? 1 : 0.15;
}
