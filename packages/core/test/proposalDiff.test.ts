import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { computeProposalDiff } from "../src/proposalDiff.js";

describe("computeProposalDiff", () => {
  it("computes added, modified, and removed entities and connections in markdown diff", () => {
    const ws = createWorkspace();
    ws.nodes.legacy = {
      id: "legacy",
      nodeType: "service",
      label: "Legacy Monolith",
      position: { x: 0, y: 0 },
    };
    ws.nodes.db = {
      id: "db",
      nodeType: "database",
      label: "Shared DB",
      position: { x: 100, y: 0 },
    };
    ws.edges.e1 = { id: "e1", source: "legacy", target: "db", relationship: "queries" };

    const ops = [
      { op: "DELETE_NODE" as const, id: "legacy" },
      { op: "CREATE_NODE" as const, id: "gateway", nodeType: "service" as const, label: "API Gateway" },
      { op: "CREATE_NODE" as const, id: "auth", nodeType: "service" as const, label: "Auth Service" },
      { op: "CONNECT_NODES" as const, source: "gateway", target: "auth", relationship: "routes" },
      { op: "CONNECT_NODES" as const, source: "auth", target: "db", relationship: "reads" },
      {
        op: "SET_STATEMENT" as const,
        id: "auth",
        statement: { kind: "decision" as const, status: "accepted" as const, body: "OAuth2 authentication" },
      },
    ];

    const diff = computeProposalDiff(ws, ops, "Decompose Monolith");

    expect(diff.valid).toBe(true);
    expect(diff.addedNodes).toHaveLength(2);
    expect(diff.removedNodes).toHaveLength(1);
    expect(diff.removedNodes[0].label).toBe("Legacy Monolith");
    expect(diff.addedEdges).toHaveLength(2);
    expect(diff.removedEdges).toHaveLength(1);

    expect(diff.markdown).toContain("Visual Architecture Proposal: Decompose Monolith");
    expect(diff.markdown).toContain("+ [service] API Gateway");
    expect(diff.markdown).toContain("+ [service] Auth Service");
    expect(diff.markdown).toContain("- Legacy Monolith");
  });

  it("surfaces validation errors clearly without throwing", () => {
    const ws = createWorkspace();
    const brokenOps = [
      { op: "CONNECT_NODES" as const, source: "nonexistent_1", target: "nonexistent_2", relationship: "calls" },
    ];
    const diff = computeProposalDiff(ws, brokenOps);
    expect(diff.valid).toBe(false);
    expect(diff.errors?.length).toBeGreaterThan(0);
    expect(diff.markdown).toContain("Proposal Validation Failed");
  });
});
