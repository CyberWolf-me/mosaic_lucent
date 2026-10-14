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
    );

    // Role was seeded, commit succeeded, and broadcast sent to room
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
});
