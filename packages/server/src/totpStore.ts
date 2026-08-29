import { and, eq, isNull, lt } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import {
  totpCredentials as totpCredentialsTable,
  recoveryCodes as recoveryCodesTable,
  type DbRecoveryCode,
  type DbTotpCredential,
} from "./db/schema.js";
import type { Db } from "./db/client.js";

/**
 * 2FA store (M1.6). One credential per user (the `users.id` PK), plus a
 * set of single-use recovery codes per user. The store is what makes the
 * TOTP + recovery flows restart-safe; without it, restarting the server
 * would log every user out of 2FA.
 */

export interface StoredTotpCredential {
  userId: string;
  /** Base32-encoded shared secret. */
  secret: string;
  enrolledAt: number;
  lastCounter: number;
}

export interface StoredRecoveryCode {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: number;
  consumedAt: number | null;
}

export interface TotpStore {
  /** Insert or replace a user's TOTP credential. */
  setCredential(cred: StoredTotpCredential): Promise<void>;
  /** Read the credential for a user, or undefined. */
  getCredential(userId: string): Promise<StoredTotpCredential | undefined>;
  /**
   * Record the highest TOTP counter accepted for a user, so the same code
   * cannot be presented twice (RFC 6238 §5.2). The write must never move the
   * counter backwards — two requests racing with codes from adjacent slots
   * would otherwise re-open the replay window — so implementations guard on
   * `counter > last_counter` rather than blindly assigning.
   */
  setLastCounter(userId: string, counter: number): Promise<void>;
  /** Remove the credential (disable 2FA). */
  removeCredential(userId: string): Promise<void>;

  /** Add a set of recovery codes; the caller has already hashed them. */
  addRecoveryCodes(codes: StoredRecoveryCode[]): Promise<void>;
  /** List a user's live recovery codes (no hashes cross the network). */
  listRecoveryCodes(
    userId: string,
  ): Promise<Array<{ id: string; createdAt: number; consumedAt: number | null }>>;
  /** Find a recovery code by its hash (so the caller can consume it). */
  findRecoveryCodeByHash(userId: string, codeHash: string): Promise<StoredRecoveryCode | undefined>;
  /**
   * Try every live recovery code for the user in constant time, consuming
   * the first one that matches. Returns true on a successful match. The
   * caller provides a `verifyAgainst(candidate, stored)` that returns
   * Promise<boolean> so the store doesn't have to know the password-hashing
   * scheme.
   */
  tryConsumeRecoveryCode(
    userId: string,
    code: string,
    verifyAgainst: (candidate: string, stored: string) => Promise<boolean>,
    now: number,
  ): Promise<boolean>;
  /** Mark a code consumed; returns true when the row was live. */
  consumeRecoveryCode(id: string, now: number): Promise<boolean>;
  /** Drop all recovery codes for a user (used at re-enrollment). */
  removeAllRecoveryCodes(userId: string): Promise<void>;
}

export class InMemoryTotpStore implements TotpStore {
  private readonly creds = new Map<string, StoredTotpCredential>();
  private readonly codes = new Map<string, StoredRecoveryCode>();

  async setCredential(cred: StoredTotpCredential): Promise<void> {
    this.creds.set(cred.userId, cred);
  }
  async getCredential(userId: string): Promise<StoredTotpCredential | undefined> {
    return this.creds.get(userId);
  }
  async setLastCounter(userId: string, counter: number): Promise<void> {
    const cred = this.creds.get(userId);
    if (!cred) return;
    // Monotonic: a late request carrying an older slot must not lower the
    // watermark and hand the replay window back.
    if (counter > cred.lastCounter) cred.lastCounter = counter;
  }
  async removeCredential(userId: string): Promise<void> {
    this.creds.delete(userId);
  }
  async addRecoveryCodes(codes: StoredRecoveryCode[]): Promise<void> {
    for (const c of codes) this.codes.set(c.id, c);
  }
  async listRecoveryCodes(
    userId: string,
  ): Promise<Array<{ id: string; createdAt: number; consumedAt: number | null }>> {
    return Array.from(this.codes.values())
      .filter((c) => c.userId === userId)
      .map((c) => ({ id: c.id, createdAt: c.createdAt, consumedAt: c.consumedAt }));
  }
  async findRecoveryCodeByHash(
    userId: string,
    codeHash: string,
  ): Promise<StoredRecoveryCode | undefined> {
    for (const c of this.codes.values()) {
      if (c.userId === userId && c.codeHash === codeHash && c.consumedAt === null) return c;
    }
    return undefined;
  }
  async tryConsumeRecoveryCode(
    userId: string,
    code: string,
    verifyAgainst: (candidate: string, stored: string) => Promise<boolean>,
    now: number,
  ): Promise<boolean> {
    for (const c of this.codes.values()) {
      if (c.userId !== userId || c.consumedAt !== null) continue;
      if (await verifyAgainst(code, c.codeHash)) {
        c.consumedAt = now;
        return true;
      }
    }
    return false;
  }
  async consumeRecoveryCode(id: string, now: number): Promise<boolean> {
    const c = this.codes.get(id);
    if (!c || c.consumedAt !== null) return false;
    c.consumedAt = now;
    return true;
  }
  async removeAllRecoveryCodes(userId: string): Promise<void> {
    for (const [id, c] of this.codes.entries()) {
      if (c.userId === userId) this.codes.delete(id);
    }
  }
}

