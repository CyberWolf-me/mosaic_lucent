import { describe, it, expect, vi } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { summarizeWorkspace, type LLMProvider } from "@lucent/ai";
import { InMemoryBoardStore, newBoardId } from "../src/boards.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { handleGenerate } from "../src/generate.js";
import { RealtimeServer } from "../src/realtime.js";
import { Room } from "../src/room.js";

describe("Findings B2 & B3: Canonical Commit Authority & Room Synchronization", () => {
  it("Non-owner editor with authorized flag validates against server stored state", async () => {
    const store = new InMemoryBoardStore();
    // Server has node 'a' only; node 'deleted_on_server' does not exist.
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    const board = {
      id: newBoardId(),
      orgId: "org_1",
      ownerId: "usr_owner",
      name: "Team Board",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put(board);

    // Attacker or stale client sends summary containing a deleted ghost node
    const staleSummary = summarizeWorkspace(
      applyOperations(createWorkspace(), [
        { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
        { op: "CREATE_NODE", id: "deleted_on_server", nodeType: "step", label: "Ghost" },
      ]),
    );

    // Model tries to connect 'a' to 'deleted_on_server'
    const provider: LLMProvider = {
      name: "test-provider",
      async generateOperations() {
        return {
          operations: [
            {
              op: "CONNECT_NODES",
              source: "a",
              target: "deleted_on_server",
              relationship: "next",
            },
          ],
        };
      },
      async generateAnswer() {
        throw new Error("unsupported");
      },
      async generateExternalPlan() {
        throw new Error("unsupported");
      },
    };

    // Editor (non-owner) with authorized: true from resolveAiContext
    const editorId = "usr_editor_collaborator";
    const authoritativeResult = await handleGenerate(
      provider,
      { message: "connect", summary: staleSummary, boardId: board.id },
      editorId,
      { boardId: board.id, store, authorized: true },
    );

    // Validation against stored board fails because target node doesn't exist on server
    expect(authoritativeResult.status).toBe(422);

    // Advisory validation (without authoritative) would accept against stale summary
    const advisoryResult = await handleGenerate(
      provider,
      { message: "connect", summary: staleSummary, boardId: board.id },
      editorId,
      undefined,
    );
    expect(advisoryResult.status).toBe(200);
  });

  it("Authoritative generation routes mutations through commitBatch", async () => {
    const store = new InMemoryBoardStore();
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "N1" },
    ]);
    const board = {
      id: newBoardId(),
      orgId: "org_1",
      ownerId: "usr_owner",
      name: "Board",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put(board);

    const committedBatches: { ops: Operation[]; label: string }[] = [];
    const mockCommitBatch = vi.fn().mockImplementation(async (ops: Operation[], label: string) => {
      committedBatches.push({ ops, label });
      return { ok: true, seq: 1 };
    });

    const provider: LLMProvider = {
      name: "test-provider",
      async generateOperations() {
        return {
          operations: [{ op: "CREATE_NODE", id: "n2", nodeType: "step", label: "N2" }],
          explanation: "Added node N2",
        };
      },
      async generateAnswer() {
        throw new Error("unsupported");
      },
      async generateExternalPlan() {
        throw new Error("unsupported");
      },
    };

    const result = await handleGenerate(
      provider,
      { message: "add n2", summary: summarizeWorkspace(ws), boardId: board.id },
      "usr_editor",
      { boardId: board.id, store, authorized: true, commitBatch: mockCommitBatch },
    );

    expect(result.status).toBe(200);
    expect(mockCommitBatch).toHaveBeenCalledTimes(1);
    expect(committedBatches[0]?.ops).toHaveLength(1);
    const op = committedBatches[0]?.ops[0];
    if (op && "id" in op) {
      expect(op.id).toBe("n2");
    }
    expect(committedBatches[0]?.label).toBe("Added node N2");
  });

  it("RealtimeServer.commitForBoard seeds editor role for authorized caller and commits to live room", async () => {
    const boardStore = new InMemoryBoardStore();
    const ws = createWorkspace();
    const board = {
      id: newBoardId(),
      orgId: "org_1",
      ownerId: "usr_owner",
      name: "Live Board",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);
    const server = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => undefined,
    });

    // Owner room exists
    const room = new Room(board.id, board.workspace, board.ownerId);
    (server as any).rooms.set(board.id, room);
    expect(room.roleOf("usr_owner")).toBe("owner");
    expect(room.roleOf("system_automation")).toBeUndefined();

    // A collaborator is connected to the board via WebSocket
    const sentFrames: string[] = [];
    const mockSocket = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => {
        sentFrames.push(data);
      },
    };
    const mockConn = { socket: mockSocket as any, userId: "usr_viewer", boardId: board.id };
    (server as any).connsByBoard.set(board.id, new Set([mockConn]));

    // System automation or offline editor commits through commitForBoard without pre-existing role
    const commitResult = await server.commitForBoard(
      board.id,
      "system_automation",
      [{ op: "CREATE_NODE", id: "auto_node", nodeType: "step", label: "Automated Step" }],
      "automation run",
      { trustedSystem: true },
    );

    // Role was seeded for trusted system actor, commit succeeded, and broadcast sent to room
    expect(commitResult).not.toBeNull();
    expect(commitResult?.ok).toBe(true);
    expect(room.roleOf("system_automation")).toBe("editor");
    expect(room.current().nodes.auto_node).toBeDefined();

    // Broadcast frame sent to connected collaborator
    expect(sentFrames.length).toBeGreaterThan(0);
    const frameStr = sentFrames[0] ?? "{}";
    const parsed = JSON.parse(frameStr);
    expect(parsed.type).toBe("op");
    expect(parsed.entry.ops[0].id).toBe("auto_node");
  });

  it("Security: Unauthorized caller or viewer cannot elevate permissions via commitForBoard metadata", async () => {
    const boardStore = new InMemoryBoardStore();
    const ws = createWorkspace();
    const board = {
      id: newBoardId(),
      orgId: "org_1",
      ownerId: "usr_owner",
      name: "Security Board",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);
    // Explicitly add usr_viewer as viewer
    await boardStore.setMember({
      boardId: board.id,
      userId: "usr_viewer",
      role: "viewer",
      invitedBy: board.ownerId,
      createdAt: Date.now(),
    });

    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);
    const server = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => undefined,
    });

    const room = new Room(board.id, board.workspace, board.ownerId);
    (server as any).rooms.set(board.id, room);

    // 1. Unregistered stranger claiming editor role in meta -> REFUSED
    const strangerResult = await server.commitForBoard(
      board.id,
      "usr_stranger",
      [{ op: "CREATE_NODE", id: "stranger_node", nodeType: "step", label: "Hack" }],
      "exploit",
      { role: "editor" },
    );
    expect(strangerResult).not.toBeNull();
    expect(strangerResult?.ok).toBe(false);
    expect(strangerResult?.error).toBe("permission");

    // 2. Known viewer attempting to elevate to editor via meta -> REFUSED
    const viewerResult = await server.commitForBoard(
      board.id,
      "usr_viewer",
      [{ op: "CREATE_NODE", id: "viewer_node", nodeType: "step", label: "Hack" }],
      "exploit",
      { role: "editor" },
    );
    expect(viewerResult).not.toBeNull();
    expect(viewerResult?.ok).toBe(false);
    expect(viewerResult?.error).toBe("permission");

    // 3. External-boundary spoofing: caller passes userId: "system" without trustedSystem capability -> REFUSED
    const spoofSystemIdResult = await server.commitForBoard(
      board.id,
      "system",
      [{ op: "CREATE_NODE", id: "spoof_system_node", nodeType: "step", label: "Hack" }],
      "exploit",
      { role: "editor" }, // no trustedSystem: true!
    );
    expect(spoofSystemIdResult).not.toBeNull();
    expect(spoofSystemIdResult?.ok).toBe(false);
    expect(spoofSystemIdResult?.error).toBe("permission");

    // 4. External-boundary spoofing: caller passes actorType: "system" without trustedSystem capability -> REFUSED
    const spoofActorResult = await server.commitForBoard(
      board.id,
      "usr_attacker",
      [{ op: "CREATE_NODE", id: "spoof_actor_node", nodeType: "step", label: "Hack" }],
      "exploit",
      { actor: { actorType: "system", actorId: "fake_webhook" }, role: "editor" }, // no trustedSystem: true!
    );
    expect(spoofActorResult).not.toBeNull();
    expect(spoofActorResult?.ok).toBe(false);
    expect(spoofActorResult?.error).toBe("permission");

    // Board in room remains completely clean
    expect(room.current().nodes.stranger_node).toBeUndefined();
    expect(room.current().nodes.viewer_node).toBeUndefined();
    expect(room.current().nodes.spoof_system_node).toBeUndefined();
    expect(room.current().nodes.spoof_actor_node).toBeUndefined();
  });

  it("Cross-Worker Fanout: Two workers synchronize spotlight and summon events without local echo", async () => {
    const busListeners: ((msg: any) => void)[] = [];
    const mockBus = {
      publish: vi.fn().mockImplementation(async (msg: any) => {
        for (const l of busListeners) l(msg);
      }),
      subscribe: vi.fn().mockImplementation((_boardId: string, listener: any) => {
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
      orgId: "org_1",
      ownerId: "usr_owner",
      name: "Shared Board",
      workspace: ws,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await boardStore.put(board);

    const userStore = new InMemoryUserStore();
    const tickets = new InMemoryTicketStore(60_000);

    // Worker 1
    const server1 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "inst_1",
    });

    // Worker 2
    const server2 = new RealtimeServer({
      userStore,
      boardStore,
      secret: "test-secret-at-least-32-characters-long",
      tickets,
      orgRoleFor: async () => "editor",
      fanout: mockBus as any,
      instanceId: "inst_2",
    });

    const room1 = await (server1 as any).roomFor(board.id, board.workspace, board.ownerId);
    const room2 = await (server2 as any).roomFor(board.id, board.workspace, board.ownerId);

    // Socket on Worker 1 (Alice)
    const aliceSocket = { readyState: 1, send: vi.fn() };
    const aliceConn = { socket: aliceSocket as any, userId: "usr_alice", name: "Alice", boardId: board.id };
    room1.setRole("usr_alice", "editor");
    (server1 as any).connsByBoard.set(board.id, new Set([aliceConn]));

    // Socket on Worker 2 (Bob)
    const bobSocket = { readyState: 1, send: vi.fn() };
    const bobConn = { socket: bobSocket as any, userId: "usr_bob", name: "Bob", boardId: board.id };
    room2.setRole("usr_bob", "editor");
    (server2 as any).connsByBoard.set(board.id, new Set([bobConn]));

    // 1. Alice takes spotlight on Worker 1
    (server1 as any).spotlight(aliceConn, true);
    expect(room1.spotlight()).toEqual({ userId: "usr_alice", name: "Alice" });

    // Worker 2 should receive fanout, update room2 spotlight, and notify Bob
    expect(room2.spotlight()).toEqual({ userId: "usr_alice", name: "Alice" });
    const bobSpotlightFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobSpotlightFrames.some((f) => f.type === "spotlight" && f.spotlight?.userId === "usr_alice")).toBe(true);

    // 2. Alice summons on Worker 1
    (server1 as any).summon(aliceConn, { type: "summon", viewport: { x: 100, y: 200, zoom: 1 } });
    const bobSummonFrames = bobSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(bobSummonFrames.some((f) => f.type === "summon" && f.from.userId === "usr_alice" && f.viewport.x === 100)).toBe(true);

    // Verify Worker 1 does not echo the message back to itself
    const aliceFrames = aliceSocket.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(aliceFrames.filter((f) => f.type === "summon").length).toBe(0); // Alice was originator of summon, not recipient
  });
});
