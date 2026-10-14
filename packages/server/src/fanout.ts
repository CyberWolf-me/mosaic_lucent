/**
 * Cross-instance fanout (M3, docs/adr/0004-postgres-fanout-over-redis.md).
 *
 * Rooms, presence and the broadcast socket set are per-process today
 * (realtime.ts), so an op committed on instance A never reaches a subscriber on
 * instance B. This is the bus that closes that gap, and it stays the only new
 * thing in the stack that knows fanout exists: the Room stays transport-free
 * and the WebSocket layer stays a byte mover.
 *
 * Two rules from the ADR shape the whole interface:
 *
 * 1. Messages are notifications, not payloads. A message says "board X advanced
 *    to seq N"; the receiver reads the ops it is missing from the op log. That
 *    is what keeps a message small enough for `pg_notify`, and the op log — not
 *    the bus — stays the source of truth, so a dropped notification costs a
 *    replay and never a lost edit. `FANOUT_MAX_PAYLOAD_BYTES` enforces the cap
 *    in every implementation, the in-process one included, so the day someone
 *    starts putting op payloads on the bus it fails loudly in a unit test
 *    instead of at 2am.
 *
 * 2. A gap is unknowable, so a reconnect resyncs. See `Fanout.subscribe`; that
 *    contract is the reason `subscribe` is per board.
 */

/**
 * What happened, coarsely. The receiver decides what to re-read:
 *
 * - `op` — the board advanced; read the log forward from your own cursor.
 * - `presence` — a peer joined, left or moved; re-read the `PresenceStore`.
 * - `resync` — you may have missed messages; reload from durable state.
 * - `proposal` — a proposal was created or decided; fan out to connected peers.
 */
export type FanoutKind = "op" | "presence" | "resync" | "proposal";

/**
 * One notification. Small on purpose (rule 1 above) — this shape is the
 * contract, and anything that resembles an op payload does not belong in it.
 */
export interface FanoutMessage {
  boardId: string;
  kind: FanoutKind;
  /**
   * For `kind: "op"`, the sequence number the board advanced to. Optional,
   * because a receiver can always read the log from its own cursor; when
   * present it lets a receiver skip a read it does not need, which is why the
   * ADR specifies `{boardId, seq}`. Never set on a `resync` — there the
   * receiver's own cursor is the only authority on what it missed.
   */
  seq?: number;
  /**
   * Who caused it. A `presence` message names the peer that changed, so a
   * receiver can update one entry instead of the whole list; an `op` message
   * names the author, which is enough for a receiver to recognise its own echo.
   */
  userId?: string;
  /**
   * The server instance that published the message, used by peers to recognize
   * and ignore their own echo.
   */
  instanceId?: string;
  /**
   * For `kind: "proposal"`, the proposal event notification payload.
   */
  data?: unknown;
}

export type FanoutListener = (message: FanoutMessage) => void;

/** Returned by `subscribe`. Idempotent, so calling it twice is safe. */
export type Unsubscribe = () => void;

/**
 * One channel for every board, with the board id in the payload.
 * `LISTEN`/`UNLISTEN` per board would put a statement on the single dedicated
 * connection for every join and every room eviction, and a Postgres identifier
 * is capped at 63 bytes anyway — which a prefix plus a board id does not
 * comfortably fit.
 */
export const FANOUT_CHANNEL = "lucent_fanout";

/**
 * Hard cap on one encoded message, from the ADR's second consequence: "`NOTIFY`
 * payloads are capped at 8000 bytes, so notifications carry `{boardId, seq}` and
 * receivers read the ops they are missing from the log."
 *
 * A well-formed notification is under a hundred bytes, so this should never fire
 * in normal operation. It is a tripwire for exactly the change the ADR exists to
 * prevent — putting op payloads on the bus — where the failure mode is otherwise
 * Postgres refusing the `NOTIFY` at commit time, or a transport that truncates
 * instead corrupting the realtime layer with no error anywhere. Better a failed
 * test than either.
 */
export const FANOUT_MAX_PAYLOAD_BYTES = 8000;

export class FanoutPayloadTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `fanout message is ${bytes} bytes, over the ${limit}-byte NOTIFY limit: ` +
        `a message is a notification, not a payload — carry {boardId, seq} and ` +
        `read the ops from the log`,
    );
    this.name = "FanoutPayloadTooLargeError";
  }
}

