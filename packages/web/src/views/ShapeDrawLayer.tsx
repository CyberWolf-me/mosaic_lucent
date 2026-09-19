import { useEffect, useRef, useState } from "react";
import type { Operation } from "@lucent/core";
import { createShapeOp, Z_OVERLAY_DRAW } from "../shapes.js";
import type { DropKind } from "../shapes.js";

const DEFAULT_SIZES: Record<DropKind, { width: number; height: number }> = {
  rect: { width: 150, height: 72 },
  ellipse: { width: 150, height: 90 },
  diamond: { width: 110, height: 110 },
  triangle: { width: 120, height: 100 },
  star: { width: 110, height: 110 },
  sticky: { width: 160, height: 120 },
  text: { width: 180, height: 32 },
  frame: { width: 320, height: 220 },
};

/**
 * Draw-to-place surface. When a shape tool is armed:
 * - A single click drops the shape centered at the click position.
 * - Click-drag sizes the shape interactively with a live preview.
 * - Pressing Escape cancels the tool and returns to Select mode.
 */
export function ShapeDrawLayer({
  kind,
  scale,
  onCreate,
  onDone,
}: {
  kind: DropKind;
  scale: number;
  onCreate: (op: Extract<Operation, { op: "CREATE_SHAPE" }>) => void;
  onDone: () => void;
}) {
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const active = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const toContent = (e: React.PointerEvent) => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return { x: e.clientX / scale, y: e.clientY / scale };
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    active.current = true;
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore capture error */
    }
    const p = toContent(e);
    setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!active.current || !rect) return;
    e.stopPropagation();
    e.preventDefault();
    const p = toContent(e);
    setRect((r) => (r ? { ...r, x1: p.x, y1: p.y } : r));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!active.current || !rect) {
      active.current = false;
      return;
    }
    e.stopPropagation();
    active.current = false;
    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore release error */
    }
    const w = Math.abs(rect.x1 - rect.x0);
    const h = Math.abs(rect.y1 - rect.y0);
    const drawn = w > 8 && h > 8;

    let op: Extract<Operation, { op: "CREATE_SHAPE" }>;
    if (drawn) {
      const x = Math.min(rect.x0, rect.x1);
      const y = Math.min(rect.y0, rect.y1);
      op = createShapeOp(kind, Math.round(x), Math.round(y), {
        width: Math.round(w),
        height: Math.round(h),
      });
    } else {
      // Single click: place centered at click position
      const def = DEFAULT_SIZES[kind] ?? { width: 160, height: 120 };
      const centerX = Math.round(rect.x0 - def.width / 2);
      const centerY = Math.round(rect.y0 - def.height / 2);
      op = createShapeOp(kind, centerX, centerY, def);
    }

    onCreate(op);
    setRect(null);
    onDone();
  };

  const box = rect
    ? {
        left: Math.min(rect.x0, rect.x1),
        top: Math.min(rect.y0, rect.y1),
        width: Math.abs(rect.x1 - rect.x0),
        height: Math.abs(rect.y1 - rect.y0),
      }
    : null;

  const rounded = kind === "ellipse";
  const isDiamond = kind === "diamond";
  const clip =
    kind === "triangle"
      ? "polygon(50% 0%, 100% 100%, 0% 100%)"
      : kind === "star"
        ? "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)"
        : undefined;

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: Z_OVERLAY_DRAW,
        cursor: "crosshair",
        touchAction: "none",
        pointerEvents: "all",
        background: "transparent",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -50000,
          top: -50000,
          width: 100000,
          height: 100000,
          pointerEvents: "all",
          background: "transparent",
        }}
      />
      {box && box.width > 2 && box.height > 2 && (
        <div
          style={{
            position: "absolute",
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: clip ? "none" : "1.5px solid var(--amber-2)",
            background: clip ? "oklch(0.82 0.15 75 / 0.35)" : "oklch(0.82 0.15 75 / 0.10)",
            borderRadius: rounded ? "50%" : isDiamond ? 0 : 8,
            transform: isDiamond ? "rotate(45deg)" : undefined,
            clipPath: clip,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
