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
});
