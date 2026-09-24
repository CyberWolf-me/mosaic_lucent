import { importSvg, type VectorData } from "@lucent/core";
import type { TracePreset } from "./traceCore.js";

/**
 * Trace an image shape's picture into an editable vector, in a worker.
 * The picture is read through a canvas, so it must be same-origin (a pasted
 * image, a stored asset); a picture hot-linked from another site can't be
 * read by the page at all, and says so.
 */

/** Long side the tracer sees: detail beyond this only multiplies paths. */
const TRACE_EDGE = 512;

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: { svg?: string; error?: string }) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./trace.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; svg?: string; error?: string }>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  return worker;
}

async function pixelsOf(
  url: string,
): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const k = Math.min(1, TRACE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read images for tracing.");
  ctx.drawImage(img, 0, 0, w, h);
  try {
    const { data } = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data };
  } catch {
    throw new Error(
      "That image is hosted on another site, so it can't be traced. Paste or upload it instead.",
    );
  }
}

export async function traceImage(
  url: string,
  preset: TracePreset,
): Promise<{ ok: true; vector: VectorData } | { ok: false; error: string }> {
  try {
    const input = await pixelsOf(url);
    const id = ++seq;
    const result = await new Promise<{ svg?: string; error?: string }>((resolve) => {
      waiting.set(id, resolve);
      getWorker().postMessage({ id, input, preset }, [input.data.buffer]);
    });
    if (!result.svg) return { ok: false, error: result.error ?? "Tracing failed." };
    const imported = importSvg(result.svg, { generator: "trace" });
    if (!imported.ok) {
      return {
        ok: false,
        error: /too detailed/.test(imported.error)
          ? "That image traces into too many parts. Try the Logo setting, or crop it first."
          : imported.error,
      };
    }
    return { ok: true, vector: imported.vector };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Tracing failed." };
  }
}
