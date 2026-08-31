import type { Workspace } from "@lucent/core";
import { apiFetch } from "./http.js";
import { hasSession } from "./session.js";

/**
 * Board REST client (docs/12). Server-side boards are what make a board
 * shareable: the realtime room is keyed by board id, so a board must exist on
 * the server before two people can join the same one.
 *
 * Every call requires a session. Signed-out users stay in the offline
 * localStorage flow and never reach these endpoints.
 */

export type BoardRole = "owner" | "editor" | "viewer";
/** Roles a share link may grant — ownership is never transferable by link. */
export type ShareRole = Exclude<BoardRole, "owner">;

export interface BoardSummary {
  id: string;
  name: string;
  updatedAt: number;
  /** Owning tenant. Present on list responses; the create/update 201 omits it. */
  orgId?: string;
  nodes?: number;
}

/** Which view a list call asks for; mirrors the server's `scope` parameter. */
export type BoardScope = "org" | "shared";

export interface BoardMemberSummary {
  boardId: string;
  userId: string;
  role: BoardRole;
  invitedBy: string | null;
  createdAt: number;
}

/**
 * Every board call, gated on having a session at all.
 *
 * `null` means "did not ask the server", which callers map to the offline flow.
 * The gate is `hasSession()` and not `getToken()`: a cookie session has no
 * readable bearer token, so the old token check made every board request a
 * silent no-op for exactly the users who had just signed in - the board list
 * came back empty and Settings reported "You are working offline".
 *
 * `apiFetch` supplies the session cookie, the CSRF header that the mutating
 * calls below (POST / PATCH / DELETE) are rejected without, and the bearer
 * header for legacy token sessions.
 */
async function authed(path: string, init?: RequestInit): Promise<Response | null> {
  if (!hasSession()) return null;
  return apiFetch(path, init ?? {});
}

/**
 * Create or update a server-side board. Passing `id` updates in place, which is
 * what "share the board I'm already working on" needs.
 *
 * `orgId` is a required parameter rather than an optional one because the
 * server's fallback for a missing one is `memberships[0]?.orgId` (app.ts:2183) -
 * whichever org the membership query happened to return first. A user who
 * belongs to two orgs then saves into an arbitrary tenant, and the board is
 * invisible from the list call for the org they were actually looking at. The
 * caller knows which org is on screen, so it has to say which.
 */
export async function saveBoard(
  orgId: string,
  name: string,
  workspace: Workspace,
  id?: string,
): Promise<BoardSummary | null> {
  const res = await authed("/api/boards", {
    method: "POST",
    body: JSON.stringify({ ...(id ? { id } : {}), orgId, name, workspace }),
  });
  if (!res || !res.ok) return null;
  const body = (await res.json()) as BoardSummary;
  // The 201 answers {id, name, updatedAt}; the tenant is the one we just asked
  // for, and callers that cache the summary need it on the object.
  return { ...body, orgId };
}

/**
 * Boards in one tenant. `scope` chooses the view the server offers:
 *   "org" (the default) - every board in the tenant, which requires a real
 *     `memberships` row; without one the server answers 404 `org not found`.
 *   "shared" - only boards the caller owns or holds a `board_members` row on.
 *     Deliberately does not require org membership, so an outside collaborator
 *     who arrived through a share link can still list what they can open.
 *
 * `orgId` is required because the route requires it: `GET /api/boards` with no
 * orgId is a 400 (`orgId query parameter required`, app.ts:2277), so the
 * no-argument version this replaces returned `[]` for every caller, always.
 */
export async function listBoards(orgId: string, scope?: BoardScope): Promise<BoardSummary[]> {
  const query = new URLSearchParams({ orgId });
  if (scope !== undefined) query.set("scope", scope);
  const res = await authed(`/api/boards?${query.toString()}`);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { boards?: BoardSummary[] };
  return data.boards ?? [];
}

