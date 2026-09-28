import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * A panel the person can move (the tool palette): drag its grip, or focus the
 * grip and use the arrow keys; double-click or Home puts it back. Where it was
 * put is remembered in this browser only — a per-viewer convenience, so
 * localStorage, and the panel still renders in its home spot when storage is
 * blocked or empty.
 */

export interface Point {
  x: number;
  y: number;
}

/** Nearest a moved panel may come to the window's edge. */
export const EDGE = 8;

/** Keep a box of `size` inside the viewport, EDGE px from every side (top-left wins when it can't fit). */
export function clampToViewport(
  p: Point,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): Point {
  const maxX = Math.max(EDGE, viewport.width - size.width - EDGE);
  const maxY = Math.max(EDGE, viewport.height - size.height - EDGE);
  return {
    x: Math.round(Math.min(maxX, Math.max(EDGE, p.x))),
    y: Math.round(Math.min(maxY, Math.max(EDGE, p.y))),
  };
}

export function loadPosition(key: string): Point | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Point>;
    return typeof p.x === "number" &&
      typeof p.y === "number" &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y)
      ? { x: p.x, y: p.y }
      : null;
  } catch {
    return null;
  }
}

export function savePosition(key: string, p: Point | null): void {
  try {
    if (p) localStorage.setItem(key, JSON.stringify({ x: p.x, y: p.y }));
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked: the panel just forgets */
  }
}

/** Arrow keys move a focused grip this far; with Shift, further. */
const STEP = 10;
const BIG_STEP = 50;

export function useFloatingPanel(ref: RefObject<HTMLElement | null>, storageKey: string) {
  const [pos, setPos] = useState<Point | null>(() => loadPosition(storageKey));
  const [dragging, setDragging] = useState(false);
  const grab = useRef<{ dx: number; dy: number } | null>(null);

  const fit = useCallback(
    (p: Point): Point => {
      const el = ref.current;
      if (!el) return p;
      const r = el.getBoundingClientRect();
      return clampToViewport(p, r, { width: window.innerWidth, height: window.innerHeight });
    },
    [ref],
  );

  // A remembered spot can be off a smaller window, and a window can shrink:
  // keep the panel on screen (without rewriting where it was put).
  const floating = pos !== null;
  useEffect(() => {
    if (!floating) return;
    const refit = () =>
      setPos((p) => {
        if (!p) return p;
        const next = fit(p);
        return next.x === p.x && next.y === p.y ? p : next;
      });
    refit();
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, [floating, fit]);

  const moveTo = (p: Point | null, remember: boolean) => {
    const next = p ? fit(p) : null;
    setPos(next);
    if (remember) savePosition(storageKey, next);
  };

  const gripProps = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !ref.current) return;
      e.preventDefault();
      e.stopPropagation();
      const r = ref.current.getBoundingClientRect();
      grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!grab.current) return;
      moveTo({ x: e.clientX - grab.current.dx, y: e.clientY - grab.current.dy }, false);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (!grab.current) return;
      grab.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
      const el = ref.current;
      if (el) {
        const r = el.getBoundingClientRect();
        savePosition(storageKey, { x: Math.round(r.left), y: Math.round(r.top) });
      }
    },
    onPointerCancel: () => {
      grab.current = null;
      setDragging(false);
    },
    onDoubleClick: () => moveTo(null, true),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Home") {
        e.preventDefault();
        moveTo(null, true);
        return;
      }
      const step = e.shiftKey ? BIG_STEP : STEP;
      const d =
        e.key === "ArrowLeft"
          ? { x: -step, y: 0 }
          : e.key === "ArrowRight"
            ? { x: step, y: 0 }
            : e.key === "ArrowUp"
              ? { x: 0, y: -step }
              : e.key === "ArrowDown"
                ? { x: 0, y: step }
                : null;
      if (!d) return;
      // The canvas's own arrow keys (nudge a selection) must not fire too.
      e.preventDefault();
      e.stopPropagation();
      const r = el.getBoundingClientRect();
      moveTo({ x: r.left + d.x, y: r.top + d.y }, true);
    },
  };

  const style: React.CSSProperties | undefined = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto", transform: "none" }
    : undefined;

  return { pos, dragging, style, gripProps };
}
