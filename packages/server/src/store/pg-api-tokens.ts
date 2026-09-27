import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiTokens } from "../db/schema.js";
import type { ApiTokenScope, ApiTokenStore, StoredApiToken } from "../apiTokens.js";

type Handle = Db["db"];
type Row = typeof apiTokens.$inferSelect;

function toToken(r: Row): StoredApiToken {
  return {
    id: r.id,
    userId: r.userId,
    orgId: r.orgId,
    name: r.name,
    tokenHash: r.tokenHash,
    prefix: r.prefix,
    scopes: Array.isArray(r.scopes) ? (r.scopes as ApiTokenScope[]) : [],
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
    expiresAt: r.expiresAt ?? null,
    revokedAt: r.revokedAt ?? null,
  };
}

/** docs/26 A6: API tokens in Postgres — a hash each, never the token. */
export class PostgresApiTokenStore implements ApiTokenStore {
  constructor(private readonly db: Handle) {}

  async create(token: StoredApiToken): Promise<void> {
    await this.db.insert(apiTokens).values({ ...token, scopes: [...token.scopes] });
  }

  async findByHash(tokenHash: string): Promise<StoredApiToken | undefined> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, tokenHash))
      .limit(1);
    return row ? toToken(row) : undefined;
  }

  async get(id: string): Promise<StoredApiToken | undefined> {
    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1);
    return row ? toToken(row) : undefined;
  }

  async listForUser(userId: string): Promise<StoredApiToken[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(toToken);
  }

  async listForOrg(orgId: string): Promise<StoredApiToken[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.orgId, orgId), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
    return rows.map(toToken);
  }

  async revoke(id: string, at: number): Promise<boolean> {
    const done = await this.db
      .update(apiTokens)
      .set({ revokedAt: at })
      .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    return done.length > 0;
  }

  async touch(id: string, at: number): Promise<void> {
    await this.db.update(apiTokens).set({ lastUsedAt: at }).where(eq(apiTokens.id, id));
  }
}
