import { apiFetch } from "./http.js";

/**
 * Teams (docs/26 A6): groups of a workspace's members a board can be shared
 * with. The workspace's owners manage them; a team an identity provider
 * manages (SCIM) is changed there, and says so.
 */

export type TeamRole = "editor" | "commenter" | "viewer";

export interface TeamView {
  id: string;
  name: string;
  /** Your identity provider manages it (SCIM): name and members are changed there. */
  managed: boolean;
  members: Array<{ userId: string; name: string; email: string }>;
}

export interface BoardTeamGrant {
  teamId: string;
  name: string;
  role: TeamRole;
  members: number;
}

type Result = { ok: true } | { ok: false; error: string };

async function call(path: string, init: RequestInit = {}): Promise<Result & { body?: unknown }> {
  try {
    const res = await apiFetch(path, init);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) return { ok: false, error: body?.error ?? "That didn't work." };
    return { ok: true, body };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

const org = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/teams`;

export async function listTeams(orgId: string): Promise<TeamView[] | null> {
  const result = await call(org(orgId));
  return result.ok ? ((result.body as { teams?: TeamView[] }).teams ?? []) : null;
}

export const createTeam = (orgId: string, name: string) =>
  call(org(orgId), { method: "POST", body: JSON.stringify({ name }) });

export const deleteTeam = (orgId: string, teamId: string) =>
  call(`${org(orgId)}/${encodeURIComponent(teamId)}`, { method: "DELETE" });

export const addTeamMember = (orgId: string, teamId: string, userId: string) =>
  call(`${org(orgId)}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "PUT",
  });

export const removeTeamMember = (orgId: string, teamId: string, userId: string) =>
  call(`${org(orgId)}/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });

const board = (boardId: string) => `/api/boards/${encodeURIComponent(boardId)}/teams`;

/** Teams with access to a board — and, for its owner, the teams to choose from. */
export async function boardTeams(
  boardId: string,
): Promise<{ teams: BoardTeamGrant[]; available: Array<{ teamId: string; name: string }> } | null> {
  const result = await call(board(boardId));
  if (!result.ok) return null;
  const body = result.body as {
    teams?: BoardTeamGrant[];
    available?: Array<{ teamId: string; name: string }>;
  };
  return { teams: body.teams ?? [], available: body.available ?? [] };
}

export const grantTeam = (boardId: string, teamId: string, role: TeamRole) =>
  call(`${board(boardId)}/${encodeURIComponent(teamId)}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });

export const removeTeamGrant = (boardId: string, teamId: string) =>
  call(`${board(boardId)}/${encodeURIComponent(teamId)}`, { method: "DELETE" });