export interface Fanout {
  /**
   * Announce a change on one board. Resolves once the bus has accepted the
   * message, not once subscribers have handled it.
   *
   * Rejects with `FanoutPayloadTooLargeError` when the encoded message exceeds
   * `FANOUT_MAX_PAYLOAD_BYTES`. That is a programming error rather than a
   * transient condition — retrying an oversized message cannot help.
   *
   * Delivery is best-effort by design. A notification lost to a dropped
   * connection costs the subscriber a replay from the op log, so `publish` must
   * never block or fail a commit, and a closed bus drops silently rather than
   * turning a shutdown race into an error.
   *
   * The publisher's own subscribers receive the message too: Postgres delivers a
   * `NOTIFY` to every listening session including the notifying one, so the
   * in-process implementation matches rather than papering over it. Handlers
   * must therefore be idempotent and treat local and remote origins identically
   * — which the client already does, ignoring an entry at or below its cursor
   * (packages/web/src/boardSync.ts:126).
   */
  publish(message: FanoutMessage): Promise<void>;

  /**
   * Listen for messages about one board; returns the unsubscribe.
   *
   * Subscriptions are per board, and the set of live subscriptions *is* the set
   * of boards this instance has joined. That is load-bearing for the Postgres
   * implementation: `LISTEN` runs on one dedicated connection outside the pool
   * (ADR 0004), and when that connection drops there is no way to learn what was
   * missed — `NOTIFY` keeps no history and carries no per-channel sequence, so
   * the size of the gap is unknowable. The only correct recovery is to tell every
   * subscriber to reload, which is what `resync` is for:
   *
   *   On reconnect, before delivering any newer notification, emit exactly one
   *   `{boardId, kind: "resync"}` per board that has live subscriptions.
   *   `resyncMessage(boardId)` builds it; iterate the subscription registry
   *   rather than the room map, so the two cannot drift.
   *
   * A subscriber must treat `resync` as "re-read durable state from my cursor"
   * (op log plus `PresenceStore`), never as an error, and must tolerate a
   * spurious one — a reconnect that missed nothing still resyncs, because the
   * implementation cannot tell the difference. Over-resyncing costs a read;
   * under-resyncing loses an edit silently.
   */
  subscribe(boardId: string, listener: FanoutListener): Unsubscribe;

  /**
   * Drop every subscription and stop delivery, releasing the dedicated
   * connection in the Postgres implementation. Idempotent, because graceful
   * shutdown and a test teardown may both call it. After close, `publish`
   * resolves without delivering and `subscribe` returns a no-op unsubscribe: a
   * socket closing mid-shutdown must not throw, and a notification dropped
   * during shutdown is safe for the reason `publish` gives.
   */
  close(): Promise<void>;
}

/**
 * Encode a message for the wire: fixed key order, absent optional fields
 * omitted. Canonical rather than a bare `JSON.stringify(message)` so the size
 * check is exact and reproducible — the same message must not pass the cap on
 * one instance and fail on another because a caller happened to build the object
 * in a different order.
 *
 * Bytes, not characters: the `NOTIFY` limit is on the encoded payload, and a
 * board id or user id outside ASCII costs more than one byte per character.
 */
export function encodeFanoutMessage(message: FanoutMessage): string {
  const canonical: Record<string, unknown> = { boardId: message.boardId, kind: message.kind };
  if (message.seq !== undefined) canonical.seq = message.seq;
  if (message.userId !== undefined) canonical.userId = message.userId;
  if (message.instanceId !== undefined) canonical.instanceId = message.instanceId;
  if (message.data !== undefined) canonical.data = message.data;
  const json = JSON.stringify(canonical);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > FANOUT_MAX_PAYLOAD_BYTES) {
    throw new FanoutPayloadTooLargeError(bytes, FANOUT_MAX_PAYLOAD_BYTES);
  }
  return json;
}

/**
 * Parse a payload received from the bus, or null when it is not a message this
 * version understands. Null rather than a throw on purpose: the Postgres
 * implementation reads every board's notifications on one shared connection, so a
 * malformed payload — or one from a newer instance mid rolling deploy — must not
 * take that connection, and with it this instance's fanout, down. Unknown fields
 * are ignored for the same reason.
 */
export function decodeFanoutMessage(raw: string): FanoutMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { boardId, kind, seq, userId, instanceId, data } = parsed as Record<string, unknown>;
  if (typeof boardId !== "string" || boardId.length === 0) return null;
  if (kind !== "op" && kind !== "presence" && kind !== "resync" && kind !== "proposal") return null;
  if (seq !== undefined && (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0)) {
    return null;
  }
  if (userId !== undefined && typeof userId !== "string") return null;
  if (instanceId !== undefined && typeof instanceId !== "string") return null;
  const message: FanoutMessage = { boardId, kind };
  if (typeof seq === "number") message.seq = seq;
  if (typeof userId === "string") message.userId = userId;
  if (typeof instanceId === "string") message.instanceId = instanceId;
  if (data !== undefined) message.data = data;
  return message;
}

