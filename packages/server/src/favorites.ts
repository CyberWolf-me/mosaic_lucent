/**
 * Favorites (docs/26 A6): the boards and projects a person stars, kept to
 * put them first — on Home, in the dashboard — and to follow them in their
 * activity feed. A favorite is a pointer, never a grant: what it points at is
 * shown only while the person can still open it.
 */

export const FAVORITE_KINDS = ["board", "project"] as const;
export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

export function isFavoriteKind(value: string): value is FavoriteKind {
  return (FAVORITE_KINDS as readonly string[]).includes(value);
}

export interface Favorite {
  userId: string;
  kind: FavoriteKind;
  targetId: string;
  orgId: string;
  createdAt: number;
}

/** How many a person may star — generous, and a bound on every Home load. */
export const MAX_FAVORITES = 200;

export interface FavoriteStore {
  /** Newest first. */
  list(userId: string): Promise<Favorite[]>;
  add(favorite: Favorite): Promise<void>;
  remove(userId: string, kind: FavoriteKind, targetId: string): Promise<boolean>;
}

export class InMemoryFavoriteStore implements FavoriteStore {
  private readonly rows = new Map<string, Favorite>();
  private key(userId: string, kind: string, targetId: string) {
    return `${userId}|${kind}|${targetId}`;
  }
  async list(userId: string): Promise<Favorite[]> {
    return [...this.rows.values()]
      .filter((f) => f.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async add(favorite: Favorite): Promise<void> {
    const key = this.key(favorite.userId, favorite.kind, favorite.targetId);
    if (!this.rows.has(key)) this.rows.set(key, { ...favorite });
  }
  async remove(userId: string, kind: FavoriteKind, targetId: string): Promise<boolean> {
    return this.rows.delete(this.key(userId, kind, targetId));
  }
}
