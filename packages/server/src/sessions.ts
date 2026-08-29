import { randomBytes } from "node:crypto";

/**
 * Browser session store (M1).
 *
 * Replaces the stateless HMAC token for browsers: opaque random ids in an
 * httpOnly cookie, looked up against a row that can be revoked. The bearer
 * token still lives in `auth.ts` for the MCP client and programmatic API
 * keys; both paths share `accounts.authenticate`, which tries cookie first
 * then falls back to bearer.
 *
 * Storage is an interface so the in-memory implementation here can be swapped
 * for Postgres without touching the handlers. Two implementations, same shape
 * as `UserStore`.
 */

export interface StoredSession {
  id: string;
  userId: string;
  /** Snapshot of the user's `tokenVersion` at creation time. */
  tokenVersion: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  ip: string | null;
}

export interface CreateSessionInput {
  userId: string;
  tokenVersion: number;
  /** ms since epoch. */
  now: number;
  /** ms until expiry; default 30 days. */
  ttlMs?: number;
  userAgent?: string | null;
  ip?: string | null;
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<StoredSession>;
  /** Returns the session if it exists, is not revoked, and has not expired. */
  find(id: string, now: number): Promise<StoredSession | undefined>;
  /** Sliding window: bump lastSeenAt so an active user stays logged in. */
  touch(id: string, now: number): Promise<void>;
  revoke(id: string, now: number): Promise<boolean>;
  /** "Sign out everywhere": every live session for a user, in one shot. */
  revokeAllForUser(userId: string, now: number): Promise<number>;
  /** Device list for the settings UI. Live sessions only, newest first. */
  listForUser(userId: string): Promise<StoredSession[]>;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A fresh 256-bit opaque id, hex-encoded. Used as the cookie value directly. */
export function newSessionId(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Per-process store. Correct for single-instance dev; replaced by Postgres
 * when `LUCENT_DATABASE_URL` is set.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, StoredSession>();

  async create(input: CreateSessionInput): Promise<StoredSession> {
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    const session: StoredSession = {
      id: newSessionId(),
      userId: input.userId,
      tokenVersion: input.tokenVersion,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.now + ttl,
      revokedAt: null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };
    this.byId.set(session.id, session);
    return session;
  }

  async find(id: string, now: number): Promise<StoredSession | undefined> {
    const s = this.byId.get(id);
    if (!s) return undefined;
    if (s.revokedAt !== null) return undefined;
    if (s.expiresAt <= now) return undefined;
    return s;
  }

  async touch(id: string, now: number): Promise<void> {
    const s = this.byId.get(id);
    if (!s) return;
    s.lastSeenAt = now;
  }

  async revoke(id: string, now: number): Promise<boolean> {
    const s = this.byId.get(id);
    if (!s || s.revokedAt !== null) return false;
    s.revokedAt = now;
    return true;
  }

  async revokeAllForUser(userId: string, now: number): Promise<number> {
    let count = 0;
    for (const s of this.byId.values()) {
      if (s.userId === userId && s.revokedAt === null) {
        s.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async listForUser(userId: string): Promise<StoredSession[]> {
    const now = Date.now();
    return Array.from(this.byId.values())
      .filter((s) => s.userId === userId && s.revokedAt === null && s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

/* ─────────────────────────── Postgres implementation ─────────────────────── */

import { and, eq, isNull } from "drizzle-orm";
import { sessions as sessionsTable } from "./db/schema.js";
import type { Db } from "./db/client.js";

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly target: Db) {}

  async create(input: CreateSessionInput): Promise<StoredSession> {
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    const session: StoredSession = {
      id: newSessionId(),
      userId: input.userId,
      tokenVersion: input.tokenVersion,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.now + ttl,
      revokedAt: null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };
    await this.target.db.insert(sessionsTable).values({
      id: session.id,
      userId: session.userId,
      tokenVersion: session.tokenVersion,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      revokedAt: null,
      userAgent: session.userAgent,
      ip: session.ip,
    });
    return session;
  }

  async find(id: string, now: number): Promise<StoredSession | undefined> {
    // The session is valid only when it exists, has not been revoked, and has
    // not expired. The tokenVersion comparison happens in `accounts.authenticate`
    // once we've joined the user row; the session row only carries the snapshot.
    const rows = await this.target.db
      .select()
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.id, id),
          isNull(sessionsTable.revokedAt),
          // expiresAt > now  →  NOT (expiresAt <= now)
          // drizzle's lt maps to <, so `<=` gives us the exclusion.
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (row.expiresAt <= now) return undefined;
    return rowToSession(row);
  }

  async touch(id: string, now: number): Promise<void> {
    await this.target.db
      .update(sessionsTable)
      .set({ lastSeenAt: now })
      .where(eq(sessionsTable.id, id));
  }

  async revoke(id: string, now: number): Promise<boolean> {
    // Update returns the row only when it was live; a revoked-or-missing id
    // resolves to 0 rows updated so callers can tell the difference.
    const updated = await this.target.db
      .update(sessionsTable)
      .set({ revokedAt: now })
      .where(and(eq(sessionsTable.id, id), isNull(sessionsTable.revokedAt)))
      .returning({ id: sessionsTable.id });
    return updated.length > 0;
  }

  async revokeAllForUser(userId: string, now: number): Promise<number> {
    const updated = await this.target.db
      .update(sessionsTable)
      .set({ revokedAt: now })
      .where(and(eq(sessionsTable.userId, userId), isNull(sessionsTable.revokedAt)))
      .returning({ id: sessionsTable.id });
    return updated.length;
  }

  async listForUser(userId: string): Promise<StoredSession[]> {
    const now = Date.now();
    const rows = await this.target.db
      .select()
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.userId, userId),
          isNull(sessionsTable.revokedAt),
          // exclude already-expired sessions too
        ),
      );
    return rows
      .map(rowToSession)
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

function rowToSession(row: typeof sessionsTable.$inferSelect): StoredSession {
  return {
    id: row.id,
    userId: row.userId,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ?? null,
    userAgent: row.userAgent ?? null,
    ip: row.ip ?? null,
  };
}
