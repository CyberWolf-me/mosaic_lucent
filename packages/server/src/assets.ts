import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { formatAssetRef, assetRefId } from "@lucent/core";

/**
 * Assets out of the graph (M3, docs/06-07).
 *
 * Until now an image *was* the diagram: `downscaleImage` in the web package
 * turned a paste into `data:image/jpeg;base64,...` and that string lived in
 * `boards.workspace`, in every op-log entry that touched it, in every websocket
 * broadcast and in every undo entry. A 1.5 MB photo therefore cost 1.5 MB per
 * copy, and the copies are unbounded. This module is the other half: bytes live
 * in a blob store under a content-addressed key, metadata lives in one row, and
 * the graph carries `asset:ast_...` (see `formatAssetRef` in core).
 *
 * Three seams, deliberately separate:
 *
 *   - `AssetStore`   -- metadata. Two implementations per ADR 0006; the Postgres
 *                       one is in store/pg-assets.ts against the `assets` table.
 *   - `BlobBackend`  -- bytes. Memory for tests, disk for dev, S3/R2 for prod.
 *   - `Thumbnailer`  -- optional, and allowed to fail (see below).
 *
 * `AssetService` composes the three and is what a route calls. Nothing here
 * touches an HTTP object: an upload is bytes plus who is uploading them, which
 * is what makes the validation and the dedupe path testable without a socket.
 *
 * The one rule that shapes every write order in this file: **a metadata row must
 * never point at bytes that are not there.** A row without its object is a
 * permanently broken image on every client that loads the board; an object
 * without a row is an orphan, invisible, and reclaimable by a sweep. So a create
 * writes bytes first and the row second, and a delete removes the row first and
 * the bytes second. Both leave the same safe residue.
 */

/**
 * Ids are minted here, not by Postgres, because the reference has to exist
 * before the row does -- see the write order above. Same shape as the other id
 * helpers in this package (`newUsageEventId`, `newBoardId`): a base36 clock so
 * ids sort roughly by age, plus randomness so two processes in the same
 * millisecond do not collide. Lowercase alphanumerics throughout, which is the
 * alphabet core's `asset:` grammar accepts.
 */
export function newAssetId(): string {
  return "ast_" + Date.now().toString(36) + randomBytes(6).toString("hex");
}

/**
 * One asset's metadata. Mirrors the `assets` table one field per column, so the
 * Postgres store is a projection and nothing about an asset is derived twice.
 *
 * `mime` is `string`, not the `AssetMime` union: the column is text, and a row
 * written by a build whose allowlist differs from this one still has to come
 * back rather than throw. Validation narrows on the way in (`validateAssetBytes`);
 * reads stay honest about what the database can hold.
 */
export interface StoredAsset {
  id: string;
  /** Tenant boundary. Every asset belongs to exactly one org (M2.1). */
  orgId: string;
  /** Where it was first used -- provenance, not ownership. Null once that board is gone. */
  boardId: string | null;
  mime: string;
  /** Size of the stored object. The unit `storage.bytes` is billed in. */
  bytes: number;
  /** Lowercase hex sha256 of the bytes, computed server-side. Unique per org. */
  checksum: string;
  /** Key into the `BlobBackend`. Content-addressed; see `assetStorageKey`. */
  storageKey: string;
  /** Key of the generated thumbnail, or null when none could be produced. */
  thumbKey: string | null;
  /** Intrinsic pixel dimensions, parsed from the header. Null when unreadable. */
  width: number | null;
  height: number | null;
  createdBy: string | null;
  createdAt: number;
}

export interface AssetStore {
  /**
   * Insert one asset, returning the row that is now authoritative.
   *
   * On a `(orgId, checksum)` collision the *existing* row is returned and the
   * caller's is discarded. That is not an error: two people pasting the same
   * screenshot into the same org is ordinary traffic, and the unique index
   * exists precisely so it is one row and one billable object. Because the
   * storage key is derived from the checksum, the loser's bytes went to the key
   * the winner already occupies -- identical content, so there is nothing to
   * clean up and nothing to double-count.
   */
  create(asset: StoredAsset): Promise<StoredAsset>;
  get(id: string): Promise<StoredAsset | undefined>;
  /** The dedupe lookup: has this org already stored these exact bytes? */
  byChecksum(orgId: string, checksum: string): Promise<StoredAsset | undefined>;
  /** Newest first, capped, for the org's storage view. */
  listForOrg(orgId: string, limit?: number): Promise<StoredAsset[]>;
  /** Assets first used on one board, oldest first. */
  listForBoard(boardId: string): Promise<StoredAsset[]>;
  /** Delete one row, returning what was removed so its bytes can be reclaimed. */
  delete(id: string): Promise<StoredAsset | undefined>;
  /**
   * Bytes this org currently stores. The live count behind M4's `storage.bytes`
   * entitlement, which is a *standing* limit (plans.ts): it has to fall when an
   * asset is deleted, which is why it is a sum over this table rather than a sum
   * over usage events in a month window.
   */
  totalBytes(orgId: string): Promise<number>;
}

/** How many assets `listForOrg` returns when the caller does not say. */
export const ASSET_LIST_LIMIT = 200;

export class InMemoryAssetStore implements AssetStore {
  private readonly rows = new Map<string, StoredAsset>();
  /** `orgId + " " + checksum` -> asset id. The unique index, by hand. */
  private readonly byOrgChecksum = new Map<string, string>();

  async create(asset: StoredAsset): Promise<StoredAsset> {
    const dedupeKey = checksumKey(asset.orgId, asset.checksum);
    const existingId = this.byOrgChecksum.get(dedupeKey);
    if (existingId !== undefined) {
      const existing = this.rows.get(existingId);
      if (existing) return existing;
    }
    this.rows.set(asset.id, asset);
    this.byOrgChecksum.set(dedupeKey, asset.id);
    return asset;
  }

  async get(id: string): Promise<StoredAsset | undefined> {
    return this.rows.get(id);
  }

  async byChecksum(orgId: string, checksum: string): Promise<StoredAsset | undefined> {
    const id = this.byOrgChecksum.get(checksumKey(orgId, checksum));
    return id === undefined ? undefined : this.rows.get(id);
  }

