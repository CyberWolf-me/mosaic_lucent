import { randomBytes } from "node:crypto";

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
  mint(userId: string): string;
  /** Atomically claim and invalidate a ticket. Returns the userId or null. */
  consume(ticket: string, now?: number): string | null;
  /** Drop expired entries; called from the prune timer. */
  prune(now?: number): number;
  /** Visible-for-tests count. */
  size(): number;
}

export class InMemoryTicketStore implements TicketStore {
  private readonly entries = new Map<string, TicketRecord>();

  constructor(private readonly ttlMs: number) {}

  mint(userId: string): string {
    // Cap on stored tickets prevents runaway memory if clients stop consuming.
    if (this.entries.size >= 10_000) this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.entries.set(ticket, { userId, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  consume(ticket: string, now: number = Date.now()): string | null {
    const record = this.entries.get(ticket);
    if (!record) return null;
    // Mark consumed atomically: even if two callers race, only the first wins.
    this.entries.delete(ticket);
    if (record.expiresAt <= now) return null;
    return record.userId;
  }

  prune(now: number = Date.now()): number {
    let removed = 0;
    for (const [ticket, record] of this.entries) {
      if (record.expiresAt <= now) {
        this.entries.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}
