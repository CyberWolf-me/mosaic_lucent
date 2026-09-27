import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema for the Lucent server (docs/06).
 *
 * The Workspace object from `@lucent/core` lives in `boards.workspace` as a
 * single JSONB blob — the schema is owned by core's zod union, not by SQL.
 * Everything else (users, orgs, memberships, op_log) is plain relational data.
 *
 * `lower(email)` is exposed via a functional unique index, which is how
 * Postgres enforces case-insensitive uniqueness without a generated column.
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /**
     * Monotonic counter for bulk-invalidation: every session is stamped with
     * the user's tokenVersion at creation, and `authenticate` rejects sessions
     * stamped with a version below the user's current value. A single UPDATE
     * (`token_version = token_version + 1`) then invalidates every live
     * session without enumerating them. Reserved for M1 ("Sign out
     * everywhere"); other code paths ignore it today.
     */
    tokenVersion: bigint("token_version", { mode: "number" }).notNull().default(0),
    /**
     * M1.4: when set, the user has confirmed control of their email. Gates
     * `POST /api/boards/:id/share` — a board owner cannot mint public share
     * links until they've verified. `null` is the same as `false`; the
     * column exists so future flows (audit log, "trust level") can read it
     * without an extra join.
     */
    emailVerifiedAt: bigint("email_verified_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    emailLowerIdx: uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
  }),
);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * The org policy plane (docs/23 S2, docs/24 Phase B): the classification
   * floor plus the AI/sharing/agent/recording denials, validated on write,
   * read through `effectiveSettings` (classification.ts) — which treats
   * absence as the permissive default and an uninterpretable value as
   * restrictive, fail closed. jsonb, not a column per field: every gate
   * resolves the whole object at once, no field is ever queried in SQL, and
   * the shape lives in exactly one TypeScript interface the store cannot
   * drift from.
   */
  settings: jsonb("settings"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.orgId] }),
    orgIdx: index("memberships_org_idx").on(t.orgId),
  }),
);

export const boards = pgTable(
  "boards",
  {
    id: text("id").primaryKey(),
    /**
     * Tenant boundary (M2.1). Every board lives in exactly one org. Set on
     * insert; not user-mutable. Cross-tenant leakage tests rely on the FK
     * to organizations + the `boards_org_idx` index below.
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Governance tier (docs/23 S1, docs/24 Phase A). Nullable on purpose: a
     * NULL row is a board that predates the field and means `internal`, so the
     * migration needs no backfill and no board's behavior changes on deploy.
     * The gates read through `classificationOf`, which supplies the default.
     */
    classification: text("classification", {
      enum: ["internal", "confidential", "restricted"],
    }),
    /** The full Workspace object, as emitted by `createWorkspace()` in core. */
    workspace: jsonb("workspace").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    ownerIdx: index("boards_owner_idx").on(t.ownerId, t.updatedAt),
    orgIdx: index("boards_org_idx").on(t.orgId, t.updatedAt),
  }),
);

/**
 * Per-board operation log. The board's authoritative state is the workspace
 * snapshot; the log is what makes collaboration restart-safe — a reconnecting
 * client gets `catchup = log.since(fromSeq)` and the room is rebuilt from this
 * on first join. Without it, a restart would replay the whole snapshot as a
 * diff that no client has applied.
 */
export const opLog = pgTable(
  "op_log",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    ops: jsonb("ops").notNull(),
    by: text("by").notNull(),
    label: text("label").notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
    /**
     * Server-generated id for this committed batch (`op_…`). The log's primary
     * key is (board_id, seq) — a coordinate in one board's history — while the
     * operation id names the batch itself, which is what an ack, a proposal's
     * applied link, or a future audit trail wants to reference without naming
     * a board and a position.
     */
    operationId: text("operation_id").notNull(),
    /**
     * Client-generated id for the submit that produced this entry (`req_…`).
     * The idempotency key (Stage B): a network retry replays the same
     * requestId and must be answered with the original outcome, never a second
     * effect. Nullable because a log written before the protocol existed — or
     * a caller with no retry semantics — has no id to claim.
     */
    requestId: text("request_id"),
    /**
     * WHO/WHAT produced this batch: "user" (a human through the room, or an
     * agent acting under a human's token), "ai" (Lucent's extraction — a
     * proposal approval commits the model's operations as the model's act),
     * or "system" (reserved for server-initiated writes; no producer yet).
     * The three-part accountability split lives on the next two columns.
     */
    actorType: text("actor_type").notNull().default("user"),
    /** The actor's stable id: a usr_… for users, "lucent" for the AI. */
    actorId: text("actor_id").notNull(),
    /**
     * WHO ASKED for it: the user whose request produced the batch. Same as
     * actorId for human edits; for an AI commit it is the user whose meeting
     * or prompt the extraction answered.
     */
    initiatedBy: text("initiated_by"),
    /**
     * WHO AUTHORIZED it: for a review-gated AI proposal, the user who
     * approved it. Null for direct edits (the editor IS the authorizer).
     */
    approvedBy: text("approved_by"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.seq] }),
    // Retention (M3) prunes by age: `board_id = $1 AND at < $2`. The primary key
    // leads with board_id but continues on seq, so an age sweep on a busy board
    // would filter every entry it owns on the heap. Ordering by `at` is also how
    // "what happened here recently" is answered without reading the whole log.
    boardAtIdx: index("op_log_board_at_idx").on(t.boardId, t.at),
    // Stage B idempotency: one row per (board, requestId) among rows that
    // carry one. Partial so legacy rows (NULL) never collide with anything.
    requestUniq: uniqueIndex("op_log_board_request_uniq")
      .on(t.boardId, t.requestId)
      .where(sql`${t.requestId} is not null`),
  }),
);

export type DbUser = typeof users.$inferSelect;
export type DbBoard = typeof boards.$inferSelect;
export type DbOpEntry = typeof opLog.$inferSelect;
export type DbOrganization = typeof organizations.$inferSelect;
export type DbMembership = typeof memberships.$inferSelect;

/**
 * Board access control. Before this table a board id was the only capability:
 * `GET /api/boards/:id` compared `ownerId` and 404'd everyone else, so the
 * sharing described in docs/12 could not work. Membership is explicit, and the
 * owner needs no row (`boards.owner_id` is authoritative for the owner role).
 */
export const boardMembers = pgTable(
  "board_members",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // `commenter` (docs/26 F8) is board-level only. The enum is type-level —
    // a text column with no CHECK — so adding a value needs no migration.
    role: text("role", { enum: ["owner", "editor", "commenter", "viewer"] }).notNull(),
    invitedBy: text("invited_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.userId] }),
    userIdx: index("board_members_user_idx").on(t.userId),
  }),
);

/**
 * Revocable share links. The token is the capability, the row carries the role
 * it grants, and revoking is a write rather than a hope that nobody kept the
 * URL. Redeeming a link creates a `board_members` row, so access survives the
 * link being revoked for the people who already joined.
 */
