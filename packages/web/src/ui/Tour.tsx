import { useCallback, useEffect, useState } from "react";
import { Ico } from "./icons.js";

/**
 * The first-run tour (G1: "interactive tour; empty states" — the
 * real-diagram-in-under-a-minute story).
 *
 * Three steps, one message each: say what you want, watch it appear, keep
 * talking to refine. It mounts over the empty canvas (the hero prompt),
 * because that is the screen the first minute is spent on — a tour that
 * starts on a dashboard tours the wrong product.
 *
 * Shown once per browser (`localStorage`), dismissible at every step (Esc,
 * the scrim, or Skip), and the flag is written the moment the tour finishes
 * or is dismissed — a refresh mid-tour does not force the whole thing again,
 * which is the acceptable failure of not persisting step position.
 *
 * The steps are content-only: no spotlight rectangle around a live element
 * (fragile against layout churn, hostile to the e2e suite) — each step
 * names its target in the copy instead.
 */

const SEEN_KEY = "lucent.tour.seen.v1";

/** The steps. The order is the product's one promise, unpacked. */
const STEPS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Describe it",
    body: 'Type or speak what you\'re building — "an e-commerce flow with Stripe checkout" is plenty. No shapes, no menus.',
  },
  {
    title: "Watch it appear",
    body: "Lucent builds the diagram: nodes, connections, layout — all editable, all structured. Every change is undoable.",
  },
  {
    title: "Keep talking",
    body: '"Add authentication before checkout." The board updates in place. You\'ll never need a shape palette.',
  },
];

/** Test seam: read the seen-flag without a DOM (vitest runs node). */
export function tourSeen(store: { getItem(k: string): string | null } | null): boolean {
  if (!store) return true; // no storage = do not tour; silent is safer than noisy
  try {
    return store.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

/** Test seam + the reset a future "replay tour" settings entry would call. */
export function markTourSeen(store: Pick<Storage, "setItem"> | null): void {
  try {
    store?.setItem(SEEN_KEY, "1");
  } catch {
    // Private browsing / quota: the tour simply may show again. Harmless.
  }
}

export function Tour({ onDone }: { onDone?: () => void }): React.ReactElement | null {
  const [visible, setVisible] = useState(
    () =>
      // tourSeen answers "has the browser seen it?"; the tour shows when it
      // has NOT, so invert. `visible` can only go false from here (finish),
      // which is also what keeps the hooks order stable below.
      !tourSeen(typeof localStorage === "undefined" ? null : localStorage),
  );
  const [step, setStep] = useState(0);

  const finish = useCallback((): void => {
    markTourSeen(typeof localStorage === "undefined" ? null : localStorage);
    setVisible(false);
    onDone?.();
  }, [onDone]);

  const next = useCallback((): void => {
    setStep((s) => {
      if (s + 1 >= STEPS.length) {
        // finish() is called via effect below to avoid setState-in-callback
        // inside another setState updater.
        return s;
      }
      return s + 1;
    });
    if (step + 1 >= STEPS.length) finish();
  }, [step, finish]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, finish, next]);

  if (!visible) return null;
  const s = STEPS[step]!;

  return (
    <>
      <div className="tour-scrim" onClick={finish} aria-hidden="true" />
      <div role="dialog" aria-modal="false" aria-label={`Tour: ${s.title}`} className="tour-card">
        <div className="mono tour-step-indicator">
          {step + 1} / {STEPS.length}
        </div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-actions">
          <button className="btn" onClick={finish}>
            Skip
          </button>
          <div style={{ flex: 1 }} />
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="btn amber" onClick={next} autoFocus>
            {step + 1 >= STEPS.length ? "Start building" : "Next"} <Ico.Arrow />
          </button>
        </div>
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={i === step ? "dot on" : "dot"} />
          ))}
        </div>
      </div>
    </>
  );
}
