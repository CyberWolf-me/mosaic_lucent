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

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
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
    if (!res.ok) return null;
    const body = (await res.json()) as { ref?: unknown };
    return typeof body.ref === "string" && isAssetRef(body.ref) ? body.ref : null;
  } catch {
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
    const ref = await uploadAsset(await dataUrlToBlob(scaled.dataUrl), boardId);
    if (ref) return { src: ref, width: scaled.width, height: scaled.height, uploaded: true };
  }
  return { src: scaled.dataUrl, width: scaled.width, height: scaled.height, uploaded: false };
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
