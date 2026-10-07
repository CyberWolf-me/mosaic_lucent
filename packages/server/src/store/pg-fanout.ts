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
  /** The connection holding `LISTEN FANOUT_CHANNEL`. Null during reconnect. */
  private listenClient: Client | null = null;
  /** Db handle holding the connection pool used for publish. */
  private readonly target: Db;
  /** Connection URL — captured at construction so reconnection can use it. */
  private readonly url: string;
  /**
   * Hook called when a listener throws. The publisher on a real bus is a
   * different process and could not know; a single-process subscriber that
   * throws must not take down delivery to the others, so the handler is
   * explicit and defaults to a no-op.
   */
  private readonly onListenerError: (error: unknown, message: FanoutMessage) => void;

  /** Reconnect management */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private isConnecting = false;

  private constructor(
    target: Db,
    listenClient: Client,
    url: string,
    onListenerError: (error: unknown, message: FanoutMessage) => void,
  ) {
    this.target = target;
    this.listenClient = listenClient;
    this.url = url;
    this.onListenerError = onListenerError;
    this.bindClientEvents(listenClient);
  }

  private bindClientEvents(client: Client): void {
    client.on("notification", (msg) => {
      if (msg.channel !== FANOUT_CHANNEL) return;
      const message = decodeFanoutMessage(msg.payload ?? "");
      if (!message) return;
      this.deliver(message);
    });
    client.on("error", (err) => {
      console.error("[lucent] fanout LISTEN client error:", err);
      this.scheduleReconnect();
    });
    client.on("end", () => {
      this.scheduleReconnect();
    });
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
    const url = target.url;
    const client = new Client(pgConfigFromUrl(url));
    await client.connect();
    await client.query(`LISTEN ${FANOUT_CHANNEL}`);
    return new PostgresFanout(target, client, url, onListenerError);
  }

  /**
   * Schedule reconnection with jittered exponential backoff.
   */
  scheduleReconnect(delayMs?: number): void {
    if (this.closed || this.reconnectTimer) return;

    if (this.listenClient) {
      this.listenClient.removeAllListeners();
      this.listenClient.end().catch(() => {});
      this.listenClient = null;
    }

    const backoff =
      delayMs !== undefined
        ? delayMs
        : Math.min(5000, 100 * Math.pow(2, Math.min(this.reconnectAttempt, 6))) +
          Math.floor(Math.random() * 200);

    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.reconnect();
    }, backoff);
  }

  /**
   * Attempt to reconnect the LISTEN client.
   * On success: re-issues LISTEN and replays resync notifications to every active subscriber.
   * On failure: schedules another reconnection attempt.
   */
  async reconnect(): Promise<void> {
    if (this.closed || this.isConnecting) return;
    this.isConnecting = true;
    try {
      const client = new Client(pgConfigFromUrl(this.url));
      await client.connect();
      await client.query(`LISTEN ${FANOUT_CHANNEL}`);
      this.listenClient = client;
      this.bindClientEvents(client);
      this.reconnectAttempt = 0;
      this.isConnecting = false;
      // Re-delivery of resync per the ADR contract: before newer notifications
      this.replayResyncs();
    } catch (err) {
      this.isConnecting = false;
      console.error("[lucent] fanout reconnect attempt failed:", err);
      this.scheduleReconnect();
    }
  }

  async publish(message: FanoutMessage): Promise<void> {
    const encoded = encodeFanoutMessage(message);
    if (this.closed) return;
    // NOTIFY over the connection pool. Decoupled from the dedicated LISTEN client.
    await this.target.pool.query("SELECT pg_notify($1, $2)", [FANOUT_CHANNEL, encoded]);
  }

  subscribe(boardId: string, listener: FanoutListener): Unsubscribe {
    if (this.closed) return () => {};
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

  replayResyncs(): void {
    for (const boardId of [...this.listeners.keys()]) {
      this.deliver(resyncMessage(boardId));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.listeners.clear();
    if (this.listenClient) {
      this.listenClient.removeAllListeners();
      await this.listenClient.end().catch(() => {});
      this.listenClient = null;
    }
  }

  subscribedBoards(): string[] {
    return [...this.listeners.keys()].sort();
  }

  /** Visible for testing */
  getListenClient(): Client | null {
    return this.listenClient;
  }
}