  async listForOrg(orgId: string, limit = ASSET_LIST_LIMIT): Promise<StoredAsset[]> {
    return [...this.rows.values()]
      .filter((a) => a.orgId === orgId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  async listForBoard(boardId: string): Promise<StoredAsset[]> {
    return [...this.rows.values()]
      .filter((a) => a.boardId === boardId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  async delete(id: string): Promise<StoredAsset | undefined> {
    const row = this.rows.get(id);
    if (!row) return undefined;
    this.rows.delete(id);
    this.byOrgChecksum.delete(checksumKey(row.orgId, row.checksum));
    return row;
  }

  async totalBytes(orgId: string): Promise<number> {
    let total = 0;
    for (const row of this.rows.values()) if (row.orgId === orgId) total += row.bytes;
    return total;
  }
}

function checksumKey(orgId: string, checksum: string): string {
  return orgId + " " + checksum;
}

/**
 * Types an upload may carry.
 *
 * The allowlist is short on purpose: it holds exactly the formats this module
 * can *prove* a byte stream is, by reading its header (`sniffImageMime`) and
 * measuring it (`imageDimensions`). A type we cannot verify would mean trusting
 * a client's Content-Type about bytes we then hand back to browsers, which is
 * the whole class of bug the sniff exists to close. Adding AVIF or HEIC is
 * therefore a sniffer plus a dimension parser, not an entry in this array.
 */
export const ALLOWED_ASSET_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type AssetMime = (typeof ALLOWED_ASSET_MIMES)[number];

export function isAllowedAssetMime(mime: string): mime is AssetMime {
  return (ALLOWED_ASSET_MIMES as readonly string[]).includes(mime);
}

/**
 * Hard per-object ceiling, independent of the plan's `storage.bytes` allowance.
 *
 * The two answer different questions: the entitlement is how much an org may
 * keep, this is how large one request may be. Without it a single upload could
 * spend a whole Enterprise allowance in one round trip, and the request body
 * would be buffered in memory before any entitlement was consulted.
 *
 * 10 MiB comfortably holds a full-resolution phone photo; `downscaleImage`
 * targets 1.5 MB, so anything near this cap came in another way.
 */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * Why an upload was refused, and the status that says so.
 *
 * The status travels with the refusal for the same reason `EntitlementRefusal`
 * carries its 402: a route that maps these itself is a route that will answer
 * 500 for a 4 MB GIF. `svg-refused` is separate from `mime-not-allowed` because
 * the client should say something specific about it.
 */
export type AssetRejectionCode =
  | "empty"
  | "too-large"
  | "mime-not-allowed"
  | "svg-refused"
  | "mime-mismatch"
  | "checksum-mismatch";

export interface AssetRejection {
  ok: false;
  code: AssetRejectionCode;
  /** 400, 413 or 415 -- send it as-is. */
  status: number;
  /** One human sentence, safe to render. */
  detail: string;
}

/** What validation learned about bytes it accepted. */
export interface ValidatedAsset {
  ok: true;
  /** The sniffed type. Authoritative over anything the client declared. */
  mime: AssetMime;
  bytes: number;
  checksum: string;
  width: number | null;
  height: number | null;
}

export type AssetValidation = ValidatedAsset | AssetRejection;

export interface ValidateAssetInput {
  bytes: Uint8Array;
  /** The client's Content-Type, if it sent one. Checked, never trusted. */
  mime?: string;
  /** A checksum the client claims. Compared, never used in place of ours. */
  checksum?: string;
  maxBytes?: number;
}

/**
 * Validate raw upload bytes.
 *
 * Order matters. Size is checked before anything reads the buffer, the type
 * comes from the bytes rather than from the request, and the checksum is
 * computed here over the actual bytes -- a client-supplied digest is only ever
 * compared against ours, so a corrupted transfer is caught while a lying client
 * gains nothing.
 *
 * SVG is refused outright, by name, even though it is an image and even though
 * the data-URL grammar in core still tolerates one. An SVG is a document: it can
 * carry `<script>`, `onload=`, `<foreignObject>` and external references, all of
 * which execute when the file is served back and rendered. Serving it safely
 * needs a sanitiser or an isolated origin, and this product has neither, so the
 * only honest answer at the door is no. That is a content-security decision, not
 * a format preference: the refusal must stay even if a sniffer for it is added.
 */
export function validateAssetBytes(input: ValidateAssetInput): AssetValidation {
  const max = input.maxBytes ?? MAX_ASSET_BYTES;
  const size = input.bytes.byteLength;
  if (size === 0) {
    return { ok: false, code: "empty", status: 400, detail: "The upload was empty." };
  }
  if (size > max) {
    return {
      ok: false,
      code: "too-large",
      status: 413,
      detail:
        "That image is " +
        formatBytes(size) +
        ". The limit for a single upload is " +
        formatBytes(max) +
        ".",
    };
  }

  if (looksLikeSvg(input.bytes)) {
    return {
      ok: false,
      code: "svg-refused",
      status: 415,
      detail:
        "SVG uploads are not accepted: an SVG can carry scripts that run when it " +
        "is displayed. Export it as PNG and upload that.",
    };
  }

  const sniffed = sniffImageMime(input.bytes);
  if (sniffed === undefined) {
    return {
      ok: false,
      code: "mime-not-allowed",
      status: 415,
      detail:
        "That file is not a supported image. Supported formats: " +
        ALLOWED_ASSET_MIMES.map((m) => m.slice("image/".length).toUpperCase()).join(", ") +
        ".",
    };
  }

  const declared = normalizeMime(input.mime);
  // A client that declares one type and sends another is broken or probing, and
  // there is no way to tell which from here. The sniff already decided what the
  // bytes are, so the mismatch is reported rather than quietly resolved: silently
  // storing PNG bytes as the JPEG the client claimed is how a served asset ends up
  // with a Content-Type that does not describe it.
  if (declared !== undefined && declared !== sniffed) {
    return {
      ok: false,
      code: "mime-mismatch",
      status: 400,
      detail: "The upload says it is " + declared + " but the file is " + sniffed + ".",
    };
  }

  const checksum = sha256Hex(input.bytes);
  if (input.checksum !== undefined && input.checksum.toLowerCase() !== checksum) {
    return {
      ok: false,
      code: "checksum-mismatch",
      status: 400,
      detail: "The upload did not match its checksum; it was corrupted in transit.",
    };
  }

  const size2 = imageDimensions(input.bytes);
  return {
    ok: true,
    mime: sniffed,
    bytes: size,
    checksum,
    // A header we cannot measure is not a reason to refuse a file we have already
    // identified: the dimensions are a rendering hint, and the client can lay the
    // image out from the natural size once it loads. Null says "unknown", which is
    // what the nullable columns are for.
    width: size2?.width ?? null,
    height: size2?.height ?? null,
  };
}

/** `image/jpg` and a charset suffix both appear in real Content-Type headers. */
function normalizeMime(mime: string | undefined): string | undefined {
  if (mime === undefined) return undefined;
  const bare = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (bare.length === 0) return undefined;
  return bare === "image/jpg" ? "image/jpeg" : bare;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " bytes";
}

/**
 * True when the bytes look like an SVG or XML document.
 *
 * Only the first kilobyte is examined, decoded as latin1 so no byte sequence can
 * throw: an SVG has its root element in the first few hundred bytes after an
 * optional prolog, comments or a DOCTYPE. This is a refusal test, not a parser --
 * a false positive means someone is told to convert a file that was not an image
 * anyway, since nothing in the allowlist contains `<svg` or `<?xml` in its
 * header.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, 1024))).toString("latin1");
  return /<svg[\s/>]/i.test(head) || /^\s*(\uFEFF)?<\?xml/i.test(head);
}

/**
 * Identify an image from its magic bytes.
 *
 * Returns undefined for anything not on the allowlist, including an SVG -- that
 * case is `looksLikeSvg`, which runs first so the refusal can say why.
 */
export function sniffImageMime(bytes: Uint8Array): AssetMime | undefined {
  const b = asBuffer(bytes);
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return "image/png";
  }
  // FF D8 FF: SOI followed by the first marker. FF D8 alone is two bytes of
  // anything, so the third byte is what makes this a JPEG rather than a guess.
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6) {
    const magic = b.toString("latin1", 0, 6);
    if (magic === "GIF87a" || magic === "GIF89a") return "image/gif";
  }
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Intrinsic pixel dimensions, parsed from the file header in pure TypeScript.
 *
 * No image library is involved, and that is the point: this package's only
 * dependencies are the framework ones, and pulling in a native decoder (with a
 * platform-specific binary, a build step and a CVE feed) to read four numbers out
 * of a 30-byte header would be the largest dependency in the server for the
 * smallest reason. Each format below needs one header field, and the formats are
 * frozen.
 *
 * Every reader goes through `Buffer`, whose accessors throw on a short read, and
 * the whole parse is wrapped once: a truncated or lying header becomes
 * `undefined` in one place instead of a bounds check per field. Undefined means
 * "unknown", not "invalid" -- an image that identified but would not measure is
 * still stored (see `validateAssetBytes`).
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const mime = sniffImageMime(bytes);
  if (mime === undefined) return undefined;
  const b = asBuffer(bytes);
  try {
    switch (mime) {
      case "image/png":
        return pngDimensions(b);
      case "image/jpeg":
        return jpegDimensions(b);
      case "image/gif":
        return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
      case "image/webp":
        return webpDimensions(b);
    }
  } catch {
    return undefined;
  }
}

/**
 * PNG: IHDR is required to be the first chunk, so the two dimensions are at a
 * fixed offset -- 8 bytes of signature, a 4-byte length, the 4-byte type, then
 * width and height as big-endian u32.
 */
function pngDimensions(b: Buffer): { width: number; height: number } | undefined {
  if (b.toString("latin1", 12, 16) !== "IHDR") return undefined;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * JPEG: the size lives in whichever SOFn frame header the encoder used, so the
 * marker segments have to be walked. Skipped along the way:
 *
 *   - fill bytes (a run of FF before a marker is legal padding);
 *   - the standalone markers, which have no length field: RSTn (D0-D7), SOI, EOI
 *     and TEM. Treating one of those as a segment would read its neighbour's
 *     bytes as a length and walk straight off the end of the file;
 *   - C4 (DHT), C8 (JPG extension) and CC (DAC), which sit inside the SOFn
 *     numeric range but are not frame headers.
 *
 * SOS (DA) ends the walk: past it the bytes are entropy-coded scan data, and any
 * FF in there is not a marker.
 */
function jpegDimensions(b: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) return undefined;
    const length = b.readUInt16BE(i + 2);
    if (length < 2) return undefined;
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    i += 2 + length;
  }
  return undefined;
}

/**
 * WebP: one of three payload layouts behind the RIFF header, and a file may be
 * any of them.
 *
 *   - `VP8 ` (lossy): a 3-byte frame tag, the 3-byte sync code 9D 01 2A, then
 *     14-bit width and height, each with 2 high bits of scale to mask off.
 *   - `VP8L` (lossless): a 0x2F signature byte then 14+14 bits packed
 *     LSB-first, stored minus one.
 *   - `VP8X` (extended -- animation, alpha, ICC): a canvas size in the chunk
 *     itself as two 24-bit little-endian values, also minus one. Reading this
 *     rather than chasing the first frame is what makes an animated WebP measure.
 */
function webpDimensions(b: Buffer): { width: number; height: number } | undefined {
  const chunk = b.toString("latin1", 12, 16);
  const payload = 20;
  if (chunk === "VP8 ") {
    if (b.readUInt8(payload + 3) !== 0x9d) return undefined;
    if (b.readUInt8(payload + 4) !== 0x01) return undefined;
    if (b.readUInt8(payload + 5) !== 0x2a) return undefined;
    return {
      width: b.readUInt16LE(payload + 6) & 0x3fff,
      height: b.readUInt16LE(payload + 8) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (b.readUInt8(payload) !== 0x2f) return undefined;
    const packed = b.readUInt32LE(payload + 1);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      width: b.readUIntLE(payload + 4, 3) + 1,
      height: b.readUIntLE(payload + 7, 3) + 1,
    };
  }
  return undefined;
}

/**
 * A Buffer view over the same memory -- no copy, so a 10 MB upload is not
 * duplicated to read 8 bytes of it. `Buffer.from(Uint8Array)` would copy;
 * `Buffer.from(buffer, offset, length)` aliases, and the offset matters because
 * these bytes often arrive as a subarray of a larger read.
 */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Blob keys.
 *
 * A key is a path, and a path reaches a filesystem. The grammar below is the
 * defence, written as an allowlist of what a key may *be* rather than a blocklist
 * of what it may not contain: every segment has to start with an alphanumeric,
 * which makes `.`, `..` and a leading slash unrepresentable rather than filtered.
 * No encoding of a parent-directory hop satisfies it, so there is no decoding
 * order to get wrong -- the class of bug a substring check invites.
 *
 * Keys are derived here, never accepted from a request. The validator still
 * exists because a key also arrives from a database row, and a row written by an
 * older build, a restored backup or a compromised admin path is not a trusted
 * input either.
 */
export const BLOB_KEY_MAX_LENGTH = 512;
const BLOB_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function isSafeBlobKey(key: string): boolean {
  return key.length > 0 && key.length <= BLOB_KEY_MAX_LENGTH && BLOB_KEY.test(key);
}

/** Refusing beats sanitising: an unsafe key is a bug, not a value to repair. */
export function assertSafeBlobKey(key: string): string {
  if (!isSafeBlobKey(key)) {
    throw new Error(`assets: refusing to use unsafe blob key ${JSON.stringify(key)}`);
  }
  return key;
}

const EXTENSIONS: Readonly<Record<AssetMime, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * Where the bytes live: `assets/<org>/<first two hex>/<checksum><ext>`.
 *
 * Content-addressed, and that is load-bearing in three places. The same file
 * uploaded twice in an org resolves to the same key, so the loser of the
 * `(org_id, checksum)` unique index has already written its bytes to the exact
 * object the winner points at: identical content, no orphan, no cleanup path to
 * get wrong. Deleting the row may delete the object, because no other row in that
 * org can address it and another tenant copy sits under a different prefix. And a
 * retry after a half-failed upload overwrites instead of accumulating.
 *
 * The org prefix keeps one tenant objects enumerable as a unit (an export or an
 * account deletion is a prefix scan), and the two-character fan-out keeps a
 * directory listing usable on the disk backend, where every object in an org
 * would otherwise land in one folder.
 *
 * The extension is what lets `mimeFromKey` answer without a database round trip,
 * which is the only reason the S3 backend can set a Content-Type on a write.
 */
export function assetStorageKey(orgId: string, checksum: string, mime: AssetMime): string {
  return assertSafeBlobKey(
    "assets/" + keySegment(orgId) + "/" + hexPrefix(checksum) + "/" + checksum + EXTENSIONS[mime],
  );
}

/**
 * The thumbnail beside the original, distinguished by suffix rather than by its
 * own prefix so the two objects share a directory and a lifecycle: whatever
 * deletes one has already listed the other.
 */
export function thumbStorageKey(orgId: string, checksum: string): string {
  return assertSafeBlobKey(
    "assets/" + keySegment(orgId) + "/" + hexPrefix(checksum) + "/" + checksum + ".thumb.webp",
  );
}

/** The Content-Type for a key this module generated. */
export function mimeFromKey(key: string): string {
  const dot = key.lastIndexOf(".");
  const ext = dot === -1 ? "" : key.slice(dot).toLowerCase();
  for (const [mime, extension] of Object.entries(EXTENSIONS)) {
    if (extension === ext) return mime;
  }
  return "application/octet-stream";
}

function keySegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`assets: ${JSON.stringify(value)} cannot appear in a storage key`);
  }
  return value;
}

