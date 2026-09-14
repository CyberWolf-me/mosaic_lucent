import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { wsTickets } from "./db/schema.js";

/**
 * Short-lived, single-use tickets for WebSocket authentication (M0.3).
 *
 * Why this exists: a long-lived bearer token would otherwise appear in proxy
 * access logs every time the client reconnects. Tickets swap that for a
 * 60-second opaque string the client fetches once via cookie-authenticated
 * POST /api/realtime/ticket, then hands to the WS upgrade. They are also
 * single-use, so a captured ticket cannot be replayed from a log file.
 */

interface TicketRecord {
  userId: string;
  /** Epoch ms when the ticket stops being accepted; 0 means already consumed. */
  expiresAt: number;
}

export interface TicketStore {
  /** Mint a ticket for the given user; the caller may issue one at a time. */
  mint(userId: string): Promise<string>;
  /** Atomically claim and invalidate a ticket. Returns the userId or null. */
  consume(ticket: string, now?: number): Promise<string | null>;
  /** Drop expired entries; called from the prune timer. */
  prune(now?: number): Promise<number>;
  /** Visible-for-tests count. */
  size(): Promise<number>;
}

export class InMemoryTicketStore implements TicketStore {
  private readonly entries = new Map<string, TicketRecord>();

  constructor(private readonly ttlMs: number) {}

  async mint(userId: string): Promise<string> {
    // Cap on stored tickets prevents runaway memory if clients stop consuming.
    if (this.entries.size >= 10_000) await this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.entries.set(ticket, { userId, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  async consume(ticket: string, now: number = Date.now()): Promise<string | null> {
    const record = this.entries.get(ticket);
    if (!record) return null;
    // Mark consumed atomically: even if two callers race, only the first wins.
    this.entries.delete(ticket);
    if (record.expiresAt <= now) return null;
    return record.userId;
  }

  async prune(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const [ticket, record] of this.entries) {
      if (record.expiresAt <= now) {
        this.entries.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  async size(): Promise<number> {
    return this.entries.size;
  }
}

/**
 * The Postgres twin (M3 follow-up, docs/20 P5): one row per ticket, the
 * SAME interface, so an instance can mint and a sibling instance can consume
 * behind a stateless ingress. Two instances behind one load balancer is the
 * exact case the in-memory store cannot serve — a ticket minted on A fails
 * its WS upgrade when the balancer lands the upgrade on B ~50% of the time
 * (two-instance.test.ts pins that per-instance behaviour as correct for the
 * in-memory store; this class is the upgrade path, chosen over sticky
 * ingress sessions in docs/20 P0).
 *
 * `consume` is one statement — `DELETE ... WHERE ticket = $1 AND expires > $2
 * RETURNING user_id` — so single-use holds across processes exactly the way
 * the in-memory delete-then-read does within one.
 *
 * `size()` is diagnostic (live rows in the window); the prune timer's
 * `prune()` is a bounded DELETE. Both are safe to run from every instance —
 * a ticket is a 60-second secret, not a ledger.
 */
export class PgTicketStore implements TicketStore {
  constructor(
    private readonly target: Db,
    private readonly ttlMs: number,
  ) {}

  async mint(userId: string): Promise<string> {
    const ticket = randomBytes(24).toString("base64url");
    await this.target.db.insert(wsTickets).values({
      ticket,
      userId,
      expiresAt: Date.now() + this.ttlMs,
    });
    return ticket;
  }

  async consume(ticket: string, now: number = Date.now()): Promise<string | null> {
    // Single-use across every instance: the DELETE claims the row and the
    // RETURNING carries the answer. An expired-but-unconsumed row also
    // deletes here (bounded cleanup on the hot path costs nothing).
    const rows = await this.target.db
      .delete(wsTickets)
      .where(and(eq(wsTickets.ticket, ticket), sql`${wsTickets.expiresAt} > ${now}`))
      .returning({ userId: wsTickets.userId });
    return rows[0]?.userId ?? null;
  }

  async prune(now: number = Date.now()): Promise<number> {
    const rows = await this.target.db
      .delete(wsTickets)
      .where(and(isNotNull(wsTickets.ticket), lt(wsTickets.expiresAt, now)))
      .returning({ ticket: wsTickets.ticket });
    return rows.length;
  }

  async size(): Promise<number> {
    const [row] = await this.target.db
      .select({ count: sql<number>`count(*)::int` })
      .from(wsTickets)
      .where(sql`${wsTickets.expiresAt} > ${Date.now()}`);
    return row?.count ?? 0;
  }
}
