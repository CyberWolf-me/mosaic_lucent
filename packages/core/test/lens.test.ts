import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { computeSemanticLens } from "../src/lens.js";

describe("computeSemanticLens", () => {
  it("filters nodes by active architectural decisions and retains 1-hop boundary context", () => {
    const ws = createWorkspace();
    ws.nodes.auth = {
      id: "auth",
      nodeType: "service",
      label: "Auth Service",
      position: { x: 0, y: 0 },
      statement: { kind: "decision", status: "accepted", body: "Use JWT tokens" },
    };
    ws.nodes.db = {
      id: "db",
      nodeType: "database",
      label: "User DB",
      position: { x: 100, y: 0 },
    };
    ws.nodes.billing = {
      id: "billing",
      nodeType: "service",
      label: "Billing Service",
      position: { x: 200, y: 0 },
      statement: { kind: "decision", status: "superseded", body: "Old payment gateway" },
    };
    ws.edges.e1 = { id: "e1", source: "auth", target: "db", relationship: "reads" };
    ws.edges.e2 = { id: "e2", source: "billing", target: "db", relationship: "reads" };

    const result = computeSemanticLens(ws, {
      statement: { kind: "decision", status: "accepted" },
      includeBoundaryContext: true,
    });

    expect(result.matchedNodeIds.has("auth")).toBe(true);
    expect(result.matchedNodeIds.has("billing")).toBe(false);
    expect(result.matchedNodeIds.has("db")).toBe(false);

    // Context node: "db" is 1-hop neighbor of "auth"
    expect(result.contextNodeIds.has("db")).toBe(true);
    expect(result.visibleNodeIds.has("auth")).toBe(true);
    expect(result.visibleNodeIds.has("db")).toBe(true);
    expect(result.visibleNodeIds.has("billing")).toBe(false);

    // Matched edges connect visible nodes
    expect(result.matchedEdgeIds.has("e1")).toBe(true);
    expect(result.matchedEdgeIds.has("e2")).toBe(false);

    expect(result.projectedWorkspace.nodes.auth).toBeDefined();
    expect(result.projectedWorkspace.nodes.db).toBeDefined();
    expect(result.projectedWorkspace.nodes.billing).toBeUndefined();
    expect(result.projectedWorkspace.edges.e1).toBeDefined();
    expect(result.projectedWorkspace.edges.e2).toBeUndefined();
  });

  it("filters by issue execution status category", () => {
    const ws = createWorkspace();
    ws.nodes.task1 = {
      id: "task1",
      nodeType: "task",
      label: "Fix Login",
      position: { x: 0, y: 0 },
      issue: { type: "task", status: "In Progress", statusCategory: "in_progress" },
    };
    ws.nodes.task2 = {
      id: "task2",
      nodeType: "task",
      label: "Write Docs",
      position: { x: 100, y: 0 },
      issue: { type: "task", status: "Done", statusCategory: "done" },
    };

    const result = computeSemanticLens(ws, {
      issue: { statusCategory: "in_progress" },
      includeBoundaryContext: false,
    });

    expect(result.matchedNodeIds.has("task1")).toBe(true);
    expect(result.matchedNodeIds.has("task2")).toBe(false);
    expect(result.stats.matchedNodes).toBe(1);
  });

  it("extracts a directional subgraph radius from a center node", () => {
    const ws = createWorkspace();
    ws.nodes.a = { id: "a", nodeType: "service", label: "A", position: { x: 0, y: 0 } };
    ws.nodes.b = { id: "b", nodeType: "service", label: "B", position: { x: 100, y: 0 } };
    ws.nodes.c = { id: "c", nodeType: "service", label: "C", position: { x: 200, y: 0 } };
    ws.nodes.d = { id: "d", nodeType: "service", label: "D", position: { x: 300, y: 0 } };
    ws.edges.ab = { id: "ab", source: "a", target: "b", relationship: "calls" };
    ws.edges.bc = { id: "bc", source: "b", target: "c", relationship: "calls" };
    ws.edges.cd = { id: "cd", source: "c", target: "d", relationship: "calls" };

    const result = computeSemanticLens(ws, {
      subgraph: {
        centerNodeIds: ["a"],
        maxHops: 2,
        direction: "downstream",
      },
      includeBoundaryContext: false,
    });

    expect(result.matchedNodeIds.has("a")).toBe(true);
    expect(result.matchedNodeIds.has("b")).toBe(true);
    expect(result.matchedNodeIds.has("c")).toBe(true);
    expect(result.matchedNodeIds.has("d")).toBe(false); // 3 hops away
  });
});
