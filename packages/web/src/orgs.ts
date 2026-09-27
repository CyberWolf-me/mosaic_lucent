import { apiFetch } from "./http.js";
import { hasSession } from "./session.js";
import { scopedStorageKey } from "./persistence.js";

/**
 * Org REST client and active-org selection (M2.3).
 *
 * Two jobs, together because they are the same question from two sides: which
 * orgs can this user reach, and which one are they looking at right now.
 *
 * The second half exists because the server made org scope mandatory and the
 * browser had no answer for it. `GET /api/boards` refuses without an `orgId`
 * query parameter (packages/server/src/app.ts:2277) and `POST /api/boards`
 * silently falls back to the caller's *first* membership when the body omits
 * one (app.ts:2183) — so a user in two orgs saved into whichever org the store
 * happened to return first. An explicit, persisted selection fixes both.
 *
 * The selection is kept in localStorage rather than in React state so a reload
 * lands in the same org, and it is always re-validated against the membership
 * list before use: memberships are revoked server-side, and a stale id would
 * turn every board request into a 404.
 */

const CURRENT_ORG_KEY = "lucent.orgId";

/** Mirrors `Role` in packages/server/src/identity.ts:14. */
export type OrgRole = "owner" | "editor" | "viewer";

export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
  createdAt: number;
  /** The org created with the account. Cannot be renamed away or deleted. */
  isPersonal: boolean;
}

export interface OrgMember {
  userId: string;
  role: OrgRole;
  email: string;
  name: string;
}

export interface OrgDetail {
  id: string;
  name: string;
  createdAt: number;
  members: OrgMember[];
  /** The caller's own role, so the UI can decide what to offer without a guess. */
  role: OrgRole;
}

/**
 * One audit row as the wire sends it (`AuditEntry` in
 * packages/server/src/orgs.ts:72). Every field the browser reads is optional
 * here even where the server populates it, because an audit trail that fails to
 * render is worse than one that renders with a blank column.
 */
export interface AuditEntry {
  id?: string;
  orgId: string;
  actorId: string | null;
  actorEmail?: string | null;
  action: string;
  subject?: string;
  targetType?: string | null;
  targetId?: string | null;
  ip: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  at: number;
}

/**
 * Every org call, gated on having a session at all — same contract as
 * `boards.ts`: `null` means "did not ask the server", which callers map to the
 * offline flow rather than to "you have no orgs".
 */
async function authed(path: string, init?: RequestInit): Promise<Response | null> {
  if (!hasSession()) return null;
  return apiFetch(path, init ?? {});
}

/** Orgs the signed-in user belongs to, personal org included. */
export async function listOrgs(): Promise<OrgSummary[]> {
  const res = await authed("/api/orgs");
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { orgs?: OrgSummary[] };
  return data.orgs ?? [];
}

/** One org with its member roster. Null when the caller is not a member. */
export async function fetchOrg(id: string): Promise<OrgDetail | null> {
  const res = await authed(`/api/orgs/${encodeURIComponent(id)}`);
  if (!res || !res.ok) return null;
  return (await res.json()) as OrgDetail;
}

/** Recent audit rows, newest first, capped at 100 by the server. Owner-only. */
export async function fetchAudit(orgId: string): Promise<AuditEntry[]> {
  const res = await authed(`/api/orgs/${encodeURIComponent(orgId)}/audit`);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { entries?: AuditEntry[] };
  return data.entries ?? [];
}

/**
 * A mutation that can be refused for a reason the user has to read.
 *
 * Not a boolean: the org routes refuse for reasons the user can act on — a
 * personal org cannot be deleted, an org with live boards must be emptied first
 * (app.ts:1571, :1583) — and collapsing "409, delete the boards first" into
 * `false` leaves the UI with nothing to say but "something went wrong".
 */
export type OrgResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The server's own message, or a fallback when the body is unreadable. */
async function refusal(
  res: Response | null,
  fallback: string,
): Promise<{ ok: false; error: string }> {
  if (!res) return { ok: false, error: "Sign in to manage organizations." };
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: body.error ?? fallback };
}

/** Create an org. The caller becomes its owner. */
export async function createOrg(name: string): Promise<OrgResult<OrgSummary>> {
  const res = await authed("/api/orgs", { method: "POST", body: JSON.stringify({ name }) });
  if (!res || !res.ok) return refusal(res, "Could not create that organization.");
  return { ok: true, value: (await res.json()) as OrgSummary };
}

/** Rename an org (owner only). */
export async function renameOrg(
  id: string,
  name: string,
): Promise<OrgResult<{ id: string; name: string }>> {
  const res = await authed(`/api/orgs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res || !res.ok) return refusal(res, "Could not rename that organization.");
  return { ok: true, value: (await res.json()) as { id: string; name: string } };
}

/** Delete an org (owner only). Refused for personal orgs and non-empty orgs. */
export async function deleteOrg(id: string): Promise<OrgResult<null>> {
  const res = await authed(`/api/orgs/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res || !res.ok) return refusal(res, "Could not delete that organization.");
  if (getCurrentOrgId() === id) clearCurrentOrgId();
  return { ok: true, value: null };
}

/* --------------------------------- members -------------------------------- */