export class PostgresTotpStore implements TotpStore {
  constructor(private readonly target: Db) {}

  async setCredential(cred: StoredTotpCredential): Promise<void> {
    await this.target.db
      .insert(totpCredentialsTable)
      .values({
        userId: cred.userId,
        secret: cred.secret,
        enrolledAt: cred.enrolledAt,
        lastCounter: cred.lastCounter,
      })
      .onConflictDoUpdate({
        target: totpCredentialsTable.userId,
        set: { secret: cred.secret, enrolledAt: cred.enrolledAt, lastCounter: cred.lastCounter },
      });
  }
  async getCredential(userId: string): Promise<StoredTotpCredential | undefined> {
    const rows = await this.target.db
      .select()
      .from(totpCredentialsTable)
      .where(eq(totpCredentialsTable.userId, userId))
      .limit(1);
    const row = rows[0];
    return row ? rowToCredential(row) : undefined;
  }
  async setLastCounter(userId: string, counter: number): Promise<void> {
    // The `lt` guard makes the update a no-op when a concurrent request has
    // already banked a newer slot, so the watermark only ever climbs. No
    // migration needed — `totp_credentials.last_counter` already exists
    // (migrations/0004_cunning_totp.sql) and was simply never written.
    await this.target.db
      .update(totpCredentialsTable)
      .set({ lastCounter: counter })
      .where(
        and(eq(totpCredentialsTable.userId, userId), lt(totpCredentialsTable.lastCounter, counter)),
      );
  }
  async removeCredential(userId: string): Promise<void> {
    await this.target.db
      .delete(totpCredentialsTable)
      .where(eq(totpCredentialsTable.userId, userId));
  }
  async addRecoveryCodes(codes: StoredRecoveryCode[]): Promise<void> {
    if (codes.length === 0) return;
    await this.target.db.insert(recoveryCodesTable).values(
      codes.map((c) => ({
        id: c.id,
        userId: c.userId,
        codeHash: c.codeHash,
        createdAt: c.createdAt,
      })),
    );
  }
  async listRecoveryCodes(
    userId: string,
  ): Promise<Array<{ id: string; createdAt: number; consumedAt: number | null }>> {
    const rows = await this.target.db
      .select()
      .from(recoveryCodesTable)
      .where(eq(recoveryCodesTable.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      consumedAt: r.consumedAt ?? null,
    }));
  }
  async findRecoveryCodeByHash(
    userId: string,
    codeHash: string,
  ): Promise<StoredRecoveryCode | undefined> {
    const rows = await this.target.db
      .select()
      .from(recoveryCodesTable)
      .where(
        and(
          eq(recoveryCodesTable.userId, userId),
          eq(recoveryCodesTable.codeHash, codeHash),
          isNull(recoveryCodesTable.consumedAt),
        ),
      )
      .limit(1);
    return rows[0] ? rowToCode(rows[0]) : undefined;
  }
  async tryConsumeRecoveryCode(
    userId: string,
    code: string,
    verifyAgainst: (candidate: string, stored: string) => Promise<boolean>,
    now: number,
  ): Promise<boolean> {
    const rows = await this.target.db
      .select({ id: recoveryCodesTable.id, codeHash: recoveryCodesTable.codeHash })
      .from(recoveryCodesTable)
      .where(and(eq(recoveryCodesTable.userId, userId), isNull(recoveryCodesTable.consumedAt)));
    for (const row of rows) {
      if (!(await verifyAgainst(code, row.codeHash))) continue;
      const updated = await this.target.db
        .update(recoveryCodesTable)
        .set({ consumedAt: now })
        .where(and(eq(recoveryCodesTable.id, row.id), isNull(recoveryCodesTable.consumedAt)))
        .returning({ id: recoveryCodesTable.id });
      return updated.length > 0;
    }
    return false;
  }
  async consumeRecoveryCode(id: string, now: number): Promise<boolean> {
    const updated = await this.target.db
      .update(recoveryCodesTable)
      .set({ consumedAt: now })
      .where(and(eq(recoveryCodesTable.id, id), isNull(recoveryCodesTable.consumedAt)))
      .returning({ id: recoveryCodesTable.id });
    return updated.length > 0;
  }
  async removeAllRecoveryCodes(userId: string): Promise<void> {
    await this.target.db.delete(recoveryCodesTable).where(eq(recoveryCodesTable.userId, userId));
  }
}

