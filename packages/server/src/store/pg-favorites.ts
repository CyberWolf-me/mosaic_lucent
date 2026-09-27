import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { favorites } from "../db/schema.js";
import type { Favorite, FavoriteKind, FavoriteStore } from "../favorites.js";

type Handle = Db["db"];

/** docs/26 A6: favorites in Postgres. */
export class PostgresFavoriteStore implements FavoriteStore {
  constructor(private readonly db: Handle) {}

  async list(userId: string): Promise<Favorite[]> {
    const rows = await this.db
      .select()
      .from(favorites)
      .where(eq(favorites.userId, userId))
      .orderBy(desc(favorites.createdAt));
    return rows.map((r) => ({
      userId: r.userId,
      kind: r.kind as FavoriteKind,
      targetId: r.targetId,
      orgId: r.orgId,
      createdAt: r.createdAt,
    }));
  }

  async add(favorite: Favorite): Promise<void> {
    await this.db.insert(favorites).values(favorite).onConflictDoNothing();
  }

  async remove(userId: string, kind: FavoriteKind, targetId: string): Promise<boolean> {
    const gone = await this.db
      .delete(favorites)
      .where(
        and(
          eq(favorites.userId, userId),
          eq(favorites.kind, kind),
          eq(favorites.targetId, targetId),
        ),
      )
      .returning();
    return gone.length > 0;
  }
}
