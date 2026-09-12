/**
 * The ELK layout worker entry (doc 18 Phase 4; ADR 0039: "the worker
 * requirement is real, not conditional" — ELK costs 0.87–2 s at 500 nodes on
 * the main thread, far outside the interactive budget). Runs the ELK adapter
 * off the main thread so layout never freezes the canvas, selection, or the
 * streaming pill. The handler logic lives in layoutWorkerCore.ts (shared
 * with its test); this file is only the worker-global wiring.
 *
 * `self` is cast rather than declaring the webworker lib: this file lives in
 * the same tsc project as the DOM-side app, and a `/// <reference
 * lib="webworker" />` here would merge worker globals into EVERY file's
 * compilation.
 */

import { ElkLayoutEngine } from "./elkLayoutEngine.js";
import { handleLayoutRequest } from "./layoutWorkerCore.js";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./layoutWorkerProtocol.js";

/** The worker-side global, without pulling the webworker lib into the build. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<LayoutWorkerRequest>) => void) | null;
  postMessage(message: LayoutWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
const engine = new ElkLayoutEngine();

scope.onmessage = (event) => {
  void handleLayoutRequest(engine, event.data, (message) => scope.postMessage(message));
};
