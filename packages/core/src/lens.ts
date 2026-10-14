import type { Workspace, StatementKind, StatementStatus, Node, Edge } from "./model.js";

export interface SemanticLensQuery {
  /** Filter by statement kind, status, or topic */
  statement?: {
    kind?: StatementKind | StatementKind[];
    status?: StatementStatus | StatementStatus[];
    topic?: string;
  };
  /** Filter by issue execution status, priority, or assignee */
  issue?: {
    statusCategory?: "todo" | "in_progress" | "done";
    priority?: string;
    assignee?: string;
  };
  /** Filter by group membership or region */
  groupId?: string | string[];
  /** Filter by subgraph around target node(s) within max hops */
  subgraph?: {
    centerNodeIds: string[];
    maxHops: number;
    direction?: "upstream" | "downstream" | "both";
  };
  /** Text search against node labels or statement bodies */
  search?: string;
  /** Filter by node types (e.g. "service", "database") */
  nodeTypes?: string[];
  /** Whether to include 1-hop contextual boundary neighbors (default: true) */
  includeBoundaryContext?: boolean;
}

export interface SemanticLensResult {
  /** Set of node IDs that directly match the query predicates */
  matchedNodeIds: Set<string>;
  /** Set of 1-hop boundary context node IDs (connected neighbors, not directly matched) */
  contextNodeIds: Set<string>;
  /** All visible node IDs (matched + context) */
  visibleNodeIds: Set<string>;
  /** Matched edge IDs connecting visible nodes */
  matchedEdgeIds: Set<string>;
  /** Projected workspace containing only visible nodes, edges, and relevant groups */
  projectedWorkspace: Workspace;
  /** Summary statistics of the projection */
  stats: {
    totalNodes: number;
    matchedNodes: number;
    contextNodes: number;
    totalEdges: number;
    matchedEdges: number;
  };
}

/**
 * Pure, deterministic semantic lens projector.
 * Filters and projects a workspace based on architectural, execution, or domain predicates
 * without mutating the durable board.
 */