function hexPrefix(checksum: string): string {
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new Error("assets: checksum must be a lowercase hex sha256");
  }
  return checksum.slice(0, 2);
}

/** A short-lived URL a client may use directly. */
export interface PresignedUrl {
  url: string;
  /** Epoch ms after which the signature stops working. */
  expiresAt: number;
  /**
   * Headers the client must send for the signature to verify. Empty for the
   * unsigned-payload requests this module issues -- see `S3BlobBackend`.
   */
  headers: Record<string, string>;
}

export interface PresignOptions {
  /** Seconds the URL stays valid. Backends clamp to their own maximum. */
  expiresIn?: number;
}

/**
 * The bytes half of an asset. Deliberately smaller than an S3 client: three
 * operations, no listing, no metadata, no ACLs. Everything else about an asset is
 * a row in `assets`, so a backend that can put, get and delete an opaque key is a
 * complete implementation -- which is why the disk one is short and a test can use
 * a Map.
 *
 * `presignPut`/`presignGet` are optional because only object storage can offer
 * them. A route must treat their absence as ordinary -- proxy the bytes itself --
 * rather than as a misconfiguration.
 */
export interface BlobBackend {
  /** For logs and the health endpoint: which backend is actually in use. */
  readonly name: string;
  write(key: string, bytes: Uint8Array): Promise<void>;
  /** The bytes, or undefined when the key holds nothing. Missing is not an error. */
  read(key: string): Promise<Uint8Array | undefined>;
  /** True when something was removed, false when the key was already empty. */
  remove(key: string): Promise<boolean>;
  presignPut?(key: string, options?: PresignOptions): Promise<PresignedUrl>;
  presignGet?(key: string, options?: PresignOptions): Promise<PresignedUrl>;
}

