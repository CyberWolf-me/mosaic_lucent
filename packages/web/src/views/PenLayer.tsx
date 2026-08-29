import { useRef, useState } from "react";
import type { Operation } from "@lucent/core";
import { shapeId, Z_OVERLAY_PEN } from "../shapes.js";

/**
 * Freehand pen. Captures pointer strokes in content coordinates and, on release,
 * emits a CREATE_SHAPE {kind:"draw"} with an SVG path so the drawing becomes a
 * real model shape (persists + undo/redo, docs/13). Renders a full-canvas
 * capture surface while the pen tool is active.
 */
export function PenLayer({
  scale,
  stroke = "var(--ink-0)",
  onCommit,
  onDone,
}: {
  scale: number;
  stroke?: string;
  onCommit: (op: Operation) => void;
  onDone?: () => void;
}) {
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const drawing = useRef(false);
  const _originRef = useRef<{ left: number; top: number }>({ left: 0, top: 0 });

  const toContent = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drawing.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPoints([toContent(e)]);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    setPoints((p) => [...p, toContent(e)]);
  };
  const onPointerUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setPoints((pts) => {
      commit(pts);
      return [];
    });
  };

  const commit = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) {
      onDone?.();
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    // Path is stored relative to the shape's origin (minX,minY).
    const d = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x - minX).toFixed(1)} ${(p.y - minY).toFixed(1)}`)
      .join(" ");
    const op: Operation = {
      op: "CREATE_SHAPE",
      id: shapeId(),
      kind: "draw",
      position: { x: minX, y: minY },
      size: { width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
      path: d,
      style: { stroke, strokeWidth: 2 },
      z: 1,
    };
    onCommit(op);
    onDone?.();
  };

  const previewPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <svg
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        cursor: "crosshair",
        touchAction: "none",
        zIndex: Z_OVERLAY_PEN,
      }}
    >
      {points.length > 1 && (
        <path
          d={previewPath}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