export function computeSemanticLens(
  workspace: Workspace,
  query: SemanticLensQuery,
): SemanticLensResult {
  const allNodes = Object.values(workspace.nodes);
  const allEdges = Object.values(workspace.edges);
  const matchedNodeIds = new Set<string>();

  // Helper matching predicates
  const matchesPredicate = (node: Node): boolean => {
    if (query.statement) {
      if (!node.statement) return false;
      const { kind, status, topic } = query.statement;
      if (kind) {
        const kinds = Array.isArray(kind) ? kind : [kind];
        if (!kinds.includes(node.statement.kind)) return false;
      }
      if (status) {
        const statuses = Array.isArray(status) ? status : [status];
        if (!statuses.includes(node.statement.status)) return false;
      }
      if (topic) {
        const normTopic = topic.trim().toLowerCase();
        if (!node.statement.topic || !node.statement.topic.toLowerCase().includes(normTopic)) {
          return false;
        }
      }
    }

    if (query.issue) {
      if (!node.issue) return false;
      const { statusCategory, priority, assignee } = query.issue;
      if (statusCategory && node.issue.statusCategory !== statusCategory) return false;
      if (priority && node.issue.priority !== priority) return false;
      if (assignee && node.issue.assignee !== assignee) return false;
    }

    if (query.groupId) {
      const groups = Array.isArray(query.groupId) ? query.groupId : [query.groupId];
      if (!node.groupId || !groups.includes(node.groupId)) return false;
    }

    if (query.nodeTypes && query.nodeTypes.length > 0) {
      if (!query.nodeTypes.includes(node.nodeType)) return false;
    }

    if (query.search) {
      const term = query.search.trim().toLowerCase();
      const inLabel = node.label.toLowerCase().includes(term);
      const inStatementTopic = Boolean(node.statement?.topic?.toLowerCase().includes(term));
      const inIssue = Boolean(node.issue?.description?.toLowerCase().includes(term));
      if (!inLabel && !inStatementTopic && !inIssue) return false;
    }

    return true;
  };

  // 1. Initial predicate matching
  const hasAttributeQuery = Boolean(
    query.statement || query.issue || query.groupId || query.nodeTypes || query.search,
  );

  for (const node of allNodes) {
    if (hasAttributeQuery) {
      if (matchesPredicate(node)) {
        matchedNodeIds.add(node.id);
      }
    }
  }

  // 2. Subgraph expansion / filtering
  if (query.subgraph && query.subgraph.centerNodeIds.length > 0) {
    const { centerNodeIds, maxHops, direction = "both" } = query.subgraph;
    const subgraphNodes = new Set<string>();
    const queue: Array<{ id: string; hop: number }> = [];

    for (const cId of centerNodeIds) {
      if (workspace.nodes[cId]) {
        queue.push({ id: cId, hop: 0 });
        subgraphNodes.add(cId);
      }
    }

    while (queue.length > 0) {
      const { id, hop } = queue.shift()!;
      if (hop >= maxHops) continue;

      for (const edge of allEdges) {
        if ((direction === "downstream" || direction === "both") && edge.source === id) {
          if (!subgraphNodes.has(edge.target) && workspace.nodes[edge.target]) {
            subgraphNodes.add(edge.target);
            queue.push({ id: edge.target, hop: hop + 1 });
          }
        }
        if ((direction === "upstream" || direction === "both") && edge.target === id) {
          if (!subgraphNodes.has(edge.source) && workspace.nodes[edge.source]) {
            subgraphNodes.add(edge.source);
            queue.push({ id: edge.source, hop: hop + 1 });
          }
        }
      }
    }

    if (hasAttributeQuery) {
      // Intersect: matched nodes must be within the subgraph
      for (const id of [...matchedNodeIds]) {
        if (!subgraphNodes.has(id)) {
          matchedNodeIds.delete(id);
        }
      }
    } else {
      // Subgraph was the primary query
      for (const id of subgraphNodes) {
        matchedNodeIds.add(id);
      }
    }
  }

  // 3. Boundary context computation (1-hop neighbors of matched nodes)
  const contextNodeIds = new Set<string>();
  const includeBoundary = query.includeBoundaryContext !== false;

  if (includeBoundary && matchedNodeIds.size > 0) {
    for (const edge of allEdges) {
      if (matchedNodeIds.has(edge.source) && !matchedNodeIds.has(edge.target)) {
        contextNodeIds.add(edge.target);
      } else if (matchedNodeIds.has(edge.target) && !matchedNodeIds.has(edge.source)) {
        contextNodeIds.add(edge.source);
      }
    }
  }

  const visibleNodeIds = new Set<string>([...matchedNodeIds, ...contextNodeIds]);

  // 4. Visible edges connecting visible nodes
  const matchedEdgeIds = new Set<string>();
  for (const edge of allEdges) {
    if (visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)) {
      matchedEdgeIds.add(edge.id);
    }
  }

  // 5. Projected workspace
  const projectedNodes: Record<string, Node> = {};
  for (const id of visibleNodeIds) {
    if (workspace.nodes[id]) {
      projectedNodes[id] = { ...workspace.nodes[id] };
    }
  }

  const projectedEdges: Record<string, Edge> = {};
  for (const id of matchedEdgeIds) {
    if (workspace.edges[id]) {
      projectedEdges[id] = { ...workspace.edges[id] };
    }
  }

  const projectedGroups: typeof workspace.groups = {};
  for (const [gId, group] of Object.entries(workspace.groups)) {
    const visibleChildren = group.children.filter((cId) => visibleNodeIds.has(cId));
    if (visibleChildren.length > 0) {
      projectedGroups[gId] = {
        ...group,
        children: visibleChildren,
      };
    }
  }

  const projectedWorkspace: Workspace = {
    ...workspace,
    nodes: projectedNodes,
    edges: projectedEdges,
    groups: projectedGroups,
  };

  return {
    matchedNodeIds,
    contextNodeIds,
    visibleNodeIds,
    matchedEdgeIds,
    projectedWorkspace,
    stats: {
      totalNodes: allNodes.length,
      matchedNodes: matchedNodeIds.size,
      contextNodes: contextNodeIds.size,
      totalEdges: allEdges.length,
      matchedEdges: matchedEdgeIds.size,
    },
  };
}