/**
 * The synthetic message a reconnecting implementation owes each joined board. A
 * helper rather than an inline literal so the "no seq on a resync" rule in
 * `FanoutMessage` has exactly one place to be got right.
 */
export function resyncMessage(boardId: string): FanoutMessage {
  return { boardId, kind: "resync" };
}

/**
 * Fanout for a single-instance deployment, and the one the tests use.
 *
 * Correct on its own whenever there is one process — "cross-instance" is then a
 * no-op — and the default until a deployment runs more than one instance, at
 * which point the Postgres `LISTEN/NOTIFY` implementation drops in behind this
 * exact shape (ADR 0004).
 *
 * It still encodes and decodes every message, for two reasons that both matter
 * more than the microseconds: the payload cap is enforced in dev and in tests
 * rather than only in production, and a subscriber receives a copy it cannot use
 * to mutate the publisher's object — the isolation a real wire gives for free,
 * so behaviour does not shift when the Postgres implementation lands.
 */
export class InProcessFanout implements Fanout {
  /** boardId → listeners. A board with no listeners holds no entry. */
  private readonly listeners = new Map<string, Set<FanoutListener>>();
  private closed = false;

  /**
   * `onListenerError` receives anything a listener throws. A listener that
   * throws must not fail the publisher's commit — on a real bus the publisher is
   * another process and could not know — but swallowing it silently would hide a
   * broken subscriber, so the handler is explicit and defaults to a no-op.
   */
  constructor(
    private readonly onListenerError: (error: unknown, message: FanoutMessage) => void = () => {},
  ) {}

  async publish(message: FanoutMessage): Promise<void> {
    // Encode first, so an oversized message fails whether or not anybody is
    // listening. A guard that only fires when a subscriber exists is a guard
    // that passes in unit tests and throws in production. `async`, so it
    // surfaces as a rejection: `publish` is called from a socket handler, and a
    // synchronous throw there would take the connection with it.
    const encoded = encodeFanoutMessage(message);
    if (this.closed) return;
    const set = this.listeners.get(message.boardId);
    if (!set || set.size === 0) return;
    // Decode what we just encoded, so listeners get a copy rather than the
    // publisher's own object. The round trip cannot fail on our own output; the
    // fallback keeps the types honest without a throw on an impossible branch.
    const delivered = decodeFanoutMessage(encoded) ?? message;
    // Snapshot: who receives a message is fixed when it is published, so a
    // listener that subscribes during delivery does not see it. One that
    // unsubscribes during delivery is skipped, because "unsubscribe stops
    // delivery" is the stronger guarantee to keep.
    for (const listener of [...set]) {
      if (!set.has(listener)) continue;
      try {
        listener(delivered);
      } catch (error) {
        this.onListenerError(error, message);
      }
    }
  }

  subscribe(boardId: string, listener: FanoutListener): Unsubscribe {
    // A closed bus registers nothing, so a late subscribe cannot leak a listener
    // that will never be delivered to or cleaned up.
    if (this.closed) return () => {};
    // A Set, so the same function subscribed twice for one board is one
    // subscription: realtime.ts passes a fresh closure per room, and dedupe is
    // friendlier than double delivery.
    const set = this.listeners.get(boardId) ?? new Set<FanoutListener>();
    set.add(listener);
    this.listeners.set(boardId, set);
    let live = true;
    return () => {
      // Idempotent: leave and shutdown may both unsubscribe the same room, and
      // the second call must not remove a listener that resubscribed since.
      if (!live) return;
      live = false;
      const current = this.listeners.get(boardId);
      if (!current) return;
      current.delete(listener);
      // Drop the empty entry, so a long-running process does not retain a Set
      // per board it once served.
      if (current.size === 0) this.listeners.delete(boardId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
  }

  /**
   * Boards with at least one live subscription — the set a reconnecting
   * implementation owes a `resync` (see `Fanout.subscribe`). Sorted, so a test
   * or a metrics scrape reads the same order twice.
   */
  subscribedBoards(): string[] {
    return [...this.listeners.keys()].sort();
  }

  /** Live subscriptions, for one board or across all of them. */
  subscriberCount(boardId?: string): number {
    if (boardId !== undefined) return this.listeners.get(boardId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}
