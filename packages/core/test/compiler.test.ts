import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/model.js";
import { compileSemanticPlan } from "../src/compiler.js";
import { SemanticPlan } from "../src/plan.js";
import { validateOperations } from "../src/validator.js";

describe("compileSemanticPlan", () => {
  it("compiles greenfield semantic plan into valid canonical Lucent operations", () => {
    const ws = createWorkspace();
    let idCounter = 1;
    const idGen = () => `c${idCounter++}`;

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Build e-commerce checkout flow",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "n1", label: "User Cart", role: "step" },
        { ref: "n2", label: "Checkout", role: "step" },
        { ref: "n3", label: "Payment Gateway", role: "service" },
      ],
      edges: [
        { from: "n1", to: "n2", relation: "next" },
        { from: "n2", to: "n3", relation: "calls" },
      ],
      groups: [
        { ref: "g1", label: "Payment Subsystem", memberRefs: ["n2", "n3"] },
      ],
      explanation: "Created checkout flow with payment subsystem",
    };

    const res = compileSemanticPlan(ws, plan, idGen);
    expect(res.ok).toBe(true);
    expect(res.diagnostics).toHaveLength(0);

    // Verify operations
    expect(res.operations).toHaveLength(6); // 3 CREATE_NODE, 1 CREATE_GROUP, 2 CONNECT_NODES

    // Ensure node creation
    const creates = res.operations.filter((o) => o.op === "CREATE_NODE");
    expect(creates).toHaveLength(3);
    expect(res.idMap.get("n1")).toBe("node_c2"); // group evaluated first -> c1 is group
    expect(res.idMap.get("n2")).toBe("node_c3");
    expect(res.idMap.get("n3")).toBe("node_c4");

    // Group membership
    const groupOp = res.operations.find((o) => o.op === "CREATE_GROUP") as any;
    expect(groupOp).toBeDefined();
    expect(groupOp.children).toContain("node_c3");
    expect(groupOp.children).toContain("node_c4");

    // Verify edge reference integrity and relation preservation
    const edges = res.operations.filter((o) => o.op === "CONNECT_NODES") as any[];
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      op: "CONNECT_NODES",
      source: "node_c2",
      target: "node_c3",
      relationship: "next",
    });
    expect(edges[1]).toMatchObject({
      op: "CONNECT_NODES",
      source: "node_c3",
      target: "node_c4",
      relationship: "calls",
    });

    // Validate that the compiled operations pass Lucent core's strict validator!
    const valErrors = validateOperations(ws, res.operations);
    expect(valErrors).toHaveLength(0);
  });

  it("resolves unique existing nodes on extend_region and rejects unresolvable endpoints", () => {
    const ws = createWorkspace();
    ws.nodes["node_auth"] = {
      id: "node_auth",
      label: "Authentication Service",
      nodeType: "service",
    };

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Add MFA to auth service",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "extend_region",
        focusNodeIds: ["node_auth"],
      },
      nodes: [
        { ref: "existing_auth", label: "Authentication Service" },
        { ref: "new_mfa", label: "MFA Provider", role: "service" },
      ],
      edges: [
        { from: "existing_auth", to: "new_mfa", relation: "calls" },
        { from: "ghost_ref", to: "new_mfa", relation: "calls" }, // unresolvable
      ],
      groups: [],
      explanation: "Added MFA",
    };

    const res = compileSemanticPlan(ws, plan);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]!.code).toBe("UNRESOLVED_ENDPOINT");

    // Existing auth should be mapped to the actual canvas node ID
    expect(res.idMap.get("existing_auth")).toBe("node_auth");
  });

  it("rejects ambiguous labels on existing boards instead of silently guessing", () => {
    const ws = createWorkspace();
    ws.nodes["db1"] = { id: "db1", label: "Postgres Database", nodeType: "database" };
    ws.nodes["db2"] = { id: "db2", label: "Postgres Database", nodeType: "database" };

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Connect service to database",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "extend_region",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "ambiguous_db", label: "Postgres Database" },
        { ref: "n_svc", label: "Analytics Service" },
      ],
      edges: [
        { from: "n_svc", to: "ambiguous_db", relation: "reads_writes" },
      ],
      groups: [],
      explanation: "",
    };

    const res = compileSemanticPlan(ws, plan);
    expect(res.ok).toBe(false);
    const diag = res.diagnostics.find((d) => d.code === "AMBIGUOUS_LABEL");
    expect(diag).toBeDefined();
    expect(diag?.ref).toBe("ambiguous_db");
  });

  it("rejects invalid explicit existingNodeId", () => {
    const ws = createWorkspace();

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Link to missing node",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "extend_region",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "n1", label: "Missing Link", existingNodeId: "nonexistent_node_999" },
      ],
      edges: [],
      groups: [],
      explanation: "",
    };

    const res = compileSemanticPlan(ws, plan);
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]?.code).toBe("INVALID_EXISTING_ID");
  });

  it("rejects self-connection attempts", () => {
    const ws = createWorkspace();

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Self-loop test",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [{ ref: "n1", label: "Self Loop Node" }],
      edges: [{ from: "n1", to: "n1", relation: "next" }],
      groups: [],
      explanation: "",
    };

    const res = compileSemanticPlan(ws, plan);
    expect(res.ok).toBe(false);
    expect(res.diagnostics[0]?.code).toBe("SELF_CONNECTION");
  });

  it("preserves rich semantic relations across various edge kinds", () => {
    const ws = createWorkspace();
    const relations = [
      "calls",
      "reads_writes",
      "produces",
      "consumes",
      "contains",
      "depends_on",
      "next",
    ] as const;

    const plan: SemanticPlan = {
      intent: {
        userObjective: "Test relations",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "src", label: "Source" },
        ...relations.map((r, i) => ({ ref: `dst_${i}`, label: `Target ${r}` })),
      ],
      edges: relations.map((r, i) => ({
        from: "src",
        to: `dst_${i}`,
        relation: r,
      })),
      groups: [],
      explanation: "",
    };

    const res = compileSemanticPlan(ws, plan);
    expect(res.ok).toBe(true);
    const edgeOps = res.operations.filter((o) => o.op === "CONNECT_NODES") as any[];
    expect(edgeOps).toHaveLength(relations.length);
    relations.forEach((rel, idx) => {
      expect(edgeOps[idx].relationship).toBe(rel);
    });
  });
});

