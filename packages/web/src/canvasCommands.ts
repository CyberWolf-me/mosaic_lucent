import type { Workspace } from "@lucent/core";

/**
 * Canvas commands from outside the canvas (docs/26 §6.4): the ⌘K palette
 * lives in the app shell, while fitting, zooming to a frame and the camera
 * history live in CanvasView. A window event carries the command — the same
 * pattern as the palette's own open event — and a pending slot holds one that
 * arrives before the canvas has mounted (the palette switches to the canvas
 * view and sends the command in the same click).
 */

export type CanvasCommand =
  | { kind: "fit" }
  | { kind: "fitSelection" }
  | { kind: "frame"; id: string }
  | { kind: "back" }
  | { kind: "forward" };

export const CANVAS_COMMAND_EVENT = "lucent:canvas-command";

let listeners = 0;
let pending: CanvasCommand | null = null;

export function sendCanvasCommand(cmd: CanvasCommand): void {
  if (listeners > 0) window.dispatchEvent(new CustomEvent(CANVAS_COMMAND_EVENT, { detail: cmd }));
  else pending = cmd;
}

/** Subscribe (the canvas does, once mounted); a command sent before then runs now. */
export function onCanvasCommand(run: (cmd: CanvasCommand) => void): () => void {
  const handler = (e: Event) => run((e as CustomEvent<CanvasCommand>).detail);
  window.addEventListener(CANVAS_COMMAND_EVENT, handler);
  listeners++;
  if (pending) {
    const cmd = pending;
    pending = null;
    // After the mount's own first fit, so the command's jump isn't overwritten.
    window.setTimeout(() => run(cmd), 0);
  }
  return () => {
    window.removeEventListener(CANVAS_COMMAND_EVENT, handler);
    listeners--;
  };
}

/** A board's frames, titled, in reading order: the palette's "Go to frame" list. */
export function frameEntries(ws: Workspace): Array<{ id: string; title: string }> {
  return Object.values(ws.shapes)
    .filter((s) => s.kind === "frame" && !s.hidden)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map((s, i) => ({ id: s.id, title: s.text?.trim() || `Frame ${i + 1}` }));
}
