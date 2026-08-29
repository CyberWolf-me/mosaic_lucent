import { useRef, useState } from "react";
import type { Operation } from "@lucent/core";
import { createShapeOp, Z_OVERLAY_DRAW } from "../shapes.js";
import type { DropKind } from "../shapes.js";

/**
 * Draw-to-place surface. When a shape tool is armed, the user click-drags to set
 * the shape's position AND size (docs/14) instead of it auto-dropping. A plain
 * click (no drag) creates the shape at its default size. Live preview follows
 * the cursor. Coordinates are content-space so it works at any zoom/pan.
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

  const toContent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    active.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toContent(e);
    setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!active.current || !rect) return;
    const p = toContent(e);
    setRect((r) => (r ? { ...r, x1: p.x, y1: p.y } : r));
  };
  const onPointerUp = () => {
    if (!active.current || !rect) {
      active.current = false;
      return;
    }
    active.current = false;
    const x = Math.min(rect.x0, rect.x1);
    const y = Math.min(rect.y0, rect.y1);
    const w = Math.abs(rect.x1 - rect.x0);
    const h = Math.abs(rect.y1 - rect.y0);
    // Tiny drag == a click: use the default size for that kind.
    const drawn = w > 6 && h > 6;
    const op = drawn
      ? createShapeOp(kind, Math.round(x), Math.round(y), {
          width: Math.round(w),
          height: Math.round(h),
        })
      : createShapeOp(kind, Math.round(x), Math.round(y));
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
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: Z_OVERLAY_DRAW,
        cursor: "crosshair",
        touchAction: "none",
      }}
    >
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