export const boardShareLinks = pgTable(
  "board_share_links",
  {
    token: text("token").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["editor", "commenter", "viewer"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => ({ boardIdx: index("board_share_links_board_idx").on(t.boardId) }),
);

export type DbBoardMember = typeof boardMembers.$inferSelect;
export type DbBoardShareLink = typeof boardShareLinks.$inferSelect;

/**
 * Browser session table (M1). The bearer token (M0) is kept for the MCP
 * client and API keys, but browsers land here: opaque random ids in an
 * httpOnly/Secure/SameSite=Lax cookie, looked up against a row that can be
 * revoked at any time. `expiresAt` is the absolute ceiling; `lastSeenAt`
 * drives sliding-window refresh on each authenticated request. `revokedAt`
 * is the explicit kill switch for "Sign out" and "Sign out everywhere".
 *
 * `token_version` is the snapshot of the user's tokenVersion at creation:
 * if the user bumps their version (a single UPDATE on `users`), every live
 * session below the new value is rejected at lookup without scanning the
 * table. The index covers the per-user device list.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenVersion: bigint("token_version", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => ({ userIdx: index("sessions_user_idx").on(t.userId) }),
);

export type DbSession = typeof sessions.$inferSelect;

/**
 * Single-use verification tokens (M1.4).
 *
 * The token row stores a SHA-256 hash of the random token, not the token
 * itself: a database dump or a leaked SQL backup reveals only hashes, and an
 * attacker who can read the table still can't present the token to the API.
 * `consumedAt` is set on first use; a second attempt with the same id is
 * rejected at lookup.
 *
 * One table for both email-verification and password-reset would save
 * columns; they're separate because the columns they will grow (audit log
 * on resets, rate-limit metadata on verifications) differ enough that
 * merging them would force one to grow into the other.
 */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
  },
  (t) => ({
    userIdx: index("email_verifications_user_idx").on(t.userId),
    tokenHashIdx: uniqueIndex("email_verifications_token_hash_idx").on(t.tokenHash),
  }),
);

export const passwordResets = pgTable(
  "password_resets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
  },
  (t) => ({
    userIdx: index("password_resets_user_idx").on(t.userId),
    tokenHashIdx: uniqueIndex("password_resets_token_hash_idx").on(t.tokenHash),
  }),
);

export type DbEmailVerification = typeof emailVerifications.$inferSelect;
export type DbPasswordReset = typeof passwordResets.$inferSelect;

/**
 * TOTP credential (M1.6). One row per user that has enrolled. The secret is
 * the raw 20-byte HMAC key, base32-encoded — at rest it lives in the same
 * column as the password hash (scrypt would be pointless, the value has to
 * match what the authenticator app expects). Disclosure of this column
 * effectively bypasses 2FA; that risk is documented in the threat model and
 * the DB is expected to be encrypted at rest.
 */
export const totpCredentials = pgTable("totp_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Base32-encoded shared secret. */
  secret: text("secret").notNull(),
  /** ms since epoch when enrollment completed. */
  enrolledAt: bigint("enrolled_at", { mode: "number" }).notNull(),
  /** Most-recent TOTP counter value successfully consumed. Anti-replay. */
  lastCounter: bigint("last_counter", { mode: "number" }).notNull().default(0),
});

/**
 * Recovery codes (M1.6). Each row is one single-use code, hashed with scrypt
 * before insert. The user types one when their authenticator is unavailable;
 * `consumedAt` is set on first match.
 */
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
  },
  (t) => ({ userIdx: index("recovery_codes_user_idx").on(t.userId) }),
);

export type DbTotpCredential = typeof totpCredentials.$inferSelect;
export type DbRecoveryCode = typeof recoveryCodes.$inferSelect;

/**
 * Account deletion queue (M1.7).
 *
 * GDPR's right-to-erasure gives a grace period before data is actually
 * removed. `requestedAt` is when the user clicked "Delete my account";
 * `executesAt` is when the row + dependent data is purged. `cancelledAt`
 * flips non-null when the user signs back in during the grace window.
 *
 * Until `executesAt` passes, the user can't log in but their data is
 * intact; on first login attempt after the grace we wipe everything
 * (boards, memberships, sessions, op log cascades) and remove the row.
 */
export const accountDeletions = pgTable("account_deletions", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
  executesAt: bigint("executes_at", { mode: "number" }).notNull(),
  cancelledAt: bigint("cancelled_at", { mode: "number" }),
});

export type DbAccountDeletion = typeof accountDeletions.$inferSelect;

/**
 * Pending org invites (M2.4).
 *
 * An invite is a single-use capability that adds the bearer to the target
 * org with the granted role when redeemed. The token column is the SHA-256
 * hash of the random token (see `tokens.ts`); the raw token is only ever
 * in the email body or the URL the invitee clicks.
 *
 * `consumedAt` is non-null after the invitee accepts; `revokedAt` is set by
 * the inviter when they rescind. An invite is "live" when both are null
 * and `expiresAt` is in the future.
 */
export const orgInvites = pgTable(
  "org_invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["editor", "viewer"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    consumedAt: bigint("consumed_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (t) => ({
    orgIdx: index("org_invites_org_idx").on(t.orgId, t.expiresAt),
    tokenHashIdx: uniqueIndex("org_invites_token_hash_idx").on(t.tokenHash),
    invitedByIdx: index("org_invites_invited_by_idx").on(t.invitedBy),
  }),
);

export type DbOrgInvite = typeof orgInvites.$inferSelect;

/**
 * Audit log (M2.5 / M6.3). Every state change an administrator could be asked
 * to account for lands here: role grants, invites, share links, board deletes,
 * plan changes, exports.
 *
 * Deliberately NOT a foreign key to `users`: the actor may later delete their
 * account, and an audit trail that disappears with the actor is not an audit
 * trail. `actorEmail` is denormalised at write time for the same reason - the
 * record has to stay readable on its own. `metadata` carries the shape-specific
 * detail (old and new role, invite email, link token prefix) as JSONB so a new
 * action type needs no migration.
 *
 * The `(org_id, at DESC)` index is the only access pattern the console needs:
 * one org's history, newest first, paginated by `at`.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    /** Dotted action name, e.g. `board.member.role_changed`. */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    at: bigint("at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgAtIdx: index("audit_log_org_at_idx").on(t.orgId, t.at),
    actorIdx: index("audit_log_actor_idx").on(t.actorId),
    targetIdx: index("audit_log_target_idx").on(t.targetType, t.targetId),
  }),
);

export type DbAuditEntry = typeof auditLog.$inferSelect;

/**
 * Federated identities (M1.8). One row per external account linked to a user,
 * so a person can sign in with Google today and GitHub tomorrow and land on
 * the same Lucent account.
 *
 * Linking is by VERIFIED email only: an unverified email from a provider would
 * let anyone who can create an account at that provider with a chosen address
 * take over a Lucent account. `email` records what the provider asserted at
 * link time, for the audit trail - it is not used for lookup after linking.
 */
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    provider: text("provider", { enum: ["google", "github"] }).notNull(),
    /** The provider's own stable user id (`sub` for OIDC), never the email. */
    providerAccountId: text("provider_account_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    lastLoginAt: bigint("last_login_at", { mode: "number" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.providerAccountId] }),
    userIdx: index("oauth_accounts_user_idx").on(t.userId),
  }),
);

export type DbOauthAccount = typeof oauthAccounts.$inferSelect;

/**
 * In-app notifications (M2.6). Written when someone is invited, mentioned in a
 * comment, or given access to a board. `readAt` is per-row rather than a
 * high-water mark so "mark this one read" works.
 *
 * `orgId` is nullable because an account-level notification (email verified,
 * subscription past due) belongs to no single org.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** Relative app path the notification points at, e.g. `/?board=b_1`. */
    link: text("link"),
    metadata: jsonb("metadata"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    readAt: bigint("read_at", { mode: "number" }),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(t.userId, t.createdAt),
    orgIdx: index("notifications_org_idx").on(t.orgId),
  }),
);

