/**
 * OAuth credentials for integration connections (docs/26 A5): one row per
 * (org, provider), its tokens sealed by `tokenBox` — this store never sees a
 * token in the clear. A connection made through OAuth names `OAUTH_REF` as
 * its credential reference; everything else still names an environment
 * variable.
 */

export interface StoredCredential {
  orgId: string;
  provider: string;
  /** Sealed (tokenBox), bound to `${orgId}:${provider}`. */
  accessToken: string;
  /** Sealed, when the provider issued one. */
  refreshToken: string | null;
  /** When the access token stops working; null = the provider didn't say. */
  expiresAt: number | null;
  scope: string | null;
  /** Who connected it. */
  obtainedBy: string;
  updatedAt: number;
}

export interface IntegrationCredentialStore {
  get(orgId: string, provider: string): Promise<StoredCredential | undefined>;
  /** Upsert by (org, provider): a reconnect or a refresh replaces the row. */
  put(credential: StoredCredential): Promise<void>;
  delete(orgId: string, provider: string): Promise<boolean>;
}

export class InMemoryIntegrationCredentialStore implements IntegrationCredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  async get(orgId: string, provider: string): Promise<StoredCredential | undefined> {
    const row = this.rows.get(`${orgId}:${provider}`);
    return row ? { ...row } : undefined;
  }

  async put(credential: StoredCredential): Promise<void> {
    this.rows.set(`${credential.orgId}:${credential.provider}`, { ...credential });
  }

  async delete(orgId: string, provider: string): Promise<boolean> {
    return this.rows.delete(`${orgId}:${provider}`);
  }
}