/**
 * Bytes in a Map. The default, and what tests use.
 *
 * Both write and read copy. A caller that keeps its upload buffer -- or decodes
 * into what `read` returned -- would otherwise be able to mutate stored content
 * in place, and the bug would appear only under the memory backend, which is to
 * say only in tests, where nobody would think to look for it.
 */
export class InMemoryBlobBackend implements BlobBackend {
  readonly name = "memory";
  private readonly objects = new Map<string, Uint8Array>();

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(assertSafeBlobKey(key), new Uint8Array(bytes));
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    const found = this.objects.get(assertSafeBlobKey(key));
    return found === undefined ? undefined : new Uint8Array(found);
  }

  async remove(key: string): Promise<boolean> {
    return this.objects.delete(assertSafeBlobKey(key));
  }

  /** Object count, for tests that assert an upload did or did not leave bytes. */
  get size(): number {
    return this.objects.size;
  }
}

/**
 * Bytes on the local filesystem. The dev choice once a directory is configured,
 * and correct for a single instance with a persistent volume.
 *
 * Two properties beyond the obvious:
 *
 *   - the key grammar is checked *and* the resolved path is compared against the
 *     root. Either alone would do; both are here because a traversal here is a
 *     read or a write anywhere the process can reach, and the second check also
 *     covers a platform whose separator differs from the one in the key.
 *   - a write lands on a temporary name and is renamed into place. `rename` is
 *     atomic within a filesystem, so a concurrent reader sees either the previous
 *     object or the complete new one, never a half-written file. Writes of the
 *     same content-addressed key race routinely (see `assetStorageKey`), and a
 *     torn read would reach a browser as a corrupt image.
 */
