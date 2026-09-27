import { applyOperations, type Operation, type Workspace } from "@lucent/core";
import { fetchRealtimeTicket } from "./boards.js";
import type { BoardRole, ServerProposal } from "./boards.js";

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
  /** A local edit was refused by the server. The requestId (Stage B) names
   * WHICH submit failed, when the submitter sent one; `head` is where the log
   * actually was, so the caller can resync rather than guess.
   */
  onRejected?: (
    error: string,
    detail?: string,
    requestId?: string,
    ...rest: [head?: number]
  ) => void;
  /** A local submit was accepted (or answered as a duplicate replay). */
  onAcked?: (seq: number, requestId: string | undefined, duplicate: boolean) => void;
  /**
   * Stage B3: a proposal was created on this board (by this browser or a
   * peer) — the review panel opens on every connected client.
   */
  onProposalCreated?: (proposal: ServerProposal, supersededId: string | null) => void;
  /** Stage B3: a proposal was decided — the panel closes everywhere. */
  onProposalDecided?: (event: {
    id: string;
    status: "approved" | "rejected";
    by: string;
    appliedSeq?: number;
  }) => void;
  /** Stage D7: an inbound-queue decision landed (this browser or a peer's)
   * — the Intelligence view refetches the queue. */
  onInboundDecided?: (changeId: string, status: string) => void;
  /**
   * Stage B4: a server-level error the client must not swallow (e.g. "board
   * deleted" from an eviction) — the caller decides what to do about it.
   */
  onError?: (message: string) => void;
  /** Connection state, for a status dot. */
  onStatus?: (status: "connecting" | "online" | "offline") => void;
  /** The caller's role on this board. */
  onRole?: (role: BoardRole) => void;
}

/**
 * A client submit id (`req_…`). Every local edit gets one before it leaves
 * the browser: a network retry of the same batch replays the same id, and the
 * server answers with the original outcome instead of applying the edit twice.
 */
function newRequestId(): string {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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
  /**
   * Stage B4: batches committed while the socket was down. `send()` used to
   * drop them silently — an edit made on a train tunnel vanished when the
   * socket blinked. Queued in order and replayed after catchup, WITH THEIR
   * ORIGINAL requestIds, so Batch 1's idempotency makes the replay
   * exactly-once: if a batch actually landed before the drop, its replay is
   * answered with the original seq as a duplicate no-op.
   */
  private pendingQueue: Array<{ msg: Record<string, unknown>; requestId: string }> = [];

  constructor(
    private readonly boardId: string,
    initial: Workspace,
    private readonly cb: BoardSyncCallbacks,
  ) {
    this.workspace = initial;
  }

  updateWorkspace(ws: Workspace): void {
    this.workspace = ws;
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
        if (msg.role) this.cb.onRole?.(msg.role as BoardRole);
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
        // Stage B4: catchup is in, the queue goes out. Replay in order with
        // the original requestIds — idempotency (B1) makes anything that
        // actually landed before the drop a duplicate no-op, so the replay
        // is exactly-once even after a half-delivered send.
        if (this.pendingQueue.length > 0) {
          const queue = this.pendingQueue;
          this.pendingQueue = [];
          for (const { msg: queued } of queue) this.send(queued);
        }
        break;
      }
      case "resync": {
        // Stage B4: the server could not serve an honest catchup from this
        // cursor (the log was pruned past it — the client's state has a hole
        // nothing can fill). The workspace arrives wholesale: replace state
        // atomically, never diff it — partial application here would leave
        // the board half-old.
        this.cb.onStatus?.("online");
        if (msg.role) this.cb.onRole?.(msg.role as BoardRole);
        this.workspace = msg.workspace as Workspace;
        this.version = Number(msg.version ?? 0);
        this.peers.clear();
        for (const p of (msg.peers ?? []) as Peer[]) this.peers.set(p.userId, p);
        this.cb.onWorkspace(this.workspace);
        this.cb.onPeers([...this.peers.values()]);
        // The queued batches were built against pre-resync state; they are
        // still the user's edits, so they replay as-is — the server's
        // validation is the arbiter of what still applies (B1 semantics).
        if (this.pendingQueue.length > 0) {
          const queue = this.pendingQueue;
          this.pendingQueue = [];
          for (const { msg: queued } of queue) this.send(queued);
        }
        break;
      }
      case "error": {
        // Stage B4: server-level errors were silently dropped — "board
        // deleted" from an eviction left a zombie client editing nothing.
        // Surfaced so the caller can react (the app navigates away).
        this.cb.onError?.(String(msg.message ?? "server error"));
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
      case "op-ack":
        // Stage B: the server confirmed a specific submit landed (or was a
        // replay of one that already had). The seq is the fact the optimistic
        // local apply now rests on — nothing to re-apply, the broadcast entry
        // carries the same ops. Surfaced for callers that track it; the
        // default handler is silence because the op echo already synced state.
        this.cb.onAcked?.(
          Number(msg.seq ?? 0),
          typeof msg.requestId === "string" ? msg.requestId : undefined,
          msg.duplicate === true,
        );
        break;
      case "op-rejected":
        this.cb.onRejected?.(
          String(msg.error ?? "rejected"),
          msg.detail as string | undefined,
          typeof msg.requestId === "string" ? msg.requestId : undefined,
          ...(typeof msg.head === "number" ? [msg.head] : []),
        );
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
      case "proposal-created": {
        const proposal = msg.proposal as ServerProposal | undefined;
        if (proposal) {
          this.cb.onProposalCreated?.(
            proposal,
            typeof msg.supersededId === "string" ? msg.supersededId : null,
          );
        }
        break;
      }
      case "proposal-decided": {
        if (
          typeof msg.id === "string" &&
          (msg.status === "approved" || msg.status === "rejected")
        ) {
          this.cb.onProposalDecided?.({
            id: msg.id,
            status: msg.status,
            by: String(msg.by ?? ""),
            ...(typeof msg.appliedSeq === "number" ? { appliedSeq: msg.appliedSeq } : {}),
          });
        }
        break;
      }
      case "integrations-inbound": {
        // Stage D7: a queue decision (this browser or a peer's) — the
        // Intelligence view refetches the queue; the accept's op frame
        // arrives separately and syncs the board itself.
        this.cb.onInboundDecided?.(
          typeof msg.id === "string" ? msg.id : "",
          typeof msg.status === "string" ? msg.status : "",
        );
        break;
      }
    }
  }

  /** Send a committed local batch to the server for sequencing. */
  commit(ops: Operation[], label = ""): void {
    if (ops.length === 0) return;
    // Stage B: every submit is idempotent by id. The same batch retried over a
    // flapping socket (a later batch) replays this id and is answered with the
    // original outcome — the client never needs to guess whether "it sent".
    const requestId = newRequestId();
    const msg: Record<string, unknown> = { type: "op", ops, label, requestId };
    // Stage B4: never drop a user edit again. Socket open → send now;
    // closed → queue for the reconnect replay above. Optimistic local state
    // already holds the edit (workspace.tsx applies first), so this is purely
    // a durability question, and the queue is the answer.
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else {
      this.pendingQueue.push({ msg, requestId });
    }
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