export type DbNotification = typeof notifications.$inferSelect;

/**
 * Per-user delivery preferences (M2.6). A row exists only when the user has
 * changed something; absence means "the default for this kind", which keeps a
 * new notification kind from needing a backfill.
 */
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    inApp: text("in_app", { enum: ["on", "off"] })
      .notNull()
      .default("on"),
    email: text("email", { enum: ["on", "off"] })
      .notNull()
      .default("on"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.kind] }) }),
);

export type DbNotificationPref = typeof notificationPrefs.$inferSelect;

/**
 * Plan catalogue (M4.1). One row per sellable tier.
 *
 * `src/plans.ts` is the source of truth for every number in the product — the
 * gates read it and `seedPlans()` writes it here. The table exists for the
 * three things a code constant cannot do: it joins (the pricing page and the
 * admin console read a plan without a deploy), it maps a tier to the Stripe
 * price that charges for it, and it can hold a tier the code does not know
 * about — which is how an Enterprise contract with negotiated caps becomes
 * real, because `entitlement()` falls back to this row's `limits` for any code
 * that is not a built-in tier.
 *
 * `limits` is the `PlanLimits` object from plans.ts, re-parsed through
 * `planLimitsSchema` on read: JSONB written by an older build is untrusted
 * input like any other.
 */
export const plans = pgTable("plans", {
  /** Machine code: `free`, `pro`, `team`, `enterprise`, or a contract id. */
  code: text("code").primaryKey(),
  displayName: text("display_name").notNull(),
  /** Sort order, so "is this an upgrade?" is a comparison and not a lookup. */
  rank: bigint("rank", { mode: "number" }).notNull().default(0),
  limits: jsonb("limits").notNull(),
  /**
   * List price in minor units, per seat per interval. Stripe stays
   * authoritative for what a customer is actually charged — coupons,
   * grandfathered prices and negotiated terms all live there. These columns
   * are what a pricing page renders; `null` means "contact us".
   */
  priceCents: bigint("price_cents", { mode: "number" }),
  annualPriceCents: bigint("annual_price_cents", { mode: "number" }),
  currency: text("currency").notNull().default("usd"),
  /** Stripe price ids: per-deployment configuration, never hard-coded. */
  stripePriceId: text("stripe_price_id"),
  stripeAnnualPriceId: text("stripe_annual_price_id"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * One subscription per org (M4.1). `org_id` is the primary key rather than a
 * surrogate id: "which plan is this org on" must have exactly one answer, and a
 * second row would make every gate ambiguous. Subscription *history* is the
 * audit log plus Stripe's own record, not extra rows here.
 *
 * `status` mirrors Stripe's vocabulary verbatim so a webhook can be written
 * through without translation. Which of those values still entitles the org is
 * a product decision rather than a schema one and lives in
 * `ENTITLING_STATUSES` (entitlements.ts): `past_due` keeps working through
 * dunning, `unpaid` and `canceled` fall back to Free.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    orgId: text("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * FK to the catalogue, so an org can never sit on a plan nobody defined.
     * The built-in tiers are seeded at boot, which also makes this the check
     * that catches a webhook carrying a price id we do not know.
     */
    plan: text("plan")
      .notNull()
      .references(() => plans.code),
    status: text("status", {
      enum: [
        "trialing",
        "active",
        "past_due",
        "canceled",
        "unpaid",
        "incomplete",
        "incomplete_expired",
        "paused",
      ],
    }).notNull(),
    /** Paid seats. Compared against `memberships` by the seat gate, not by SQL. */
    seats: bigint("seats", { mode: "number" }).notNull().default(1),
    /** Current billing period, epoch ms. Metered counters reset at `periodEnd`. */
    periodStart: bigint("period_start", { mode: "number" }),
    periodEnd: bigint("period_end", { mode: "number" }),
    /** Set once the customer asks to cancel; access continues until `periodEnd`. */
    cancelAt: bigint("cancel_at", { mode: "number" }),
    trialEndsAt: bigint("trial_ends_at", { mode: "number" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // Unique so a webhook can resolve the org from either Stripe id and can
    // never find two. Postgres allows repeated NULLs in a unique index, so the
    // orgs that never reached checkout (every Free org) do not collide.
    stripeCustomerIdx: uniqueIndex("subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
    stripeSubscriptionIdx: uniqueIndex("subscriptions_stripe_subscription_idx").on(
      t.stripeSubscriptionId,
    ),
    // The dunning sweep and the expiring-trials job both read by status and
    // period end; without this they scan every subscriber to find the few.
    statusIdx: index("subscriptions_status_idx").on(t.status, t.periodEnd),
    planIdx: index("subscriptions_plan_idx").on(t.plan),
  }),
);

/**
 * Metering (M4.2). Append-only: one row per billable act, written by the gate
 * that authorised it. The number a gate compares against a limit is a SUM over
 * this table rather than a counter column — a counter cannot be recomputed
 * after a bug, and "revenue reconciles against usage_events" (the M4 exit
 * criterion) means being able to re-derive every total from the events.
 *
 * `id` is the idempotency key, not a surrogate: callers pass a deterministic id
 * derived from the request and the store inserts ON CONFLICT DO NOTHING, so a
 * retried write bills once.
 *
 * `kind` is text and `metadata` is JSONB so metering a new thing (tokens per
 * model, exported bytes) needs no migration.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    /** Whole units of `kind`: generations, voice minutes, bytes. */
    quantity: bigint("quantity", { mode: "number" }).notNull().default(1),
    at: bigint("at", { mode: "number" }).notNull(),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    // The gate's query, exactly: one org, one kind, a time range. Leading
    // (org_id, kind) makes it an index range scan, and `at` last keeps the
    // month-to-date window inside that scan instead of a filter above it.
    orgKindAtIdx: index("usage_events_org_kind_at_idx").on(t.orgId, t.kind, t.at),
    // The rollup job and the Stripe push read the mirror image — one day
    // across every org — which the index above cannot serve, since its leading
    // column is the org.
    atIdx: index("usage_events_at_idx").on(t.at),
  }),
);

/**
 * Daily rollups (M4.2). Derived data: `rollupDay()` recomputes a whole UTC day
 * from `usage_events`, so a rollup can always be discarded and rebuilt.
 *
 * Deliberately *not* what a gate reads. Entitlement decisions sum the events,
 * because a rollup for the current day is stale by construction and a limit
 * that lags by up to 24 hours is a limit that can be overrun. Rollups serve the
 * two consumers that want coarse data: the usage meters in settings (one row
 * per day per kind instead of a scan over every event) and the metered line
 * items pushed to Stripe at the end of a period.
 *
 * `events` is how many source rows are behind `quantity` — the number that
 * turns reconciliation into a check rather than a hope.
 */
export const usageRollups = pgTable(
  "usage_rollups",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * UTC calendar day, `YYYY-MM-DD`. Text rather than an epoch because every
     * support question about usage starts with a date.
     */
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    events: bigint("events", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.day, t.kind] }),
    // The PK covers "this org, this range of days" (the dashboard). The Stripe
    // push wants one day across every org, which needs its own index.
    dayIdx: index("usage_rollups_day_idx").on(t.day),
  }),
);

export type DbPlan = typeof plans.$inferSelect;
export type DbSubscription = typeof subscriptions.$inferSelect;
export type DbUsageEvent = typeof usageEvents.$inferSelect;
export type DbUsageRollup = typeof usageRollups.$inferSelect;

