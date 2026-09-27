import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { integrationCredentials } from "../db/schema.js";
import type { IntegrationCredentialStore, StoredCredential } from "../integrations/credentials.js";

type Handle = Db["db"];

/** docs/26 A5: sealed OAuth tokens, one row per (org, provider). */
export class PostgresIntegrationCredentialStore implements IntegrationCredentialStore {
  constructor(private readonly db: Handle) {}

  async get(orgId: string, provider: string): Promise<StoredCredential | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationCredentials)
      .where(
        and(eq(integrationCredentials.orgId, orgId), eq(integrationCredentials.provider, provider)),
      );
    return row
      ? {
          orgId: row.orgId,
          provider: row.provider,
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          expiresAt: row.expiresAt,
          scope: row.scope,
          obtainedBy: row.obtainedBy,
          updatedAt: row.updatedAt,
        }
      : undefined;
  }

  async put(credential: StoredCredential): Promise<void> {
    const values = {
      orgId: credential.orgId,
      provider: credential.provider,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      scope: credential.scope,
      obtainedBy: credential.obtainedBy,
      updatedAt: credential.updatedAt,
    };
    await this.db
      .insert(integrationCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [integrationCredentials.orgId, integrationCredentials.provider],
        set: {
          accessToken: values.accessToken,
          refreshToken: values.refreshToken,
          expiresAt: values.expiresAt,
          scope: values.scope,
          obtainedBy: values.obtainedBy,
          updatedAt: values.updatedAt,
        },
      });
  }

  async delete(orgId: string, provider: string): Promise<boolean> {
    const gone = await this.db
      .delete(integrationCredentials)
      .where(
        and(eq(integrationCredentials.orgId, orgId), eq(integrationCredentials.provider, provider)),
      )
      .returning();
    return gone.length > 0;
  }
}
