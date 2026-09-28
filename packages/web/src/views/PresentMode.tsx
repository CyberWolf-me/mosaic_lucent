import { useCallback, useEffect, useRef } from "react";
import type { Workspace } from "@lucent/core";
import type { Slide } from "../board/slides.js";
import { toScene } from "../scene.js";
import { Ico } from "../ui/icons.js";
import type { ViewportControls } from "../ui/atoms.js";

/**
 * Presentation mode: a guided walkthrough. With frames on the board it steps
 * through them as slides (docs/26 §6.1), fitting each frame to the screen;
 * without, it steps through the diagram's nodes in layout order, auto-panning
 * to each and spotlighting it. Single-user and backend-free (docs/12); the
 * same camera primitives power Follow and Spotlight (docs/28 S5).
 */
export function PresentMode({
  workspace,
  slides,
  controls,
  step,
  setStep,
  onExit,
  frameLabel,
}: {
  workspace: Workspace;
  /** Frames in slide order; when non-empty they are what's presented. */
  slides?: Slide[];
  controls: React.MutableRefObject<ViewportControls | null>;
  step: number;
  setStep: (updater: (s: number) => number) => void;
  onExit: () => void;
  frameLabel?: string;
}) {
  const bySlide = (slides?.length ?? 0) > 0;
  const { nodes } = toScene(workspace);
  const count = bySlide ? slides!.length : nodes.length; // toScene keeps layout order
  const at = Math.min(step, count - 1);
  const node = bySlide ? undefined : nodes[at];
  const slide = bySlide ? slides![at] : undefined;

  const go = useCallback(
    (dir: 1 | -1) => setStep((s) => Math.max(0, Math.min(count - 1, s + dir))),
    [count, setStep],
  );

  // Pan/zoom to the active node whenever the step changes.
  useEffect(() => {
    if (!node) return;
    controls.current?.focusOn(node.cx, node.cy, 120);
  }, [node, controls]);

  // Fit the active slide's frame to the screen.
  const sx = slide?.box.x;
  const sy = slide?.box.y;
  const sw = slide?.box.width;
  const sh = slide?.box.height;
  useEffect(() => {
    if (sx === undefined || sy === undefined || sw === undefined || sh === undefined) return;
    controls.current?.fitBounds({ x: sx, y: sy, width: sw, height: sh });
  }, [sx, sy, sw, sh, controls]);

  // Keyboard: arrows advance, Esc exits. Subscribed once, reading the latest
  // callbacks from a ref: the canvas's own Escape handler runs first and sets
  // state, React flushes that render between the two listeners, and a
  // listener re-subscribed by that render (onExit is a new function each
  // time) was removed mid-dispatch — so Esc never reached it.
  const keys = useRef({ go, onExit });
  keys.current = { go, onExit };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        keys.current.go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        keys.current.go(-1);
      } else if (e.key === "Escape") keys.current.onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!node && !slide) return null;
  const unit = bySlide ? "Slide" : "Step";

  return (
    <div
      className="present-caption"
      role="region"
      aria-roledescription="presentation"
      aria-label={`Presentation${frameLabel ? `: ${frameLabel}` : ""} — ${unit.toLowerCase()} ${at + 1} of ${count}`}
    >
      <button
        className="present-nav"
        onClick={() => go(-1)}
        disabled={step <= 0}
        title="Previous · ←"
        aria-label="Previous slide"
      >
        <Ico.Down style={{ transform: "rotate(90deg)" }} />
      </button>

      <div className="present-body">
        <div className="present-meta" aria-live="polite" aria-atomic="true">
          {frameLabel ? `${frameLabel} · ` : ""}
          {unit} {at + 1} of {count}
          {node?.meta ? ` · ${node.meta}` : ""}
        </div>
        <div className="present-title">
          {slide ? slide.title || `Slide ${at + 1}` : node!.label}
        </div>
      </div>

      <button
        className="present-nav"
        onClick={() => go(1)}
        disabled={step >= count - 1}
        title="Next · →"
        aria-label="Next slide"
      >
        <Ico.Down style={{ transform: "rotate(-90deg)" }} />
      </button>
      <div className="present-sep" />
      <button
        className="present-nav"
        onClick={onExit}
        title="Exit · Esc"
        aria-label="Exit presentation"
      >
        <Ico.X />
      </button>
    </div>
  );
}
