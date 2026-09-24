/// <reference lib="webworker" />
import { traceToSvg, type TraceInput, type TracePreset } from "./traceCore.js";

/** Tracing blocks for hundreds of milliseconds on a real image — never on the UI thread. */
self.onmessage = (e: MessageEvent<{ id: number; input: TraceInput; preset: TracePreset }>) => {
  const { id, input, preset } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, svg: traceToSvg(input, preset) });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
