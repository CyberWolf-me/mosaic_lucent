import { createHash, randomBytes } from "node:crypto";

/**
 * Single-use token store (M1.4).
 *
 * Used for email-verification and password-reset links. The token row carries
 * a hash of the token (SHA-256), never the token itself: a leaked DB dump or
 * a compromised backup reveals only the hashes, and a `findByRawToken` lookup
 * hashes the input before the query, so a SQL read by the attacker doesn't
 * let them present tokens to the API.
 *
 * Both tables (`email_verifications` and `password_resets`) have the same
 * shape, so the same interface works for both — the table is chosen by the
 * constructor argument.
 */

export interface StoredToken {
  id: string;
  userId: string;
  /** SHA-256 hex of the raw token. */
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface IssueTokenInput {
  userId: string;
  ttlMs: number;
  now: number;
}

export interface TokenStore {
  /** Mint a new token. Returns the row + the raw token to send in the email. */
  issue(input: IssueTokenInput): Promise<{ row: StoredToken; raw: string }>;
  /**
   * Resolve a raw token (from the URL) to the row, or undefined when the
   * token doesn't exist, has been consumed, or has expired.
   */
  findByRawToken(raw: string, now: number): Promise<StoredToken | undefined>;
  /** Mark a token as used. Idempotent — consuming twice is a no-op. */
  consume(id: string, now: number): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly byId = new Map<string, StoredToken>();
  private readonly byHash = new Map<string, string>();

  async issue(input: IssueTokenInput): Promise<{ row: StoredToken; raw: string }> {
    const raw = randomBytes(32).toString("base64url");
    const row: StoredToken = {
      id: `tok_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`,
      userId: input.userId,
      tokenHash: hashToken(raw),
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
      consumedAt: null,
    };
    this.byId.set(row.id, row);
    this.byHash.set(row.tokenHash, row.id);
    return { row, raw };
  }

  async findByRawToken(raw: string, now: number): Promise<StoredToken | undefined> {
    const id = this.byHash.get(hashToken(raw));
    if (!id) return undefined;
    const row = this.byId.get(id);
    if (!row) return undefined;
    if (row.consumedAt !== null) return undefined;
    if (row.expiresAt <= now) return undefined;
    return row;
  }

  async consume(id: string, now: number): Promise<void> {
    const row = this.byId.get(id);
    if (!row) return;
    if (row.consumedAt !== null) return;
    row.consumedAt = now;
  }
}

/* ─────────────────────────── Postgres implementation ───────────────────────── */

import { and, eq, isNull } from "drizzle-orm";
import {
  emailVerifications,
  passwordResets,
  type DbEmailVerification,
  type DbPasswordReset,
} from "./db/schema.js";
import type { Db } from "./db/client.js";

export class PostgresEmailVerificationStore implements TokenStore {
  constructor(private readonly target: Db) {}

  async issue(input: IssueTokenInput): Promise<{ row: StoredToken; raw: string }> {
    const raw = randomBytes(32).toString("base64url");
    const id = `evt_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const row: StoredToken = {
      id,
      userId: input.userId,
      tokenHash: hashToken(raw),
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
      consumedAt: null,
    };
    await this.target.db.insert(emailVerifications).values({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
    return { row, raw };
  }

  async findByRawToken(raw: string, now: number): Promise<StoredToken | undefined> {
    const rows = await this.target.db
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.tokenHash, hashToken(raw)),
          isNull(emailVerifications.consumedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (row.expiresAt <= now) return undefined;
    return rowToToken(row);
  }

  async consume(id: string, now: number): Promise<void> {
    await this.target.db
      .update(emailVerifications)
      .set({ consumedAt: now })
      .where(and(eq(emailVerifications.id, id), isNull(emailVerifications.consumedAt)));
  }
}

export class PostgresPasswordResetStore implements TokenStore {
  constructor(private readonly target: Db) {}

  async issue(input: IssueTokenInput): Promise<{ row: StoredToken; raw: string }> {
    const raw = randomBytes(32).toString("base64url");
    const id = `rst_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const row: StoredToken = {
      id,
      userId: input.userId,
      tokenHash: hashToken(raw),
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
      consumedAt: null,
    };
    await this.target.db.insert(passwordResets).values({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
    return { row, raw };
  }

  async findByRawToken(raw: string, now: number): Promise<StoredToken | undefined> {
    const rows = await this.target.db
      .select()
      .from(passwordResets)
      .where(and(eq(passwordResets.tokenHash, hashToken(raw)), isNull(passwordResets.consumedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (row.expiresAt <= now) return undefined;
    return rowToToken(row);
  }

  async consume(id: string, now: number): Promise<void> {
    await this.target.db
      .update(passwordResets)
      .set({ consumedAt: now })
      .where(and(eq(passwordResets.id, id), isNull(passwordResets.consumedAt)));
  }
}

function rowToToken(row: DbEmailVerification | DbPasswordReset): StoredToken {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? null,
  };
}

/** Hash a raw token to SHA-256 hex. Stable across runs and stores. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
