import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memberships, oauthAccounts, organizations, users } from "../db/schema.js";
import type { UserStore } from "../accounts.js";
import {
  normalizeEmail,
  type Membership,
  type Organization,
  type StoredUser,
} from "../identity.js";
import type { OauthIdentity, OauthProviderName } from "../oauth.js";

/**
 * Postgres-backed UserStore. Implements the same interface as
 * `InMemoryUserStore` (docs/06) so main.ts can pick one at boot and the rest
 * of the server is none the wiser. Both implementations are async.
 *
 * Lookups go through indexed columns: `lower(email)` (functional unique
 * index) for byEmail, `id` (PK) for byId, `(user_id, org_id)` (PK) for
 * memberships. The unique index is what gives us the same "duplicate signup
 * is refused" property the in-memory store had, but enforced at the database
 * rather than by an in-process Map.
 */
export class PostgresUserStore implements UserStore {
  constructor(private readonly target: Db) {}

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const norm = normalizeEmail(email);
    const rows = await this.target.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${norm}`)
      .limit(1);
    return rows[0] ? rowToStoredUser(rows[0]) : undefined;
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    const rows = await this.target.db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? rowToStoredUser(rows[0]) : undefined;
  }

  async findOauthIdentity(
    provider: OauthProviderName,
    providerAccountId: string,
  ): Promise<OauthIdentity | undefined> {
    const rows = await this.target.db
      .select({ userId: oauthAccounts.userId })
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerAccountId, providerAccountId),
        ),
      )
      .limit(1);
    return rows[0] ? { provider, providerAccountId, userId: rows[0].userId } : undefined;
  }

  async linkOauthIdentity(
    identity: OauthIdentity & { email: string | null; now: number },
  ): Promise<void> {
    // ON CONFLICT DO NOTHING: a redelivered link (two logins racing, a
    // callback retry) must not bump last_login_at backwards or error out —
    // the row either exists with the right user or is written now.
    await this.target.db
      .insert(oauthAccounts)
      .values({
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        userId: identity.userId,
        email: identity.email,
        createdAt: identity.now,
        lastLoginAt: identity.now,
      })
      .onConflictDoNothing({
        target: [oauthAccounts.provider, oauthAccounts.providerAccountId],
      });
  }

  async insert(user: StoredUser): Promise<void> {
    await this.target.db.insert(users).values({
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      // tokenVersion has a SQL DEFAULT 0; pass explicitly so a future bump of
      // the default doesn't silently rewrite legacy users' values.
      tokenVersion: user.tokenVersion,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    });
  }

  async ensurePersonalOrg(userId: string, displayName: string, now: number): Promise<Organization> {
    const orgId = `org_personal_${userId}`;
    // The personal org id is deterministic; ON CONFLICT skips the insert when
    // a migration or a prior call already created it.
    await this.target.db
      .insert(organizations)
      .values({ id: orgId, name: `${displayName.trim() || "User"}'s workspace`, createdAt: now })
      .onConflictDoNothing();
    await this.target.db
      .insert(memberships)
      .values({ userId, orgId, role: "owner" })
      .onConflictDoNothing();
    const rows = await this.target.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return rows[0]!;
  }

  async listOrgsForUser(
    userId: string,
  ): Promise<Array<{ org: Organization; role: Membership["role"] }>> {
    const rows = await this.target.db
      .select({ org: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, userId));
    return rows.map((r) => ({ org: r.org, role: r.role as Membership["role"] }));
  }

  async membershipsFor(userId: string): Promise<Membership[]> {
    const rows = await this.target.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return rows.map((r) => ({
      userId: r.userId,
      orgId: r.orgId,
      role: r.role as Membership["role"],
    }));
  }

  /**
   * INDEX USE: the `memberships` primary key is `(user_id, org_id)`, so this
   * counts through `memberships_org_idx` on `(org_id)`. int8 again, hence the
   * string cast and the parse.
   */
  async countMembers(orgId: string): Promise<number> {
    const rows = await this.target.db
      .select({ count: sql<string>`count(*)` })
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
    const raw = rows[0]?.count;
    const parsed = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async removeMembership(orgId: string, userId: string): Promise<void> {
    await this.target.db
      .delete(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  }

  async setMembership(membership: Membership): Promise<void> {
    await this.target.db
      .insert(memberships)
      .values({ userId: membership.userId, orgId: membership.orgId, role: membership.role })
      .onConflictDoUpdate({
        target: [memberships.userId, memberships.orgId],
        // A joiner-via-link is at most editor; never escalate role upward if the
        // joiner already had a stronger grant.
        set: { role: membership.role },
      });
  }

  async bumpTokenVersion(userId: string, _now: number): Promise<number> {
    // The increment is a SQL-side operation; the `_now` parameter is reserved
    // for a future column that records "last bumped at" (M1 currently reads
    // only the version, never the timestamp).
    const updated = await this.target.db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId))
      .returning({ tokenVersion: users.tokenVersion });
    return updated[0]?.tokenVersion ?? -1;
  }

  async setEmailVerified(userId: string, now: number): Promise<void> {
    await this.target.db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, userId));
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.target.db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  async updateProfile(userId: string, patch: { name?: string }): Promise<void> {
    if (typeof patch.name !== "string") return;
    const trimmed = patch.name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) return;
    await this.target.db.update(users).set({ name: trimmed }).where(eq(users.id, userId));
  }

  async deleteUser(userId: string): Promise<void> {
    // Deleting a user has to take with it any org that was only reachable
    // through them. The personal workspace every signup gets (M2.1,
    // `org_personal_<userId>`) has exactly one member, so without this the org
    // row and its boards outlive the account: nobody can open it, nobody is
    // billed for it, and its id/name stay occupied forever. Nothing downstream
    // collects those remains - `runScheduledDeletions` (accounts.ts) treats
    // `deleteUser` as the entire wipe and then only drops the deletion row, and
    // accountDeletion.ts's contract is the same ("we execute by deleting the
    // user + cascade"). `InMemoryUserStore.deleteUser` has always dropped every
    // org left with no members; this is Postgres catching up to the semantics
    // the in-memory store and the deletion job already promise.
    //
    // The rule, once: an org is deleted iff no membership rows remain for it
    // after this user's are gone. That covers the personal org without
    // special-casing its id, and it deliberately keeps a shared org that still
    // has other members - removing one owner of a five-person tenant must not
    // remove the tenant. It also collects a *shared* org this user happened to
    // be the last member of, which is the same unreachable state by a different
    // route, and is what the in-memory store does.
    //
    // One transaction, because the two halves are only correct together: a
    // crash between them leaves precisely the orphaned org this fixes, and a
    // half-deleted account is a state none of the read paths can answer for.
    await this.target.db.transaction(async (tx) => {
      // Read the candidate orgs first: the membership rows naming them are
      // about to disappear with the user, so after the delete there is nothing
      // left to tell us which orgs this account could reach.
      const memberOf = await tx
        .select({ orgId: memberships.orgId })
        .from(memberships)
        .where(eq(memberships.userId, userId));

      // `memberships.user_id` is ON DELETE CASCADE (db/schema.ts), as are
      // sessions, op_log, board_members, board_share_links, account_deletions,
      // totp_credentials, recovery_codes, oauth_accounts, notifications and the
      // boards this user owns. Deleting the user row is therefore the whole
      // per-user wipe; re-issuing those deletes by hand would just be a second
      // copy of the cascade to keep in sync with the schema.
      await tx.delete(users).where(eq(users.id, userId));
      if (memberOf.length === 0) return;

      // NOT EXISTS is evaluated inside the same transaction that removed the
      // membership rows, so "no members left" is read after the cascade rather
      // than predicted before it - and it stays correct if the user held rows in
      // several orgs. Deleting the org row cascades onward to its boards (and
      // from there op_log, board_members, share links), invites, audit_log,
      // notifications, subscriptions and usage rows: every FK into
      // `organizations` is ON DELETE CASCADE, so this one DELETE is enough.
      const orgIds = [...new Set(memberOf.map((m) => m.orgId))];
      await tx.delete(organizations).where(
        and(
          inArray(organizations.id, orgIds),
          notExists(
            tx
              .select({ one: sql<number>`1` })
              .from(memberships)
              .where(eq(memberships.orgId, organizations.id)),
          ),
        ),
      );
    });
  }
}

function rowToStoredUser(row: typeof users.$inferSelect): StoredUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt,
    passwordHash: row.passwordHash,
    // Existing rows created before M1 lack the column in their Drizzle type;
    // coalesce to 0 so `authenticate` can compare against `row.tokenVersion`.
    tokenVersion: row.tokenVersion ?? 0,
    emailVerifiedAt: row.emailVerifiedAt ?? null,
  };
}
