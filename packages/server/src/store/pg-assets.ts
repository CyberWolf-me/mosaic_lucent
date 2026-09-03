import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assets } from "../db/schema.js";
import { ASSET_LIST_LIMIT, type AssetStore, type StoredAsset } from "../assets.js";

/**
 * Postgres-backed asset metadata store (Stage B6 — the production-safety
 * completion the roadmap's honest-gaps section named). Parity with
 * `InMemoryAssetStore` is pinned by the gated suite in pg-store.test.ts.
 *
 * The bytes stay in the BlobBackend (memory/disk/S3 by config); this table is
 * the metadata the gateway needs to survive a restart — every uploaded asset
 * row previously evaporated with the process.
 *
 * The documented caveat, from main.ts's original deferral note: a
 * BlobBackend swap that does not also carry the bytes to the same bucket
 * leaves rows pointing at keys the new backend cannot serve. The same
 * content-addressed keys make that a migration of bytes, not of metadata —
 * re-uploading dedupes — and it is recorded in the restore runbook rather
 * than solved here.
 */
export class PostgresAssetStore implements AssetStore {
  constructor(private readonly target: Db) {}

  async create(asset: StoredAsset): Promise<StoredAsset> {
    // ON CONFLICT is the dedupe: two people pasting the same screenshot into
    // the same org is ordinary traffic, the unique index exists so it is one
    // row, and the loser's identical bytes went to the same content-addressed
    // key — nothing to clean up, nothing to double-count.
    const rows = await this.target.db
      .insert(assets)
      .values({
        id: asset.id,
        orgId: asset.orgId,
        boardId: asset.boardId,
        mime: asset.mime,
        bytes: asset.bytes,
        checksum: asset.checksum,
        storageKey: asset.storageKey,
        thumbKey: asset.thumbKey,
        width: asset.width,
        height: asset.height,
        createdBy: asset.createdBy,
        createdAt: asset.createdAt,
      })
      .onConflictDoNothing({ target: [assets.orgId, assets.checksum] })
      .returning();
    if (rows[0]) return toRow(rows[0]);
    // Collision: the existing row is authoritative. Read it back so the
    // caller learns the winner's id — its own bytes were a no-op.
    const existing = await this.byChecksum(asset.orgId, asset.checksum);
    return existing ?? asset;
  }

  async get(id: string): Promise<StoredAsset | undefined> {
    const rows = await this.target.db.select().from(assets).where(eq(assets.id, id)).limit(1);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async byChecksum(orgId: string, checksum: string): Promise<StoredAsset | undefined> {
    const rows = await this.target.db
      .select()
      .from(assets)
      .where(and(eq(assets.orgId, orgId), eq(assets.checksum, checksum)))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async listForOrg(orgId: string, limit = ASSET_LIST_LIMIT): Promise<StoredAsset[]> {
    const rows = await this.target.db
      .select()
      .from(assets)
      .where(eq(assets.orgId, orgId))
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(limit);
    return rows.map(toRow);
  }

  async listForBoard(boardId: string): Promise<StoredAsset[]> {
    const rows = await this.target.db
      .select()
      .from(assets)
      .where(eq(assets.boardId, boardId))
      .orderBy(asc(assets.createdAt), asc(assets.id));
    return rows.map(toRow);
  }

  async delete(id: string): Promise<StoredAsset | undefined> {
    const rows = await this.target.db.delete(assets).where(eq(assets.id, id)).returning();
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  async totalBytes(orgId: string): Promise<number> {
    // SUM over the index-adjacent rows; bigint comes back as a string.
    const rows = await this.target.db
      .select({ total: sql<string>`coalesce(sum(${assets.bytes}), 0)` })
      .from(assets)
      .where(eq(assets.orgId, orgId));
    return toNumber(rows[0]?.total);
  }
}

function toRow(row: typeof assets.$inferSelect): StoredAsset {
  return {
    id: row.id,
    orgId: row.orgId,
    boardId: row.boardId,
    mime: row.mime,
    bytes: toNumber(row.bytes),
    checksum: row.checksum,
    storageKey: row.storageKey,
    thumbKey: row.thumbKey,
    width: row.width === null ? null : toNumber(row.width),
    height: row.height === null ? null : toNumber(row.height),
    createdBy: row.createdBy,
    createdAt: toNumber(row.createdAt),
  };
}

/** int8 arrives as a string past 2^53; parse defensively (the other pg stores do). */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
