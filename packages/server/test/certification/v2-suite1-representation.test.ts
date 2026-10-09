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

describe("Pipeline Certification V2 - Suite 1: End-to-End Representation & Prompt Corpus", () => {
  it("certifies Software & Cloud Architecture representation and relational network topology", () => {
    const ws = createWorkspace();
    const prompt =
      "Design a high-availability cloud architecture with Cloudflare CDN, Kong Gateway, User Service, Payment Service, and Aurora PostgreSQL";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("architecture");
    expect(intent?.expectedTopology).toBe("relational_network");
    expect(intent?.mutationScope).toBe("new_canvas");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "cdn", label: "Cloudflare CDN", role: "client" },
        { ref: "gw", label: "Kong Gateway", role: "gateway" },
        { ref: "userSvc", label: "User Service", role: "service" },
        { ref: "paySvc", label: "Payment Service", role: "service" },
        { ref: "db", label: "Aurora PostgreSQL", role: "database" },
      ],
      edges: [
        { from: "cdn", to: "gw", relation: "calls" },
        { from: "gw", to: "userSvc", relation: "calls" },
        { from: "gw", to: "paySvc", relation: "calls" },
        { from: "userSvc", to: "db", relation: "reads_writes" },
        { from: "paySvc", to: "db", relation: "reads_writes" },
      ],
      groups: [
        { ref: "grp_backend", label: "Core Backend Services", memberRefs: ["userSvc", "paySvc"] },
      ],
      explanation: "Cloud architecture with CDN, API gateway, microservices, and database.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);
    expect(compiled.diagnostics).toHaveLength(0);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
    expect(quality.violations).toHaveLength(0);

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("architecture");
    expect(Object.keys(projected.nodes)).toHaveLength(5);
    expect(Object.keys(projected.edges)).toHaveLength(5);
    expect(Object.keys(projected.groups)).toHaveLength(1);
    expect(validateOperations(ws, compiled.operations)).toHaveLength(0);
  });

  it("certifies Process Flowcharts with sequential steps and strict DAG ordering", () => {
    const ws = createWorkspace();
    const prompt =
      "Step-by-step user checkout flowchart with cart validation, payment processing, fraud check, and order confirmation";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("flowchart");
    expect(intent?.expectedTopology).toBe("directed_flow");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "step1", label: "Cart Validation", role: "step" },
        { ref: "step2", label: "Fraud Check", role: "step" },
        { ref: "step3", label: "Payment Processing", role: "step" },
        { ref: "step4", label: "Order Confirmation", role: "step" },
      ],
      edges: [
        { from: "step1", to: "step2", relation: "next" },
        { from: "step2", to: "step3", relation: "next" },
        { from: "step3", to: "step4", relation: "next" },
      ],
      groups: [],
      explanation: "Checkout flow from cart validation to order confirmation.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("flowchart");
    expect(Object.keys(projected.nodes)).toHaveLength(4);
    expect(Object.keys(projected.edges)).toHaveLength(3);
  });

  it("certifies Entity-Relationship Diagrams with relational model semantics", () => {
    const ws = createWorkspace();
    const prompt =
      "Create an ER diagram for database schema with Users, Organizations, Projects, Tasks, and Comments";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("er");
    expect(intent?.expectedTopology).toBe("relational_network");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "tbl_users", label: "Users Table", role: "entity" },
        { ref: "tbl_orgs", label: "Organizations Table", role: "entity" },
        { ref: "tbl_projects", label: "Projects Table", role: "entity" },
        { ref: "tbl_tasks", label: "Tasks Table", role: "entity" },
        { ref: "tbl_comments", label: "Comments Table", role: "entity" },
      ],
      edges: [
        { from: "tbl_orgs", to: "tbl_users", relation: "contains", label: "1:N" },
        { from: "tbl_orgs", to: "tbl_projects", relation: "contains", label: "1:N" },
        { from: "tbl_projects", to: "tbl_tasks", relation: "contains", label: "1:N" },
        { from: "tbl_tasks", to: "tbl_comments", relation: "contains", label: "1:N" },
        { from: "tbl_users", to: "tbl_tasks", relation: "relates_to", label: "assigned_to" },
      ],
      groups: [],
      explanation: "Relational database schema ERD.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("er");
    expect(Object.keys(projected.nodes)).toHaveLength(5);
    expect(Object.keys(projected.edges)).toHaveLength(5);
  });

  it("certifies Mind Maps & Hierarchical Trees with rooted hierarchy", () => {
    const ws = createWorkspace();
    const prompt =
      "Mind map of company annual strategic goals, product vision, engineering roadmaps, and marketing initiatives";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("mindmap");
    expect(intent?.expectedTopology).toBe("tree_hierarchy");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "root", label: "Annual Company Goals", role: "concept" },
        { ref: "prod", label: "Product Vision", role: "concept" },
        { ref: "eng", label: "Engineering Roadmap", role: "concept" },
        { ref: "mkt", label: "Marketing Initiatives", role: "concept" },
        { ref: "ai", label: "AI Features", role: "concept" },
        { ref: "infra", label: "Infra Scale", role: "concept" },
      ],
      edges: [
        { from: "root", to: "prod", relation: "contains" },
        { from: "root", to: "eng", relation: "contains" },
        { from: "root", to: "mkt", relation: "contains" },
        { from: "eng", to: "ai", relation: "contains" },
        { from: "eng", to: "infra", relation: "contains" },
      ],
      groups: [],
      explanation: "Tree hierarchy mind map.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("mindmap");
    expect(Object.keys(projected.nodes)).toHaveLength(6);
    expect(Object.keys(projected.edges)).toHaveLength(5);
  });

  it("certifies Decision Trees with branching conditional paths", () => {
    const ws = createWorkspace();
    const prompt =
      "Build a decision tree for refund authorization based on customer tier, request age, and return reason";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("decisiontree");
    expect(intent?.expectedTopology).toBe("tree_hierarchy");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "q1", label: "Request Age < 30 Days?", role: "decision" },
        { ref: "pass1", label: "VIP Customer Tier?", role: "decision" },
        { ref: "reject1", label: "Reject: Policy Exceeded", role: "action" },
        { ref: "auto_approve", label: "Auto-Approve Refund", role: "action" },
        { ref: "manual_review", label: "Send to Support Review", role: "action" },
      ],
      edges: [
        { from: "q1", to: "pass1", relation: "next", label: "Yes" },
        { from: "q1", to: "reject1", relation: "next", label: "No" },
        { from: "pass1", to: "auto_approve", relation: "next", label: "VIP" },
        { from: "pass1", to: "manual_review", relation: "next", label: "Standard" },
      ],
      groups: [],
      explanation: "Branching decision tree for refund policy.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("decisiontree");
    expect(Object.keys(projected.nodes)).toHaveLength(5);
    expect(Object.keys(projected.edges)).toHaveLength(4);
  });

  it("certifies Tables & Comparison Matrices with criteria and options", () => {
    const ws = createWorkspace();
    const prompt =
      "Create a comparison matrix between PostgreSQL and MongoDB for scalability, ACID transactions, and document storage";
    const intent = classifyIntentFastPath(prompt, ws);

    expect(intent?.targetKind).toBe("matrix");
    expect(intent?.expectedTopology).toBe("independent_clusters");

    const plan: SemanticPlan = {
      intent: intent!,
      nodes: [
        { ref: "pg", label: "PostgreSQL", role: "option" },
        { ref: "mongo", label: "MongoDB", role: "option" },
        { ref: "acid", label: "ACID Guarantees", role: "criterion" },
        { ref: "scale", label: "Horizontal Partitioning", role: "criterion" },
        { ref: "json", label: "Flexible JSON Documents", role: "criterion" },
      ],
      edges: [
        { from: "pg", to: "acid", relation: "relates_to" },
        { from: "mongo", to: "scale", relation: "relates_to" },
        { from: "mongo", to: "json", relation: "relates_to" },
      ],
      groups: [],
      explanation: "Feature comparison matrix between relational and document databases.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");

    const projected = applyOperations(ws, compiled.operations);
    expect(projected.diagramKind).toBe("matrix");
    expect(Object.keys(projected.nodes)).toHaveLength(5);
  });

  it("certifies Mixed Diagrams coexisting multiple semantic relationship types", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective:
          "Event-driven system with API calls, message queues, and database persistence",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "client", label: "Web Client", role: "client" },
        { ref: "api", label: "Order API", role: "service" },
        { ref: "queue", label: "Kafka Events", role: "queue" },
        { ref: "worker", label: "Billing Worker", role: "worker" },
        { ref: "db", label: "Primary Database", role: "database" },
      ],
      edges: [
        { from: "client", to: "api", relation: "calls" },
        { from: "api", to: "queue", relation: "produces" },
        { from: "queue", to: "worker", relation: "consumes" },
        { from: "worker", to: "db", relation: "reads_writes" },
        { from: "api", to: "db", relation: "depends_on" },
      ],
      groups: [],
      explanation: "Multi-relationship distributed pipeline.",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    // Verify all 5 relationship types are preserved in compiled CONNECT_NODES operations
    const connectOps = compiled.operations.filter(
      (op): op is Extract<typeof op, { op: "CONNECT_NODES" }> => op.op === "CONNECT_NODES",
    );
    const relations = new Set(connectOps.map((op) => (op as any).relationship));
    expect(relations.has("calls")).toBe(true);
    expect(relations.has("produces")).toBe(true);
    expect(relations.has("consumes")).toBe(true);
    expect(relations.has("reads_writes")).toBe(true);
    expect(relations.has("depends_on")).toBe(true);

    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    expect(quality.outcome).toBe("PASS");
  });

  it("certifies Ambiguous and Incomplete requests return null on fast path without guessing", () => {
    const ws = createWorkspace();
    // Ambiguous prompts on blank canvas should not make unguided assumptions
    expect(classifyIntentFastPath("make something cool and interesting", ws)).toBeNull();
    expect(classifyIntentFastPath("think about the future", ws)).toBeNull();
    expect(classifyIntentFastPath("asdf 12345", ws)).toBeNull();
  });

  it("certifies Explicit Unsupported requests return null gracefully", () => {
    const ws = createWorkspace();
    // Non-canvas domain requests must not produce spurious diagrams
    expect(classifyIntentFastPath("Render a 3D CAD model of an aircraft fuselage", ws)).toBeNull();
    expect(classifyIntentFastPath("Compile this C++ program to WebAssembly", ws)).toBeNull();
  });

  it("certifies Anti-Collapse: diverse requests do NOT all collapse to a flowchart default", () => {
    const testCases = [
      {
        prompt: "Design our microservices architecture with gateway and database",
        expected: "architecture",
      },
      { prompt: "Step-by-step user onboarding and signup flowchart", expected: "flowchart" },
      { prompt: "ER diagram and database schema for orders and customers", expected: "er" },
      { prompt: "Mind map of our engineering and product initiatives", expected: "mindmap" },
      { prompt: "Feature comparison matrix between Redis and Memcached", expected: "matrix" },
      { prompt: "Build a decision tree for loan approval rules", expected: "decisiontree" },
    ];

    const ws = createWorkspace();
    const resolvedKinds = new Set<string>();

    for (const tc of testCases) {
      const intent = classifyIntentFastPath(tc.prompt, ws);
      expect(intent).not.toBeNull();
      expect(intent?.targetKind).toBe(tc.expected);
      resolvedKinds.add(intent!.targetKind);
    }

    // Confirms that all 6 distinct kinds are resolved, completely disproving flowchart default collapse!
    expect(resolvedKinds.size).toBe(6);
    expect(resolvedKinds).toContain("architecture");
    expect(resolvedKinds).toContain("flowchart");
    expect(resolvedKinds).toContain("er");
    expect(resolvedKinds).toContain("mindmap");
    expect(resolvedKinds).toContain("matrix");
    expect(resolvedKinds).toContain("decisiontree");
  });
});