/**
 * Periodic workspace snapshots (M3). A cache over the op log, never a second
 * source of truth: deleting every row here costs a slower cold start and
 * nothing else, which is precisely what makes pruning the log safe.
 *
 * Two problems, one table. A cold room replays the whole log to reach current
 * state, so a board with 50k entries pays 50k applications on the first join;
 * with a snapshot at seq 49,900 it replays 100. And retention cannot delete an
 * entry that some cold start still needs, so the prune floor is the latest
 * snapshot's seq — no snapshot, no pruning.
 *
 * Keyed `(board_id, seq)` rather than one row per board: keeping the last few
 * makes a snapshot written from a corrupt in-memory workspace recoverable by
 * dropping it, and makes "state at seq N" answerable for the version history
 * docs/13 wants. The retention sweep is what keeps the count bounded.
 */
export const boardSnapshots = pgTable(
  "board_snapshots",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** The op-log seq this workspace is the state *after*. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** Same JSONB shape as `boards.workspace` — core's zod union owns it. */
    workspace: jsonb("workspace").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.seq] }),
  }),
);

/**
 * Live presence across instances (M3, docs/adr/0004). The interface and the
 * reasoning live in src/presence.ts; this is only its table.
 *
 * A durable table for state that is ephemeral by definition looks wrong until
 * you ask what the alternative is: presence has to be readable by the instance
 * that does *not* hold the socket, and Postgres is already there (ADR 0004).
 * The TTL is what keeps it honest — `peers()` filters on `updated_at` as well
 * as sweeping it, so a crashed instance's rows stop being believed immediately
 * rather than when a timer next runs.
 *
 * Keyed `(board_id, user_id)`, matching the client's peer map: two tabs are one
 * participant and the last touch wins, including the `instance_id` that says
 * whose process owes the row its liveness touches.
 */
export const presence = pgTable(
  "presence",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which instance holds this participant's socket. Never crosses the wire. */
    instanceId: text("instance_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    /** `{x, y}` in content coordinates, or NULL for off-canvas. */
    cursor: jsonb("cursor"),
    /** Selected object ids, as a JSON array. */
    selection: jsonb("selection").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.userId] }),
    // The sweep's only query is `updated_at <= $1` across every board, which the
    // board-leading primary key cannot serve at all.
    updatedIdx: index("presence_updated_idx").on(t.updatedAt),
    userIdx: index("presence_user_idx").on(t.userId),
  }),
);

export type DbBoardSnapshot = typeof boardSnapshots.$inferSelect;
export type DbPresence = typeof presence.$inferSelect;

/**
 * Uploaded binaries, out of the workspace graph (M3).
 *
 * Images used to travel as data URLs inside `boards.workspace`, which put the
 * same bytes in the JSONB row, in every WS frame that carried the op, and in
 * localStorage — a 2 MB screenshot pasted twice is 8 MB of the things that are
 * hardest to make bigger. The rows here are the metadata; `src/assets.ts` owns
 * the bytes behind an `AssetStore` (disk in dev, S3/R2 in prod).
 *
 * Two decisions that shape everything downstream:
 *
 *  - **`(org_id, checksum)` is unique**, so the same file uploaded twice in an
 *    org is one row and one billable object. That is what makes copy/paste and
 *    duplicate-board free, and it is why `storage.bytes` can be a plain SUM
 *    over this table without double-counting.
 *  - **`board_id` is provenance, not ownership** (`ON DELETE SET NULL`). It
 *    records where an asset first entered, because dedupe means a second board
 *    can reference the same row and deleting the first board must not break it.
 *    Reachability is a property of the op log, not of this column, so reclaiming
 *    space is a sweep over unreferenced rows rather than a cascade.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Where it was first uploaded. NULL once that board is gone. */
    boardId: text("board_id").references(() => boards.id, { onDelete: "set null" }),
    /** Validated against an allowlist at upload; never echoed back unchecked. */
    mime: text("mime").notNull(),
    /** Object size. The `storage.bytes` gate is a SUM of this per org. */
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    /** SHA-256 of the bytes, hex. The dedupe key and the integrity check. */
    checksum: text("checksum").notNull(),
    /** Key in the backing store, opaque to callers. */
    storageKey: text("storage_key").notNull(),
    /** Key of the generated thumbnail, or NULL when one could not be made. */
    thumbKey: text("thumb_key"),
    width: bigint("width", { mode: "number" }),
    height: bigint("height", { mode: "number" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // Dedupe, and the leading column also serves "everything this org stores".
    orgChecksumIdx: uniqueIndex("assets_org_checksum_idx").on(t.orgId, t.checksum),
    boardIdx: index("assets_board_idx").on(t.boardId),
    // The orphan sweep reads oldest-first across every org.
    createdIdx: index("assets_created_idx").on(t.createdAt),
    createdByIdx: index("assets_created_by_idx").on(t.createdBy),
  }),
);

export type DbAsset = typeof assets.$inferSelect;

/**
 * Stripe webhook deliveries (M4.3). The idempotency ledger, not an event store.
 *
 * Stripe retries a delivery until it gets a 2xx, and it can deliver the same
 * event more than once even after success. A webhook that grants seats or flips
 * a subscription to `active` therefore has to be exactly-once *in effect*, and
 * the only durable way to get that is to write the event id and let the unique
 * primary key refuse the second attempt.
 *
 * `status` distinguishes the four honest outcomes: `received` (claimed, still
 * running — a crash leaves this and the sweep retries it), `processed`,
 * `ignored` (an event type we do not act on, recorded so the ledger explains
 * itself), and `failed` with `error` and `attempts` so a delivery that keeps
 * losing is visible rather than silently dropped.
 *
 * `org_id` is nullable on purpose: an event that arrives before we can resolve
 * its customer must still be recorded, or the retry would process twice.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    /** Stripe's `evt_…` id. The idempotency key, hence the primary key. */
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** Resolved from the payload's customer, when it resolves at all. */
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
    /** Stripe's `livemode`, kept so test traffic is never mistaken for revenue. */
    livemode: text("livemode", { enum: ["live", "test"] }).notNull(),
    status: text("status", { enum: ["received", "processed", "ignored", "failed"] })
      .notNull()
      .default("received"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    /** Last failure message, truncated by the writer. NULL while healthy. */
    error: text("error"),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    processedAt: bigint("processed_at", { mode: "number" }),
  },
  (t) => ({
    // The retry sweep's query: everything not finished, oldest first.
    statusIdx: index("stripe_events_status_idx").on(t.status, t.receivedAt),
    orgIdx: index("stripe_events_org_idx").on(t.orgId),
  }),
);

export type DbStripeEvent = typeof stripeEvents.$inferSelect;

/**
 * Org-scoped template library (M2.6, team libraries). Templates are
 * reusable batches of operations owned by an org: an editor with access can
 * apply them onto any of their boards the same way the built-in
 * `TEMPLATES` in `packages/web/src/templates.ts` are applied today.
 *
 * Stored as JSONB ops rather than a workspace row so a template can be
 * applied to a board of any size: the apply path re-stamps node ids so two
 * inserts of the same template do not collide the way a workspace copy
 * would (`templates.ts:11-18` already documents this constraint).
 *
 * Org-scoped rather than global so a Free org cannot pollute another's
 * gallery, and so the deletion cascade is the same one a board already
 * rides (`organizations ON DELETE CASCADE`).
 */
