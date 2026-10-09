import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
  computeLayout,
  applyOperations,
  type SemanticPlan,
  type Operation,
} from "@lucent/core";
import { classifyIntentFastPath, MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../../src/app.js";
import { InMemoryUserStore } from "../../src/accounts.js";
import { InMemoryBoardStore } from "../../src/boards.js";
import { InMemoryProposalStore } from "../../src/proposals.js";
import { UsageTracker } from "../../src/usage.js";
import { Telemetry } from "../../src/telemetry.js";
import { Limiter } from "../../src/limiter.js";
import { InMemoryTicketStore } from "../../src/realtimeTicket.js";
import { readConfig } from "../../src/config.js";
import { issueToken } from "../../src/auth.js";

const SECRET = "test-secret-at-least-16-chars";

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (pct: number) =>
    sorted[Math.min(Math.floor(sorted.length * (pct / 100)), sorted.length - 1)]!;
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    p50: p(50),
    p90: p(90),
    p95: p(95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: sum / samples.length,
  };
}

interface Harness {
  base: string;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = { perWindow: 10_000, windowMs: 60_000, perDay: 100_000 };
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, boardStore, userStore, close };
}

describe("Pipeline Certification V2 - Suite 5: Warm-Up Benchmarks & Statistical Distributions", () => {
  it("benchmarks Deterministic Intent Classification with warm-up and p50/p95 latency", () => {
    const ws = createWorkspace();
    const prompt =
      "Design an event-driven microservices architecture with Kafka, Postgres, and Redis";

    // 10 Warm-up runs
    for (let i = 0; i < 10; i++) {
      classifyIntentFastPath(prompt, ws);
    }

    // 100 Measurement iterations
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      const res = classifyIntentFastPath(prompt, ws);
      const t1 = performance.now();
      samples.push(t1 - t0);
      expect(res?.targetKind).toBe("architecture");
    }

    const stats = percentiles(samples);
    expect(stats.p50).toBeLessThan(1.0); // Sub-1ms median
    expect(stats.p95).toBeLessThan(5.0); // Sub-5ms p95
  });

  it("benchmarks Semantic Plan Compilation latency across 50 iterations", () => {
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
        { ref: "gw", label: "API Gateway", role: "gateway" },
        { ref: "auth", label: "Auth Service", role: "service" },
        { ref: "user", label: "User Service", role: "service" },
        { ref: "db", label: "PostgreSQL Database", role: "database" },
        { ref: "redis", label: "Redis Cache Cluster", role: "database" },
      ],
      edges: [
        { from: "gw", to: "auth", relation: "calls" },
        { from: "gw", to: "user", relation: "calls" },
        { from: "auth", to: "db", relation: "reads_writes" },
        { from: "user", to: "db", relation: "reads_writes" },
        { from: "user", to: "redis", relation: "reads_writes" },
      ],
      groups: [{ ref: "g1", label: "Backend Core", memberRefs: ["auth", "user"] }],
      explanation: "Caching cluster",
    };

    // 10 Warm-up runs
    for (let i = 0; i < 10; i++) {
      compileSemanticPlan(ws, plan);
    }

    // 50 Measurement runs
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = compileSemanticPlan(ws, plan);
      const t1 = performance.now();
      samples.push(t1 - t0);
      expect(res.ok).toBe(true);
    }

    const stats = percentiles(samples);
    expect(stats.p50).toBeLessThan(2.0); // Sub-2ms median
    expect(stats.p95).toBeLessThan(10.0); // Sub-10ms p95
  });

  it("benchmarks Topology Quality Gate Evaluation across 50 iterations", () => {
    const ws = createWorkspace();
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Quality gate benchmark",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "s1", label: "Service A" },
        { ref: "s2", label: "Service B" },
        { ref: "s3", label: "Service C" },
      ],
      edges: [
        { from: "s1", to: "s2", relation: "calls" },
        { from: "s2", to: "s3", relation: "calls" },
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, plan);
    expect(compiled.ok).toBe(true);

    // 10 Warm-up runs
    for (let i = 0; i < 10; i++) {
      evaluateTopologyQuality(ws, plan, compiled.operations);
    }

    // 50 Measurement runs
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const res = evaluateTopologyQuality(ws, plan, compiled.operations);
      const t1 = performance.now();
      samples.push(t1 - t0);
      expect(res.outcome).toBe("PASS");
    }

    const stats = percentiles(samples);
    expect(stats.p50).toBeLessThan(2.0);
    expect(stats.p95).toBeLessThan(10.0);
  });

  it("benchmarks Layout Engine latency scaling from 20 to 100 nodes", () => {
    // 20 Nodes
    let ws20 = createWorkspace({ diagramKind: "flowchart" });
    const ops20: Operation[] = [];
    for (let i = 0; i < 20; i++) {
      ops20.push({ op: "CREATE_NODE", id: `n20_${i}`, nodeType: "step", label: `Step ${i}` });
      if (i > 0) {
        ops20.push({
          op: "CONNECT_NODES",
          source: `n20_${i - 1}`,
          target: `n20_${i}`,
          relationship: "next",
        });
      }
    }
    ws20 = applyOperations(ws20, ops20);

    // Warm-up
    computeLayout(ws20);

    const samples20: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      computeLayout(ws20);
      samples20.push(performance.now() - t0);
    }
    const stats20 = percentiles(samples20);
    expect(stats20.p50).toBeLessThan(15.0);

    // 100 Nodes
    let ws100 = createWorkspace({ diagramKind: "flowchart" });
    const ops100: Operation[] = [];
    for (let i = 0; i < 100; i++) {
      ops100.push({ op: "CREATE_NODE", id: `n100_${i}`, nodeType: "step", label: `Stage ${i}` });
      if (i > 0) {
        ops100.push({
          op: "CONNECT_NODES",
          source: `n100_${i - 1}`,
          target: `n100_${i}`,
          relationship: "next",
        });
      }
    }
    ws100 = applyOperations(ws100, ops100);

    // Warm-up
    computeLayout(ws100);

    const samples100: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      computeLayout(ws100);
      samples100.push(performance.now() - t0);
    }
    const stats100 = percentiles(samples100);
    expect(stats100.p50).toBeLessThan(50.0);
    expect(stats100.p95).toBeLessThan(120.0);
  });

  it("benchmarks Full End-to-End HTTP Server Orchestration Latency", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_bench_e2e",
        email: "bench_e2e@test.com",
        name: "Bench User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_bench_e2e",
        name: "Bench Board",
        ownerId: user.id,
        orgId: "org-bench",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      const apiCall = async (prompt: string, reqId: string) => {
        const res = await fetch(`${h.base}/api/boards/${board.id}/orchestrate`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ prompt, requestId: reqId }),
        });
        return res;
      };

      // 3 Warm-up calls
      for (let w = 0; w < 3; w++) {
        await apiCall(`Warmup step ${w}`, `warmup-${w}`);
      }

      // 20 Measurement calls
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const res = await apiCall(`Bench run step ${i}`, `bench-run-${i}`);
        const t1 = performance.now();
        expect(res.status).toBe(200);
        samples.push(t1 - t0);
      }

      const stats = percentiles(samples);
      expect(stats.p50).toBeLessThan(35.0); // Sub-35ms p50 end-to-end
      expect(stats.p95).toBeLessThan(80.0); // Sub-80ms p95 end-to-end
    } finally {
      await h.close();
    }
  });
});
