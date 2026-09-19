/**
 * The worker's handler, extracted so a Node test can drive it directly —
 * Node has no `self`, so the posting side is injected. The logic is the
 * single source for both the real worker (layoutWorker.ts) and the test.
 *
 * ADR 0038's clause applied to the transport: the handler owns geometry and
 * nothing else. Requests are self-contained envelopes; responses carry only
 * the correlated result. The adapter (elkLayoutEngine.ts) stays the single
 * implementation of Lucent→ELK mapping — this file ferries envelopes.
 */

import type { ElkLayoutEngine } from "./elkLayoutEngine.js";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./layoutWorkerProtocol.js";

/** The worker-side handler, parameterized on how it posts back. */
export async function handleLayoutRequest(
  engine: ElkLayoutEngine,
  data: LayoutWorkerRequest,
  post: (message: LayoutWorkerResponse) => void,
): Promise<void> {
  try {
    if (data.kind === "layout") {
      const out = await engine.layout({
        workspace: data.workspace as never,
        options: (data.options ?? {}) as never,
      });
      post({ kind: "layout-done", id: data.id, layout: out.layout, routes: out.routes });
    } else {
      const out = await engine.relayoutRegion(
        data.workspace as never,
        data.groupId,
        (data.options ?? {}) as never,
      );
      // `null` means "not my kind of region" — an in-band decline, not an
      // error. The proxy turns it into the same null the sync engine returns.
      if (out) {
        post({ kind: "layout-done", id: data.id, layout: out.layout, routes: out.routes });
      } else {
        post({ kind: "region-declined", id: data.id });
      }
    }
  } catch (err) {
    // The message is all the proxy needs: it degrades, never surfaces raw
    // worker internals to the UI.
    post({
      kind: "layout-error",
      id: data.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
