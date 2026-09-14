import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  parseMentions,
  safeParseProgrammaticOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { Room } from "./room.js";
import type { LoggedOp } from "./room.js";
import type { FanoutMessage, Unsubscribe } from "./fanout.js";
import type { BoardStore } from "./boards.js";
import type { OperationActor } from "./boards.js";
import type { UserStore } from "./accounts.js";
import type { Role } from "./identity.js";
import type { TicketStore } from "./realtimeTicket.js";
import type { NotificationKind, NotifyEvent } from "./notifications.js";

/**
 * Realtime transport (docs/12). A thin adapter that binds WebSocket connections
 * to Room instances: it authenticates the socket, joins the caller to the board's
 * room, relays operations and presence, and broadcasts the results the Room
 * returns. All the sync semantics live in Room; this file only moves bytes.
 *
 * One room per board, created on first join and evicted when the last participant
 * leaves. The board's authoritative workspace is loaded from and saved back to the
 * BoardStore, so realtime edits and the REST /api/generate path share one source
 * of truth.
 *
 * Authentication uses short-lived tickets minted by /api/realtime/ticket (M0.3).
 * Long-lived bearer tokens are not accepted here — they should not appear in
 * proxy access logs, and a captured ticket cannot be replayed.
 */

interface ClientMsg {
  type: "join" | "op" | "presence" | "ping";
  boardId?: string;
  fromSeq?: number;
  ops?: unknown[];
  label?: string;
  /**
   * The submit's idempotency key (Stage B): every send carries one, and a
   * network retry of the same key is answered with the original outcome
   * instead of a second effect.
   */
  requestId?: string;
  cursor?: { x: number; y: number } | null;
  selection?: string[];
}

interface Conn {
  socket: WebSocket;
  userId: string;
  name: string;
  boardId: string | null;
  /** Epoch ms when the socket was accepted; the connection-duration SLO's clock. */
  openedAt: number;
}

/** Shape the Room expects when reconstructing from a persisted op log. */
type RoomInitLog = LoggedOp[];

/**
 * Fire-and-forget notification dispatch. The same shape `notifyUser` has in
 * `app.ts` — already swallows errors and never throws — so the realtime path
 * can hand the comment kinds off without learning how the tray is wired.
 *
 * Omitted in tests that don't care about notifications; the comment ops still
 * commit normally and the WS path is unaffected.
 */
export type NotifyFn = (event: NotifyEvent<NotificationKind>) => void;

export interface RealtimeDeps {
  userStore: UserStore;
  boardStore: BoardStore;
  secret: string;
  tickets: TicketStore;
  /**
   * Observes one finished connection's lifetime, in seconds. The
   * realtime-reachability SLO (docs/reliability/slo.md) measures the share of
   * connections that survive five minutes; that needs a histogram of
   * connection durations, which only this layer can see — `attach()` is the
   * one place a connection's start is known and `leave()` the one place its
   * end is. Optional so tests and the in-memory path construct no metrics;
   * the SLO's own rule is "no metric, no SLO", and this is what makes the
   * metric exist.
   */
  observeConnectionDuration?: (seconds: number) => void;
  /**
   * The caller's role on an org (M2.2), so a socket join resolves the same
   * *effective* board role the HTTP guard does. Required, not optional: a room
   * hands the joiner's role to `Room.commit` once and every later op inherits
   * it, so a wiring that forgot this would silently refuse an org owner on
   * their own org's board — which is exactly the bug this replaced.
   */
  orgRoleFor: (userId: string, orgId: string) => Promise<Role | undefined>;
  /**
   * M2.6: the seam that emits `comment.mention` (ADD_COMMENT whose body
   * @-names a member) and `comment.reply` (REPLY_COMMENT on a thread someone
   * else started). Optional — without it the realtime path is unchanged, which
   * is what older tests and offline dev rely on.
   */
  notify?: NotifyFn;
  /**
   * M3: cross-instance presence. When present, presence updates are mirrored
   * to the store so an op committed on instance A sees editors whose sockets
   * are on instance B. The room's local map is kept for the in-process hot
   * path; the store is the cross-instance answer.
   */
  presenceStore?: import("./presence.js").PresenceStore;
  /**
   * M3: cross-instance broadcast bus. When present, every committed op is
   * published so subscribers on a sibling instance catch up. The local
   * broadcast still runs; subscribers must dedupe by `entry.seq` (which the
   * client already does).
   */
  fanout?: import("./fanout.js").Fanout;
  /**
   * Identifies this instance on the bus. Used as `instanceId` in presence
   * rows and as a label in fanout messages. A short string per process.
   */
  instanceId?: string;
}