export const teamTemplates = pgTable(
  "team_templates",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    description: text("description"),
    ops: jsonb("ops").notNull(),
    /** Null when the creator has been deleted; the row stays for history. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgIdx: index("team_templates_org_idx").on(t.orgId, t.createdAt),
    orgKindIdx: index("team_templates_org_kind_idx").on(t.orgId, t.kind),
    createdByIdx: index("team_templates_created_by_idx").on(t.createdBy),
  }),
);

export type DbTeamTemplate = typeof teamTemplates.$inferSelect;
export type DbNewTeamTemplate = typeof teamTemplates.$inferInsert;

/**
 * SCIM 2.0 identity mapping (M6 / F1).
 *
 * Each row pairs an IdP-issued external id with a Lucent user id. PATCH with
 * `active: false` does not delete the row in v1 (auditing), but the
 * deprovision route (`DELETE /scim/v2/Users/:id`) does — and either way the
 * user's sessions are dropped via `tokenVersion` bump, which is the actual
 * access revocation. The row is the *provisioning* record; the session
 * invalidation is the *access* record.
 *
 * `idp` is free-text today ("okta", "azure-ad", …) so a deployment with more
 * than one IdP can scope each external id. v1 ships a single IdP per
 * deployment; the column is here so the second IdP is a config change, not a
 * migration.
 *
 * The unique index is `(idp, external_id)` so the same external id cannot be
 * claimed by two Lucent users. The user_id index is for `DELETE` and
 * `deactivate` lookups on the Lucent-side primary key.
 */
export const scimIdentities = pgTable(
  "scim_identities",
  {
    idp: text("idp").notNull(),
    externalId: text("external_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.idp, t.externalId] }),
    userIdx: index("scim_identities_user_idx").on(t.userId),
  }),
);

export type DbScimIdentity = typeof scimIdentities.$inferSelect;
export type DbNewScimIdentity = typeof scimIdentities.$inferInsert;

/**
 * Meeting transcripts (E3 / R3): one row per recorded meeting on a board.
 *
 * `turns` is the whole diarised transcript as a JSONB array —
 * `[{speaker, at, text, kind?}]` — rather than a turn-per-row table, for the
 * same reason the board workspace is one JSONB blob: a transcript is read
 * and written as a unit, never queried by turn, and the meeting flow (M5)
 * treats it as one document. The `kind` classification (problem/hypothesis/
 * solution/decision/action/requirement) rides each turn because that is the
 * extraction's own data — rebuilding it from text later would be lossy.
 *
 * Cascades: a deleted board takes its meetings; a deleted org takes the
 * board anyway; the creator going away keeps the row (history) and nulls
 * `created_by`, matching the team-template convention.
 */
export const meetingTranscripts = pgTable(
  "meeting_transcripts",
  {
    id: text("id").primaryKey(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    turns: jsonb("turns").notNull(),
    /**
     * docs/24 Phase D: the capture profile in force when recorded
     * (record/intelligence/assistant/participant). Nullable: rows written
     * before profiles existed carry no mode, and the readers treat absence
     * as unknown — never backfilled.
     */
    mode: text("mode"),
    /**
     * ADR 0045 (docs/26 J1): the meeting's name. Null means untitled — the
     * reader shows the board and the date; nothing is backfilled.
     */
    title: text("title"),
    /**
     * docs/28 A3.3: the end-of-meeting summary — the notes enhancer's cited
     * note over the whole transcript, written once the meeting ends. Null
     * until then, and always in Record mode (transcript only).
     */
    summary: jsonb("summary"),
    /**
     * docs/28 S7: people's corrections to turns — an append-only overlay, so
     * `turns` (and an ended transcript's record) is never rewritten.
     */
    corrections: jsonb("corrections"),
    /**
     * docs/28 A3.4: a scheduled meeting — when it starts and how long it
     * runs. Null for a meeting that began when someone pressed Record. Until
     * it starts, `started_at` holds this same time and the row has no turns
     * (the status reads `scheduled`, derived as ADR 0045 says).
     */
    scheduledFor: bigint("scheduled_for", { mode: "number" }),
    durationMin: bigint("duration_min", { mode: "number" }),
    /** User ids invited; the host is `created_by`. */
    invitees: jsonb("invitees"),
    /** The notes template the meeting follows (docs/27 §2.3). */
    template: text("template"),
    /** The host called it off before it started. */
    cancelledAt: bigint("cancelled_at", { mode: "number" }),
    cancelledBy: text("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    /** Null when the creator has been deleted; the transcript stays. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    boardStartedIdx: index("meeting_transcripts_board_started_idx").on(t.boardId, t.startedAt),
    orgIdx: index("meeting_transcripts_org_idx").on(t.orgId),
    createdByIdx: index("meeting_transcripts_created_by_idx").on(t.createdBy),
  }),
);

export type DbMeetingTranscript = typeof meetingTranscripts.$inferSelect;
export type DbNewMeetingTranscript = typeof meetingTranscripts.$inferInsert;

/**
 * Meeting notes (docs/27 N1): one person's notes on one meeting — the lines
 * they typed and, once enhanced, the structured note. Keyed by (meeting,
 * user) because notes are private: the routes only ever read or write the
 * caller's own row. Cascades with the meeting (a deleted transcript takes
 * the notes about it) and with the user (their private notes go with them).
 */
export const meetingNotes = pgTable(
  "meeting_notes",
  {
    meetingId: text("meeting_id")
      .notNull()
      .references(() => meetingTranscripts.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    template: text("template").notNull(),
    lines: jsonb("lines").notNull(),
    enhanced: jsonb("enhanced"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.meetingId, t.userId] }),
    userIdx: index("meeting_notes_user_idx").on(t.userId),
  }),
);

export type DbMeetingNotes = typeof meetingNotes.$inferSelect;

/**
 * Per-org SSO connections (F1 / ADR 0013). One row per IdP an org trusts;
 * in practice one, but `(org_id, idp_entity_id)` unique rather than
 * `org_id` unique so a migration-period org can carry a second IdP while
 * the first is retired.
 *
 * `x509CertPem` is the trust anchor: signature verification only ever
 * succeeds against this certificate, so an org's owner pasting a new cert
 * is the only way trust changes — exactly the property an enterprise buyer
 * audits.
 *
 * `enforceSso` is the password-login switch: when on, an email on a
 * claimed domain is refused password sign-in and pointed at SSO. Stored
 * per connection (not per claim) because it is an org policy, and the
 * connection is the org's IdP record.
 */
export const ssoConnections = pgTable(
  "sso_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    idpEntityId: text("idp_entity_id").notNull(),
    acsUrl: text("acs_url").notNull(),
    x509CertPem: text("x509_cert_pem").notNull(),
    nameIdFormat: text("name_id_format")
      .notNull()
      .default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
    enforceSso: boolean("enforce_sso").notNull().default(false),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgIdpUnique: uniqueIndex("sso_connections_org_idp_uniq").on(t.orgId, t.idpEntityId),
  }),
);

/**
 * Domain claims (F1): proof an org owns an email domain, so SSO applies to
 * its users automatically. `token` is the TXT-record challenge; `verifiedAt`
 * null until the DNS check passes — a claim row that has not verified gates
 * nothing.
 */
export const domainClaims = pgTable(
  "domain_claims",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    token: text("token").notNull(),
    verifiedAt: bigint("verified_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    domainUnique: uniqueIndex("domain_claims_domain_uniq").on(t.domain),
    orgIdx: index("domain_claims_org_idx").on(t.orgId),
  }),
);

