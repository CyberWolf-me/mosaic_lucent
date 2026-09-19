/**
 * The main-thread half of the ELK worker pair (doc 18 Phase 4): a
 * `DiagramLayoutEngine` whose `layout`/`relayoutRegion` calls are ferried to
 * the worker (layoutWorker.ts) and correlated back by request id.
 *
 * Why a proxy per the ADRs: ADR 0039 made the worker mandatory (main-thread
 * ELK breaches the interactive budget at scale) and ADR 0038 made the
 * Phase 1 boundary the only channel through which an engine is consumed —
 * so the worker is reached exactly the way the benchmark harness reaches ELK:
 * behind `layoutService`'s `engines.primary` seam. No call site ever learns a
 * worker exists.
 *
 * Failure behavior (doc 18 Phase 4 item 3): a worker that cannot spawn, dies,
 * or hangs does NOT fall back to running ELK on the main thread — a frozen
 * UI is worse than a quieter layout. The proxy rejects, and the layout
 * service's own fallback answers with the built-in engine's geometry: the
 * board re-flows deterministically, the user keeps an interactive canvas,
 * and the "degraded" notice fires only if that fallback fails too.
 */

import type {
  DiagramLayoutEngine,
  DiagramLayoutRequest,
  DiagramLayoutResult,
  LayoutOptions,
  Workspace,
} from "@lucent/core";
import type { LayoutWorkerResponse } from "./layoutWorkerProtocol.js";

/**
 * Bounds one worker round-trip. The slowest ELK kind the service ever routes
 * here (dense layered, 500 nodes) measured ~2 s; 20 s covers that with an
 * order of magnitude of margin for a cold worker boot. The 68 s mind-map
 * figure from the Phase 2 comparison never reaches ELK — mindmap is not an
 * ELK kind in the service.
 */
const WORKER_TIMEOUT_MS = 20_000;

type Pending = {
  resolve: (value: DiagramLayoutResult | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkerElkEngine implements DiagramLayoutEngine {
  readonly id = "elk-0.12-worker";

  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Set when worker creation failed; calls reject fast without re-spawning. */
  private workerBroken = false;

  constructor(
    /** Injectable for tests: how this environment creates workers. */
    private readonly spawn: () => Worker | null = defaultSpawn,
  ) {}

  supports(): boolean {
    return true;
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    const worker = this.spawn();
    if (!worker) {
      this.workerBroken = true;
      return null;
    }
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as LayoutWorkerResponse;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.kind === "layout-done") {
        pending.resolve({
          layout: data.layout as DiagramLayoutResult["layout"],
          routes: data.routes as DiagramLayoutResult["routes"],
        });
      } else if (data.kind === "region-declined") {
        pending.resolve(null);
      } else {
        pending.reject(new Error(data.message));
      }
    };
    worker.onerror = () => {
      // The worker died with requests outstanding: fail them now so callers
      // degrade. Future calls re-spawn — a worker that failed once may have
      // died from a transient OOM, and the cost of retrying is one message.
      this.dropWorker();
      this.failAll(new Error("layout worker failed"));
    };
    this.worker = worker;
    return worker;
  }

  /** Forget the current worker (terminating it) without breaking future spawns. */
  private dropWorker(): void {
    try {
      this.worker?.terminate();
    } catch {
      // terminate on an already-dead worker is harmless in every browser;
      // swallowing keeps the recovery path simple.
    }
    this.worker = null;
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  /**
   * One worker round-trip with id correlation and a timeout. Transport-level
   * failure (no worker, worker death, timeout, postMessage throw) REJECTS —
   * the layout service answers with its built-in fallback, which is the
   * degradation this design prefers over a frozen main thread. A `null`
   * RESOLUTION is different: it is the worker's in-band "declined" for a
   * region the adapter does not serve, exactly the sync contract's null.
   */
  private post<T>(envelope: Record<string, unknown>): Promise<T | null> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.reject(new Error("layout worker unavailable"));
    const id = this.nextId++;
    return new Promise<T | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timed out: free the entry and kill the worker so the NEXT call
        // re-spawns instead of re-waiting. Ids are monotonic, so a reply the
        // dead worker still emits can never be mistaken for a later request.
        this.pending.delete(id);
        this.dropWorker();
        reject(new Error("layout worker timed out"));
      }, WORKER_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: DiagramLayoutResult | null) => void,
        reject,
        timer,
      });
      try {
        worker.postMessage({ ...envelope, id });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async layout({ workspace, options }: DiagramLayoutRequest): Promise<DiagramLayoutResult> {
    return this.post<DiagramLayoutResult>({ kind: "layout", workspace, options }).then((out) => {
      if (!out) throw new Error("layout worker declined a board layout");
      return out;
    });
  }

  relayoutRegion(
    workspace: Workspace,
    groupId: string,
    options: LayoutOptions = {},
  ): Promise<DiagramLayoutResult | null> {
    return this.post<DiagramLayoutResult>({ kind: "region", workspace, groupId, options });
  }
}

function defaultSpawn(): Worker | null {
  try {
    // Vite dev + build both resolve this to the worker bundle with ELK in it.
    return new Worker(new URL("./layoutWorker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

/** The production primary engine (ADR 0039): ELK, off the main thread. */
export const WORKER_ELK_ENGINE: DiagramLayoutEngine = new WorkerElkEngine();