/**
 * Fetch one board. Returns the caller's own role alongside the workspace, so
 * the UI can decide what to offer without a second request or a guess.
 * Null when the board doesn't exist or the caller isn't a member.
 */
export async function fetchBoard(
  id: string,
): Promise<{ id: string; name: string; workspace: Workspace; role: BoardRole } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(id)}`);
  if (!res || !res.ok) return null;
  return (await res.json()) as {
    id: string;
    name: string;
    workspace: Workspace;
    role: BoardRole;
  };
}

/**
 * Mint a share link for a board (owner only). The returned token is the
 * capability; the caller builds the invite URL around it.
 */
export async function createShareLink(
  boardId: string,
  role: ShareRole,
  expiresInHours?: number,
): Promise<{ token: string; role: ShareRole; expiresAt: number | null } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/share`, {
    method: "POST",
    body: JSON.stringify({ role, ...(expiresInHours ? { expiresInHours } : {}) }),
  });
  if (!res || !res.ok) {
    // Surface the server's reason rather than swallowing it: "verify your
    // email before sharing a board" is a fixable action, and telling the
    // actual owner they're "not the owner" (the old blanket message) sent
    // people down the wrong path.
    try {
      const body = (await res?.json()) as { error?: string } | null;
      if (body?.error) lastShareLinkError = body.error;
    } catch {
      // non-JSON body: leave the generic caller message in place
    }
    return null;
  }
  return (await res.json()) as { token: string; role: ShareRole; expiresAt: number | null };
}

/** The server's reason for the last failed createShareLink, when it sent one.
 * Cleared on the next call. Exists so the share dialog can show the real
 * reason ("verify your email before sharing a board") instead of a guess. */
let lastShareLinkError: string | null = null;
export function readShareLinkError(): string | null {
  const err = lastShareLinkError;
  lastShareLinkError = null;
  return err;
}

/** Revoke one link, or every live link on the board when token is omitted. */
export async function revokeShareLinks(boardId: string, token?: string): Promise<number> {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/share${query}`, {
    method: "DELETE",
  });
  if (!res || !res.ok) return 0;
  return ((await res.json()) as { revoked?: number }).revoked ?? 0;
}

/**
 * Redeem a share link. Idempotent — joining a board you already belong to
 * returns your existing role rather than downgrading it. Returns the granted
 * role, or an error message suitable for showing the user.
 */
export async function joinBoard(
  boardId: string,
  token: string,
): Promise<{ ok: true; role: BoardRole } | { ok: false; error: string }> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/join`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  if (!res) return { ok: false, error: "Sign in to open a shared board." };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? "That invite link is not valid." };
  }
  const body = (await res.json()) as { role: BoardRole };
  return { ok: true, role: body.role };
}

/** Members of a board, plus the caller's own role. Any member may read this. */
export async function listMembers(
  boardId: string,
): Promise<{ members: BoardMemberSummary[]; role: BoardRole } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/members`);
  if (!res || !res.ok) return null;
  return (await res.json()) as { members: BoardMemberSummary[]; role: BoardRole };
}

/** Change a member's role (owner only). The board owner cannot be demoted. */
export async function setMemberRole(
  boardId: string,
  userId: string,
  role: ShareRole,
): Promise<boolean> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
  return Boolean(res?.ok);
}

/** Remove a member's access (owner only). */
export async function removeMember(boardId: string, userId: string): Promise<boolean> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  return Boolean(res?.ok);
}

/**
 * Mint a 60-second, single-use ticket for the WebSocket upgrade (M0.3). The
 * browser exchanges its bearer token for the ticket on demand, then the
 * token never appears in proxy access logs or server-side WS upgrade frames.
 */
export async function fetchRealtimeTicket(): Promise<string | null> {
  const res = await authed("/api/realtime/ticket", { method: "POST" });
  if (!res || !res.ok) return null;
  const body = (await res.json()) as { ticket?: string };
  return body.ticket ?? null;
}
