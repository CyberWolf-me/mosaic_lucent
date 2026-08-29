import { applyOperations, type Operation, type Workspace } from "@lucent/core";
import { fetchRealtimeTicket } from "./boards.js";

/**
 * Client realtime sync (docs/12). Mirrors the server's Room over a WebSocket:
 * joins a board, catches up on missed operations, applies the authoritative
 * broadcast, sends local edits, and tracks peers' cursors and selections.
 *
 * The server is authoritative, so this is intentionally simple — it does not
 * merge or transform. Local edits are sent and echoed back sequenced; the
 * workspace the caller renders is always what the server has accepted. If a local
 * edit is rejected (a viewer, or a stale operation), `onRejected` fires and the
 * caller reconciles by trusting the server state it already holds.
 */

export interface Peer {
  userId: string;
  name: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  color: string;
}

export interface BoardSyncCallbacks {
  /** The authoritative workspace changed (catchup or a broadcast op). */
  onWorkspace: (workspace: Workspace) => void;
  /** Peer presence changed (join/leave/cursor/selection). */
  onPeers: (peers: Peer[]) => void;
  /** A local edit was refused by the server. */
  onRejected?: (error: string, detail?: string) => void;
  /** Connection state, for a status dot. */
  onStatus?: (status: "connecting" | "online" | "offline") => void;
  /** The caller's role on this board. */
  onRole?: (role: "owner" | "editor" | "viewer") => void;
}

export class BoardSync {
  private socket: WebSocket | null = null;
  private version = 0;
  private workspace: Workspace;
  private readonly peers = new Map<string, Peer>();
  private closed = false;
  private reconnectAttempts = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPresence: { cursor?: { x: number; y: number } | null; selection?: string[] } = {};

  constructor(
    private readonly boardId: string,
    initial: Workspace,
    private readonly cb: BoardSyncCallbacks,
  ) {
    this.workspace = initial;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    this.cb.onStatus?.("connecting");
    // Same-origin ws:// or wss:// depending on the page protocol.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Mint a one-shot ticket server-side so the long-lived bearer token never
    // appears in proxy access logs (M0.3). A 60-second TTL means the upgrade
    // either uses the ticket within seconds or re-mints.
    void fetchRealtimeTicket().then((ticket) => {
      if (this.closed) return;
      if (!ticket) {
        this.cb.onStatus?.("offline");
        return;
      }
      const socket = new WebSocket(
        `${proto}//${location.host}/ws?ticket=${encodeURIComponent(ticket)}`,
      );
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.send({ type: "join", boardId: this.boardId, fromSeq: this.version });
      };
      socket.onmessage = (e) => this.receive(String(e.data));
      socket.onclose = () => {
        this.cb.onStatus?.("offline");
        if (!this.closed) this.scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    });
  }

  private scheduleReconnect(): void {
    // Exponential backoff with jitter, capped — so a flaky link recovers without
    // hammering the server.
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000) + Math.random() * 500;
    this.reconnectAttempts += 1;
    setTimeout(() => {
      if (!this.closed) this.open();
    }, delay);
  }

  private receive(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type) {
      case "welcome": {
        this.cb.onStatus?.("online");
        if (msg.role) this.cb.onRole?.(msg.role as "owner" | "editor" | "viewer");
        // Replay everything we missed while away.
        const catchup = (msg.catchup ?? []) as Array<{ seq: number; ops: Operation[] }>;
        for (const entry of catchup) {
          this.workspace = applyOperations(this.workspace, entry.ops);
          this.version = entry.seq;
        }
        this.peers.clear();
        for (const p of (msg.peers ?? []) as Peer[]) this.peers.set(p.userId, p);
        this.cb.onWorkspace(this.workspace);
        this.cb.onPeers([...this.peers.values()]);
        break;
      }
      case "op": {
        const entry = msg.entry as { seq: number; ops: Operation[] };
        // Ignore anything we've already applied (a reconnect can re-send).
        if (entry.seq <= this.version) break;
        this.workspace = applyOperations(this.workspace, entry.ops);
        this.version = entry.seq;
        this.cb.onWorkspace(this.workspace);
        break;
      }
      case "op-rejected":
        this.cb.onRejected?.(String(msg.error ?? "rejected"), msg.detail as string | undefined);
        break;
      case "peer-joined":
      case "presence": {
        const p = msg.presence as Peer;
        this.peers.set(p.userId, p);
        this.cb.onPeers([...this.peers.values()]);
        break;
      }
      case "peer-left":
        this.peers.delete(String(msg.userId));
        this.cb.onPeers([...this.peers.values()]);
        break;
    }
  }

  /** Send a committed local batch to the server for sequencing. */
  commit(ops: Operation[], label = ""): void {
    if (ops.length === 0) return;
    this.send({ type: "op", ops, label });
  }

  /** Report cursor/selection; throttled so a moving mouse doesn't flood. */
  setPresence(update: { cursor?: { x: number; y: number } | null; selection?: string[] }): void {
    this.pendingPresence = { ...this.pendingPresence, ...update };
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.send({ type: "presence", ...this.pendingPresence });
      this.pendingPresence = {};
      this.presenceTimer = null;
    }, 60);
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }
}
