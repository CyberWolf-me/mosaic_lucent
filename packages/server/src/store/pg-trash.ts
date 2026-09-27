import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { trashItems } from "../db/schema.js";
import type { TrashItem, TrashKind, TrashStore } from "../trash.js";

type Handle = Db["db"];

function toItem(row: typeof trashItems.$inferSelect): TrashItem {
  return {
    kind: row.kind as TrashKind,
    id: row.itemId,
    orgId: row.orgId,
    boardId: row.boardId,
    name: row.name,
    deletedBy: row.deletedBy,
    deletedAt: row.deletedAt,
  };
}

/** docs/26 A6: trashed meetings and projects in Postgres. */
export class PostgresTrashStore implements TrashStore {
  constructor(private readonly db: Handle) {}

  async put(item: TrashItem): Promise<void> {
    const values = {
      kind: item.kind,
      itemId: item.id,
      orgId: item.orgId,
      boardId: item.boardId,
      name: item.name,
      deletedBy: item.deletedBy,
      deletedAt: item.deletedAt,
    };
    await this.db
      .insert(trashItems)
      .values(values)
      .onConflictDoUpdate({
        target: [trashItems.kind, trashItems.itemId],
        set: { deletedBy: values.deletedBy, deletedAt: values.deletedAt, name: values.name },
      });
  }

  async remove(kind: TrashKind, id: string): Promise<boolean> {
    const gone = await this.db
      .delete(trashItems)
      .where(and(eq(trashItems.kind, kind), eq(trashItems.itemId, id)))
      .returning();
    return gone.length > 0;
  }

  async get(kind: TrashKind, id: string): Promise<TrashItem | undefined> {
    const [row] = await this.db
      .select()
      .from(trashItems)
      .where(and(eq(trashItems.kind, kind), eq(trashItems.itemId, id)));
    return row ? toItem(row) : undefined;
  }

  async forOrg(orgId: string): Promise<TrashItem[]> {
    const rows = await this.db
      .select()
      .from(trashItems)
      .where(eq(trashItems.orgId, orgId))
      .orderBy(desc(trashItems.deletedAt));
    return rows.map(toItem);
  }

  async expired(before: number, limit: number): Promise<TrashItem[]> {
    const rows = await this.db
      .select()
      .from(trashItems)
      .where(lt(trashItems.deletedAt, before))
      .orderBy(asc(trashItems.deletedAt))
      .limit(limit);
    return rows.map(toItem);
  }

  async hidden(kind: TrashKind, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ id: trashItems.itemId })
      .from(trashItems)
      .where(and(eq(trashItems.kind, kind), inArray(trashItems.itemId, [...ids])));
    return new Set(rows.map((r) => r.id));
  }
}
