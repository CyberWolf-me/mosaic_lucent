import { assetRefId, isAssetRef } from "@lucent/core";
import { downscaleImage } from "./board/images.js";
import { apiFetch, getCsrfToken } from "./http.js";

/**
 * The asset upload client (docs/26 §6.4, M3's missing half).
 *
 * The server has stored images since M3 (`POST /api/assets`, an `asset:ast_…`
 * reference in the shape's `src`), but the canvas never uploaded: every pasted
 * or dropped image rode the op log as a ~1.5 MB data URL, replayed to every
 * peer and stored in every snapshot. On a shared board an image now uploads
 * once and the op carries a 20-byte reference. A local board has no server to
 * hold the bytes, so it keeps the data URL — and so does a shared board whose
 * upload fails (offline, quota): the image still lands, just the old way.
 */

export interface PlacedImage {
  src: string;
  width: number;
  height: number;
  /** True when the bytes went to the asset store. */
  uploaded: boolean;
}

/** The URL an `<img>` loads a reference from — same-origin, so the session cookie rides along. */
export function assetUrl(ref: string): string | undefined {
  const id = assetRefId(ref);
  return id === undefined ? undefined : `/api/assets/${id}`;
}

/**
 * Decode a data URL to a Blob of its declared type, in-process.
 *
 * This used to be `fetch(dataUrl)`. The production CSP's `connect-src 'self'
 * https: wss:` has no `data:`, so that fetch was refused in production — and
 * the caller's catch swallowed it, so every generated or pasted image quietly
 * stayed inline in the op log. Decoding here needs no network permission, so
 * the CSP stays as tight as it is. Throws on a malformed URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(0, comma);
  if (!meta.startsWith("data:") || comma === -1) throw new Error("not a data URL");
  const params = meta.slice(5).split(";");
  const type = params[0] || "text/plain";
  const payload = dataUrl.slice(comma + 1);
  if (params.includes("base64")) {
    const bin = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }
  return new Blob([decodeURIComponent(payload)], { type });
}

/** True for an inline SVG, which the asset store refuses by design (script-capable markup). */
function isSvgDataUrl(src: string): boolean {
  return /^data:image\/svg\+xml[;,]/i.test(src);
}

// An upload that fails leaves the image inline — it still lands — but that
// fallback used to be silent, which is how a CSP refusal went unnoticed in
// production. Each distinct reason is logged once, not on every image.
const warned = new Set<string>();
function warnInline(reason: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  console.warn(
    `Lucent: an image stayed inline in the board instead of uploading (${reason}). ` +
      "It still works, but it travels in the op log. Later failures for the same reason aren't logged.",
  );
}

/** Upload image bytes for a board; the reference, or null on any failure. */
export async function uploadAsset(blob: Blob, boardId: string): Promise<string | null> {
  try {
    // A Blob body can't be replayed after a CSRF refusal, so hold a token first.
    await getCsrfToken();
    const res = await apiFetch("/api/assets", {
      method: "POST",
      body: blob,
      headers: {
        "content-type": blob.type || "application/octet-stream",
        ...(blob.type ? { "x-lucent-asset-mime": blob.type } : {}),
        "x-lucent-board-id": boardId,
      },
    });
    if (!res.ok) {
      warnInline(`upload refused: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { ref?: unknown };
    if (typeof body.ref === "string" && isAssetRef(body.ref)) return body.ref;
    warnInline("the server answered without a valid asset reference");
    return null;
  } catch (err) {
    warnInline(`upload failed: ${(err as Error).message || "network error"}`);
    return null;
  }
}

/**
 * Turn a picked, pasted or dropped image into a shape's `src`: downscaled as
 * always (M0.5), then uploaded when the board is shared. Null when the file
 * isn't a readable image.
 */
export async function placeImage(file: Blob, boardId: string | null): Promise<PlacedImage | null> {
  const scaled = await downscaleImage(file);
  if (!scaled) return null;
  if (boardId) {
    const ref = await uploadDataUrl(scaled.dataUrl, boardId);
    if (ref) return { src: ref, width: scaled.width, height: scaled.height, uploaded: true };
  }
  return { src: scaled.dataUrl, width: scaled.width, height: scaled.height, uploaded: false };
}

/** Decode and upload a data URL; null (with the reason logged) when either step fails. */
async function uploadDataUrl(dataUrl: string, boardId: string): Promise<string | null> {
  let blob: Blob;
  try {
    blob = dataUrlToBlob(dataUrl);
  } catch (err) {
    warnInline(`the image couldn't be decoded: ${(err as Error).message}`);
    return null;
  }
  return uploadAsset(blob, boardId);
}

/**
 * Move an already-generated image (the data URL the AI image provider returns)
 * into the asset store, so a ~2.6 MB PNG doesn't ride the op log — replayed to
 * every peer and kept in every snapshot — the way generated images used to.
 *
 * Returns an `asset:` reference on success, or the original `src` unchanged: on
 * a local board (no server to hold the bytes), when the upload fails (offline,
 * quota), or when it isn't a data URL to begin with. Raw SVG data URLs (the
 * offline mock) stay inline without an attempt: the asset store refuses SVG
 * by design, so posting one was a guaranteed refusal on every generation.
 * Unlike `placeImage` this does NOT downscale: a generated image is already
 * sized for the canvas.
 */
export async function uploadGeneratedImage(
  src: string,
  boardId: string | null,
): Promise<string> {
  if (!boardId || !src.startsWith("data:") || isSvgDataUrl(src)) return src;
  return (await uploadDataUrl(src, boardId)) ?? src;
}

// ---- export: a static file can't fetch, so referenced bytes are inlined ----

const dataCache = new Map<string, string>();

/** Base64 in 32 KB slices: String.fromCharCode over a whole image overflows the stack. */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The inlined bytes of a reference, if `preloadAssetData` fetched them. */
export function peekAssetData(ref: string | undefined): string | undefined {
  return ref ? dataCache.get(ref) : undefined;
}

/** Fetch referenced images as data URLs so an export (SVG/PNG/PDF) is self-contained. */
export async function preloadAssetData(refs: Iterable<string>): Promise<void> {
  const todo = [...new Set(refs)].filter((r) => isAssetRef(r) && !dataCache.has(r));
  await Promise.all(
    todo.map(async (ref) => {
      try {
        const res = await apiFetch(assetUrl(ref)!);
        if (!res.ok) return;
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) return;
        dataCache.set(
          ref,
          `data:${blob.type};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`,
        );
      } catch {
        // The export shows its "Linked image" placeholder instead.
      }
    }),
  );
}