/** Change a member's workspace role (owner only; docs/26 A6). */
export async function setOrgMemberRole(
  orgId: string,
  userId: string,
  role: "owner" | "editor" | "viewer",
): Promise<OrgResult<null>> {
  const res = await authed(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
  if (!res || !res.ok) return refusal(res, "Could not change that role.");
  return { ok: true, value: null };
}

/**
 * Remove a member (owner only), or leave — when `userId` is your own. Their
 * direct access to the workspace's boards ends with it (docs/26 A6).
 */
export async function removeOrgMember(orgId: string, userId: string): Promise<OrgResult<null>> {
  const res = await authed(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res || !res.ok) return refusal(res, "Could not remove that member.");
  return { ok: true, value: null };
}

/** Someone outside the workspace with some of its boards (docs/26 A6). */
export interface OrgGuest {
  userId: string;
  name: string;
  email: string;
  boards: Array<{ id: string; name: string; role: string }>;
}

/** The workspace's guests (owner only; empty for anyone else). */
export async function listOrgGuests(orgId: string): Promise<OrgGuest[] | null> {
  const res = await authed(`/api/orgs/${encodeURIComponent(orgId)}/guests`);
  if (!res || !res.ok) return null;
  return ((await res.json()) as { guests?: OrgGuest[] }).guests ?? [];
}

/** End a guest's access to every board in the workspace (owner only). */
export async function removeOrgGuest(orgId: string, userId: string): Promise<OrgResult<null>> {
  const res = await authed(
    `/api/orgs/${encodeURIComponent(orgId)}/guests/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res || !res.ok) return refusal(res, "Could not end that guest's access.");
  return { ok: true, value: null };
}

/* --------------------------------- invites -------------------------------- */

/** A pending invite as the owner-only list returns it (token hash never leaves). */
export interface OrgInvite {
  id: string;
  email: string;
  role: "editor" | "viewer";
  createdAt: number;
  expiresAt: number;
}

/**
 * Invite someone to an org by email (owner only). The server answers 204 for
 * any address — it must not reveal whether the invitee has an account — so
 * success here means "sent if deliverable", and the pending list is the
 * source of truth for what was created. 402 is the seat ceiling.
 */
export async function inviteToOrg(
  orgId: string,
  email: string,
  role: "editor" | "viewer",
): Promise<OrgResult<null>> {
  const res = await authed(`/api/orgs/${encodeURIComponent(orgId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
  if (res?.status === 402) {
    return { ok: false, error: "This workspace is out of seats. Upgrade the plan to invite more people." };
  }
  if (!res || !res.ok) return refusal(res, "Could not send that invite.");
  return { ok: true, value: null };
}

/** Live invites for an org (owner only; empty for everyone else). */
export async function listOrgInvites(orgId: string): Promise<OrgInvite[]> {
  const res = await authed(`/api/orgs/${encodeURIComponent(orgId)}/invites`);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { invites?: OrgInvite[] };
  return data.invites ?? [];
}

/** Revoke a pending invite (owner only). Idempotent on the server. */
export async function revokeOrgInvite(orgId: string, inviteId: string): Promise<OrgResult<null>> {
  const res = await authed(
    `/api/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
  if (!res || !res.ok) return refusal(res, "Could not revoke that invite.");
  return { ok: true, value: null };
}

/* ------------------------- active org selection --------------------------- */

/**
 * The org the user is currently looking at, as last chosen. Never trusted on
 * its own — `resolveCurrentOrg` checks it against live memberships first.
 */
/**
 * The org the user is currently looking at, as last chosen. Never trusted on
 * its own — `resolveCurrentOrg` checks it against live memberships first.
 * Scoped per account (the same namespace rule as the local projects): the
 * selection is a fact about *this user's* memberships, not the browser's.
 */
export function getCurrentOrgId(): string | null {
  try {
    const raw = localStorage.getItem(scopedStorageKey(CURRENT_ORG_KEY));
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function setCurrentOrgId(orgId: string): void {
  try {
    localStorage.setItem(scopedStorageKey(CURRENT_ORG_KEY), orgId);
  } catch {
    /* storage unavailable - the choice just won't outlive this page */
  }
}

export function clearCurrentOrgId(): void {
  try {
    localStorage.removeItem(scopedStorageKey(CURRENT_ORG_KEY));
  } catch {
    /* ignore */
  }
}

/**
 * Pick the org to work in, given the memberships the server just reported.
 *
 * The stored id wins only if it is still in the list: memberships get revoked,
 * orgs get deleted, and a browser that keeps asking for a board list in an org
 * it was removed from gets a 404 on every request with no way out. Falling back
 * to the personal org is the safe landing spot, because every account has one.
 */
export function resolveCurrentOrg(orgs: OrgSummary[]): OrgSummary | null {
  if (orgs.length === 0) return null;
  const stored = getCurrentOrgId();
  const match = stored !== null ? orgs.find((o) => o.id === stored) : undefined;
  if (match) return match;
  const fallback = orgs.find((o) => o.isPersonal) ?? orgs[0]!;
  setCurrentOrgId(fallback.id);
  return fallback;
}

/**
 * One call for boot: the membership list and the resolved active org together.
 * Callers need both and asking twice invites them to disagree.
 */
export async function loadOrgs(): Promise<{ orgs: OrgSummary[]; current: OrgSummary | null }> {
  const orgs = await listOrgs();
  return { orgs, current: resolveCurrentOrg(orgs) };
}
