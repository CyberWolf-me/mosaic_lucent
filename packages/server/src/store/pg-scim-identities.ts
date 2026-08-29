import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { scimIdentities } from "../db/schema.js";
import type { ScimIdentity, ScimIdentityStore } from "../scim.js";

/**
 * Postgres-backed SCIM identity store (M6 / F1).
 *
 * Mirrors `InMemoryScimIdentityStore` 1:1 so the parity tests in
 * `pg-store.test.ts` can swap between them. Queries always pin the IdP —
 * `idp` is part of every lookup key.
 *
 * The unique index `(idp, external_id)` makes the `insert` race-safe at the
 * database: a double POST from the IdP cannot land two distinct Lucent users
 * on the same external id; the second `INSERT` fails and the handler turns
 * that into a 409.
 */
export class PostgresScimIdentityStore implements ScimIdentityStore {
  constructor(private readonly target: Db) {}

  async byExternalId(idp: string, externalId: string): Promise<ScimIdentity | undefined> {
    const rows = await this.target.db
      .select()
      .from(scimIdentities)
      .where(and(eq(scimIdentities.idp, idp), eq(scimIdentities.externalId, externalId)))
      .limit(1);
    const row = rows[0];
    return row ? toIdentity(row) : undefined;
  }

  async byUserId(idp: string, userId: string): Promise<ScimIdentity | undefined> {
    const rows = await this.target.db
      .select()
      .from(scimIdentities)
      .where(and(eq(scimIdentities.idp, idp), eq(scimIdentities.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? toIdentity(row) : undefined;
  }

  async insert(row: ScimIdentity): Promise<void> {
    // ON CONFLICT DO NOTHING keeps this idempotent and lets concurrent
    // provisioning be a no-op rather than a transaction-rollback failure.
    await this.target.db
      .insert(scimIdentities)
      .values({
        idp: row.idp,
        externalId: row.externalId,
        userId: row.userId,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing({
        target: [scimIdentities.idp, scimIdentities.externalId],
      });
  }

  async remove(idp: string, externalId: string): Promise<boolean> {
    const deleted = await this.target.db
      .delete(scimIdentities)
      .where(and(eq(scimIdentities.idp, idp), eq(scimIdentities.externalId, externalId)))
      .returning({ userId: scimIdentities.userId });
    return deleted.length > 0;
  }

  async listForIdp(idp: string): Promise<ScimIdentity[]> {
    const rows = await this.target.db
      .select()
      .from(scimIdentities)
      .where(eq(scimIdentities.idp, idp));
    return rows.map(toIdentity);
  }
}

function toIdentity(row: typeof scimIdentities.$inferSelect): ScimIdentity {
  return {
    idp: row.idp,
    externalId: row.externalId,
    userId: row.userId,
    createdAt: row.createdAt,
  };
}