export class DiskBlobBackend implements BlobBackend {
  readonly name = "disk";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const temp = full + "." + randomBytes(6).toString("hex") + ".part";
    try {
      await writeFile(temp, bytes);
      await rename(temp, full);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isMissing(err)) return undefined;
      throw err;
    }
  }

  async remove(key: string): Promise<boolean> {
    try {
      await unlink(this.pathFor(key));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  private pathFor(key: string): string {
    const full = resolve(join(this.root, assertSafeBlobKey(key)));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`assets: blob key ${JSON.stringify(key)} escapes the asset root`);
    }
    return full;
  }
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** SigV4's own ceiling on a presigned URL: seven days. */
export const SIGV4_MAX_EXPIRES = 604_800;

export interface S3BlobConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** From STS or an instance role; travels as `X-Amz-Security-Token`. */
  sessionToken?: string;
  /** Base endpoint. Default `https://s3.<region>.amazonaws.com`. */
  endpoint?: string;
  /** MinIO, Ceph and older clones need the bucket in the path, not the host. */
  forcePathStyle?: boolean;
  /** Default presigned-URL lifetime in seconds. Default 300. */
  expiresIn?: number;
  /** Injected clock, so a signature can be reproduced in a test. */
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * S3 (and anything that speaks it) over presigned URLs and `fetch`, with no AWS
 * SDK dependency.
 *
 * The trick that makes this small: every request this backend makes is itself a
 * presigned URL. Signing a request in headers means canonicalising whatever
 * headers the HTTP stack decides to add; signing it in the query string means the
 * signature covers exactly five parameters and one header we set ourselves, and
 * the same routine then serves `presignGet` for a browser. One code path, one set
 * of bugs, and the part a client sees is the part we exercise on every read.
 *
 * `UNSIGNED-PAYLOAD` is what makes that possible for uploads: the alternative is
 * hashing the body into the signature, which forces the whole object into memory
 * to sign and rules out ever handing a client a PUT URL. The bytes are protected
 * by TLS and by the key being unguessable-until-known; the *content* is verified
 * separately by `validateAssetBytes`, which is the check that actually matters
 * and which no header-signing scheme performs.
 */
