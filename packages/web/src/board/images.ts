/**
 * Image ingestion for the workspace (M0.5).
 *
 * Pasted or dragged images land on the board as data URLs, and at full 12 MP
 * resolution each one is several megabytes. localStorage has a 5–10 MB budget
 * per origin, so a few screenshots would silently break autosave. M3 moves
 * images to object storage; in the meantime, this helper downscales the image
 * to a sensible canvas size (1600 px on the long edge) and re-encodes as JPEG
 * at ~1.5 MB so the workspace stays well under quota.
 *
 * Browser-only — uses canvas + URL.createObjectURL. Server-side codepaths
 * shouldn't need this.
 */

const MAX_LONG_EDGE = 1_600;
/** Target bytes for the JPEG output. ~1.5 MB keeps three screenshots under quota. */
const TARGET_BYTES = 1_500_000;

export interface DownscaledImage {
  /** data:image/jpeg;base64,… ready to drop into a CREATE_SHAPE op. */
  dataUrl: string;
  width: number;
  height: number;
  /** Final encoded byte count. Useful for telemetry and a "size" badge. */
  bytes: number;
}

/**
 * Read a File or Blob and return a JPEG data URL scaled to fit. `quality`
 * starts at 0.85 and steps down until the encoded bytes are under the budget
 * or the JPEG floor is reached. Returns null if the source can't be decoded.
 */
export async function downscaleImage(
  source: Blob,
  opts: { maxLongEdge?: number; targetBytes?: number } = {},
): Promise<DownscaledImage | null> {
  const maxLongEdge = opts.maxLongEdge ?? MAX_LONG_EDGE;
  const targetBytes = opts.targetBytes ?? TARGET_BYTES;
  const bitmap = await blobToImageBitmap(source).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, maxLongEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : (() => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          return c;
        })();
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // Quality steps: 0.85 is visually indistinguishable from the source for
  // most photos; we drop to 0.7 only if 0.85 overshoots the budget.
  const steps = [0.85, 0.75, 0.65, 0.55, 0.45];
  let blob: Blob | null = null;
  let url = "";
  for (const q of steps) {
    blob = await canvasToBlob(canvas, "image/jpeg", q);
    if (blob && blob.size <= targetBytes) break;
  }
  if (!blob) return null;
  url = await blobToDataUrl(blob);
  return { dataUrl: url, width: w, height: h, bytes: blob.size };
}

async function blobToImageBitmap(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  // Safari < 15 fallback: decode via <img>. Slower but still correct.
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = url;
    });
    return img as unknown as ImageBitmap;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), type, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