function rowToCredential(row: DbTotpCredential): StoredTotpCredential {
  return {
    userId: row.userId,
    secret: row.secret,
    enrolledAt: row.enrolledAt,
    lastCounter: row.lastCounter,
  };
}

function rowToCode(row: DbRecoveryCode): StoredRecoveryCode {
  return {
    id: row.id,
    userId: row.userId,
    codeHash: row.codeHash,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt ?? null,
  };
}
/* ────────────────────── Pending two-factor login state ───────────────────── */

/**
 * The half-authenticated state between "password was correct" and "second
 * factor was correct".
 *
 * This used to be a module-level `Map` inside `accounts.ts`, which meant the
 * second login step only worked when it happened to land on the same process
 * that served the first one — a silent 401 on any deployment behind a load
 * balancer with more than one instance. It lives behind a store interface for
 * the same reason sessions and tokens do: a Postgres implementation drops in
 * without the handlers changing.
 *
 * The token is a bearer credential, so a persistent implementation stores a
 * SHA-256 hash of it (see `hashPendingToken`) exactly as `tokens.ts` does —
 * a DB dump must not yield tokens an attacker can present.
 */
export interface PendingTwoFactor {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingTwoFactorStore {
  /**
   * Mint and store a one-shot login token for `userId`. Returns the raw token
   * to hand to the client; the store keeps only what it needs to look it up.
   */
  issue(userId: string, now: number, ttlMs: number): Promise<string>;
  /**
   * Redeem a raw token: returns the pending entry and deletes it, so a token
   * is good for exactly one attempt. Returns undefined when the token is
   * unknown, already spent, or expired.
   */
  take(rawToken: string, now: number): Promise<PendingTwoFactor | undefined>;
  /** Drop expired entries. Cheap enough to call opportunistically. */
  prune(now: number): Promise<number>;
}

/** SHA-256 hex of a raw pending-2FA token. Same scheme as `tokens.ts`. */
export function hashPendingToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Per-process implementation. Correct for a single instance, and the default
 * so behaviour is unchanged for deployments that have not wired a persistent
 * store yet. It keys on the token hash rather than the raw token so the
 * in-memory and Postgres implementations behave identically.
 */
export class InMemoryPendingTwoFactorStore implements PendingTwoFactorStore {
  private readonly byHash = new Map<string, PendingTwoFactor>();

  async issue(userId: string, now: number, ttlMs: number): Promise<string> {
    const raw = randomBytes(24).toString("base64url");
    this.byHash.set(hashPendingToken(raw), { userId, createdAt: now, expiresAt: now + ttlMs });
    return raw;
  }

  async take(rawToken: string, now: number): Promise<PendingTwoFactor | undefined> {
    const key = hashPendingToken(rawToken);
    const entry = this.byHash.get(key);
    // Delete on every hit, expired or not: a presented token is spent either
    // way, which keeps a brute-force attempt from getting a second try.
    if (entry) this.byHash.delete(key);
    if (!entry || entry.expiresAt <= now) return undefined;
    return entry;
  }

  async prune(now: number): Promise<number> {
    let dropped = 0;
    for (const [key, entry] of this.byHash.entries()) {
      if (entry.expiresAt <= now) {
        this.byHash.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Test-only: forget every pending login. */
  clear(): void {
    this.byHash.clear();
  }
}
