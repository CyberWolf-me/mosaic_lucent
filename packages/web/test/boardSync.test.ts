import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWorkspace } from "@lucent/core";
import { BoardSync, type Peer } from "../src/boardSync.js";

/**
 * Client sync applies the server's authoritative broadcasts; it never merges or
 * transforms. These tests drive a fake WebSocket to prove catch-up, ordered
 * application, de-duplication on reconnect, and presence tracking without a
 * network.
 */

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // Test helper: deliver a server message.
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  lastSent(): unknown {
    return JSON.parse(this.sent[this.sent.length - 1]!);
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
  // BoardSync mints a realtime ticket before opening the socket (M0.3).
  // The tests don't care which token it hands back, only that one exists.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ticket: "test-ticket" }),
      }),
    ) as unknown,
  );
});

interface Harness {
  sync: BoardSync;
  workspace: ReturnType<typeof createWorkspace>;
  peers: Peer[];
  role: string | undefined;
  rejected: { error: string; detail?: string } | null;
}

async function makeSync(
  initial = createWorkspace(),
  _cb: Record<string, unknown> = {},
): Promise<Harness> {
  const state: Harness = {
    sync: undefined as unknown as BoardSync,
    workspace: initial,
    peers: [],
    role: undefined,
    rejected: null,
  };
  state.sync = new BoardSync("brd_1", initial, {
    onWorkspace: (w) => {
      state.workspace = w;
    },
    onPeers: (p) => {
      state.peers = p;
    },
    onRole: (r) => {
      state.role = r;
    },
    onRejected: (e, d) => {
      state.rejected = { error: e, detail: d };
    },
  });
  state.sync.connect();
  // Drain the microtask queue so the ticket-fetch has resolved and the
  // WebSocket has been constructed; only then trigger the open handler.
  // The chain is fetch() → authed() → res.json() → new WebSocket(), each
  // await introducing a microtask hop. Four awaits cover the worst case
  // without being flaky.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  socket.onopen?.();
  return state;
}

describe("join and catch-up", () => {
  it("sends a join with its cursor on open", async () => {
    await makeSync();
    expect(socket.lastSent()).toMatchObject({ type: "join", boardId: "brd_1", fromSeq: 0 });
  });

  it("applies catch-up operations and adopts the role", async () => {
    const h = await makeSync();
    socket.deliver({
      type: "welcome",
      version: 2,
      role: "editor",
      catchup: [
        { seq: 1, ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }] },
        { seq: 2, ops: [{ op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" }] },
      ],
      peers: [],
    });
    expect(Object.keys(h.workspace.nodes).sort()).toEqual(["a", "b"]);
    expect(h.role).toBe("editor");
  });
});

describe("applying broadcasts", () => {
  it("applies an op broadcast in sequence", async () => {
    const h = await makeSync();
    socket.deliver({ type: "welcome", version: 0, role: "editor", catchup: [], peers: [] });
    socket.deliver({
      type: "op",
      entry: { seq: 1, ops: [{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" }] },
    });
    expect(h.workspace.nodes.x).toBeDefined();
  });

  it("ignores an op it has already applied (reconnect re-send)", async () => {
    const h = await makeSync();
    socket.deliver({
      type: "welcome",
      version: 1,
      role: "editor",
      catchup: [{ seq: 1, ops: [{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" }] }],
      peers: [],
    });
    socket.deliver({
      type: "op",
      entry: { seq: 1, ops: [{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" }] },
    });
    expect(Object.keys(h.workspace.nodes)).toEqual(["x"]);
  });

  it("surfaces a rejected local edit", async () => {
    const h = await makeSync();
    socket.deliver({ type: "welcome", version: 0, role: "viewer", catchup: [], peers: [] });
    socket.deliver({ type: "op-rejected", error: "permission", detail: "editor role required" });
    expect(h.rejected).toEqual({ error: "permission", detail: "editor role required" });
  });
});

describe("presence", () => {
  it("tracks peers from welcome, presence, and leave", async () => {
    const h = await makeSync();
    socket.deliver({
      type: "welcome",
      version: 0,
      role: "editor",
      catchup: [],
      peers: [{ userId: "u2", name: "Bo", cursor: null, selection: [], color: "#f00" }],
    });
    expect(h.peers.map((p) => p.userId)).toEqual(["u2"]);

    socket.deliver({
      type: "presence",
      presence: {
        userId: "u3",
        name: "Cy",
        cursor: { x: 1, y: 2 },
        selection: ["a"],
        color: "#0f0",
      },
    });
    expect(h.peers).toHaveLength(2);

    socket.deliver({ type: "peer-left", userId: "u2" });
    expect(h.peers.map((p) => p.userId)).toEqual(["u3"]);
  });

  it("throttles presence updates into one send", async () => {
    const h = await makeSync();
    socket.sent.length = 0;
    h.sync.setPresence({ cursor: { x: 1, y: 1 } });
    h.sync.setPresence({ cursor: { x: 2, y: 2 } });
    h.sync.setPresence({ selection: ["a"] });
    expect(socket.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(socket.sent).toHaveLength(1);
  });
});

describe("commit", () => {
  it("sends a non-empty batch and ignores an empty one", async () => {
    const h = await makeSync();
    socket.deliver({ type: "welcome", version: 0, role: "editor", catchup: [], peers: [] });
    socket.sent.length = 0;
    h.sync.commit([], "nothing");
    expect(socket.sent).toHaveLength(0);
    h.sync.commit([{ op: "CREATE_NODE", id: "z", nodeType: "step", label: "Z" }], "add z");
    expect(socket.lastSent()).toMatchObject({ type: "op", label: "add z" });
  });
});

describe("entries that arrive out of order", () => {
  it("holds an entry that arrives ahead of a gap, then applies both in seq order", async () => {
    const h = await makeSync();
    socket.deliver({ type: "welcome", version: 0, role: "editor", catchup: [], peers: [] });
    socket.deliver({
      type: "op",
      entry: { seq: 2, ops: [{ op: "CHANGE_TEXT", id: "x", text: "second" }] },
    });
    expect(h.workspace.nodes.x).toBeUndefined();
    socket.deliver({
      type: "op",
      entry: { seq: 1, ops: [{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "first" }] },
    });
    expect(h.workspace.nodes.x?.label).toBe("second");
  });

  it("re-joins from its cursor when a gap does not fill", async () => {
    await makeSync();
    vi.useFakeTimers();
    try {
      socket.deliver({ type: "welcome", version: 0, role: "editor", catchup: [], peers: [] });
      socket.deliver({
        type: "op",
        entry: { seq: 3, ops: [{ op: "CREATE_NODE", id: "z", nodeType: "step", label: "Z" }] },
      });
      vi.advanceTimersByTime(2100);
      expect(socket.lastSent()).toMatchObject({ type: "join", boardId: "brd_1", fromSeq: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
