import { apiFetch } from "./http.js";

/**
 * Your own view across workspaces (docs/26 A6): what you starred, and what
 * others changed lately on the boards you follow.
 */

export type FavoriteKind = "board" | "project";

export interface FavoriteView {
  kind: FavoriteKind;
  id: string;
  name: string;
  orgId: string;
  updatedAt: number;
}

export interface ActivityItem {
  boardId: string;
  boardName: string;
  starred: boolean;
  seq: number;
  at: number;
  label: string;
  ops: number;
  actor: string;
  actorType?: "ai" | "system";
  /** An AI change: who asked for it. */
  onBehalfOf?: string;
}

async function get<T>(path: string, key: string): Promise<T[] | null> {
  try {
    const res = await apiFetch(path);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return (body?.[key] as T[] | undefined) ?? [];
  } catch {
    return null;
  }
}

export const listFavorites = () => get<FavoriteView>("/api/me/favorites", "favorites");

export const loadActivity = () => get<ActivityItem>("/api/me/activity", "activity");

/** Star or unstar; true when the server agreed. */
export async function setFavorite(kind: FavoriteKind, id: string, on: boolean): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/me/favorites/${kind}/${encodeURIComponent(id)}`, {
      method: on ? "PUT" : "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}