export type DbSsoConnection = typeof ssoConnections.$inferSelect;
export type DbNewSsoConnection = typeof ssoConnections.$inferInsert;
export type DbDomainClaim = typeof domainClaims.$inferSelect;
export type DbNewDomainClaim = typeof domainClaims.$inferInsert;

/**
 * Review-gate proposals, server-side (Stage B3 — the P2 boundary). A proposal
 * is a durable record of what Lucent wants to change: the operations, the
 * request that prompted them, the meeting provenance, and the decision.
 *
 * Before this table a pending proposal for a SHARED board lived only in the
 * proposing browser's localStorage — that browser was the sole source of
 * truth for the batch, invisible to every peer, gone if it closed. Now the
 * server is the record, every member of the board sees the same pending
 * batch, and the decision is transition-guarded where the log's own
 * idempotency lives.
 *
 * `appliedSeq` links an approval to the exact op_log entry it produced, and
 * together with the actor columns on that entry (ai/lucent/initiatedBy/
 * approvedBy) gives the full accountability chain for every gated change.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    /** Null when not extracted from a meeting. */
    meetingId: text("meeting_id"),
    status: text("status").notNull(),
    operations: jsonb("operations").notNull(),
    /** What the user asked for, as typed or spoken. */
    request: text("request").notNull(),
    /** The model's one-line explanation of the batch. */
    explanation: text("explanation"),
    /** Meeting provenance: quote, turnRange, turnKinds. */
    provenance: jsonb("provenance"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Who decided, when — null while pending. */
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: bigint("decided_at", { mode: "number" }),
    /** The op_log seq the approval committed, once applied. */
    appliedSeq: bigint("applied_seq", { mode: "number" }),
    /** ADR 0047: the AI run that produced this proposal, when known. */
    runId: text("run_id"),
  },
  (t) => ({
    // One pending proposal per board, enforced by the database rather than by
    // cooperating clients: two browsers extracting into the same board race
    // for the slot, and the loser's create supersedes the winner's pending
    // record — same contract the localStorage path had, now race-safe.
    onePendingPerBoard: uniqueIndex("proposals_board_pending_uniq")
      .on(t.boardId)
      .where(sql`${t.status} = 'pending'`),
    boardIdx: index("proposals_board_idx").on(t.boardId, t.createdAt),
    orgIdx: index("proposals_org_idx").on(t.orgId),
    createdByIdx: index("proposals_created_by_idx").on(t.createdBy),
    decidedByIdx: index("proposals_decided_by_idx").on(t.decidedBy),
  }),
);

export type DbProposal = typeof proposals.$inferSelect;
export type DbNewProposal = typeof proposals.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Integrations (Stage D4–D6, ADR 0030/0031/0032)                              */
/* -------------------------------------------------------------------------- */

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** A REFERENCE (env var name), never the secret itself (ADR 0030). */
    credentialRef: text("credential_ref").notNull(),
    /** Provider-specific configuration (Linear's teamId) — D6. */
    config: jsonb("config"),
    scopes: jsonb("scopes").notNull(),
    status: text("status").notNull(),
    /** docs/26 A5: how it has been answering (integrations/health.ts). */
    health: jsonb("health"),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // One connection per (org, provider) — the putConnection upsert key.
    orgProviderUniq: uniqueIndex("integration_connections_org_provider_uniq").on(
      t.orgId,
      t.provider,
    ),
  }),
);

export const integrationTaskLinks = pgTable(
  "integration_task_links",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url"),
    lastSyncedStatus: text("last_synced_status").notNull(),
    /** docs/26 A5: the owner and due date the provider held at last sync. */
    lastSyncedFields: jsonb("last_synced_fields"),
    syncedAt: bigint("synced_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // The linkTask upsert key: one link per (board, node, provider).
    nodeProviderUniq: uniqueIndex("integration_task_links_node_provider_uniq").on(
      t.boardId,
      t.nodeId,
      t.provider,
    ),
    boardIdx: index("integration_task_links_board_idx").on(t.boardId),
  }),
);

export const integrationActions = pgTable(
  "integration_actions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The connection the proposal previewed (D6's approval safety check). */
    connectionId: text("connection_id").notNull(),
    status: text("status").notNull(),
    /** IntegrationActionItem[] — the payload doubles as the replay source. */
    items: jsonb("items").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    /** Stage D9: who drafted the proposal — "user" (default) or "ai". */
    origin: text("origin"),
    /** Stage D9: the AI path's {request, explanation} (a recommendation). */
    provenance: jsonb("provenance"),
    /** Stage D9: the board's op-log head at proposal time (audit). */
    sourceSeq: bigint("source_seq", { mode: "number" }),
    decidedBy: text("decided_by"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    appliedAt: bigint("applied_at", { mode: "number" }),
    error: text("error"),
  },
  (t) => ({
    pendingIdx: index("integration_actions_pending_idx").on(t.boardId, t.provider, t.status),
    boardIdx: index("integration_actions_board_idx").on(t.boardId, t.createdAt),
  }),
);

export const executionLedger = pgTable(
  "execution_ledger",
  {
    boardId: text("board_id").notNull(),
    provider: text("provider").notNull(),
    requestId: text("request_id").notNull(),
    lucentActionId: text("lucent_action_id").notNull(),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull(),
    attempts: bigint("attempts", { mode: "number" }).notNull(),
    error: text("error"),
    beganAt: bigint("began_at", { mode: "number" }).notNull(),
    appliedAt: bigint("applied_at", { mode: "number" }),
    externalId: text("external_id"),
  },
  (t) => ({
    // THE COMPOSITE KEY (the owner's triplet): attempts dedupe on it.
    pk: primaryKey({ columns: [t.boardId, t.provider, t.requestId] }),
    // The sweep's feed: reclaimable rows, oldest first.
    sweepIdx: index("execution_ledger_sweep_idx").on(t.status, t.beganAt),
  }),
);

export type DbIntegrationConnection = typeof integrationConnections.$inferSelect;
export type DbNewIntegrationConnection = typeof integrationConnections.$inferInsert;
export type DbIntegrationTaskLink = typeof integrationTaskLinks.$inferSelect;
export type DbNewIntegrationTaskLink = typeof integrationTaskLinks.$inferInsert;
export type DbIntegrationAction = typeof integrationActions.$inferSelect;
export type DbNewIntegrationAction = typeof integrationActions.$inferInsert;
export type DbExecutionRecord = typeof executionLedger.$inferSelect;
export type DbNewExecutionRecord = typeof executionLedger.$inferInsert;

/* -------------------------------------------------------------------------- */
/* Inbound sync (Stage D7, ADR 0033)                                           */
/* -------------------------------------------------------------------------- */

export const integrationWebhookEvents = pgTable(
  "integration_webhook_events",
  {
    /** sha256(provider + ":" + raw bytes) — identical bytes, one row. */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    orgId: text("org_id"),
    externalId: text("external_id"),
    status: text("status").notNull(),
    attempts: bigint("attempts", { mode: "number" }).notNull(),
    error: text("error"),
    claimedAt: bigint("claimed_at", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // The sweep's feed: reclaimable rows, oldest first.
    sweepIdx: index("integration_webhook_events_sweep_idx").on(t.status, t.claimedAt),
  }),
);

/**
 * docs/26 A6: the board trash. A row here hides its board from every read
 * until it's restored or purged (after 30 days).
 */
export const boardTrash = pgTable(
  "board_trash",
  {
    boardId: text("board_id")
      .primaryKey()
      .references(() => boards.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    deletedBy: text("deleted_by").notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgIdx: index("board_trash_org_idx").on(t.orgId, t.deletedAt),
  }),
);