export class S3BlobBackend implements BlobBackend {
  readonly name = "s3";
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken: string | undefined;
  private readonly base: URL;
  private readonly pathStyle: boolean;
  private readonly expiresIn: number;
  private readonly clock: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: S3BlobConfig) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
    this.sessionToken = config.sessionToken;
    this.base = new URL(config.endpoint ?? `https://s3.${config.region}.amazonaws.com`);
    this.pathStyle = config.forcePathStyle ?? false;
    this.expiresIn = clampExpiry(config.expiresIn ?? 300);
    this.clock = config.now ?? Date.now;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Host and canonical path for one key. `base.pathname` is preserved as a prefix
   * because an S3-compatible endpoint may live under a path, and dropping it
   * would sign a URL for a resource that is not the one requested.
   *
   * Each key segment is encoded separately: the slashes are structure and must
   * survive, everything else must not. This is the encoding the canonical request
   * and the URL share -- computing them differently is the classic SigV4 bug,
   * where the signature verifies against a path the server never received.
   */
  private target(key: string): { host: string; path: string } {
    const encoded = assertSafeBlobKey(key).split("/").map(rfc3986).join("/");
    const prefix = this.base.pathname.replace(/\/+$/, "");
    if (this.pathStyle) {
      return { host: this.base.host, path: `${prefix}/${rfc3986(this.bucket)}/${encoded}` };
    }
    return { host: `${this.bucket}.${this.base.host}`, path: `${prefix}/${encoded}` };
  }

  /**
   * AWS Signature Version 4, query-string flavour. Deterministic given the clock,
   * which is what lets a test check it against a published AWS vector rather than
   * against itself.
   *
   * `host` is the only signed header, so nothing an HTTP client adds on the way
   * out -- `accept-encoding`, `user-agent`, a proxy's `via` -- can invalidate a
   * signature that was correct when it was made.
   */
  private presign(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    options?: PresignOptions,
  ): PresignedUrl {
    const seconds = clampExpiry(options?.expiresIn ?? this.expiresIn);
    const at = this.clock();
    const amzDate = amzTimestamp(at);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const { host, path } = this.target(key);

    const params: [string, string][] = [
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.accessKeyId}/${scope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(seconds)],
      ["X-Amz-SignedHeaders", "host"],
    ];
    // A temporary credential's token is part of the request, not a header we could
    // add later: it has to be inside the signature or S3 rejects the pair.
    if (this.sessionToken !== undefined) params.push(["X-Amz-Security-Token", this.sessionToken]);
    // Sorted by *encoded* name, because that is the order S3 canonicalises in.
    const canonicalQuery = params
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .sort()
      .join("&");

    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      `host:${host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(Buffer.from(canonicalRequest, "utf8")),
    ].join("\n");
    const key4 = signingKey(this.secretAccessKey, dateStamp, this.region);
    const signature = hmac(key4, stringToSign).toString("hex");
    return {
      url: `${this.base.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: at + seconds * 1000,
      headers: {},
    };
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const signed = this.presign("PUT", key);
    const response = await this.fetchImpl(signed.url, {
      method: "PUT",
      body: bytes,
      // Unsigned, so a mismatch cannot fail the signature. It is stored metadata
      // only, and `mimeFromKey` derives it from the extension this module chose --
      // never from what an uploader claimed.
      headers: { "content-type": mimeFromKey(key) },
    });
    if (!response.ok) throw await s3Error("write", key, response);
    await drain(response);
  }

  /**
   * Absence is a 404 and nothing else. A 403 is deliberately an error: it means a
   * bad key, a bad clock or a policy that does not grant `s3:GetObject` on our own
   * prefix, and reporting any of those as "the object is missing" would send a
   * caller looking for a lost upload instead of a broken deployment.
   */
  async read(key: string): Promise<Uint8Array | undefined> {
    const signed = this.presign("GET", key);
    const response = await this.fetchImpl(signed.url, { method: "GET" });
    if (response.status === 404) {
      await drain(response);
      return undefined;
    }
    if (!response.ok) throw await s3Error("read", key, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * S3 answers 204 whether or not the key existed, so `true` here means "the
   * object is gone", not "it was there". Memory and disk can tell the difference
   * and do; nothing in this module branches on it, which is why the weaker
   * guarantee is acceptable rather than a lie.
   */
  async remove(key: string): Promise<boolean> {
    const signed = this.presign("DELETE", key);
    const response = await this.fetchImpl(signed.url, { method: "DELETE" });
    if (response.status === 404) {
      await drain(response);
      return false;
    }
    if (!response.ok) throw await s3Error("remove", key, response);
    await drain(response);
    return true;
  }

  /**
   * A URL a browser may PUT to directly, for an upload too large to stream through
   * this process.
   *
   * The contract that comes with it: a route handing one out MUST read the object
   * back and put it through `validateAssetBytes` before writing a metadata row.
   * Nothing else validates it -- the signature attests to who asked for the URL,
   * not to what was uploaded -- and an unvalidated object with no row is
   * unreachable, which is the property that makes deferring the check safe.
   */
  async presignPut(key: string, options?: PresignOptions): Promise<PresignedUrl> {
    return this.presign("PUT", key, options);
  }

  async presignGet(key: string, options?: PresignOptions): Promise<PresignedUrl> {
    return this.presign("GET", key, options);
  }
}

/** `20260828T101112Z` -- SigV4's basic-format ISO 8601, no separators. */
function amzTimestamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * The four-step derivation. Its whole point is that the signing key is scoped to
 * one day, one region and one service, so a leaked signature is worth far less
 * than the secret that produced it.
 */
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(Buffer.from("AWS4" + secret, "utf8"), dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function clampExpiry(seconds: number): number {
  if (!Number.isFinite(seconds)) return 300;
  return Math.min(SIGV4_MAX_EXPIRES, Math.max(1, Math.floor(seconds)));
}

/**
 * RFC 3986, which `encodeURIComponent` almost implements: it leaves `!'()*`
 * alone, and S3 percent-encodes them. Signing with one alphabet and requesting
 * with the other is a 403 whose message says nothing about the cause.
 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * S3 explains itself in an XML body, and that text is the difference between
 * "SignatureDoesNotMatch" and "NoSuchBucket". Truncated because it reaches a log.
 */
async function s3Error(action: string, key: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = body.trim().slice(0, 500);
  return new Error(
    `assets: s3 ${action} of ${JSON.stringify(key)} failed with ${response.status}` +
      (detail.length > 0 ? `: ${detail}` : ""),
  );
}

/**
 * An unread body holds its socket out of the connection pool until the GC gets to
 * it, which under undici turns a busy upload path into stalled requests.
 */
async function drain(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}

/**
 * The longest edge of a generated thumbnail. 320 is chosen for the board canvas,
 * where an image node is rendered at a few hundred CSS pixels at default zoom:
 * large enough that the thumbnail is what the canvas shows, small enough that a
 * board full of photographs loads previews instead of originals.
 */
export const THUMBNAIL_MAX_EDGE = 320;

export interface Thumbnail {
  bytes: Uint8Array;
  mime: AssetMime;
  width: number;
  height: number;
}

/**
 * Optional, by construction. Image resizing needs native code -- libvips, or a
 * WASM build of it -- and this product must install and run with neither, so the
 * only honest interface is one whose failure is a documented answer.
 *
 * `thumbnail` therefore returns `undefined` rather than throwing, for *every*
 * reason: no resizer installed, a format it cannot read, a corrupt file, an OOM
 * inside native code. An upload whose bytes validated is a successful upload, and
 * a missing preview is a smaller image on a canvas, not a failed request.
 */
export interface Thumbnailer {
  /** For logs and the health endpoint: whether previews are actually available. */
  readonly name: string;
  thumbnail(bytes: Uint8Array, mime: AssetMime): Promise<Thumbnail | undefined>;
}

/** The default. Every asset gets `thumbKey: null` and the canvas uses originals. */
export class NoThumbnailer implements Thumbnailer {
  readonly name = "none";

  async thumbnail(): Promise<undefined> {
    return undefined;
  }
}

/**
 * The shape this module needs from a resizer, declared structurally rather than
 * imported. `sharp` is not a dependency of this package -- there is no `@types`
 * for it here and `import type` would not compile -- so the contract is written
 * out and the loaded module is narrowed against it at runtime.
 *
 * Anything with this shape works, which is the point: a deployment can install
 * `sharp`, or a WASM-backed drop-in, and set `LUCENT_ASSET_RESIZER` to its name.
 */
interface ResizerPipeline {
  resize(options: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }): ResizerPipeline;
  webp(options: { quality: number }): ResizerPipeline;
  toBuffer(): Promise<Buffer>;
}

type ResizerFactory = (input: Uint8Array) => ResizerPipeline;

/** The optional resizer's default package name. */
export const DEFAULT_RESIZER_MODULE = "sharp";

/**
 * A thumbnailer backed by whatever resizer happens to be installed.
 *
 * The import specifier is a variable on purpose. A literal `import("sharp")`
 * would be a compile error in a package that does not depend on sharp, and
 * bundlers would try to resolve it at build time; a variable is opaque to both and
 * resolved by Node at first use. That is the mechanism that makes an optional
 * native dependency actually optional.
 *
 * The load is attempted once and the outcome cached -- including failure. A
 * missing module throws on every attempt, and retrying it per upload would put a
 * module-resolution walk in the hot path forever.
 */
export class OptionalResizerThumbnailer implements Thumbnailer {
  readonly name: string;
  private readonly specifier: string;
  private loading: Promise<ResizerFactory | undefined> | undefined;

  constructor(specifier: string = DEFAULT_RESIZER_MODULE) {
    this.specifier = specifier;
    this.name = `optional:${specifier}`;
  }

  async thumbnail(bytes: Uint8Array, mime: AssetMime): Promise<Thumbnail | undefined> {
    const resize = await this.factory();
    if (resize === undefined) return undefined;
    try {
      // `fit: "inside"` preserves aspect ratio inside the box, and
      // `withoutEnlargement` means an image already smaller than the box is
      // re-encoded, not blown up: a 40px icon must not become a blurry 320px one.
      const out = await resize(bytes)
        .resize({
          width: THUMBNAIL_MAX_EDGE,
          height: THUMBNAIL_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
      const produced = new Uint8Array(out);
      // Measured with this module's own parser rather than trusted from the
      // resizer's metadata: these are the numbers that land in the `assets` row,
      // and they must describe the bytes we are about to store.
      const size = imageDimensions(produced);
      if (size === undefined) return undefined;
      return { bytes: produced, mime: "image/webp", width: size.width, height: size.height };
    } catch (err) {
      console.warn(`[lucent] thumbnail failed for ${mime}: ${errorText(err)}`);
      return undefined;
    }
  }

  private async factory(): Promise<ResizerFactory | undefined> {
    this.loading ??= loadResizer(this.specifier);
    return this.loading;
  }
}

/**
 * Resolve the resizer, or report that there isn't one.
 *
 * Both module shapes are accepted because sharp is CommonJS: under Node's ESM
 * interop `await import("sharp")` yields a namespace whose `default` is the
 * callable, while an ES-native drop-in may export the callable as the namespace
 * itself. Checking both is two lines; guessing wrong disables previews with no
 * diagnostic.
 */
async function loadResizer(specifier: string): Promise<ResizerFactory | undefined> {
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch {
    // Absence is the expected case, not a fault: nothing installs a native
    // resizer by default, and this is not a warning a normal boot should print.
    return undefined;
  }
  const factory = asResizerFactory(loaded);
  if (factory === undefined) {
    console.warn(`[lucent] ${specifier} loaded but is not a resizer; thumbnails disabled`);
  }
  return factory;
}

function asResizerFactory(loaded: unknown): ResizerFactory | undefined {
  if (typeof loaded === "function") return loaded as ResizerFactory;
  if (typeof loaded === "object" && loaded !== null) {
    const inner = (loaded as { default?: unknown }).default;
    if (typeof inner === "function") return inner as ResizerFactory;
  }
  return undefined;
}

/** A message from an unknown throw, for a log line that has to say something. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface UploadAssetInput {
  orgId: string;
  /** The board it was uploaded on, or null for an org-level asset. */
  boardId: string | null;
  /** Who uploaded it; null for a backfill or another system writer. */
  userId: string | null;
  bytes: Uint8Array;
  /** The client's declared type, if any. Checked against the bytes. */
  mime?: string;
  /** The client's declared checksum, if any. Checked against the bytes. */
  checksum?: string;
}

export interface UploadedAsset {
  ok: true;
  asset: StoredAsset;
  /** What goes in a shape's `src`. The only handle a board ever holds. */
  ref: string;
  /** True when these bytes were already in this org and no new row was written. */
  deduped: boolean;
}

export type UploadResult = UploadedAsset | AssetRejection;

export interface AssetServiceOptions {
  store: AssetStore;
  blobs: BlobBackend;
  /** Defaults to `NoThumbnailer`: previews are an optional extra, never required. */
  thumbnails?: Thumbnailer;
  now?: () => number;
}

/**
 * The two seams joined: validation and bytes on one side, metadata on the other.
 * Everything above this -- an HTTP route, the data-URL backfill -- talks to this
 * class and never orders the writes itself, because the order is the invariant
 * (see the module doc) and it is not one a caller should have to remember.
 */
export class AssetService {
  private readonly store: AssetStore;
  private readonly blobs: BlobBackend;
  private readonly thumbnails: Thumbnailer;
  private readonly clock: () => number;

  constructor(options: AssetServiceOptions) {
    this.store = options.store;
    this.blobs = options.blobs;
    this.thumbnails = options.thumbnails ?? new NoThumbnailer();
    this.clock = options.now ?? Date.now;
  }

  /** Which backends are live, for the health endpoint. */
  describe(): { blobs: string; thumbnails: string } {
    return { blobs: this.blobs.name, thumbnails: this.thumbnails.name };
  }

  /**
   * Validate, store, and return the reference a shape should carry.
   *
   * The dedupe lookup comes before any write, and returns the existing row
   * *without* re-writing the bytes. That is sound only because of the write order:
   * a row exists only after its object did, so a row is proof of bytes. The
   * inverse would not be safe, which is why delete removes the row first -- the
   * failure mode that leaves an unreferenced object costs storage, and the one
   * that leaves a row pointing at nothing costs a broken image on a board.
   */
  async upload(input: UploadAssetInput): Promise<UploadResult> {
    const validated = validateAssetBytes({
      bytes: input.bytes,
      ...(input.mime === undefined ? {} : { mime: input.mime }),
      ...(input.checksum === undefined ? {} : { checksum: input.checksum }),
    });
    if (!validated.ok) return validated;

    const existing = await this.store.byChecksum(input.orgId, validated.checksum);
    if (existing) {
      return { ok: true, asset: existing, ref: formatAssetRef(existing.id), deduped: true };
    }

    const storageKey = assetStorageKey(input.orgId, validated.checksum, validated.mime);
    await this.blobs.write(storageKey, input.bytes);

    // Best effort, and after the original is durable: a thumbnail is a derived
    // convenience, so nothing about it may decide whether the upload succeeded.
    let thumbKey: string | null = null;
    const thumb = await this.thumbnails.thumbnail(input.bytes, validated.mime);
    if (thumb) {
      const key = thumbStorageKey(input.orgId, validated.checksum);
      try {
        await this.blobs.write(key, thumb.bytes);
        thumbKey = key;
      } catch (err) {
        // A storage failure on the preview alone leaves the row's `thumb_key`
        // null, which is the same state as "no resizer installed" -- already a
        // path every reader handles.
        console.warn(`[lucent] thumbnail write failed for ${key}: ${errorText(err)}`);
      }
    }

    const id = newAssetId();
    const asset = await this.store.create({
      id,
      orgId: input.orgId,
      boardId: input.boardId,
      mime: validated.mime,
      bytes: validated.bytes,
      checksum: validated.checksum,
      storageKey,
      thumbKey,
      width: validated.width,
      height: validated.height,
      createdBy: input.userId,
      createdAt: this.clock(),
    });
    // `create` returns the row that won an `(org_id, checksum)` race, which may be
    // another writer's. Both wrote identical content to the same key, so the loser
    // has no orphan to clean up -- it simply reports the dedupe it lost.
    return { ok: true, asset, ref: formatAssetRef(asset.id), deduped: asset.id !== id };
  }

  /**
   * An asset's row, if it belongs to this org. The tenant check is here rather
   * than left to callers because an asset id travels inside a board's `src` and a
   * board can be duplicated, exported or pasted across orgs: the id alone is never
   * authority to read the bytes.
   */
  async lookup(orgId: string, id: string): Promise<StoredAsset | undefined> {
    const asset = await this.store.get(id);
    if (!asset || asset.orgId !== orgId) return undefined;
    return asset;
  }

  /** The row and its bytes, for a route that serves the object itself. */
  async read(
    orgId: string,
    id: string,
  ): Promise<{ asset: StoredAsset; bytes: Uint8Array } | undefined> {
    const asset = await this.lookup(orgId, id);
    if (!asset) return undefined;
    const bytes = await this.blobs.read(asset.storageKey);
    if (bytes === undefined) {
      // The write order makes this impossible in normal operation, so it is a real
      // inconsistency -- a half-finished delete, a restored database against an
      // emptied bucket, a backend swapped underneath -- and it is worth a log line
      // rather than a silent 404.
      console.warn(`[lucent] asset ${id} has no bytes at ${asset.storageKey}`);
      return undefined;
    }
    return { asset, bytes };
  }

  /** The preview, or undefined when this asset has none. Never an error. */
  async thumb(
    orgId: string,
    id: string,
  ): Promise<{ asset: StoredAsset; bytes: Uint8Array } | undefined> {
    const asset = await this.lookup(orgId, id);
    if (!asset || asset.thumbKey === null) return undefined;
    const bytes = await this.blobs.read(asset.thumbKey);
    return bytes === undefined ? undefined : { asset, bytes };
  }

  /**
   * Forget an asset: row first, then bytes. Returns false when there was nothing
   * of this org's to delete.
   *
   * A byte-removal failure is swallowed on purpose. The row is already gone, so
   * the asset is unreachable and the caller's intent is satisfied; re-inserting
   * the row to keep the two in step would resurrect a deleted image because a
   * bucket was briefly unavailable.
   */
  async remove(orgId: string, id: string): Promise<boolean> {
    const asset = await this.lookup(orgId, id);
    if (!asset) return false;
    await this.store.delete(asset.id);
    for (const key of asset.thumbKey === null
      ? [asset.storageKey]
      : [asset.storageKey, asset.thumbKey]) {
      try {
        await this.blobs.remove(key);
      } catch (err) {
        console.warn(`[lucent] orphaned blob ${key} after deleting asset ${id}: ${errorText(err)}`);
      }
    }
    return true;
  }

  /**
   * Resolve a shape's `src`. Returns undefined for a data URL, an http(s) URL, a
   * malformed reference, an unknown id, or an id belonging to another org -- every
   * one of which a renderer treats the same way, as "not an asset of yours".
   */
  async resolveRef(orgId: string, src: string): Promise<StoredAsset | undefined> {
    const id = assetRefId(src);
    if (id === undefined) return undefined;
    return this.lookup(orgId, id);
  }

  /** Bytes this org holds, for the `storage.bytes` entitlement gate. */
  async totalBytes(orgId: string): Promise<number> {
    return this.store.totalBytes(orgId);
  }
}

/**
 * Which byte store a deployment gets, inferred from what it configured.
 *
 * Inference rather than a required flag, because the failure mode of a required
 * flag is a boot that refuses to start over storage nobody asked for. The order
 * says what a deployment meant: a bucket outranks a directory, a directory
 * outranks memory, and `LUCENT_ASSET_BACKEND` overrides all three for the case
 * where credentials are present in the environment but must not be used.
 *
 * Memory is the default and it loses every upload on restart. That is correct for
 * tests and acceptable for a first `npm run dev`; it is why `describe()` exists and
 * why the name reaches the health endpoint.
 */
export function selectBlobBackend(env: NodeJS.ProcessEnv = process.env): BlobBackend {
  const requested = env.LUCENT_ASSET_BACKEND?.trim().toLowerCase();
  const dir = env.LUCENT_ASSET_DIR?.trim();
  const s3 = s3ConfigFromEnv(env);

  if (requested === "memory") return new InMemoryBlobBackend();
  if (requested === "disk" || (requested === undefined && s3 === undefined && dir)) {
    if (!dir) throw new Error("assets: LUCENT_ASSET_BACKEND=disk needs LUCENT_ASSET_DIR");
    return new DiskBlobBackend(dir);
  }
  if (requested === "s3" || (requested === undefined && s3 !== undefined)) {
    if (s3 === undefined) {
      throw new Error(
        "assets: LUCENT_ASSET_BACKEND=s3 needs LUCENT_S3_BUCKET, a region, and credentials",
      );
    }
    return new S3BlobBackend(s3);
  }
  if (requested !== undefined) {
    throw new Error(`assets: unknown LUCENT_ASSET_BACKEND ${JSON.stringify(requested)}`);
  }
  return new InMemoryBlobBackend();
}

/**
 * S3 credentials, or nothing. The `AWS_*` names are accepted alongside ours
 * because that is what every deployment target already injects -- a task role, a
 * CI secret, `aws configure` in a container -- and requiring them to be copied
 * under a second name is a step that gets skipped and then debugged.
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3BlobConfig | undefined {
  const bucket = env.LUCENT_S3_BUCKET?.trim();
  const region = (env.LUCENT_S3_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION)?.trim();
  const accessKeyId = (env.LUCENT_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID)?.trim();
  const secretAccessKey = (env.LUCENT_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY)?.trim();
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = (env.LUCENT_S3_SESSION_TOKEN ?? env.AWS_SESSION_TOKEN)?.trim();
  const endpoint = env.LUCENT_S3_ENDPOINT?.trim();
  const expiresIn = Number(env.LUCENT_S3_EXPIRES_SECONDS ?? "");
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(isTruthyEnv(env.LUCENT_S3_FORCE_PATH_STYLE) ? { forcePathStyle: true } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
  };
}

/**
 * Previews are opt-in: `LUCENT_ASSET_RESIZER` names the module to try, and its
 * absence means no thumbnails rather than an attempted import on every boot.
 */
export function selectThumbnailer(env: NodeJS.ProcessEnv = process.env): Thumbnailer {
  const specifier = env.LUCENT_ASSET_RESIZER?.trim();
  if (!specifier || specifier.toLowerCase() === "none") return new NoThumbnailer();
  return new OptionalResizerThumbnailer(specifier);
}

function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
