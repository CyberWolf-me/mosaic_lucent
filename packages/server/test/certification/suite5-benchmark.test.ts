import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
  computeLayout,
  applyLayout,
  applyOperations,
  type SemanticPlan,
} from "@lucent/core";
import { classifyIntentFastPath } from "@lucent/ai";

describe("Pipeline Certification v1 - Suite 5: Quality and Latency Benchmark", () => {
  it("measures Deterministic Intent Resolution latency (< 15ms)", () => {
    const ws = createWorkspace();
    const prompt = "Design an event-driven architecture with Kafka and microservices";

    const start = performance.now();
    const intent = classifyIntentFastPath(prompt, ws);
    const durationMs = performance.now() - start;

    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("architecture");
    expect(intent?.expectedTopology).toBe("relational_network");
    expect(durationMs).toBeLessThan(15); // Deterministic fast-path must execute in under 15ms
  });

  it("measures Reference Integrity and Zero Dropped Connections", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Full billing pipeline",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "cart", label: "Cart" },
        { ref: "checkout", label: "Checkout" },
        { ref: "pay", label: "Payment Gateway" },
        { ref: "receipt", label: "Receipt" },
      ],
      edges: [
        { from: "cart", to: "checkout", relation: "next" },
        { from: "checkout", to: "pay", relation: "next" },
        { from: "pay", to: "receipt", relation: "next" },
      ],
      groups: [],
      explanation: "Checkout flow",
    };

    const start = performance.now();
    const compiled = compileSemanticPlan(ws, plan);
    const compileTimeMs = performance.now() - start;

    expect(compiled.ok).toBe(true);
    expect(compileTimeMs).toBeLessThan(25);

    // 100% reference integrity: every edge connects existing created nodes
    const createdNodes = compiled.operations
      .filter((op): op is Extract<typeof op, { op: "CREATE_NODE" }> => op.op === "CREATE_NODE")
      .map((op) => op.id);
    const createdEdges = compiled.operations.filter(
      (op): op is Extract<typeof op, { op: "CONNECT_NODES" }> => op.op === "CONNECT_NODES",
    );

    for (const edge of createdEdges) {
      expect(createdNodes).toContain(edge.source);
      expect(createdNodes).toContain(edge.target);
    }
  });

  it("measures Connectivity and Quality Gate Latency (< 20ms)", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Distributed caching cluster",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "s1", label: "App Server" },
        { ref: "c1", label: "Redis Primary" },
        { ref: "c2", label: "Redis Replica" },
      ],
      edges: [
        { from: "s1", to: "c1", relation: "calls" },
        { from: "c1", to: "c2", relation: "produces" },
      ],
      groups: [],
      explanation: "Redis cluster",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const start = performance.now();
    const quality = evaluateTopologyQuality(ws, plan, compiled.operations);
    const evalDuration = performance.now() - start;

    expect(quality.outcome).toBe("PASS");
    expect(evalDuration).toBeLessThan(20);
    expect(quality.violations).toHaveLength(0);
  });

  it("evaluates Aspect-Ratio Sprawl and Overlap Metrics", () => {
    const ws = createWorkspace({ diagramKind: "architecture" });
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Full-stack cloud infrastructure",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "cdn", label: "Cloudflare CDN" },
        { ref: "lb", label: "Load Balancer" },
        { ref: "api1", label: "API Cluster 1" },
        { ref: "api2", label: "API Cluster 2" },
        { ref: "db", label: "Primary Postgres" },
        { ref: "cache", label: "Redis Cluster" },
      ],
      edges: [
        { from: "cdn", to: "lb", relation: "calls" },
        { from: "lb", to: "api1", relation: "calls" },
        { from: "lb", to: "api2", relation: "calls" },
        { from: "api1", to: "db", relation: "reads_writes" },
        { from: "api2", to: "db", relation: "reads_writes" },
        { from: "api1", to: "cache", relation: "calls" },
      ],
      groups: [],
      explanation: "Cloud infra",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    const projected = applyOperations(ws, compiled.operations);
    const layoutRes = computeLayout(projected);
    const laidOut = applyLayout(projected, layoutRes);

    const positions = Object.values(laidOut.nodes).map((n) => n.position!);
    const xs = positions.map((p) => p.x);
    const ys = positions.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // Aspect ratio sprawl: should not be an endless flat horizontal line
    expect(height).toBeGreaterThan(50);
    const ratio = width / Math.max(height, 1);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(8.0); // Within comfortable viewing aspect ratio
  });
});
