import { describe, expect, it, vi } from "vitest";
import { createWorkspace, type Operation, type SemanticPlan } from "@lucent/core";
import {
  evaluateProposalPolicy,
  isDestructiveOperation,
  isHighImpactOperation,
} from "../src/proposalPolicy.js";
import { orchestrateGeneration } from "../src/orchestrator.js";
import { InMemoryBoardStore, newBoardId } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { RealtimeServer } from "../src/realtime.js";
import { MockProvider } from "@lucent/ai";
import { Room } from "../src/room.js";

describe("Risk-Based Proposal Policy (Unit Tests)", () => {
  it("classifies destructive operations correctly", () => {
    const destructive: Operation[] = [
      { op: "DELETE_NODE", id: "n1" },
      { op: "DELETE_GROUP", id: "g1" },
      { op: "DELETE_SHAPE", id: "s1" },
      { op: "DELETE_WIREFRAME", id: "w1" },
      { op: "TRANSFORM_DIAGRAM", to: "mindmap" },
      { op: "DISCONNECT_NODES", source: "n1", target: "n2", relationship: "calls" },
      { op: "DISCONNECT_SHAPES", id: "sl1" },
      { op: "CLEAR_VOTES" },
      { op: "REMOVE_VOTE", id: "v1" },
      { op: "REMOVE_REACTION", id: "r1" },
      { op: "DELETE_COMMENT", id: "c1" },
    ];

    for (const op of destructive) {
      expect(isDestructiveOperation(op)).toBe(true);
      expect(isHighImpactOperation(op)).toBe(true);
    }

    const safe: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "Step 1" },
      { op: "CONNECT_NODES", source: "n1", target: "n2", relationship: "calls" },
      { op: "CREATE_GROUP", id: "g1", label: "Backend", children: ["n1"] },
      { op: "SET_ISSUE", id: "n1", issue: { type: "story", status: "open" } },
      { op: "SET_STATEMENT", id: "n1", statement: { kind: "decision", status: "open" } },
    ];

    for (const op of safe) {
      expect(isDestructiveOperation(op)).toBe(false);
      expect(isHighImpactOperation(op)).toBe(false);
    }
  });

  it("single-op DELETE_NODE plan requires proposal (MUST NOT bypass because count <= 5)", () => {
    const singleOp: Operation[] = [{ op: "DELETE_NODE", id: "auth_service" }];
    const decision = evaluateProposalPolicy({
      operations: singleOp,
      existingNodeCount: 10,
    });

    expect(decision.requiresProposal).toBe(true);
    expect(decision.riskLevel).toBe("critical");
    expect(decision.destructiveOps).toContain("DELETE_NODE");
    expect(decision.reason).toMatch(/destructive operation/i);
  });

  it("single-op TRANSFORM_DIAGRAM plan requires proposal", () => {
    const singleOp: Operation[] = [{ op: "TRANSFORM_DIAGRAM", to: "mindmap" }];
    const decision = evaluateProposalPolicy({
      operations: singleOp,
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(true);
    expect(decision.riskLevel).toBe("critical");
    expect(decision.destructiveOps).toContain("TRANSFORM_DIAGRAM");
  });

  it("single-op DELETE_GROUP plan requires proposal", () => {
    const singleOp: Operation[] = [{ op: "DELETE_GROUP", id: "core_cluster" }];
    const decision = evaluateProposalPolicy({
      operations: singleOp,
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(true);
    expect(decision.riskLevel).toBe("critical");
    expect(decision.destructiveOps).toContain("DELETE_GROUP");
  });

  it("high-impact plan scope 'reorganize_only' requires proposal even if ops are additive", () => {
    const additiveOps: Operation[] = [
      { op: "CREATE_NODE", id: "gateway", nodeType: "system", label: "Gateway" },
    ];
    const plan: SemanticPlan = {
      intent: {
        userObjective: "Reorganize the entire architecture into microservices",
        targetKind: "architecture",
        expectedTopology: "relational_network",
        mutationScope: "reorganize_only",
        focusNodeIds: [],
      },
      nodes: [{ ref: "gateway", label: "Gateway", role: "system" }],
      edges: [],
      groups: [],
      explanation: "Restructure board to microservices",
    };

    const decision = evaluateProposalPolicy({
      operations: additiveOps,
      plan,
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(true);
    expect(decision.riskLevel).toBe("high");
    expect(decision.isHighImpact).toBe(true);
    expect(decision.reason).toMatch(/reorganize_only/i);
  });

  it("single-op additive plan on existing board auto-applies with low risk", () => {
    const singleOp: Operation[] = [
      { op: "CREATE_NODE", id: "logger", nodeType: "step", label: "Logger" },
    ];
    const decision = evaluateProposalPolicy({
      operations: singleOp,
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(false);
    expect(decision.riskLevel).toBe("low");
  });

  it("mode='never' still enforces human review for destructive operations", () => {
    // Contract: "Never — auto-apply, still review destructive/external"
    const destructiveOp: Operation[] = [{ op: "DELETE_NODE", id: "victim" }];
    const decision = evaluateProposalPolicy({
      operations: destructiveOp,
      mode: "never",
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(true);
    expect(decision.riskLevel).toBe("critical");
  });

  it("mode='never' allows safe additive operations exceeding threshold", () => {
    const batchOps: Operation[] = Array.from({ length: 8 }, (_, i) => ({
      op: "CREATE_NODE",
      id: `node_${i}`,
      nodeType: "step",
      label: `Node ${i}`,
    }));

    const decision = evaluateProposalPolicy({
      operations: batchOps,
      mode: "never",
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(false);
  });

  it("mode='always' gates even single additive operations", () => {
    const singleSafeOp: Operation[] = [
      { op: "CREATE_NODE", id: "safe_node", nodeType: "step", label: "Safe" },
    ];
    const decision = evaluateProposalPolicy({
      operations: singleSafeOp,
      mode: "always",
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(true);
  });

  it("forceApply=true overrides policy when caller is explicitly authorized", () => {
    const destructiveOp: Operation[] = [{ op: "DELETE_NODE", id: "victim" }];
    const decision = evaluateProposalPolicy({
      operations: destructiveOp,
      forceApply: true,
      existingNodeCount: 5,
    });

    expect(decision.requiresProposal).toBe(false);
    expect(decision.reason).toMatch(/force applied/i);
  });
});

describe("Risk-Based Proposal Gating in Orchestrator (Integration Tests)", () => {
  it("orchestrateGeneration gates high-impact restructure plan into ProposalStore", async () => {
    const boardStore = new InMemoryBoardStore();
    const proposalStore = new InMemoryProposalStore();

    const ws = createWorkspace();
    ws.nodes.legacy_node = {
      id: "legacy_node",
      label: "Legacy System",
      nodeType: "step",
      position: { x: 10, y: 10 },
    };

    const board = {
      id: "board_arch_test",
      orgId: "org_test",
      name: "Architecture Board",
      ownerId: "usr_alice",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const room = new Room(board.id, board.workspace, board.ownerId);
    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);
    const server = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => undefined,
    });
    (server as any).rooms.set(board.id, room);

    const broadcastedProposals: any[] = [];
    const services: any = {
      boardStore,
      proposals: proposalStore,
      provider: new MockProvider(),
      realtimeServer: server,
      commitForBoard: (bId: string, uId: string, ops: any[], lbl: string, meta: any) =>
        server.commitForBoard(bId, uId, ops, lbl, meta),
      broadcastProposal: vi.fn().mockImplementation((_boardId, evt) => {
        broadcastedProposals.push(evt);
      }),
    };

    // Caller provides a high-impact restructure plan
    const destructivePlan: SemanticPlan = {
      intent: {
        userObjective: "Restructure entire architecture",
        targetKind: "flowchart",
        expectedTopology: "independent_clusters",
        mutationScope: "reorganize_only",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "gateway", label: "Gateway", role: "system" },
      ],
      edges: [],
      groups: [],
      explanation: "Restructure architecture",
    };

    const outcome = await orchestrateGeneration(services, {
      boardId: board.id,
      userId: "usr_alice",
      prompt: "Restructure entire architecture",
      actor: "user",
      role: "editor",
      plan: destructivePlan,
    });

    // Verification:
    // 1. Outcome must be "proposed", NOT committed!
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.outcome !== "proposed") {
      throw new Error(`Expected proposed outcome, got: ${JSON.stringify(outcome)}`);
    }

    expect(outcome.outcome).toBe("proposed");
    expect(outcome.proposalId).toBeDefined();
    expect(outcome.reason).toMatch(/reorganize_only/i);

    // 2. Proposal must be durably recorded in ProposalStore
    const stored = await proposalStore.get(board.id, outcome.proposalId);
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("pending");
    expect(stored?.operations.length).toBeGreaterThan(0);

    // 3. Realtime room and stored board workspace must NOT be modified yet!
    expect(room.current().nodes.legacy_node).toBeDefined();
    expect(room.current().nodes.gateway).toBeUndefined();
    const freshBoard = await boardStore.get(board.id);
    expect(freshBoard?.workspace.nodes.legacy_node).toBeDefined();
    expect(freshBoard?.workspace.nodes.gateway).toBeUndefined();

    // 4. broadcastProposal must have been called with proposal-opened
    expect(services.broadcastProposal).toHaveBeenCalled();
    expect(broadcastedProposals.length).toBeGreaterThanOrEqual(1);
    expect(broadcastedProposals[0].type).toBe("proposal-opened");
  });

  it("orchestrateGeneration auto-commits low-risk additive plan directly to live room", async () => {
    const boardStore = new InMemoryBoardStore();
    const proposalStore = new InMemoryProposalStore();

    const ws = createWorkspace();
    const board = {
      id: "board_new_arch_test",
      orgId: "org_test",
      name: "New Architecture Board",
      ownerId: "usr_alice",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const room = new Room(board.id, board.workspace, board.ownerId);
    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);
    const server = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => undefined,
    });
    (server as any).rooms.set(board.id, room);

    const services: any = {
      boardStore,
      proposals: proposalStore,
      provider: new MockProvider(),
      realtimeServer: server,
      commitForBoard: (bId: string, uId: string, ops: any[], lbl: string, meta: any) =>
        server.commitForBoard(bId, uId, ops, lbl, meta),
    };

    const additivePlan: SemanticPlan = {
      intent: {
        userObjective: "Add payment gateway",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "extend_region",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "stripe_gateway", label: "Stripe Gateway", role: "step" },
      ],
      edges: [],
      groups: [],
      explanation: "Add Stripe payment gateway node",
    };

    const outcome = await orchestrateGeneration(services, {
      boardId: board.id,
      userId: "usr_alice",
      prompt: "Add payment gateway",
      actor: "user",
      role: "editor",
      plan: additivePlan,
    });

    // Verification:
    // 1. Outcome must be "committed"
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.outcome !== "committed") {
      throw new Error(`Expected committed outcome, got: ${JSON.stringify(outcome)}`);
    }

    expect(outcome.outcome).toBe("committed");
    expect(outcome.seq).toBe(1);

    // 2. ProposalStore must remain empty
    const pending = await proposalStore.pendingForBoards([board.id]);
    expect(pending).toHaveLength(0);

    // 3. Room current workspace immediately contains the new node
    const nodeKeys = Object.keys(room.current().nodes);
    expect(nodeKeys.length).toBe(1);
    const createdNode = Object.values(room.current().nodes)[0];
    expect(createdNode?.label).toBe("Stripe Gateway");
  });

  it("orchestrator strictly forbids editors or agents from using forceApply on destructive plans", async () => {
    const boardStore = new InMemoryBoardStore();
    const proposalStore = new InMemoryProposalStore();

    const ws = createWorkspace();
    ws.nodes.victim_node = {
      id: "victim_node",
      label: "Critical Service",
      nodeType: "step",
    };

    const board = {
      id: newBoardId(),
      orgId: "org_test",
      name: "Destructive Test Board",
      ownerId: "usr_owner_real",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const room = new Room(board.id, board.workspace, board.ownerId);
    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);
    const server = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => undefined,
    });
    (server as any).rooms.set(board.id, room);

    const services: any = {
      boardStore,
      proposals: proposalStore,
      provider: new MockProvider(),
      realtimeServer: server,
      commitForBoard: (bId: string, uId: string, ops: any[], lbl: string, meta: any) =>
        server.commitForBoard(bId, uId, ops, lbl, meta),
    };

    const destructivePlan: SemanticPlan = {
      intent: {
        userObjective: "Reorganize architecture with new edge gateway",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "reorganize_only",
        focusNodeIds: [],
      },
      nodes: [
        {
          ref: "edge_gw",
          label: "New Edge Gateway",
          role: "step",
        },
      ],
      edges: [
        {
          from: "edge_gw",
          to: "victim_node",
          relation: "calls",
        },
      ],
      groups: [],
      explanation: "Restructure architecture with edge gateway",
    };

    // 1. Editor passes forceApply: true -> MUST NOT BYPASS! Gated behind proposal!
    const editorOutcome = await orchestrateGeneration(services, {
      boardId: board.id,
      userId: "usr_editor_1",
      prompt: "Delete critical service",
      actor: "user",
      role: "editor", // Editor is NOT owner!
      forceApply: true,
      plan: destructivePlan,
    });
    expect(editorOutcome.ok).toBe(true);
    expect(editorOutcome.outcome).toBe("proposed"); // Must be proposed, NOT committed!

    // 2. Agent passes forceApply: true -> MUST NOT BYPASS! Gated behind proposal!
    const agentOutcome = await orchestrateGeneration(services, {
      boardId: board.id,
      userId: "usr_owner_real",
      prompt: "Delete critical service",
      actor: "agent", // AI/agent actor cannot force-apply!
      role: "owner",
      forceApply: true,
      plan: destructivePlan,
    });
    expect(agentOutcome.ok).toBe(true);
    expect(agentOutcome.outcome).toBe("proposed");

    // 3. Authenticated Human Owner passes forceApply: true -> Authorized! Directly committed!
    const ownerOutcome = await orchestrateGeneration(services, {
      boardId: board.id,
      userId: "usr_owner_real",
      prompt: "Delete critical service with owner confirmation",
      actor: "user",
      role: "owner", // Owner human
      forceApply: true,
      plan: destructivePlan,
    });
    expect(ownerOutcome.ok).toBe(true);
    expect(ownerOutcome.outcome).toBe("committed");
  });
});
