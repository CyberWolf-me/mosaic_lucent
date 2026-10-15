import { describe, expect, it, vi } from "vitest";
import { createWorkspace, type Operation } from "@lucent/core";
import { RealtimeServer } from "../src/realtime.js";
import { InMemoryBoardStore, newBoardId } from "../src/boards.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import type { FanoutMessage } from "../src/fanout.js";

describe("Cross-Worker Fanout: Complete Coverage for All 6 Declared Categories", () => {
  it("Two workers synchronize across all 6 categories (op, presence, resync, proposal, spotlight, summon) and recover durably after lost notifications", async () => {
    // Shared bus delivering between instances
    const busListeners: ((msg: FanoutMessage) => void)[] = [];
    let dropNotifications = false;

    const mockBus = {
      publish: vi.fn().mockImplementation(async (msg: FanoutMessage) => {
        if (dropNotifications && msg.kind === "op") {
          // Simulate lost notification over network / dropped pg_notify
          return;
        }
        for (const l of [...busListeners]) l(msg);
      }),
      subscribe: vi.fn().mockImplementation((_boardId: string, listener: (msg: FanoutMessage) => void) => {
        busListeners.push(listener);
        return () => {
          const idx = busListeners.indexOf(listener);
          if (idx !== -1) busListeners.splice(idx, 1);
        };
      }),
      close: async () => {},
    };

    const boardStore = new InMemoryBoardStore();
    const ws = createWorkspace();
    const board = {
      id: newBoardId(),
      orgId: "org_multiworker",
      ownerId: "usr_owner",
      name: "Distributed Canvas",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);

    // Worker 1
    const worker1 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "worker_1",
    });

    // Worker 2
    const worker2 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "worker_2",
    });

    const room1 = await (worker1 as any).roomFor(board.id, board.workspace, board.ownerId);
    const room2 = await (worker2 as any).roomFor(board.id, board.workspace, board.ownerId);

    // Connected socket on Worker 1 (Alice)
    const aliceSocket = { readyState: 1, send: vi.fn() };
    const aliceConn = { socket: aliceSocket as any, userId: "usr_alice", name: "Alice", boardId: board.id };
    room1.setRole("usr_alice", "editor");
    (worker1 as any).connsByBoard.set(board.id, new Set([aliceConn]));

    // Connected socket on Worker 2 (Bob)
    const bobSocket = { readyState: 1, send: vi.fn() };
    const bobConn = { socket: bobSocket as any, userId: "usr_bob", name: "Bob", boardId: board.id };
    room2.setRole("usr_bob", "editor");
    (worker2 as any).connsByBoard.set(board.id, new Set([bobConn]));

    // -------------------------------------------------------------
    // CATEGORY 1: "op"
    // -------------------------------------------------------------
    const op1: Operation = { op: "CREATE_NODE", id: "node_1", nodeType: "step", label: "Initial Step" };
    const commit1 = await worker1.commitForBoard(board.id, "usr_alice", [op1], "Add initial step", { role: "editor" });
    expect(commit1?.ok).toBe(true);

    // Worker 2 should receive fanout, pull from op log, absorb op, and send to Bob
    await new Promise((r) => setTimeout(r, 50));
    expect(room2.current().nodes.node_1).toBeDefined();
    expect(room2.current().nodes.node_1?.label).toBe("Initial Step");
    const bobOpFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobOpFrames.some((f) => f.type === "op" && f.entry?.seq === 1)).toBe(true);

    // -------------------------------------------------------------
    // CATEGORY 2: "presence"
    // -------------------------------------------------------------
    bobSocket.send.mockClear();
    aliceSocket.send.mockClear();

    (worker1 as any).presence(aliceConn, {
      type: "presence",
      cursor: { x: 300, y: 450 },
      selection: ["node_1"],
    });

    await new Promise((r) => setTimeout(r, 50));
    const bobPresenceFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(
      bobPresenceFrames.some(
        (f) => f.type === "presence" && f.presence?.userId === "usr_alice" && f.presence?.cursor?.x === 300,
      ),
    ).toBe(true);
    // No echo to Alice on Worker 1
    const alicePresenceEcho = aliceSocket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((f) => f.type === "presence" && f.presence?.userId === "usr_alice");
    expect(alicePresenceEcho.length).toBe(0);

    // -------------------------------------------------------------
    // CATEGORY 3: "proposal"
    // -------------------------------------------------------------
    bobSocket.send.mockClear();
    const proposalEvent = {
      type: "proposal-opened",
      proposal: {
        id: "prp_fanout_test",
        boardId: board.id,
        status: "pending",
        request: "Add payment service",
        operations: [{ op: "CREATE_NODE", id: "pay_node", nodeType: "step", label: "Payments" }],
      },
    };
    worker1.broadcastProposal(board.id, proposalEvent);

    await new Promise((r) => setTimeout(r, 50));
    const bobProposalFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobProposalFrames.some((f) => f.type === "proposal-opened" && f.proposal?.id === "prp_fanout_test")).toBe(true);

    // -------------------------------------------------------------
    // CATEGORY 4: "spotlight"
    // -------------------------------------------------------------
    bobSocket.send.mockClear();
    (worker1 as any).spotlight(aliceConn, true);
    expect(room1.spotlight()).toEqual({ userId: "usr_alice", name: "Alice" });

    await new Promise((r) => setTimeout(r, 50));
    expect(room2.spotlight()).toEqual({ userId: "usr_alice", name: "Alice" });
    const bobSpotlightFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobSpotlightFrames.some((f) => f.type === "spotlight" && f.spotlight?.userId === "usr_alice")).toBe(true);

    // -------------------------------------------------------------
    // CATEGORY 5: "summon"
    // -------------------------------------------------------------
    bobSocket.send.mockClear();
    (worker1 as any).summon(aliceConn, { type: "summon", viewport: { x: 500, y: 600, zoom: 1.5 } });

    await new Promise((r) => setTimeout(r, 50));
    const bobSummonFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobSummonFrames.some((f) => f.type === "summon" && f.from.userId === "usr_alice" && f.viewport.x === 500)).toBe(true);

    // -------------------------------------------------------------
    // CATEGORY 6: "resync" & DURABLE RECOVERY AFTER LOST NOTIFICATIONS
    // -------------------------------------------------------------
    // Drop all subsequent "op" notifications on the bus
    dropNotifications = true;
    bobSocket.send.mockClear();

    // Worker 1 commits 3 successive operations directly to the shared durable log
    const op2: Operation = { op: "CREATE_NODE", id: "node_2", nodeType: "step", label: "Second Step" };
    const op3: Operation = { op: "CREATE_NODE", id: "node_3", nodeType: "step", label: "Third Step" };
    const op4: Operation = { op: "CONNECT_NODES", source: "node_2", target: "node_3", relationship: "triggers" };

    const c2 = await worker1.commitForBoard(board.id, "usr_alice", [op2], "Step 2", { role: "editor" });
    const c3 = await worker1.commitForBoard(board.id, "usr_alice", [op3], "Step 3", { role: "editor" });
    const c4 = await worker1.commitForBoard(board.id, "usr_alice", [op4], "Link 2->3", { role: "editor" });

    expect(c2?.ok && c3?.ok && c4?.ok).toBe(true);
    expect(c4?.entry?.seq).toBe(4);

    // Allow async bus ticks
    await new Promise((r) => setTimeout(r, 50));

    // Because notifications were dropped: Worker 2 MUST STILL BE at seq 1 and unaware of node_2 or node_3
    expect(room2.current().nodes.node_2).toBeUndefined();
    expect(room2.current().nodes.node_3).toBeUndefined();
    expect(room2.version()).toBe(1);

    // Re-enable bus and trigger RESYNC (reconnect event / bus resync notification)
    dropNotifications = false;
    await mockBus.publish({ boardId: board.id, kind: "resync" });

    // Allow Worker 2 to process resync, call pullRemote(), and reconcile from durable store
    await new Promise((r) => setTimeout(r, 100));

    // VERIFICATION OF DURABLE RECOVERY:
    // 1. Worker 2 room caught up completely to seq 4
    expect(room2.version()).toBe(4);
    expect(room2.current().nodes.node_2).toBeDefined();
    expect(room2.current().nodes.node_3).toBeDefined();
    expect(Object.keys(room2.current().edges)).toHaveLength(1);
    const edgeValues = Object.values(room2.current().edges) as Array<{ source: string; target: string }>;
    expect(edgeValues[0]?.source).toBe("node_2");
    expect(edgeValues[0]?.target).toBe("node_3");

    // 2. Both workers now have 100% identical workspace projections
    expect(room2.current()).toEqual(room1.current());

    // 3. Bob's socket on Worker 2 received all missing ops (seq 2, 3, 4)
    const bobResyncOpFrames = bobSocket.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((f) => f.type === "op");

    const absorbedSeqs = bobResyncOpFrames.map((f) => f.entry?.seq);
    expect(absorbedSeqs).toContain(2);
    expect(absorbedSeqs).toContain(3);
    expect(absorbedSeqs).toContain(4);
  });

  it("proves durable proposal recovery after lost notifications, reconnect catchup, duplicate idempotency, and tenant isolation", async () => {
    const busListeners: ((msg: FanoutMessage) => void)[] = [];
    let dropProposals = false;

    const mockBus = {
      publish: vi.fn().mockImplementation(async (msg: FanoutMessage) => {
        if (dropProposals && msg.kind === "proposal") {
          // Simulate lost proposal notification over network / dropped bus message
          return;
        }
        for (const l of [...busListeners]) l(msg);
      }),
      subscribe: vi.fn().mockImplementation((_boardId: string, listener: (msg: FanoutMessage) => void) => {
        busListeners.push(listener);
        return () => {
          const idx = busListeners.indexOf(listener);
          if (idx !== -1) busListeners.splice(idx, 1);
        };
      }),
      close: async () => {},
    };

    const boardStore = new InMemoryBoardStore();
    const proposalStore = new (await import("../src/proposals.js")).InMemoryProposalStore();
    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);

    // Tenant 1: Board A in Org 1
    const boardA = {
      id: "brd_tenant_A",
      orgId: "org_alpha",
      ownerId: "usr_alice",
      name: "Board A",
      workspace: createWorkspace(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(boardA);

    // Tenant 2: Board B in Org 2
    const boardB = {
      id: "brd_tenant_B",
      orgId: "org_beta",
      ownerId: "usr_charlie",
      name: "Board B",
      workspace: createWorkspace(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(boardB);

    // Worker 1
    const worker1 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "worker_1",
      proposals: proposalStore,
    });

    // Worker 2
    const worker2 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "worker_2",
      proposals: proposalStore,
    });

    const roomA1 = await (worker1 as any).roomFor(boardA.id, boardA.workspace, boardA.ownerId);
    const roomA2 = await (worker2 as any).roomFor(boardA.id, boardA.workspace, boardA.ownerId);
    const roomB2 = await (worker2 as any).roomFor(boardB.id, boardB.workspace, boardB.ownerId);

    // Sockets
    const aliceSocket = { readyState: 1, send: vi.fn() };
    const aliceConn = { socket: aliceSocket as any, userId: "usr_alice", name: "Alice", boardId: boardA.id };
    roomA1.setRole("usr_alice", "editor");
    (worker1 as any).connsByBoard.set(boardA.id, new Set([aliceConn]));

    const bobSocket = { readyState: 1, send: vi.fn() };
    const bobConn = { socket: bobSocket as any, userId: "usr_bob", name: "Bob", boardAId: boardA.id, boardId: boardA.id };
    roomA2.setRole("usr_bob", "editor");
    (worker2 as any).connsByBoard.set(boardA.id, new Set([bobConn]));

    const charlieSocket = { readyState: 1, send: vi.fn() };
    const charlieConn = { socket: charlieSocket as any, userId: "usr_charlie", name: "Charlie", boardId: boardB.id };
    roomB2.setRole("usr_charlie", "editor");
    (worker2 as any).connsByBoard.set(boardB.id, new Set([charlieConn]));

    // 1. TENANT ISOLATION: Proposal created on Board A must NEVER leak to Board B
    const createdA = await proposalStore.create({
      boardId: boardA.id,
      orgId: boardA.orgId,
      request: "Reorganize auth on Board A",
      operations: [{ op: "CREATE_NODE", id: "auth_A", nodeType: "step", label: "Auth A" }],
      createdBy: "usr_alice",
      createdAt: Date.now(),
    });

    worker1.broadcastProposal(boardA.id, {
      type: "proposal-opened",
      proposal: createdA.proposal,
    });

    await new Promise((r) => setTimeout(r, 50));

    // Bob on Board A on Worker 2 received proposal
    const bobFrames1 = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobFrames1.some((f) => f.type === "proposal-opened" && f.proposal?.id === createdA.proposal.id)).toBe(true);

    // Charlie on Board B (Org Beta) on Worker 2 received ZERO proposal frames! Tenant isolation holds!
    const charlieFrames = charlieSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(charlieFrames.filter((f) => f.type === "proposal-opened").length).toBe(0);

    // 2. LOCAL-ECHO SUPPRESSION: Alice on Worker 1 received the broadcast only once, no duplicate echo
    const aliceFrames = aliceSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(aliceFrames.filter((f) => f.type === "proposal-opened").length).toBe(1);

    // 3. LOST PROPOSAL NOTIFICATION & DURABLE CATCHUP
    // Simulate: Proposal created in durable ProposalStore while network notification is dropped
    dropProposals = true;
    bobSocket.send.mockClear();

    const createdA2 = await proposalStore.create({
      boardId: boardA.id,
      orgId: boardA.orgId,
      request: "Add billing microservice",
      operations: [{ op: "CREATE_NODE", id: "billing_A", nodeType: "step", label: "Billing A" }],
      createdBy: "usr_alice",
      createdAt: Date.now(),
    });

    // Worker 1 attempts to broadcast, but bus drops it
    worker1.broadcastProposal(boardA.id, {
      type: "proposal-opened",
      proposal: createdA2.proposal,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Bob received NOTHING because notification was dropped
    expect(bobSocket.send).not.toHaveBeenCalled();

    // DURABLE RECOVERY VIA RESYNC:
    // When bus fires "resync" or a client reconnects, Worker 2 reconciles with durable ProposalStore
    await mockBus.publish({ boardId: boardA.id, kind: "resync" });
    await new Promise((r) => setTimeout(r, 50));

    // Bob's socket on Worker 2 now received the authoritative pending proposal!
    const bobCatchupFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobCatchupFrames.some((f) => f.type === "proposal-opened" && f.proposal?.id === createdA2.proposal.id)).toBe(true);

    // DURABLE RECOVERY VIA RECONNECT JOIN:
    // A new joiner on Worker 2 joining after lost notifications receives the pending proposal on join
    const davidSocket = { readyState: 1, send: vi.fn() };
    const davidConn: any = { socket: davidSocket as any, userId: "usr_david", name: "David" };
    await (worker2 as any).join(davidConn, boardA.id, 0);

    const davidFrames = davidSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(davidFrames.some((f) => f.type === "welcome")).toBe(true);
    expect(davidFrames.some((f) => f.type === "proposal-opened" && f.proposal?.id === createdA2.proposal.id)).toBe(true);

    // 4. DUPLICATE NOTIFICATION IDEMPOTENCY:
    // Replayed proposal notification causes zero state mutation or error
    dropProposals = false;
    worker1.broadcastProposal(boardA.id, {
      type: "proposal-opened",
      proposal: createdA2.proposal,
    });
    await new Promise((r) => setTimeout(r, 50));
    // Proposals store remains with exactly 1 pending proposal
    const pendingList = await proposalStore.pendingForBoards([boardA.id]);
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]?.id).toBe(createdA2.proposal.id);
  });
});
