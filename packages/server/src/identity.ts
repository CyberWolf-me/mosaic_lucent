/**
 * Identity model (docs/06 security, docs/08 orgs/workspaces).
 *
 * Pure data and validation only — no hashing, no I/O. This is the vocabulary the
 * rest of the server speaks: a User is a person, an Organization is a billing and
 * membership boundary, and a Membership ties them with a role. The canvas engine
 * (`@lucent/core`) stays identity-free; ownership lives here so a board can carry
 * `ownerId` without the deterministic reducer knowing what a user is.
 *
 * `by: "me"` placeholders on votes/reactions/comments become a real `usr_...` id
 * once requests are authenticated (Step 1e).
 */

/**
 * `commenter` (docs/26 F8) is a board-level role — a board member or a share
 * link — between viewer and editor: it may comment, reply, react, vote and
 * resolve threads, and delete only its own comments; everything else on the
 * board needs an editor. Org roles stay owner / editor / viewer.
 */
export type Role = "owner" | "editor" | "commenter" | "viewer";

/** Roles ranked so a permission check is a comparison, not a lookup table. */
const ROLE_RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, owner: 3 };

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
}

/** An org-level role: commenting is granted per board, never org-wide. */
export type OrgRole = Exclude<Role, "commenter">;

export interface Membership {
  userId: string;
  orgId: string;
  role: OrgRole;
}

/** Public shape of a user — never carries the password hash. */
export interface PublicUser extends User {
  emailVerifiedAt: number | null;
}

/** Account deletion scheduling (M1.7). */
export interface AccountDeletion {
  userId: string;
  requestedAt: number;
  /** ms since epoch — the row + every dependent row is wiped once `now >= executesAt`. */
  executesAt: number;
  cancelledAt: number | null;
}

/** Stored user, including the credential. Never leaves the server. */
export interface StoredUser extends User {
  /** scrypt hash in `salt:hash` hex form (see auth.ts). */
  passwordHash: string;
  /**
   * Monotonic counter for bulk-invalidation. Sessions are stamped with this
   * value at creation; bumping it (`UPDATE users SET token_version = ...`)
   * invalidates every live session in one write. Defaults to 0 for new users
   * and existing rows. Reserved for M1's "Sign out everywhere".
   */
  tokenVersion: number;
  /** ms since epoch when the user confirmed their email; null until verified. */
  emailVerifiedAt: number | null;
}

export function newUserId(): string {
  return `usr_${Date.now().toString(36)}${randomSuffix()}`;
}

export function newOrgId(): string {
  return `org_${Date.now().toString(36)}${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Strip the credential before a user crosses the network. */
export function toPublicUser(user: StoredUser): PublicUser {
  const { passwordHash: _drop, ...rest } = user;
  return {
    id: rest.id,
    email: rest.email,
    name: rest.name,
    createdAt: rest.createdAt,
    emailVerifiedAt: rest.emailVerifiedAt,
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface CredentialError {
  field: "email" | "password" | "name";
  message: string;
}

/** Validate signup input; returns the problems, empty when acceptable. */
export function validateSignup(input: {
  email: string;
  password: string;
  name: string;
}): CredentialError[] {
  const errors: CredentialError[] = [];
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email))
    errors.push({ field: "email", message: "Enter a valid email address." });
  if (input.password.length < 8)
    errors.push({ field: "password", message: "Password must be at least 8 characters." });
  if (input.password.length > 200)
    errors.push({ field: "password", message: "Password is too long." });
  if (input.name.trim().length === 0)
    errors.push({ field: "name", message: "Name can't be empty." });
  if (input.name.length > 100) errors.push({ field: "name", message: "Name is too long." });
  return errors;
}

/** Normalize an email for storage and lookup (case- and space-insensitive). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True when `role` is at least as privileged as `required`. */
export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * Effective role on a board (M2.2). An owner at the org level is also an
 * owner on every board in that org — that's what makes org-level grants
 * useful, otherwise an org-level viewer would still need a per-board row.
 *
 * `boardRole` comes from the explicit `board_members` row; `orgRole` comes
 * from the `memberships` row. Either may be undefined when the user has
 * no grant at that level, and the result is undefined when neither grants
 * any role.
 *
 * Pure — no I/O — so it's the right primitive for the cross-tenant
 * leakage tests to assert against.
 */
export function effectiveBoardRole(
  orgRole: Role | undefined,
  boardRole: Role | undefined,
): Role | undefined {
  if (orgRole === "owner" || boardRole === "owner") return "owner";
  if (orgRole === "editor" || boardRole === "editor") return "editor";
  if (orgRole === "commenter" || boardRole === "commenter") return "commenter";
  if (orgRole === "viewer" || boardRole === "viewer") return "viewer";
  return undefined;
}
