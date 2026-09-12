import { useCallback, useEffect } from "react";
import type { Workspace } from "@lucent/core";
import { toScene } from "../scene.js";
import { Ico } from "../ui/icons.js";
import type { ViewportControls } from "../ui/atoms.js";

/**
 * Presentation mode: a guided walkthrough of the current diagram. Steps through
 * nodes in layout order, auto-panning the viewport to each and spotlighting it.
 * Single-user and backend-free (docs/12); the same focusOn primitive powers
 * remote Follow/Spotlight once collaboration exists.
 */
export function PresentMode({
  workspace,
  controls,
  step,
  setStep,
  onExit,
  frameLabel,
}: {
  workspace: Workspace;
  controls: React.MutableRefObject<ViewportControls | null>;
  step: number;
  setStep: (updater: (s: number) => number) => void;
  onExit: () => void;
  frameLabel?: string;
}) {
  const { nodes } = toScene(workspace);
  const ordered = nodes; // toScene preserves layout/insertion order
  const count = ordered.length;
  const current = ordered[Math.min(step, count - 1)];

  const go = useCallback(
    (dir: 1 | -1) => setStep((s) => Math.max(0, Math.min(count - 1, s + dir))),
    [count, setStep],
  );

  // Pan/zoom to the active node whenever the step changes.
  useEffect(() => {
    if (!current) return;
    controls.current?.focusOn(current.cx, current.cy, 120);
  }, [current, controls]);

  // Keyboard: arrows advance, Esc exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Escape") onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onExit]);

  if (!current) return null;

  return (
    <div
      className="present-caption"
      role="region"
      aria-roledescription="presentation"
      aria-label={`Presentation${frameLabel ? `: ${frameLabel}` : ""} — step ${step + 1} of ${count}`}
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
          {frameLabel ? `${frameLabel} · ` : ""}Step {step + 1} of {count}
          {current.meta ? ` · ${current.meta}` : ""}
        </div>
        <div className="present-title">{current.label}</div>
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
