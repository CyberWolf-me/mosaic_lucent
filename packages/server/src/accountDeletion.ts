import { eq, isNull } from "drizzle-orm";
import { accountDeletions } from "./db/schema.js";
import type { Db } from "./db/client.js";
import type { AccountDeletion } from "./identity.js";

/**
 * Pending account deletion (M1.7).
 *
 * The user schedules deletion; the row sits here until `executesAt`. We
 * execute by deleting the user + cascade (see `UserStore.deleteUser`). The
 * grace window is what gives GDPR compliance its teeth: until the timer
 * passes the data is intact, and the user can sign back in to cancel.
 */

export interface AccountDeletionStore {
  schedule(userId: string, requestedAt: number, executesAt: number): Promise<void>;
  cancel(userId: string, cancelledAt: number): Promise<void>;
  find(userId: string): Promise<AccountDeletion | undefined>;
  /** Find all users whose deletion has matured (now >= executesAt). */
  matured(now: number): Promise<AccountDeletion[]>;
  /** Remove a row after the user has been wiped. */
  remove(userId: string): Promise<void>;
}

export class InMemoryAccountDeletionStore implements AccountDeletionStore {
  private readonly byUser = new Map<string, AccountDeletion>();
  async schedule(userId: string, requestedAt: number, executesAt: number): Promise<void> {
    this.byUser.set(userId, { userId, requestedAt, executesAt, cancelledAt: null });
  }
  async cancel(userId: string, cancelledAt: number): Promise<void> {
    const d = this.byUser.get(userId);
    if (d) d.cancelledAt = cancelledAt;
  }
  async find(userId: string): Promise<AccountDeletion | undefined> {
    return this.byUser.get(userId);
  }
  async matured(now: number): Promise<AccountDeletion[]> {
    return Array.from(this.byUser.values()).filter(
      (d) => d.executesAt <= now && d.cancelledAt === null,
    );
  }
  async remove(userId: string): Promise<void> {
    this.byUser.delete(userId);
  }
}

export class PostgresAccountDeletionStore implements AccountDeletionStore {
  constructor(private readonly target: Db) {}
  async schedule(userId: string, requestedAt: number, executesAt: number): Promise<void> {
    await this.target.db
      .insert(accountDeletions)
      .values({ userId, requestedAt, executesAt })
      .onConflictDoUpdate({
        target: accountDeletions.userId,
        set: { requestedAt, executesAt, cancelledAt: null },
      });
  }
  async cancel(userId: string, cancelledAt: number): Promise<void> {
    await this.target.db
      .update(accountDeletions)
      .set({ cancelledAt })
      .where(eq(accountDeletions.userId, userId));
  }
  async find(userId: string): Promise<AccountDeletion | undefined> {
    const rows = await this.target.db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, userId))
      .limit(1);
    return rows[0] ? rowToDeletion(rows[0]) : undefined;
  }
  async matured(now: number): Promise<AccountDeletion[]> {
    const rows = await this.target.db
      .select()
      .from(accountDeletions)
      .where(isNull(accountDeletions.cancelledAt));
    return rows.filter((r) => r.executesAt <= now).map(rowToDeletion);
  }
  async remove(userId: string): Promise<void> {
    await this.target.db.delete(accountDeletions).where(eq(accountDeletions.userId, userId));
  }
}

function rowToDeletion(row: typeof accountDeletions.$inferSelect): AccountDeletion {
  return {
    userId: row.userId,
    requestedAt: row.requestedAt,
    executesAt: row.executesAt,
    cancelledAt: row.cancelledAt ?? null,
  };
}
