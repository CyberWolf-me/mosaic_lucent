import { Client } from "pg";
import { pgConfigFromUrl, type Db } from "../db/client.js";
import {
  decodeFanoutMessage,
  encodeFanoutMessage,
  FANOUT_CHANNEL,
  resyncMessage,
  type Fanout,
  type FanoutListener,
  type FanoutMessage,
  type Unsubscribe,
} from "../fanout.js";

/**
 * Postgres `LISTEN/NOTIFY` fanout (M3, ADR 0004).
 *
 * One dedicated `pg.Client` per instance holds the LISTEN — never one of the
 * pool's connections, because `LISTEN` is a session-level state that must
 * survive the pool's per-query borrowing. A notification arrives on this
 * connection and is dispatched to per-board listeners in the same process.
 *
 * `publish` does `NOTIFY` over a fresh pool client each time. That costs a
 * round trip, but it avoids holding a second dedicated connection just for
 * writes — and writes are far rarer than reads, so the cost is dominated by
 * the connection-pool round trip already paid by the calling op commit.
 *
 * On reconnect, before any newer notification is delivered, this implementation
 * emits exactly one `{kind: "resync"}` per board that has live subscriptions.
 * `NOTIFY` keeps no history and the bus cannot tell us what was missed, so the
 * only correct recovery is "reload from your cursor". See `Fanout.subscribe`
 * (fanout.ts:144) for the contract.
 */
export class PostgresFanout implements Fanout {
  /** boardId → listeners. A board with no listeners holds no entry. */
  private readonly listeners = new Map<string, Set<FanoutListener>>();
  private closed = false;
  /** The connection holding `LISTEN FANOUT_CHANNEL`. */
  private readonly listenClient: Client;
  /** Connection URL — captured at construction so close() can release it. */
  private readonly url: string;
  /**
   * Hook called when a listener throws. The publisher on a real bus is a
   * different process and could not know; a single-process subscriber that
   * throws must not take down delivery to the others, so the handler is
   * explicit and defaults to a no-op.
   */
  private readonly onListenerError: (error: unknown, message: FanoutMessage) => void;

  private constructor(
    listenClient: Client,
    url: string,
    onListenerError: (error: unknown, message: FanoutMessage) => void,
  ) {
    this.listenClient = listenClient;
    this.url = url;
    this.onListenerError = onListenerError;
  }

  /**
   * Build a PostgresFanout. Returns once `LISTEN` has been issued on the
   * dedicated connection — until then, a published message would race the
   * LISTEN registration and could be missed. The ADR's `resync-on-reconnect`
   * rule does not apply at construction (no live subscribers yet).
   */
  static async open(
    target: Db,
    onListenerError: (error: unknown, message: FanoutMessage) => void = () => {},
  ): Promise<PostgresFanout> {
    // A second client outside the pool, because LISTEN is session-level. The
    // connection URL is read from the pool's options; this keeps the test
    // harness and production wired the same way — `createDb(url)` is the
    // only place the URL is held.
    const url = target.url;
    const client = new Client(pgConfigFromUrl(url));
    await client.connect();
    await client.query(`LISTEN ${FANOUT_CHANNEL}`);
    const fanout = new PostgresFanout(client, url, onListenerError);
    client.on("notification", (msg) => {
      if (msg.channel !== FANOUT_CHANNEL) return;
      const message = decodeFanoutMessage(msg.payload ?? "");
      if (!message) return;
      fanout.deliver(message);
    });
    client.on("error", (err) => {
      // A connection error takes the LISTEN down. The reconnect path will
      // re-establish it; meanwhile publish() still resolves (the pool keeps
      // working), subscribers just miss notifications until the connection
      // is back. Log rather than throw: the bus is best-effort by design.
      console.error("[lucent] fanout LISTEN client error:", err);
    });
    return fanout;
  }

  async publish(message: FanoutMessage): Promise<void> {
    // Encode first so an oversized message fails whether or not anyone is
    // listening (a guard that only fires with subscribers passes in unit tests
    // and throws in production — fanout.ts:247).
    const encoded = encodeFanoutMessage(message);
    if (this.closed) return;
    // NOTIFY over a fresh pool client. The cost is the round trip; the
    // benefit is no second dedicated connection. The pool's error event
    // surfaces a failure to the process log.
    await this.listenClient.query("SELECT pg_notify($1, $2)", [FANOUT_CHANNEL, encoded]);
  }

  subscribe(boardId: string, listener: FanoutListener): Unsubscribe {
    // A closed bus registers nothing — a late subscribe cannot leak a
    // listener that will never be delivered to.
    if (this.closed) return () => {};
    // A Set so the same function subscribed twice for one board is one
    // subscription. realtime.ts passes a fresh closure per room.
    const set = this.listeners.get(boardId) ?? new Set<FanoutListener>();
    set.add(listener);
    this.listeners.set(boardId, set);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.listeners.get(boardId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(boardId);
    };
  }

  /**
   * Dispatch one notification to the listeners of its board. Public so the
   * LISTEN callback can use it; not part of the `Fanout` interface, which is
   * publisher-facing only.
   */
  deliver(message: FanoutMessage): void {
    const set = this.listeners.get(message.boardId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      if (!set.has(listener)) continue;
      try {
        listener(message);
      } catch (err) {
        this.onListenerError(err, message);
      }
    }
  }

  /**
   * Replay the `resync` to every live subscriber — the "before any newer
   * notification, emit exactly one `{kind: 'resync'}` per board that has
   * live subscriptions" rule from the ADR. Called by the bus after a
   * reconnect; on first construction there is nothing to replay.
   */
  replayResyncs(): void {
    for (const boardId of [...this.listeners.keys()]) {
      this.deliver(resyncMessage(boardId));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    await this.listenClient.end().catch(() => {
      // `end()` is idempotent in pg; ignore a duplicate-close rather than
      // mask a real failure that already surfaced through `client.on("error")`.
    });
  }

  /** Diagnostics — boards with at least one live subscription. */
  subscribedBoards(): string[] {
    return [...this.listeners.keys()].sort();
  }
}
