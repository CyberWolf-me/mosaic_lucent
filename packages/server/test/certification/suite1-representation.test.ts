import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
  applyOperations,
  validateOperations,
  type SemanticPlan,
} from "@lucent/core";
import { classifyIntentFastPath } from "@lucent/ai";

describe("Pipeline Certification v1 - Suite 1: Representation and Graph Correctness", () => {
  it("certifies Backend Architecture representation and relational network topology", () => {
    const ws = createWorkspace();
    const prompt =
      "Design scalable backend architecture with API Gateway, Auth Service, and PostgreSQL database";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("architecture");
    expect(intent?.expectedTopology).toBe("relational_network");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "gw", label: "API Gateway", role: "gateway" },
        { ref: "auth", label: "Auth Service", role: "service" },
        { ref: "db", label: "PostgreSQL", role: "database" },
      ],
      edges: [
        { from: "gw", to: "auth", relation: "calls" },
        { from: "auth", to: "db", relation: "reads_writes" },
      ],
      groups: [],
      explanation: "Backend architecture with API gateway and authenticated database access",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
    expect(quality.violations).toHaveLength(0);

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("architecture");
    expect(Object.keys(projected.nodes)).toHaveLength(3);
    expect(Object.values(projected.edges)).toHaveLength(2);
    expect(validateOperations(ws, compiled.operations)).toHaveLength(0);
  });

  it("certifies Authentication Flow representation and directed flow topology", () => {
    const ws = createWorkspace();
    const prompt = "Build a step-by-step user onboarding and authentication flowchart";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("flowchart");
    expect(intent?.expectedTopology).toBe("directed_flow");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "n1", label: "User Visits App" },
        { ref: "n2", label: "Submit Login Credentials" },
        { ref: "n3", label: "Validate Password" },
        { ref: "n4", label: "Issue JWT Session" },
      ],
      edges: [
        { from: "n1", to: "n2", relation: "next" },
        { from: "n2", to: "n3", relation: "next" },
        { from: "n3", to: "n4", relation: "next" },
      ],
      groups: [],
      explanation: "Authentication process flow",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("flowchart");
    expect(Object.keys(projected.nodes)).toHaveLength(4);
    expect(Object.values(projected.edges)).toHaveLength(3);
  });

  it("certifies ER Diagram representation and entity relationships", () => {
    const ws = createWorkspace();
    const prompt = "Create an ER diagram for database schema with Users, Orders, and Products";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("er");
    expect(intent?.expectedTopology).toBe("relational_network");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "u", label: "Users Table", role: "entity" },
        { ref: "o", label: "Orders Table", role: "entity" },
        { ref: "p", label: "Products Table", role: "entity" },
      ],
      edges: [
        { from: "u", to: "o", relation: "relates_to", label: "1:N places" },
        { from: "o", to: "p", relation: "relates_to", label: "N:M contains" },
      ],
      groups: [],
      explanation: "Relational entity model",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);
    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("er");
  });

  it("certifies Mind Map representation and hierarchical tree structure", () => {
    const ws = createWorkspace();
    const prompt = "Generate a mind map exploring Q4 Product Growth strategies";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("mindmap");
    expect(intent?.expectedTopology).toBe("tree_hierarchy");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "root", label: "Q4 Growth" },
        { ref: "b1", label: "Self-Serve PLG" },
        { ref: "b2", label: "Enterprise Sales" },
        { ref: "c1", label: "Interactive Demos" },
      ],
      edges: [
        { from: "root", to: "b1", relation: "contains" },
        { from: "root", to: "b2", relation: "contains" },
        { from: "b1", to: "c1", relation: "contains" },
      ],
      groups: [],
      explanation: "Product growth mind map",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);
    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("mindmap");
  });

  it("certifies Brainstorming with independent clusters without creating artificial edges", () => {
    const ws = createWorkspace();
    const prompt = "Brainstorm 5 ideas for improving developer onboarding";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.expectedTopology).toBe("independent_clusters");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "i1", label: "One-Click Codespaces" },
        { ref: "i2", label: "Video Walkthroughs" },
        { ref: "i3", label: "CLI Healthcheck Tool" },
        { ref: "i4", label: "Buddy Mentorship" },
        { ref: "i5", label: "Interactive Sandbox" },
      ],
      edges: [], // Zero edges!
      groups: [],
      explanation: "Ideation stickies",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
    expect(quality.missingConnections).toHaveLength(0);

    const projected = applyOperations(ws, compiled.operations);
    expect(Object.keys(projected.nodes)).toHaveLength(5);
    expect(Object.keys(projected.edges)).toHaveLength(0); // Zero artificial edges created!
  });

  it("certifies Organizational Hierarchy with multiple roots (forest)", () => {
    const ws = createWorkspace();
    const prompt = "Dual division organizational hierarchy";
    const plan: SemanticPlan = {
      intent: {
        userObjective: prompt,
        targetKind: "mindmap",
        expectedTopology: "tree_hierarchy",
        mutationScope: "new_canvas",
        focusNodeIds: [],
        hierarchyStructure: "forest",
      },
      nodes: [
        { ref: "vp1", label: "VP Engineering" },
        { ref: "dir1", label: "Director Infrastructure" },
        { ref: "vp2", label: "VP Product" },
        { ref: "dir2", label: "Director Design" },
      ],
      edges: [
        { from: "vp1", to: "dir1", relation: "contains" },
        { from: "vp2", to: "dir2", relation: "contains" },
      ],
      groups: [],
      explanation: "Forest hierarchy",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);
    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
  });

  it("certifies Deliberate Cyclic Workflows with retry/approval loops", () => {
    const ws = createWorkspace();
    const prompt = "Loan application approval process with reject-and-resubmit retry loop";
    const plan: SemanticPlan = {
      intent: {
        userObjective: prompt,
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
        allowCycles: true,
      },
      nodes: [
        { ref: "submit", label: "Submit Loan Application" },
        { ref: "review", label: "Underwriter Review" },
        { ref: "revise", label: "Request Revisions" },
        { ref: "approve", label: "Disburse Funds" },
      ],
      edges: [
        { from: "submit", to: "review", relation: "next" },
        { from: "review", to: "approve", relation: "next", label: "Approved" },
        { from: "review", to: "revise", relation: "next", label: "Incomplete" },
        { from: "revise", to: "review", relation: "next", label: "Resubmit" }, // Intentional cyclic retry!
      ],
      groups: [],
      explanation: "Approval workflow with feedback loop",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
    expect(quality.violations).toHaveLength(0);

    const projected = applyOperations(ws, compiled.operations);
    expect(Object.keys(projected.nodes)).toHaveLength(4);
    expect(Object.values(projected.edges)).toHaveLength(4);
  });
});
