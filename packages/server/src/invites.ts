import { eq } from "drizzle-orm";
import { orgInvites, type DbOrgInvite } from "./db/schema.js";
import type { Db } from "./db/client.js";

/**
 * Org-invite store (M2.4).
 *
 * A pending invite carries the SHA-256 hash of a single-use token. The
 * raw token lives only in the email body / accept URL; the table is
 * enough on its own to verify (we hash the candidate on lookup) and to
 * revoke (set `revokedAt`).
 */

export interface StoredOrgInvite {
  id: string;
  orgId: string;
  email: string;
  role: "editor" | "viewer";
  tokenHash: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface CreateOrgInviteInput {
  orgId: string;
  email: string;
  role: "editor" | "viewer";
  tokenHash: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface OrgInviteStore {
  create(input: CreateOrgInviteInput): Promise<StoredOrgInvite>;
  /** Live (not consumed/revoked/expired) invites for an org. */
  listForOrg(orgId: string, now: number): Promise<StoredOrgInvite[]>;
  /** Find a live invite by its raw token's hash; used at accept time. */
  findByRawToken(raw: string, now: number): Promise<StoredOrgInvite | undefined>;
  /** Mark an invite consumed; idempotent. */
  consume(id: string, now: number): Promise<void>;
  revoke(id: string, now: number): Promise<void>;
}

export class InMemoryOrgInviteStore implements OrgInviteStore {
  private readonly invites = new Map<string, StoredOrgInvite>();

  async create(input: CreateOrgInviteInput): Promise<StoredOrgInvite> {
    const invite: StoredOrgInvite = {
      id: `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orgId: input.orgId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
    };
    this.invites.set(invite.id, invite);
    return invite;
  }

  async listForOrg(orgId: string, now: number): Promise<StoredOrgInvite[]> {
    return Array.from(this.invites.values())
      .filter(
        (i) =>
          i.orgId === orgId && i.consumedAt === null && i.revokedAt === null && i.expiresAt > now,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findByRawToken(raw: string, now: number): Promise<StoredOrgInvite | undefined> {
    // Hash in this method so the store doesn't import tokens.ts directly.
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(raw).digest("hex");
    for (const i of this.invites.values()) {
      if (i.tokenHash !== h) continue;
      if (i.consumedAt !== null) return undefined;
      if (i.revokedAt !== null) return undefined;
      if (i.expiresAt <= now) return undefined;
      return i;
    }
    return undefined;
  }

  async consume(id: string, now: number): Promise<void> {
    const i = this.invites.get(id);
    if (!i || i.consumedAt !== null) return;
    i.consumedAt = now;
  }

  async revoke(id: string, now: number): Promise<void> {
    const i = this.invites.get(id);
    if (!i || i.revokedAt !== null) return;
    i.revokedAt = now;
  }
}

export class PostgresOrgInviteStore implements OrgInviteStore {
  constructor(private readonly target: Db) {}

  async create(input: CreateOrgInviteInput): Promise<StoredOrgInvite> {
    const invite: StoredOrgInvite = {
      id: `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      orgId: input.orgId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
      revokedAt: null,
    };
    await this.target.db.insert(orgInvites).values({
      id: invite.id,
      orgId: invite.orgId,
      email: invite.email,
      role: invite.role,
      tokenHash: invite.tokenHash,
      invitedBy: invite.invitedBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    });
    return invite;
  }

  async listForOrg(orgId: string, now: number): Promise<StoredOrgInvite[]> {
    const rows = await this.target.db.select().from(orgInvites).where(eq(orgInvites.orgId, orgId));
    return rows
      .map(rowToInvite)
      .filter((i) => i.consumedAt === null && i.revokedAt === null && i.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async findByRawToken(raw: string, now: number): Promise<StoredOrgInvite | undefined> {
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256").update(raw).digest("hex");
    const rows = await this.target.db
      .select()
      .from(orgInvites)
      .where(eq(orgInvites.tokenHash, h))
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    if (row.consumedAt !== null) return undefined;
    if (row.revokedAt !== null) return undefined;
    if (row.expiresAt <= now) return undefined;
    return rowToInvite(row);
  }

  async consume(id: string, now: number): Promise<void> {
    await this.target.db
      .update(orgInvites)
      .set({ consumedAt: now })
      // The first WHERE keeps the update scoped to live invites; the
      // second is a defence in depth in case two requests race.
      .where(eq(orgInvites.id, id));
  }

  async revoke(id: string, now: number): Promise<void> {
    await this.target.db.update(orgInvites).set({ revokedAt: now }).where(eq(orgInvites.id, id));
  }
}

function rowToInvite(row: DbOrgInvite): StoredOrgInvite {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role,
    tokenHash: row.tokenHash,
    invitedBy: row.invitedBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}
