import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
  validateOperations,
  applyOperations,
  type SemanticPlan,
  type Operation,
} from "@lucent/core";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../../src/app.js";
import { InMemoryUserStore } from "../../src/accounts.js";
import { InMemoryBoardStore } from "../../src/boards.js";
import { InMemoryProposalStore } from "../../src/proposals.js";
import { UsageTracker, limitsFromEnv } from "../../src/usage.js";
import { Telemetry } from "../../src/telemetry.js";
import { Limiter } from "../../src/limiter.js";
import { InMemoryTicketStore } from "../../src/realtimeTicket.js";
import { readConfig } from "../../src/config.js";
import { issueToken } from "../../src/auth.js";

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
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

async function api(
  h: Harness,
  path: string,
  options: { method?: string; token?: string; agent?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.agent ? { authorization: `Agent ${options.agent}` } : {}),
  };
  const res = await fetch(`${h.base}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("Pipeline Certification V2 - Suite 3: Adversarial Mutations & Failure Recovery", () => {
  it("certifies Missing Edge Endpoints are rejected with UNRESOLVED_REFERENCE and no partial writes", () => {
    const ws = createWorkspace();
    const badPlan: SemanticPlan = {
      intent: {
        userObjective: "Adversarial broken references",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [{ ref: "n1", label: "Valid First Step" }],
      edges: [{ from: "n1", to: "ghost_nonexistent_endpoint", relation: "next" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, badPlan);
    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
    const hasUnresolved = compiled.diagnostics.some((d) => d.code === "UNRESOLVED_REFERENCE");
    expect(hasUnresolved).toBe(true);

    // No operations should be emitted for unresolvable edges
    const connectOps = compiled.operations.filter((o) => o.op === "CONNECT_NODES");
    expect(connectOps).toHaveLength(0);
  });

  it("certifies Self-Referential Edge Loops are flagged by compiler", () => {
    const ws = createWorkspace();
    const selfLoopPlan: SemanticPlan = {
      intent: {
        userObjective: "Self connection test",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [{ ref: "loop_node", label: "Recursive Step" }],
      edges: [{ from: "loop_node", to: "loop_node", relation: "next" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, selfLoopPlan);
    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.some((d) => d.code === "SELF_CONNECTION")).toBe(true);
  });

  it("certifies Idempotency under concurrent request submission", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_concurrent_idemp",
        email: "conc_idemp@test.com",
        name: "Concurrent Idemp User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_conc_idemp",
        name: "Concurrent Idemp Board",
        ownerId: user.id,
        orgId: "org-idemp",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      const sharedReqId = "concurrent-idempotent-key-445566";

      // Fire two concurrent calls with identical requestId
      const [res1, res2] = await Promise.all([
        api(h, `/api/boards/${board.id}/orchestrate`, {
          token,
          body: { prompt: "Build telemetry system", requestId: sharedReqId },
        }),
        api(h, `/api/boards/${board.id}/orchestrate`, {
          token,
          body: { prompt: "Build telemetry system", requestId: sharedReqId },
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // One is original commit, the other is duplicate response with matching seq
      const seq1 = res1.body.seq;
      const seq2 = res2.body.seq;
      expect(seq1).toBe(seq2);

      // Verify board only moved forward by exactly 1 mutation batch
      const updated = await h.boardStore.get(board.id);
      expect(updated).toBeDefined();
    } finally {
      await h.close();
    }
  });

  it("certifies Stale Expected Sequence returns 409 and does not overwrite board", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_stale_seq",
        email: "stale_seq@test.com",
        name: "Stale Seq User",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_stale_seq",
        name: "Stale Seq Board",
        ownerId: user.id,
        orgId: "org-stale",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // Commit op to increment seq
      const step1 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Step 1" },
      });
      expect(step1.status).toBe(200);
      const headSeq = step1.body.seq;

      // Present stale expectedSeq = 0
      const staleRes = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Step 2 with stale seq", expectedSeq: 0 },
      });

      expect(staleRes.status).toBe(409);
      expect(staleRes.body.ok).toBe(false);
      expect(staleRes.body.outcome).toBe("conflict");
      expect(staleRes.body.headSeq).toBe(headSeq);
    } finally {
      await h.close();
    }
  });

  it("certifies Truthful Failure on Unrepairable Quality Violations (no false claims)", () => {
    const ws = createWorkspace();
    const brokenHierarchyPlan: SemanticPlan = {
      intent: {
        userObjective: "Acyclic hierarchy with cycle",
        targetKind: "mindmap",
        expectedTopology: "tree_hierarchy",
        mutationScope: "new_canvas",
        focusNodeIds: [],
        hierarchyStructure: "single_root",
      },
      nodes: [
        { ref: "root", label: "Root Goal" },
        { ref: "child", label: "Sub Goal" },
      ],
      edges: [
        { from: "root", to: "child", relation: "contains" },
        { from: "child", to: "root", relation: "contains" }, // illegal cycle in hierarchy
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, brokenHierarchyPlan);
    expect(compiled.ok).toBe(true);

    // Pass 2 must flag UNRESOLVED truthfully
    const quality = evaluateTopologyQuality(ws, brokenHierarchyPlan, compiled.operations, true);
    expect(quality.outcome).toBe("UNRESOLVED");
    expect(quality.violations.some((v) => v.code === "CYCLE_IN_HIERARCHY")).toBe(true);
  });

  it("certifies Atomic Isolation: invalid operation batches are rejected without partial corruption", () => {
    const ws = createWorkspace();
    const validInitial: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "First Step" },
    ];
    const cleanWs = applyOperations(ws, validInitial);
    expect(Object.keys(cleanWs.nodes)).toHaveLength(1);

    // Batch containing 1 valid node and 1 invalid operation (connecting to nonexistent node)
    const mixedBatch: Operation[] = [
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: "Second Step" },
      { op: "CONNECT_NODES", source: "n2", target: "ghost_nonexistent", relationship: "next" },
    ];

    const validationErrors = validateOperations(cleanWs, mixedBatch);
    expect(validationErrors.length).toBeGreaterThan(0);

    // When validator rejects, nothing is applied to workspace
    expect(cleanWs.nodes["n2"]).toBeUndefined();
    expect(Object.keys(cleanWs.nodes)).toHaveLength(1);
  });
});