/** docs/26 A6: the boards and projects a person stars (favorites.ts). */
export const favorites = pgTable(
  "favorites",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.kind, t.targetId] }),
  }),
);

/**
 * docs/26 A6: trashed meetings and projects (trash.ts) — hidden from every
 * read until restored, purged after 30 days.
 */
export const trashItems = pgTable(
  "trash_items",
  {
    kind: text("kind").notNull(),
    itemId: text("item_id").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    boardId: text("board_id"),
    name: text("name").notNull(),
    deletedBy: text("deleted_by").notNull(),
    deletedAt: bigint("deleted_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.itemId] }),
    orgIdx: index("trash_items_org_idx").on(t.orgId, t.deletedAt),
  }),
);

/**
 * docs/26 A6: teams inside an org (teams.ts) — groups of members a board can
 * be shared with; SCIM Groups sync into them (`external_id`).
 */
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    externalId: text("external_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    orgIdx: index("teams_org_idx").on(t.orgId),
    externalIdx: uniqueIndex("teams_org_external_idx").on(t.orgId, t.externalId),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.userId] }),
    userIdx: index("team_members_user_idx").on(t.userId),
  }),
);

export const boardTeamGrants = pgTable(
  "board_team_grants",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.teamId] }),
  }),
);

/**
 * docs/26 A5: OAuth tokens for integration connections, sealed with
 * LUCENT_TOKEN_KEY (integrations/tokenBox.ts) — never stored in the clear.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: bigint("expires_at", { mode: "number" }),
    scope: text("scope"),
    obtainedBy: text("obtained_by").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.provider] }),
  }),
);

export const integrationInboundChanges = pgTable(
  "integration_inbound_changes",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    nodeId: text("node_id").notNull(),
    externalId: text("external_id").notNull(),
    field: text("field").notNull(),
    /** The raw provider word at detection — what the human reads. */
    externalValue: text("external_value").notNull(),
    /** mapStatus of externalValue; null = the never-guesses warning row. */
    mappedValue: text("mapped_value"),
    status: text("status").notNull(),
    source: text("source").notNull(),
    detectedAt: bigint("detected_at", { mode: "number" }).notNull(),
    decidedBy: text("decided_by"),
    decidedAt: bigint("decided_at", { mode: "number" }),
    appliedSeq: bigint("applied_seq", { mode: "number" }),
    reason: text("reason"),
  },
  (t) => ({
    // The queue's read: pending first per board.
    boardIdx: index("integration_inbound_changes_board_idx").on(t.boardId, t.status),
    // The queue-level dedupe probe: the pending row for one field of one
    // node of one provider. Not unique — history rows keep their ids; the
    // dedupe is decided in code (like the ledger's claim ladder).
    pendingIdx: index("integration_inbound_changes_pending_idx").on(
      t.boardId,
      t.nodeId,
      t.provider,
      t.field,
      t.status,
    ),
  }),
);

export type DbIntegrationWebhookEvent = typeof integrationWebhookEvents.$inferSelect;
export type DbNewIntegrationWebhookEvent = typeof integrationWebhookEvents.$inferInsert;
export type DbIntegrationInboundChange = typeof integrationInboundChanges.$inferSelect;
export type DbNewIntegrationInboundChange = typeof integrationInboundChanges.$inferInsert;

/**
 * WebSocket auth tickets (M0.3), Postgres twin (docs/20 P5). One row per
 * minted ticket; `consume` is a DELETE ... RETURNING so single-use holds
 * across every API instance behind a stateless ingress. Rows live for the
 * ticket TTL (~60s); `prune()` bounds the table.
 */
export const wsTickets = pgTable(
  "ws_tickets",
  {
    ticket: text("ticket").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    // The prune scan and size() read the window, not the whole table.
    expiryIdx: index("ws_tickets_expiry_idx").on(t.expiresAt),
    // Who holds live tickets, if an operator ever needs to revoke by user.
    userIdx: index("ws_tickets_user_idx").on(t.userId),
  }),
);

export type DbWsTicket = typeof wsTickets.$inferSelect;
export type DbNewWsTicket = typeof wsTickets.$inferInsert;

/**
 * The transactional outbox (docs/20 P2, advisory §18/§19).
 *
 * The problem it solves is the one the advisory states: "the DB transaction
 * succeeds but the event publish fails, or vice versa." A row here is written
 * INSIDE the same transaction that changed state, so a committed change and
 * its announcement cannot disagree — either both are visible or neither is.
 * A separate dispatcher later reads undispatched rows and delivers them
 * at-least-once; consumers are idempotent by `id`.
 *
 * `payload` is deliberately small and notification-shaped — an id, a seq, a
 * name — never op payloads or board content. This is the same rule the
 * realtime fanout follows (`FANOUT_MAX_PAYLOAD_BYTES`): a queue row is a
 * pointer to truth, not a second copy of it (ADR 0040: a projection never
 * becomes a second database).
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    /** The event name, from the fixed OutboxEventType vocabulary. */
    type: text("type").notNull(),
    /** Scope, when the event concerns one: lets a consumer filter cheaply. */
    boardId: text("board_id"),
    orgId: text("org_id"),
    /** Small, notification-shaped JSON. Never the op payload. */
    payload: jsonb("payload").notNull().default({}),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    dispatchedAt: bigint("dispatched_at", { mode: "number" }),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => ({
    /**
     * The dispatcher's only hot query: undispatched rows, oldest first.
     * A partial index keeps it proportional to the backlog rather than to
     * every event ever written.
     */
    pendingIdx: index("outbox_events_pending_idx").on(t.createdAt),
    // "what happened to this board?" — the operator's question.
    boardIdx: index("outbox_events_board_idx").on(t.boardId, t.createdAt),
    typeIdx: index("outbox_events_type_idx").on(t.type, t.createdAt),
  }),
);

export type DbOutboxEvent = typeof outboxEvents.$inferSelect;
export type DbNewOutboxEvent = typeof outboxEvents.$inferInsert;

