import { apiFetch } from "./http.js";

/**
 * The trash (docs/26 A6): a deleted board, meeting or project waits here for
 * 30 days, restorable by whoever could delete it; an org owner can delete it
 * for good sooner.
 */

export type TrashKind = "board" | "meeting" | "project";

export interface TrashEntry {
  kind: TrashKind;
  id: string;
  name: string;
  boardId?: string;
  boardName?: string;
  deletedBy: string;
  deletedAt: number;
  purgeAt: number;
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

const trashPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/trash`;

export async function loadTrash(orgId: string): Promise<TrashEntry[] | null> {
  const result = await call(trashPath(orgId));
  return result.ok ? ((result.body as { items?: TrashEntry[] }).items ?? []) : null;
}

export const restoreFromTrash = (orgId: string, kind: TrashKind, id: string) =>
  call(`${trashPath(orgId)}/restore`, { method: "POST", body: JSON.stringify({ kind, id }) });

export const deleteForGood = (orgId: string, kind: TrashKind, id: string) =>
  call(`${trashPath(orgId)}/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Move a team board to the trash (its owner, or the org's). */
export const trashBoard = (boardId: string) =>
  call(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });

export const trashMeeting = (boardId: string, meetingId: string) =>
  call(`/api/boards/${encodeURIComponent(boardId)}/meetings/${encodeURIComponent(meetingId)}`, {
    method: "DELETE",
  });

export const trashProject = (orgId: string, projectId: string) =>
  call(`/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
