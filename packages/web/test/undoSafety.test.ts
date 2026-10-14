import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkspace, type Operation } from "@lucent/core";
import { BoardSync } from "../src/boardSync.js";
import { LARGE_UNDO_OBJECTS, removalOf } from "../src/workspaceHelpers.js";

/**
 * Undo safety: one accidental Ctrl+Z must not take the board away. A step
 * that removes LARGE_UNDO_OBJECTS or more objects asks first (workspace.tsx
 * needsConfirm), and an AI change approved from this tab is recorded so it
 * can be undone at all (BoardSync.onEntry → OperationHistory.recordApplied).
 */

describe("removalOf — what an undo or redo would take off the board", () => {
  it("counts nodes, shapes, wireframes and connections", () => {
    const ops: Operation[] = [
      { op: "DISCONNECT_NODES", source: "a", target: "b", relationship: "calls" },
      { op: "DELETE_NODE", id: "a" },
      { op: "DELETE_NODE", id: "b" },
      { op: "DELETE_SHAPE", id: "s" },
      { op: "DELETE_WIREFRAME", id: "w" },
      { op: "DISCONNECT_SHAPES", id: "l" },
      { op: "CHANGE_TEXT", id: "c", text: "untouched" },
    ];
    expect(removalOf(ops)).toEqual({ objects: 4, nodes: 2, shapes: 1, links: 2 });
  });

  it("a whole AI build is large; a single stroke is not", () => {
    const build: Operation[] = Array.from({ length: 8 }, (_, i) => ({
      op: "DELETE_NODE",
      id: `n${i}`,
    }));
    expect(removalOf(build).objects).toBeGreaterThanOrEqual(LARGE_UNDO_OBJECTS);
    expect(removalOf([{ op: "DELETE_SHAPE", id: "stroke" }]).objects).toBeLessThan(
      LARGE_UNDO_OBJECTS,
    );
  });
});

class FakeSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let socket: FakeSocket;
beforeEach(() => {
  socket = new FakeSocket();
  vi.stubGlobal("WebSocket", function (this: unknown) {
    return socket;
  } as unknown);
  (globalThis.WebSocket as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k === "lucent.token" ? "tok" : null),
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ticket: "t" }) }),
    ) as unknown,
  );
});

describe("BoardSync.onEntry — live entries with the state before them", () => {
  it("reports each live entry with the board as it was just before it, never the catchup", async () => {
    const seen: Array<{ seq: number; nodesBefore: string[]; requestId?: string }> = [];
    const sync = new BoardSync("brd_1", createWorkspace(), {
      onWorkspace: () => {},
      onPeers: () => {},
      onEntry: (entry, before) =>
        seen.push({
          seq: entry.seq,
          nodesBefore: Object.keys(before.nodes),
          ...(entry.requestId ? { requestId: entry.requestId } : {}),
        }),
    });
    sync.connect();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    socket.onopen?.();
    socket.deliver({
      type: "welcome",
      version: 1,
      role: "editor",
      catchup: [
        { seq: 1, ops: [{ op: "CREATE_NODE", id: "old", nodeType: "step", label: "Old" }] },
      ],
      peers: [],
    });
    expect(seen).toEqual([]); // a reload must not re-attribute old entries
    socket.deliver({
      type: "op",
      entry: {
        seq: 2,
        requestId: "prp_p1_u1",
        ops: [{ op: "CREATE_NODE", id: "new", nodeType: "step", label: "New" }],
      },
    });
    expect(seen).toEqual([{ seq: 2, nodesBefore: ["old"], requestId: "prp_p1_u1" }]);
  });
});