/**
 * The job queue (docs/20 P3, advisory §7/§9).
 *
 * WHY. The advisory's §9 names the problem: `setInterval` in the API process
 * means N instances run N sweeps. A scheduled sweep that re-claims a stuck
 * execution-ledger row is idempotent per row, so N sweeps are merely
 * wasteful — but a sweep that sends an email or reconciles a provider is
 * N-fold work against a rate-limited third party. More fundamentally, the
 * expensive AI work (§7) has nowhere to go: it runs on the request path and
 * occupies a connection slot a user is waiting on.
 *
 * The claim is deliberately NOT a new concurrency model. It is the
 * execution ledger's proven triad, generalized (docs/20: "do not invent a new
 * concurrency model"): first-INSERT-wins on a unique key, a status-guarded
 * re-claim whose WHERE restates the stale rule, and a stale window that makes
 * a dead worker's job claimable again. See `integrations/ledger.ts`.
 *
 * `family` is the worker-family split from advisory §8: a worker claims only
 * the families it serves, so `lucent-ai-worker` never picks up a maintenance
 * sweep.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** Which worker family serves this: ai | media | integration | maintenance. */
    family: text("family").notNull(),
    /** The handler name, from the registered job-type vocabulary. */
    type: text("type").notNull(),
    /** Handler input. Small: an id to look up, not the record itself. */
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    /** Earliest time this may run (retry backoff, or a scheduled sweep). */
    runAfter: bigint("run_after", { mode: "number" }).notNull(),
    /** Which worker holds it, and since when — the stale-window anchor. */
    claimedBy: text("claimed_by"),
    claimedAt: bigint("claimed_at", { mode: "number" }),
    result: jsonb("result"),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    /**
     * Dedupe key for recurring jobs: `sweep-stripe` may only have one live
     * job at a time, so the scheduler enqueuing it on every tick while a
     * previous one is still queued is a no-op rather than a pile-up. Null for
     * one-shot jobs, which are always distinct work.
     */
    dedupeKey: text("dedupe_key"),
  },
  (t) => ({
    /**
     * The claim query's index: queued work ready to run, oldest first.
     * Partial, so its size tracks the backlog rather than the table.
     */
    claimIdx: index("jobs_claim_idx").on(t.family, t.status, t.runAfter),
    /**
     * The recurring-job dedupe, scoped to LIVE jobs only.
     *
     * Partial on purpose, and this is load-bearing: a plain unique index on
     * `dedupe_key` would let a completed `sweep-stripe` block every future
     * occurrence forever — the sweep would run exactly once and never again.
     * The key exists to stop a PILE-UP, not to make a name single-use, so
     * only `queued`/`claimed` rows participate.
     */
    dedupeIdx: uniqueIndex("jobs_dedupe_idx")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'claimed')`),
    // "what is this worker doing?" and queue-age metrics.
    workerIdx: index("jobs_worker_idx").on(t.claimedBy, t.status),
  }),
);

export type DbJob = typeof jobs.$inferSelect;
export type DbNewJob = typeof jobs.$inferInsert;

/**
 * Shared rate-limit and quota counters (docs/20 P5, advisory §12/§26).
 *
 * `Limiter` and `UsageTracker` are per-process Maps, so two API instances
 * grant twice the configured limit — the auth limiter included, which is the
 * brute-force guard. One row per (key, window) makes the counter shared and
 * the increment atomic in a single upsert.
 *
 * Deliberately a COUNTER, not a log of hits: a fixed window is one row per
 * key per window, where a sliding log would be one row per request on the
 * hottest path in the system, with a sweep to keep it from growing forever.
 *
 * `windowStart` carries both meanings the two callers need: a rounded
 * millisecond timestamp for the per-minute limiter, and midnight UTC for the
 * daily quota. The composite primary key is what makes the upsert atomic.
 */
export const rateCounters = pgTable(
  "rate_counters",
  {
    key: text("key").notNull(),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    hits: bigint("hits", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.key, t.windowStart] }),
    // The prune scan: drop windows that have rolled past.
    windowIdx: index("rate_counters_window_idx").on(t.windowStart),
  }),
);

export type DbRateCounter = typeof rateCounters.$inferSelect;
export type DbNewRateCounter = typeof rateCounters.$inferInsert;

/**
 * Projects (docs/26 J2, ADR 0046): org-scoped records that link boards. A
 * project grants nothing — every board in it is still read through board
 * access — so these rows carry no permission of their own. `members` is a
 * list of user ids (who works on it, for filtering and notifications), not
 * an access list.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    objective: text("objective").notNull().default(""),
    status: text("status").notNull().default("active"),
    leadId: text("lead_id").references(() => users.id, { onDelete: "set null" }),
    members: jsonb("members").notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    archivedAt: bigint("archived_at", { mode: "number" }),
  },
  (t) => ({
    orgIdx: index("projects_org_idx").on(t.orgId),
  }),
);

export type DbProject = typeof projects.$inferSelect;

/** Which boards a project gathers — many to many (ADR 0046). */
export const projectBoards = pgTable(
  "project_boards",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: bigint("added_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.boardId] }),
    boardIdx: index("project_boards_board_idx").on(t.boardId),
  }),
);

/**
 * The workspace intelligence index (docs/26 J3, ADR 0046): every board's
 * statements, derived by core's `statementRows` — never written by a route,
 * droppable and rebuildable from the boards at any time. `ord` keeps the
 * board's insertion order.
 */
export const statementIndex = pgTable(
  "statement_index",
  {
    boardId: text("board_id")
      .notNull()
      .references(() => boards.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    orgId: text("org_id").notNull(),
    ord: bigint("ord", { mode: "number" }).notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    label: text("label").notNull(),
    topic: text("topic"),
    supersedes: jsonb("supersedes"),
    assignee: text("assignee"),
    dueDate: text("due_date"),
    executionStatus: text("execution_status"),
    blocked: boolean("blocked").notNull().default(false),
    drivesActions: bigint("drives_actions", { mode: "number" }),
    meetingId: text("meeting_id"),
    turnStart: bigint("turn_start", { mode: "number" }),
    turnEnd: bigint("turn_end", { mode: "number" }),
    /** ADR 0047: how the statement came to be trusted; null before trust existed. */
    trust: text("trust"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.boardId, t.nodeId] }),
    orgKindIdx: index("statement_index_org_kind_idx").on(t.orgId, t.kind, t.status),
  }),
);

/**
 * The index's derivation source, one row per board: the board revision
 * (`boards.updated_at`) its rows were derived from. A read compares it with
 * the board and re-derives when the board is newer.
 */
export const statementIndexState = pgTable("statement_index_state", {
  boardId: text("board_id")
    .primaryKey()
    .references(() => boards.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  sourceAt: bigint("source_at", { mode: "number" }).notNull(),
  indexedAt: bigint("indexed_at", { mode: "number" }).notNull(),
});

/**
 * AI runs (docs/26 J6, ADR 0047): one row wherever a model is called or an
 * agent writes on a board — which model, what context, who started it, what
 * came of it, and who approved. Governance, not billing (usage_events keeps
 * the meter): a run's `op_seqs` are the op-log entries its output became.
 */
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    boardId: text("board_id").references(() => boards.id, { onDelete: "set null" }),
    initiatedBy: text("initiated_by").references(() => users.id, { onDelete: "set null" }),
    surface: text("surface").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    contextScope: text("context_scope").notNull(),
    tools: jsonb("tools").notNull().default(sql`'[]'::jsonb`),
    outputHash: text("output_hash"),
    opCount: bigint("op_count", { mode: "number" }).notNull().default(0),
    proposalId: text("proposal_id"),
    opSeqs: jsonb("op_seqs").notNull().default(sql`'[]'::jsonb`),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    decidedAt: bigint("decided_at", { mode: "number" }),
  },
  (t) => ({
    orgIdx: index("ai_runs_org_idx").on(t.orgId, t.createdAt),
    boardIdx: index("ai_runs_board_idx").on(t.boardId, t.createdAt),
  }),
);

export type DbAiRun = typeof aiRuns.$inferSelect;

/**
 * Conversation threads (docs/26 J7, ADR 0048): one person's conversation on
 * one scope ("board:…", "meeting:…:…", "project:…:…", "workspace:…"),
 * private to them. Messages keep the latest THREAD_KEEP per thread.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scopeKey: text("scope_key").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => ({
    ownerScope: uniqueIndex("threads_user_scope_idx").on(t.userId, t.scopeKey),
  }),
);

export const threadMessages = pgTable(
  "thread_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    text: text("text").notNull(),
    reply: text("reply"),
    citations: jsonb("citations"),
    surface: text("surface").notNull(),
    at: bigint("at", { mode: "number" }).notNull(),
  },
  (t) => ({
    threadAt: index("thread_messages_thread_idx").on(t.threadId, t.at),
  }),
);
