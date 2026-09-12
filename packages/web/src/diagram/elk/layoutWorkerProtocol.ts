/**
 * The worker-protocol types (doc 18 Phase 4), shared by both halves so they
 * can never drift: the worker (layoutWorker.ts) answers requests the proxy
 * (elkWorkerEngine.ts) sends. A third consumer is the protocol test, which
 * drives the handler directly — Node has no `self`, so the handler itself
 * lives in layoutWorkerCore.ts, injectable and pure.
 */

export type LayoutWorkerRequest =
  | { kind: "layout"; id: number; workspace: unknown; options: unknown }
  | {
      kind: "region";
      id: number;
      workspace: unknown;
      groupId: string;
      options: unknown;
    };

export type LayoutWorkerResponse =
  | { kind: "layout-done"; id: number; layout: unknown; routes: unknown }
  | { kind: "region-declined"; id: number }
  | { kind: "layout-error"; id: number; message: string };
