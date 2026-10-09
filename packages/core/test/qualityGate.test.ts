import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/model.js";
import { compileSemanticPlan } from "../src/compiler.js";
import { evaluateTopologyQuality } from "../src/qualityGate.js";
import type { SemanticPlan } from "../src/plan.js";

describe("evaluateTopologyQuality", () => {
  it("allows floating nodes in independent_clusters (brainstorming negative case)", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Brainstorm 4 marketing ideas",
        targetKind: "neutral",
        expectedTopology: "independent_clusters",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "idea1", label: "Launch Podcast" },
        { ref: "idea2", label: "SEO Campaign" },
        { ref: "idea3", label: "Customer Referral Program" },
        { ref: "idea4", label: "Developer Hackathon" },
      ],
      edges: [], // Zero edges!
      groups: [],
      explanation: "Collected brainstorming ideas",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(report.outcome).toBe("PASS");
    expect(report.violations).toHaveLength(0);
    expect(report.missingConnections).toHaveLength(0);
  });

  it("flags disconnected nodes in directed_flow as REPAIRABLE, then UNRESOLVED on 2nd pass", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Sign in flow",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "step1", label: "Enter Credentials" },
        { ref: "step2", label: "Verify 2FA" },
        { ref: "step_orphan", label: "Dangling Step" }, // No edges to this!
      ],
      edges: [{ from: "step1", to: "step2", relation: "next" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    // Pass 1: should be REPAIRABLE
    const pass1 = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(pass1.outcome).toBe("REPAIRABLE");
    expect(pass1.missingConnections).toContain("Dangling Step");
    expect(pass1.violations[0]?.code).toBe("DISCONNECTED_FLOW");

    // Pass 2: should be UNRESOLVED (truthful failure, no false claims)
    const pass2 = evaluateTopologyQuality(ws, plan, compiled.operations, true);
    expect(pass2.outcome).toBe("UNRESOLVED");
    expect(pass2.missingConnections).toContain("Dangling Step");
  });

  it("permits intentional cyclic workflows and retries in directed_flow by default", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Approval and revision retry loop",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "submit", label: "Submit Application" },
        { ref: "review", label: "Manager Review" },
        { ref: "revise", label: "Revise Application" },
      ],
      edges: [
        { from: "submit", to: "review", relation: "next" },
        { from: "review", to: "revise", relation: "next", label: "Rejected" },
        { from: "revise", to: "review", relation: "next", label: "Resubmit" }, // Intentional retry cycle!
      ],
      groups: [],
      explanation: "Workflow with retry cycle",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("PASS");
    expect(report.violations).toHaveLength(0);
  });

  it("flags cycles in directed_flow only when strictAcyclic is explicitly requested", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Strictly DAG data pipeline",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
        strictAcyclic: true,
      },
      nodes: [
        { ref: "stage1", label: "Ingest" },
        { ref: "stage2", label: "Transform" },
      ],
      edges: [
        { from: "stage1", to: "stage2", relation: "next" },
        { from: "stage2", to: "stage1", relation: "next" },
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("REPAIRABLE");
    expect(report.violations.some((v) => v.code === "CYCLE_IN_DAG")).toBe(true);
  });

  it("detects directed cycles in tree_hierarchy", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Org chart",
        targetKind: "mindmap",
        expectedTopology: "tree_hierarchy",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "n1", label: "CEO" },
        { ref: "n2", label: "VP Eng" },
        { ref: "n3", label: "Tech Lead" },
      ],
      edges: [
        { from: "n1", to: "n2", relation: "contains" },
        { from: "n2", to: "n3", relation: "contains" },
        { from: "n3", to: "n1", relation: "contains" }, // Invalid cycle!
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("REPAIRABLE");
    expect(report.violations.some((v) => v.code === "CYCLE_IN_HIERARCHY")).toBe(true);
  });

  it("permits forest hierarchy with multiple roots when hierarchyStructure is forest", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Dual-track organization trees",
        targetKind: "mindmap",
        expectedTopology: "tree_hierarchy",
        mutationScope: "new_canvas",
        focusNodeIds: [],
        hierarchyStructure: "forest",
      },
      nodes: [
        { ref: "r1", label: "Product Org" },
        { ref: "c1", label: "PM Team" },
        { ref: "r2", label: "Engineering Org" },
        { ref: "c2", label: "Dev Team" },
      ],
      edges: [
        { from: "r1", to: "c1", relation: "contains" },
        { from: "r2", to: "c2", relation: "contains" },
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("PASS");
    expect(report.violations).toHaveLength(0);
  });

  it("allows intentional standalone entities in relational_network", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "System architecture with legend note",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "api", label: "API Gateway" },
        { ref: "auth", label: "Auth Service" },
        { ref: "legend", label: "Architecture Legend", standalone: true },
      ],
      edges: [{ from: "api", to: "auth", relation: "calls" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("PASS");
    expect(report.violations).toHaveLength(0);
  });

  it("flags isolated services in relational_network when not standalone", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Microservices Architecture",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "api", label: "API Gateway" },
        { ref: "auth", label: "Auth Service" },
        { ref: "billing", label: "Billing Service" }, // isolated!
      ],
      edges: [{ from: "api", to: "auth", relation: "calls" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const report = evaluateTopologyQuality(ws, plan, compiled.operations, false);
    expect(report.outcome).toBe("REPAIRABLE");
    expect(report.missingConnections).toContain("Billing Service");
    expect(report.violations[0]?.code).toBe("ISOLATED_IN_NETWORK");
  });
});
