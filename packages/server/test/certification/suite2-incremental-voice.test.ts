import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
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
  return { status: res.status, body: (await res.json()) as any };
}

describe("Pipeline Certification v1 - Suite 2: Incremental Voice Construction", () => {
  it("certifies multi-turn incremental construction preserves existing objects across turns", () => {
    // Stage 1: Initial creation of checkout and billing
    let ws = createWorkspace({ diagramKind: "flowchart" });

    const initialPlan: SemanticPlan = {
      intent: {
        userObjective: "Build checkout and billing flow",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "chk", label: "Checkout Page" },
        { ref: "bill", label: "Billing Service" },
      ],
      edges: [{ from: "chk", to: "bill", relation: "next" }],
      groups: [],
      explanation: "Initial checkout and billing",
    };

    const c1 = compileSemanticPlan(ws, initialPlan);
    expect(c1.ok).toBe(true);
    ws = applyOperations(ws, c1.operations);

    const initialNodes = Object.values(ws.nodes);
    expect(initialNodes).toHaveLength(2);
    const checkoutNodeId = initialNodes.find((n) => n.label === "Checkout Page")!.id;
    const billingNodeId = initialNodes.find((n) => n.label === "Billing Service")!.id;

    // Stage 2: Incremental addition ("Add Stripe payment processor")
    const addStripePlan: SemanticPlan = {
      intent: {
        userObjective: "Add Stripe to billing service",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "extend_region",
        focusNodeIds: [billingNodeId],
      },
      nodes: [
        { ref: "stripe", label: "Stripe API", role: "service" },
        // Reference existing billing node!
        { ref: "b_ref", label: "Billing Service", existingNodeId: billingNodeId },
      ],
      edges: [{ from: "b_ref", to: "stripe", relation: "calls", label: "Charges" }],
      groups: [],
      explanation: "Added Stripe integration to Billing",
    };

    const c2 = compileSemanticPlan(ws, addStripePlan);
    expect(c2.ok).toBe(true);
    const q2 = evaluateTopologyQuality(ws, addStripePlan, c2.operations);
    expect(q2.outcome).toBe("PASS");

    // Apply incremental addition
    ws = applyOperations(ws, c2.operations);

    // Invariant: Existing Checkout Page and Billing Service IDs are strictly preserved!
    expect(ws.nodes[checkoutNodeId]).toBeDefined();
    expect(ws.nodes[billingNodeId]).toBeDefined();
    expect(ws.nodes[checkoutNodeId]?.label).toBe("Checkout Page");
    expect(ws.nodes[billingNodeId]?.label).toBe("Billing Service");

    // Verify Stripe node was created and connected to billing
    const stripeNode = Object.values(ws.nodes).find((n) => n.label === "Stripe API");
    expect(stripeNode).toBeDefined();
    expect(Object.keys(ws.nodes)).toHaveLength(3);

    const stripeEdge = Object.values(ws.edges).find(
      (e) => e.source === billingNodeId && e.target === stripeNode!.id,
    );
    expect(stripeEdge).toBeDefined();

    // Stage 3: Incremental modification ("Modify the refund path")
    const refundPlan: SemanticPlan = {
      intent: {
        userObjective: "Add refund processing path from billing",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "extend_region",
        focusNodeIds: [billingNodeId, stripeNode!.id],
      },
      nodes: [
        { ref: "ref_node", label: "Refund Handler" },
        { ref: "b_ref", label: "Billing Service", existingNodeId: billingNodeId },
        { ref: "s_ref", label: "Stripe API", existingNodeId: stripeNode!.id },
      ],
      edges: [
        { from: "b_ref", to: "ref_node", relation: "next", label: "Dispute" },
        { from: "ref_node", to: "s_ref", relation: "calls", label: "Refund API" },
      ],
      groups: [],
      explanation: "Wired refund path",
    };

    const c3 = compileSemanticPlan(ws, refundPlan);
    expect(c3.ok).toBe(true);
    const q3 = evaluateTopologyQuality(ws, refundPlan, c3.operations);
    expect(q3.outcome).toBe("PASS");

    ws = applyOperations(ws, c3.operations);

    // Invariant: No unrelated objects regenerated; original IDs intact
    expect(ws.nodes[checkoutNodeId]).toBeDefined();
    expect(ws.nodes[billingNodeId]).toBeDefined();
    expect(ws.nodes[stripeNode!.id]).toBeDefined();
    expect(Object.keys(ws.nodes)).toHaveLength(4);
  });

  it("certifies LiveKit voice agent tool convergence on /api/boards/:id/orchestrate", async () => {
    const h = await harness();
    try {
      // 1. Create user and board
      const user = {
        id: "usr_voice_owner",
        email: "owner-voice@test.com",
        name: "Voice Owner",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_voice_1",
        name: "Voice Construction Board",
        ownerId: user.id,
        orgId: "org-voice",
        workspace: createWorkspace({ diagramKind: "flowchart" }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // 2. Invoke orchestrate endpoint (the LiveKit voice agent construct_diagram call path)
      const orchRes = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: {
          prompt: "Build an authentication flow with login, 2FA, and dashboard",
        },
      });

      expect(orchRes.status).toBe(200);
      const orchData = orchRes.body as {
        ok: boolean;
        outcome: string;
        seq: number;
        operations: Operation[];
        explanation: string;
      };

      expect(orchData.ok).toBe(true);
      expect(orchData.outcome).toBe("committed");
      expect(orchData.seq).toBeGreaterThan(0);
      expect(orchData.operations.length).toBeGreaterThan(0);

      // 3. Verify server state directly
      const updated = await h.boardStore.get(board.id);
      expect(Object.keys(updated!.workspace.nodes).length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });
});
