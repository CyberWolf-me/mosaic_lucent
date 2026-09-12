/**
 * Ambient declaration for the `?url` import of elkjs's web-worker script
 * (doc 18 Phase 4). Vite's client types cover generic `*?url` imports, but
 * this pins the intent: the ELK adapter loads elkjs's GWT worker script as a
 * servable asset URL and hands it to a real nested Web Worker — elkjs's own
 * intended browser architecture. The in-process "fake worker" from the same
 * file CANNOT be imported inside our layout worker: in a worker scope the
 * UMD's export arm self-installs onto the global `self.onmessage` instead of
 * exporting (see elkLayoutEngine.ts's import comment).
 */

declare module "elkjs/lib/elk-worker.min.js?url" {
  const src: string;
  export default src;
}
