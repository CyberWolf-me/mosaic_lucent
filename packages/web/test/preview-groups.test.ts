import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";

/**
 * Mirrors applyPreview in CanvasView: the proposal preview must include proposed
 * groups, or a tier/swimlane diagram previews as an ungrouped wall of boxes and
 * then visibly rearranges the moment the user hits Apply.
 */
function applyPreview(workspace: ReturnType<typeof createWorkspace>, operations: Operation[]) {
  const nodes = { ...workspace.nodes };
  const edges = { ...workspace.edges };
  const groups = { ...workspace.groups };
  for (const op of operations) {
    if (op.op === "CREATE_NODE" && !nodes[op.id]) {
      nodes[op.id] = {
        id: op.id,
        nodeType: op.nodeType,
        label: op.label,
        ...(op.groupId ? { groupId: op.groupId } : {}),
      };
    }
    if (op.op === "CONNECT_NODES") {
      const id = `${op.source}->${op.target}:${op.relationship}`;
      edges[id] = { id, source: op.source, target: op.target, relationship: op.relationship };
    }
    if (op.op === "CREATE_GROUP" && !groups[op.id]) {
      groups[op.id] = { id: op.id, label: op.label, children: [...op.children] };
    }
  }
  for (const n of Object.values(nodes)) {
    if (n.groupId && groups[n.groupId] && !groups[n.groupId]!.children.includes(n.id)) {
      groups[n.groupId] = {
        ...groups[n.groupId]!,
        children: [...groups[n.groupId]!.children, n.id],
      };
    }
  }
  return { ...workspace, nodes, edges, groups };
}

const proposal: Operation[] = [
  { op: "CREATE_GROUP", id: "edge-tier", label: "Edge", children: [] },
  { op: "CREATE_GROUP", id: "data-tier", label: "Data Stores", children: [] },
  { op: "CREATE_NODE", id: "gw", nodeType: "gateway", label: "API Gateway", groupId: "edge-tier" },
  { op: "CREATE_NODE", id: "db", nodeType: "database", label: "Orders DB", groupId: "data-tier" },
  { op: "CONNECT_NODES", source: "gw", target: "db", relationship: "reads/writes orders" },
];

describe("proposal preview", () => {
  it("includes proposed groups", () => {
    const p = applyPreview(createWorkspace(), proposal);
    expect(Object.keys(p.groups).sort()).toEqual(["data-tier", "edge-tier"]);
  });

  it("attaches proposed nodes to their proposed group", () => {
    const p = applyPreview(createWorkspace(), proposal);
    expect(p.groups["edge-tier"]!.children).toEqual(["gw"]);
    expect(p.groups["data-tier"]!.children).toEqual(["db"]);
  });

  it("keeps the relationship verb on the previewed edge", () => {
    const p = applyPreview(createWorkspace(), proposal);
    const edge = Object.values(p.edges)[0]!;
    expect(edge.relationship).toBe("reads/writes orders");
  });

  it("matches the real reducer's group membership", () => {
    const previewed = applyPreview(createWorkspace(), proposal);
    const applied = applyOperations(createWorkspace(), proposal);
    for (const gid of Object.keys(applied.groups)) {
      expect([...previewed.groups[gid]!.children].sort()).toEqual(
        [...applied.groups[gid]!.children].sort(),
      );
    }
  });

  it("does not mutate the workspace it previews", () => {
    const ws = createWorkspace();
    const before = JSON.stringify(ws);
    applyPreview(ws, proposal);
    expect(JSON.stringify(ws)).toBe(before);
  });
});