export class RealtimeServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  /** Sockets grouped by board, for broadcast. */
  private readonly connsByBoard = new Map<string, Set<Conn>>();
  /** Live bus subscriptions, per hosted board (M3). */
  private readonly fanoutUnsubs = new Map<string, Unsubscribe>();

  constructor(private readonly deps: RealtimeDeps) {
    // noServer: we handle the HTTP upgrade ourselves so auth runs first.
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Attach to an existing HTTP server, upgrading /ws requests. */
  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const ticket = url.searchParams.get("ticket");
      // Atomic consume: a ticket used by a parallel upgrade is already gone.
      // Async since the Postgres ticket store (docs/20 P5) made the seam a
      // Promise — the in-memory twin resolves on the microtask queue, so
      // single-process dev pays no round trip.
      const consume = ticket ? this.deps.tickets.consume(ticket) : Promise.resolve(null);
      void consume
        .then((userId) => {
          if (!userId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
          return this.deps.userStore.findById(userId).then((user) => {
            if (!user) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
              this.onConnection(ws, user.id, user.name);
            });
          });
        })
        .catch(() => {
          socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          socket.destroy();
        });
    });
  }

  /** Close the WebSocketServer and every room. */
  close(): void {
    for (const ws of this.wss.clients) {
      try {
        ws.terminate();
      } catch {
        // ignore: close is best-effort during shutdown.
      }
    }
    this.wss.close();
    for (const unsub of this.fanoutUnsubs.values()) unsub();
    this.fanoutUnsubs.clear();
    this.rooms.clear();
    this.connsByBoard.clear();
  }

  /**
   * Drop a hosted room and its bus subscription; state lives in the store.
   * Eviction is also the compaction moment (Stage B4): the room's current
   * workspace is written as a snapshot at its head seq, so the NEXT cold start
   * rebuilds from it and replays only the tail — a busy board stops paying the
   * full-history replay on every all-participants-leave cycle. Idempotent on
   * (board, seq) by the store's contract; best-effort, because a failed
   * snapshot costs a full replay next time, never correctness.
   *
   * Guarded on the store head (found live: 2026-09-10): the room can trail
   * the store when writes bypass it (pre-fix ops-API batches, multi-instance
   * winners the room hasn't pulled). Snapshotting a trailing room's workspace
   * freezes STALE state at the room's version — and the next cold start then
   * anchors to it, hiding the newer store ops behind the snapshot floor.
   * When the store's head is past the room's version, no snapshot is written
   * (a full replay rebuilds correctly next time, which is the guarded cost),
   * and the drifted snapshot never poisons a future join.
   */
  private evictRoom(boardId: string, room?: Room): void {
    const current = room ?? this.rooms.get(boardId);
    if (current) {
      const roomVersion = current.version();
      void this.deps.boardStore
        .latestSeq(boardId)
        .then((storeHead) => {
          if (storeHead > roomVersion) return;
          return this.deps.boardStore.putSnapshot(boardId, roomVersion, current.current());
        })
        .catch(() => {});
    }
    this.rooms.delete(boardId);
    this.connsByBoard.delete(boardId);
    const unsub = this.fanoutUnsubs.get(boardId);
    if (unsub) {
      unsub();
      this.fanoutUnsubs.delete(boardId);
    }
  }

  private onConnection(socket: WebSocket, userId: string, name: string): void {
    const conn: Conn = { socket, userId, name, boardId: null, openedAt: Date.now() };

    socket.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data)) as ClientMsg;
      } catch {
        return;
      }
      this.handle(conn, msg);
    });

    socket.on("close", () => this.leave(conn));
    socket.on("error", () => this.leave(conn));
  }

  private handle(conn: Conn, msg: ClientMsg): void {
    switch (msg.type) {
      case "join":
        void this.join(conn, msg.boardId ?? "", msg.fromSeq ?? 0);
        break;
      case "op":
        void this.applyOp(conn, msg);
        break;
      case "presence":
        this.presence(conn, msg);
        break;
      case "ping":
        this.sendTo(conn, { type: "pong" });
        break;
    }
  }

  private async join(conn: Conn, boardId: string, fromSeq: number): Promise<void> {
    const board = await this.deps.boardStore.get(boardId);
    if (!board) {
      this.sendTo(conn, { type: "error", message: "board not found" });
      return;
    }
    // Membership is explicit (docs/12). A board id is not a capability: someone
    // who hasn't redeemed a share link is refused rather than silently admitted
    // as a viewer, which is what the previous "until sharing exists" fallback
    // did. The owner resolves to "owner" without a membership row.
    //
    // The resolver is the WS half of M2.2's effective roles: max(org role,
    // board role). Without it this call saw only `board_members`, so an org
    // owner or editor was refused a board in their own org — and because the
    // role is stamped into the Room at join time, every subsequent `op` on
    // that socket inherited the refusal.
    const role = await this.deps.boardStore.memberRole(boardId, conn.userId, (uid) =>
      this.deps.orgRoleFor(uid, board.orgId),
    );
    if (!role) {
      this.sendTo(conn, { type: "error", message: "board not found" });
      return;
    }
    // Room rebuild, snapshot-anchored (ADR 0010's intent, wired): a hot room
    // is reused; a cold start rebuilds from the newest SNAPSHOT plus the log
    // tail after it, instead of replaying the board's whole history — a
    // board with 50k entries used to replay all 50k on every cold join. When
    // no snapshot exists the full log is the only honest base.
    const room = await this.roomFor(boardId, board.workspace, board.ownerId);
    room.setRole(conn.userId, role);

    conn.boardId = boardId;
    const set = this.connsByBoard.get(boardId) ?? new Set<Conn>();
    set.add(conn);
    this.connsByBoard.set(boardId, set);

    const presence = room.updatePresence(conn.userId, conn.name, {});
    // M3: mirror the presence row into the cross-instance store, so a sibling
    // instance sees this joiner and the welcome peer list spans instances.
    // Best-effort: a store failure must not refuse the join.
    if (this.deps.presenceStore) {
      void this.deps.presenceStore
        .upsert({
          boardId,
          userId: conn.userId,
          name: conn.name,
          instanceId: this.deps.instanceId ?? "local",
          cursor: null,
          selection: [],
        })
        .catch(() => {});
    }

    // Reseed instead of a partial catchup: the client's cursor predates the
    // snapshot floor (the log was pruned past where it last was), so honest
    // entries for the gap simply do not exist. Sending the tail alone would
    // leave a hole in the client's state; the workspace wholesale is the only
    // correct answer, and the client's resync handler replaces its state
    // atomically rather than applying a diff.
    if (room.baseSeqOf() > fromSeq) {
      this.sendTo(conn, {
        type: "resync",
        workspace: room.current(),
        version: room.version(),
        role: room.roleOf(conn.userId),
        peers: room.peers(conn.userId),
      });
      this.broadcast(boardId, { type: "peer-joined", presence }, conn);
      return;
    }

    // Send the joiner: their role, the current version, and any ops they've missed.
    this.sendTo(conn, {
      type: "welcome",
      boardId,
      version: room.version(),
      role: room.roleOf(conn.userId),
      catchup: room.since(fromSeq),
      peers: room.peers(conn.userId),
    });
    // Tell everyone else this person is here.
    this.broadcast(boardId, { type: "peer-joined", presence }, conn);
  }

  private async applyOp(conn: Conn, msg: ClientMsg): Promise<void> {
    if (!conn.boardId) return;
    const room = this.rooms.get(conn.boardId);
    if (!room) return;

    // The request id is bounded and shape-checked: it is echoed into acks and
    // stored as the idempotency key, so a hostile string must not ride either.
    const requestId =
      typeof msg.requestId === "string" && msg.requestId.length > 0 && msg.requestId.length <= 64
        ? msg.requestId
        : undefined;

    // The wire contract before any state touches the batch (found live:
    // 2026-09-10). `Room.commit` validates presence and cycle rules, not op
    // SHAPE — an op that passes the hand-rolled checks but not the schema
    // (statement fields at the top level instead of nested, say) reached the
    // reducer, which crashed the process. Parse with the STRICT schema
    // (unknown top-level keys refused, not stripped) so the socket answer is
    // a correlated refusal the client can fix, not a dead server or a
    // silently acked no-op.
    const parsed = safeParseProgrammaticOperations(msg.ops ?? []);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const at = first?.path?.length ? ` (at ${first.path.join(".")})` : "";
      this.sendTo(conn, {
        type: "op-rejected",
        error: "schema",
        detail: `operations failed schema validation: ${first?.message ?? "invalid op"}${at}`,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(room ? { head: room.version() } : {}),
      });
      return;
    }

    const result = await room.commit(conn.userId, parsed.data, msg.label ?? "", {
      ...(requestId !== undefined ? { requestId } : {}),
    });
    if (!result.ok) {
      // Correlated refusal (Stage B): the client knows WHICH submit failed,
      // not merely that something did, and `head` names where the log actually
      // is so a retry resyncs rather than guessing.
      this.sendTo(conn, {
        type: "op-rejected",
        error: result.error,
        detail: result.detail,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        ...(result.head !== undefined ? { head: result.head } : {}),
      });
      return;
    }
    // A replayed request: the original entry already broadcast when it first
    // committed, and re-sending it would double-apply on every peer that
    // trusts seq ordering... except it would not (clients dedupe by seq), but
    // the room also never re-applied it, so there is no entry to send. The
    // ack below IS the answer to a retry — it names the original seq.
    if (result.duplicate) {
      this.sendTo(conn, {
        type: "op-ack",
        seq: result.head,
        operationId: result.entry?.operationId,
        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
        duplicate: true,
      });
      return;
    }
    // The explicit ack (Stage B): "I sent it, therefore it happened" was never
    // a safe client assumption. The ack names the submit's requestId, the seq
    // it landed at, and the operationId of the committed batch — the same
    // facts the broadcast entry carries, addressed to the one submitter.
    this.sendTo(conn, {
      type: "op-ack",
      seq: result.entry?.seq,
      operationId: result.entry?.operationId,
      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
    });
    // Persist so the REST path and a future reconnect see the same state —
    // unless the commit already did: with a durable allocator wired into the
    // room (M3), the entry was written to the store as part of allocating its
    // seq, and appending it again would put the batch in the log twice.
    if (!result.persisted && result.entry) {
      await this.deps.boardStore.appendOp({ ...result.entry, boardId: conn.boardId });
    }
    const board = await this.deps.boardStore.get(conn.boardId);
    if (board) {
      await this.deps.boardStore.put({
        ...board,
        workspace: room.current(),
        updatedAt: Date.now(),
      });
    }
    // M2.6: emit comment notifications on the realtime path. This runs after
    // persistence so a notification never points at state the store has not
    // accepted, and after the broadcast so a slow mailer cannot delay the WS
    // round-trip. `notify` is fire-and-forget — its own contract is that
    // nothing on this critical path depends on its outcome.
    if (this.deps.notify && board) {
      void this.emitCommentNotifications(conn, board, result.entry?.ops ?? []);
    }
    // Broadcast what this commit absorbed first (entries another instance
    // wrote while we were validating), then our own: clients advance by seq,
    // so the absorbed ones must arrive before the entry built on top of them.
    // Local dedupe by seq (boardSync.ts:126) makes a re-delivery harmless.
    for (const entry of result.absorbed ?? []) {
      this.broadcast(conn.boardId, { type: "op", entry });
    }
    // Broadcast the sequenced entry to everyone, including the sender, so all
    // clients advance their cursor identically.
    this.broadcast(conn.boardId, { type: "op", entry: result.entry });
    // M3: cross-instance fanout. A sibling instance's subscribers should
    // catch up via the bus; they deduplicate by `entry.seq` (which the
    // client already does, boardSync.ts:126). Best-effort: a fanout
    // failure must not undo a successful commit.
    if (this.deps.fanout && result.entry && conn.boardId) {
      void this.deps.fanout
        .publish({
          boardId: conn.boardId,
          kind: "op",
          seq: result.entry.seq,
          userId: result.entry.by,
        })
        .catch(() => {});
    }
  }

  /**
   * Walk a committed batch and fire `comment.mention` and `comment.reply` for
   * the comment ops in it. Errors and missing lookups are swallowed so a
   * notification failure cannot invalidate an op the Room has already accepted.
   *
   * The resolution rules are the product decisions in `notifications.ts:60-66`:
   *   - mention: every name in the body that matches a board member's display
   *     name, excluding the author. A name that does not match anyone is a
   *     typo on the author's part, not a reason to fail the commit.
   *   - reply: the parent comment's author, excluding the reply author (no
   *     self-reply notification). The validator guarantees the parent exists
   *     (`validator.ts:222-227`), so we read it off the live workspace rather
   *     than re-validating.
   */
  private async emitCommentNotifications(
    conn: Conn,
    board: { id: string; name: string; orgId: string; ownerId: string },
    ops: Operation[],
  ): Promise<void> {
    const notify = this.deps.notify;
    if (!notify || !conn.boardId) return;
    const boardId = conn.boardId;
    const boardName = board.name;
    const orgId = board.orgId;
    // One pass over `members` for both kinds: each lookup is name → userId →
    // email, and the membership row is the right scope for "who can I mention
    // here" — listing every user in the tenant would let one board mention a
    // member of a sibling org. The owner is not in `members` (memberships.ts
    // row is implied by `ownerId`), so the owner is added to the name pool
    // separately — an owner who cannot be @-mentioned on their own board
    // would be a confusing restriction.
    const members = await this.deps.boardStore.members(boardId);
    const byName = new Map<string, string>();
    for (const m of members) {
      const user = await this.deps.userStore.findById(m.userId);
      if (!user) continue;
      // First write wins on a duplicate name: rare, and silently picking one
      // is the same outcome the UI would render. A duplicate that mattered
      // would have failed the validation gate already.
      if (!byName.has(user.name)) byName.set(user.name, user.id);
    }
    const ownerUser = await this.deps.userStore.findById(board.ownerId);
    if (ownerUser && !byName.has(ownerUser.name)) {
      byName.set(ownerUser.name, ownerUser.id);
    }

    for (const op of ops) {
      if (op.op === "ADD_COMMENT") {
        const names = parseMentions(op.body);
        if (names.length === 0) continue;
        const seen = new Set<string>();
        for (const name of names) {
          const targetId = byName.get(name);
          // Unknown name: silently dropped (the validator cannot help here —
          // any string of word characters is a legal body). The author will
          // notice their typo when nobody highlights.
          if (!targetId || targetId === conn.userId) continue;
          if (seen.has(targetId)) continue;
          seen.add(targetId);
          const recipient = await this.deps.userStore.findById(targetId);
          if (!recipient) continue;
          notify({
            kind: "comment.mention",
            to: { userId: recipient.id, email: recipient.email },
            orgId,
            payload: {
              boardId,
              boardName,
              authorName: conn.name,
              body: op.body,
              commentId: op.id,
            },
          });
        }
        continue;
      }
      if (op.op === "REPLY_COMMENT") {
        const workspace = this.rooms.get(boardId)?.current();
        const parent = workspace?.comments?.[op.parentId];
        // The validator already required the parent to exist; a missing read
        // here is a race we cannot notify against, so drop it.
        if (!parent) continue;
        if (parent.by === conn.userId) continue;
        const recipient = await this.deps.userStore.findById(parent.by);
        if (!recipient) continue;
        notify({
          kind: "comment.reply",
          to: { userId: recipient.id, email: recipient.email },
          orgId,
          payload: {
            boardId,
            boardName,
            authorName: conn.name,
            body: op.body,
            commentId: op.id,
          },
        });
        continue;
      }
    }
  }

  private presence(conn: Conn, msg: ClientMsg): void {
    if (!conn.boardId) return;
    const room = this.rooms.get(conn.boardId);
    if (!room) return;
    const presence = room.updatePresence(conn.userId, conn.name, {
      cursor: msg.cursor,
      selection: msg.selection,
    });
    this.broadcast(conn.boardId, { type: "presence", presence }, conn);
    // M3: mirror the cursor/selection to the cross-instance store. A live
    // cursor on instance A must be visible to a peer on instance B, and the
    // row's `updated_at` is also what keeps the participant alive through
    // sweeps. Best-effort: store failure must not drop a frame.
    if (this.deps.presenceStore) {
      void this.deps.presenceStore
        .upsert({
          boardId: conn.boardId,
          userId: conn.userId,
          name: conn.name,
          instanceId: this.deps.instanceId ?? "local",
          cursor: msg.cursor ?? null,
          selection: msg.selection,
        })
        .catch(() => {});
    }
  }

  private leave(conn: Conn): void {
    // The SLO histogram first: it must fire for every leave, including the
    // early-return below for sockets that never joined a board, or the
    // five-minute-survival figure is biased by exactly the connections that
    // behaved worst.
    this.deps.observeConnectionDuration?.((Date.now() - conn.openedAt) / 1000);
    if (!conn.boardId) return;
    const room = this.rooms.get(conn.boardId);
    const set = this.connsByBoard.get(conn.boardId);
    set?.delete(conn);
    if (room) {
      room.removePresence(conn.userId);
      this.broadcast(conn.boardId, { type: "peer-left", userId: conn.userId }, conn);
      // Evict an empty room; its state is already persisted in the board store.
      // The cross-instance store is the authoritative "is anyone still here?"
      // when it is wired — a peer on a sibling instance counts.
      let stillHasPeer = false;
      if (this.deps.presenceStore) {
        // Capture boardId into a non-null local for the async callback below;
        // the early-return above already proved it is a string.
        const boardIdForEvict = conn.boardId;
        // Best-effort: a stale "still has peer" because the store query
        // failed is safer than the opposite (evicting a board with a live
        // peer on another instance).
        void this.deps.presenceStore
          .peers(boardIdForEvict)
          .then((peers) => {
            if (peers.length === 0) {
              this.evictRoom(boardIdForEvict, room);
            }
          })
          .catch(() => {});
        stillHasPeer = true;
      }
      if (!stillHasPeer && room.isEmpty()) {
        this.evictRoom(conn.boardId, room);
      }
      // Drop the cross-instance row for this participant. The compare-and-
      // delete on `instanceId` keeps a sibling instance's live row safe if
      // (say) this instance died without a leave.
      if (this.deps.presenceStore) {
        void this.deps.presenceStore
          .remove(conn.boardId, conn.userId, this.deps.instanceId ?? "local")
          .catch(() => {});
      }
    }
    conn.boardId = null;
  }

  /**
   * The room for a board, cold-started snapshot-anchored (Stage B4, wiring
   * ADR 0010's design): the newest snapshot becomes the base state and only
   * the log TAIL after it replays. `Room.fromSnapshot` records the snapshot's
   * seq as `baseSeq`, which is what makes the reseed-vs-catchup decision in
   * `join` possible — and a board with a long history stops paying the full
   * replay on every cold join. No snapshot: the full log is the only honest
   * base, and the room is built exactly as before.
   */
  private async roomFor(boardId: string, workspace: Workspace, ownerId: string): Promise<Room> {
    let room = this.rooms.get(boardId);
    if (!room) {
      // M3: the room allocates seqs through the board store, so two instances
      // serving one board draw from the same uniqueness source (the log's
      // (board_id, seq) key) instead of each counting in its own memory. The
      // fetcher is the conflict path: a losing commit pulls the winner's
      // entries in, re-validates, retries. The store contract says appendOp
      // never throws on contention, it answers `conflict`/`lost` — exactly
      // what the allocator wants.
      const append = (entry: {
        ops: Operation[];
        by: string;
        label: string;
        at: number;
        expectedSeq: number;
        requestId?: string;
        actor?: OperationActor;
      }) =>
        this.deps.boardStore.appendOp({
          boardId,
          ops: entry.ops,
          by: entry.by,
          label: entry.label,
          at: entry.at,
          expectedSeq: entry.expectedSeq,
          ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
          ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
        });
      // LoggedOpEntry and LoggedOp are structurally the same record; the
      // mapping keeps the room decoupled from the store's type.
      const mapLog = (entries: Awaited<ReturnType<BoardStore["loadLog"]>>): RoomInitLog =>
        entries.map((e) => ({
          seq: e.seq,
          ops: e.ops,
          by: e.by,
          label: e.label,
          at: e.at,
          ...(e.operationId !== undefined ? { operationId: e.operationId } : {}),
          ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
          ...(e.actor !== undefined ? { actor: e.actor } : {}),
        }));
      const fetch = (fromSeq: number): Promise<RoomInitLog> =>
        this.deps.boardStore.loadLog(boardId, fromSeq).then(mapLog);
      // Stage B4: the authoritative replay check — a request committed at a
      // seq that was later snapshotted and pruned leaves no replayed entry
      // for the room's map, and only the store can still answer.
      const findRequest = (bid: string, requestId: string) =>
        this.deps.boardStore
          .findRequest(bid, requestId)
          .then((e) => (e ? { seq: e.seq } : undefined));
      // Snapshot-anchored cold start: the base state is the newest snapshot
      // and only the tail replays. `Room.fromSnapshot` records the snapshot's
      // seq as baseSeq, which is what makes the reseed-vs-catchup decision in
      // `join` honest. No snapshot: the full log is the only correct base.
      const snapshot = await this.deps.boardStore.latestSnapshot(boardId);
      if (snapshot) {
        const tail = await this.deps.boardStore.loadLog(boardId, snapshot.seq);
        room = Room.fromSnapshot(boardId, snapshot, mapLog(tail), ownerId, {
          append,
          fetch,
          findRequest,
        });
      } else {
        const log = await this.deps.boardStore.loadLog(boardId);
        room = new Room(boardId, workspace, ownerId, mapLog(log), { append, fetch, findRequest });
      }
      this.rooms.set(boardId, room);
      this.subscribeFanout(boardId, room);
    }
    return room;
  }

  /**
   * The fanout's receiving half. A bus message only says "the log moved" —
   * the entries are read back from the store, which is why a lost notification
   * costs a read rather than an edit, and why `resync` ("you may have missed
   * some; reload") and `op` ("this seq happened") land in the same handler:
   * both become `pullRemote`, which is idempotent by seq. Nothing subscribes
   * without a bus, so the single-instance path is untouched.
   */
  private subscribeFanout(boardId: string, room: Room): void {
    const fanout = this.deps.fanout;
    if (!fanout || this.fanoutUnsubs.has(boardId)) return;
    const listener = (message: FanoutMessage): void => {
      if (message.boardId !== boardId) return; // one channel, many boards
      if (message.kind !== "op" && message.kind !== "resync") return;
      void room
        .pullRemote()
        .then((absorbed) => {
          for (const entry of absorbed) {
            this.broadcast(boardId, { type: "op", entry });
          }
        })
        .catch(() => {
          // A failed reload is retried by the next bus message or the next
          // commit's conflict path; the store stays the truth either way.
        });
    };
    this.fanoutUnsubs.set(boardId, fanout.subscribe(boardId, listener));
  }

  private sendTo(conn: Conn, msg: unknown): void {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify(msg));
    }
  }

  private broadcast(boardId: string, msg: unknown, except?: Conn): void {
    const set = this.connsByBoard.get(boardId);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const conn of set) {
      if (conn === except) continue;
      if (conn.socket.readyState === WebSocket.OPEN) conn.socket.send(data);
    }
  }

  /**
   * Drop a board's room and detach whoever is in it. Called when the board is
   * deleted over REST (DELETE /api/boards/:id): otherwise the room keeps
   * accepting ops for a board that no longer exists and `appendOp` writes to a
   * log whose board row is gone. The sockets stay open — a client may join
   * another board — but they are told the board went away, and any further op
   * from them finds no room and is dropped.
   */
  evictBoard(boardId: string): void {
    const set = this.connsByBoard.get(boardId);
    for (const conn of set ?? []) {
      this.sendTo(conn, { type: "error", message: "board deleted" });
      conn.boardId = null;
    }
    this.rooms.delete(boardId);
    this.connsByBoard.delete(boardId);
  }

  /**
   * Commit a batch into a board's room on behalf of a user (Stage B3). The
   * proposal-approval path uses this so an applied proposal broadcasts through
   * the ordinary pipeline — peers receive the same sequenced entry any edit
   * produces, carrying the proposal's AI actor record. Requires the room to be
   * live; an approval when nobody is connected to the board returns false and
   * the caller applies the batch through the store directly instead.
   */
  async commitForBoard(
    boardId: string,
    userId: string,
    ops: Operation[],
    label: string,
    meta?: { requestId?: string; actor?: import("./boards.js").OperationActor },
  ): Promise<import("./room.js").CommitResult | null> {
    const room = this.rooms.get(boardId);
    if (!room) return null;
    // The room's role map is the gate: a user who has not joined (or holds no
    // role on the board) cannot commit through this seam at all.
    if (room.roleOf(userId) === undefined) return null;
    const result = await room.commit(userId, ops, label, meta);
    // The caller has no store access, so this seam also performs the two
    // post-commit steps applyOp owns: persist the room's workspace into the
    // board row (unless the allocator already did) and publish the fanout.
    if (result.ok && result.entry && !result.persisted) {
      await this.deps.boardStore.appendOp({ ...result.entry, boardId });
    }
    if (result.ok && result.entry) {
      const board = await this.deps.boardStore.get(boardId);
      if (board) {
        await this.deps.boardStore.put({
          ...board,
          workspace: room.current(),
          updatedAt: Date.now(),
        });
      }
      if (this.deps.fanout) {
        void this.deps.fanout
          .publish({ boardId, kind: "op", seq: result.entry.seq, userId: result.entry.by })
          .catch(() => {});
      }
    }
    return result;
  }

  /**
   * Broadcast a proposal event to everyone connected to a board (Stage B3).
   * The proposal review panel opens on every browser as one fact: the panel
   * state is per-board, so the create and the decision both fan out here.
   * Returns false when nobody is connected — the event is still durable in
   * the store, and the next join reads it from GET /proposals.
   */
  broadcastProposal(boardId: string, event: unknown): boolean {
    const set = this.connsByBoard.get(boardId);
    if (!set || set.size === 0) return false;
    for (const conn of set) {
      if (conn.boardId === boardId) this.sendTo(conn, event);
    }
    return true;
  }

  /** Testing/metrics: how many rooms are live. */
  roomCount(): number {
    return this.rooms.size;
  }
}
