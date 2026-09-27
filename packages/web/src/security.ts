import { apiFetch } from "./http.js";

/**
 * Two-step verification for your account, and a workspace's requirement of
 * it (docs/26 A6). Enrollment is the server's two steps: a secret to put in
 * an authenticator app, then a code from it — which turns it on and hands
 * back recovery codes, shown once.
 */

export interface TwoFactorStatus {
  /** False when this server has no two-step store configured. */
  available: boolean;
  enabled: boolean;
  enrolledAt: number | null;
  recoveryCodesLeft: number;
}

export interface BlockedWorkspace {
  orgId: string;
  orgName: string;
  reason: "two_factor";
  /** You're in it as a guest on some of its boards, not as a member. */
  asGuest: boolean;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function call<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const res = await apiFetch(path, init);
    const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
    if (!res.ok) return { ok: false, error: body?.error ?? "That didn't work." };
    return { ok: true, ...body };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

const post = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

export async function twoFactorStatus(): Promise<TwoFactorStatus | null> {
  const r = await call<TwoFactorStatus>("/api/auth/2fa");
  return r.ok ? r : null;
}

/** Step one: the secret for the authenticator app, and its otpauth link. */
export const beginEnrollment = () =>
  call<{ secret: string; otpauthUri: string }>("/api/auth/2fa/enroll", post());

/** Step two: a code from the app turns it on; the recovery codes come back once. */
export const confirmEnrollment = (secret: string, code: string) =>
  call<{ recoveryCodes: string[] }>(
    "/api/auth/2fa/enroll/confirm",
    post({ secret, code: code.replace(/\s+/g, "") }),
  );

export const disableTwoFactor = (code: string) =>
  call<object>("/api/auth/2fa/disable", post({ code: code.trim() }));

/** The workspaces closed to you right now, and why; null when unknown. */
export async function loadAccess(): Promise<BlockedWorkspace[] | null> {
  const r = await call<{ blocked?: BlockedWorkspace[] }>("/api/me/access");
  return r.ok ? (r.blocked ?? []) : null;
}

/** The secret in groups of four, as authenticator apps show it. */
export function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** Owner: require two-step verification for the workspace, or stop. */
export async function setRequireTwoFactor(orgId: string, on: boolean): Promise<Result<object>> {
  return call<object>(`/api/orgs/${encodeURIComponent(orgId)}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requireTwoFactor: on }),
  });
}

/** Owner: whether the workspace requires it, or null (not an owner, offline). */
export async function loadRequireTwoFactor(orgId: string): Promise<boolean | null> {
  const r = await call<{ effective?: { requireTwoFactor?: boolean } }>(
    `/api/orgs/${encodeURIComponent(orgId)}/settings`,
  );
  return r.ok ? r.effective?.requireTwoFactor === true : null;
}
