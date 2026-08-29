import { useRef, useState } from "react";
import type { Node, Shape } from "@lucent/core";

/**
 * Marquee drag-select. A transparent capture surface (below shapes via z-index)
 * that, on empty-canvas drag, draws a selection rectangle and selects every
 * shape *and node* whose box intersects it (docs/13 Tier 2). Coordinates are in
 * content space so it works at any zoom/pan.
 */
export function MarqueeLayer({
  scale,
  shapes,
  nodes = [],
  onSelect,
}: {
  scale: number;
  shapes: Shape[];
  /** Semantic nodes, so a marquee can grab diagram nodes like FigJam/Miro. */
  nodes?: Node[];
  onSelect: (ids: { shapes: Set<string>; nodes: Set<string> }) => void;
}) {
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const active = useRef(false);

  const toContent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Only start a marquee on a direct hit of this backdrop (empty canvas).
    if (e.target !== e.currentTarget) return;
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
    const minX = Math.min(rect.x0, rect.x1);
    const maxX = Math.max(rect.x0, rect.x1);
    const minY = Math.min(rect.y0, rect.y1);
    const maxY = Math.max(rect.y0, rect.y1);
    // Ignore tiny (click) marquees; let clicks fall through to deselect.
    if (maxX - minX < 5 && maxY - minY < 5) {
      onSelect({ shapes: new Set(), nodes: new Set() });
      setRect(null);
      return;
    }
    const hitShapes = new Set<string>();
    for (const s of shapes) {
      const sx = s.position.x;
      const sy = s.position.y;
      const sr = sx + s.size.width;
      const sb = sy + s.size.height;
      if (sx < maxX && sr > minX && sy < maxY && sb > minY) hitShapes.add(s.id);
    }
    const hitNodes = new Set<string>();
    for (const n of nodes) {
      if (!n.position) continue;
      const nx = n.position.x;
      const ny = n.position.y;
      const nr = nx + (n.size?.width ?? 160);
      const nb = ny + (n.size?.height ?? 64);
      if (nx < maxX && nr > minX && ny < maxY && nb > minY) hitNodes.add(n.id);
    }
    onSelect({ shapes: hitShapes, nodes: hitNodes });
    setRect(null);
  };

  const box = rect
    ? {
        left: Math.min(rect.x0, rect.x1),
        top: Math.min(rect.y0, rect.y1),
        width: Math.abs(rect.x1 - rect.x0),
        height: Math.abs(rect.y1 - rect.y0),
      }
    : null;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ position: "absolute", inset: 0, zIndex: 1 }}
    >
      {box && (
        <div
          style={{
            position: "absolute",
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: "1px solid var(--amber-2)",
            background: "oklch(0.82 0.15 75 / 0.08)",
            borderRadius: 2,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
