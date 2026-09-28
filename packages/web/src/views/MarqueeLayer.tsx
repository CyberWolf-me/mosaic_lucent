import { useRef, useState } from "react";
import type { Node, Shape } from "@lucent/core";
import { lassoHits } from "../board/geometry.js";
import { Z_MARQUEE } from "../shapes.js";

/**
 * Marquee drag-select. A transparent capture surface (below shapes via z-index)
 * that, on empty-canvas drag, draws a selection rectangle and selects every
 * shape *and node* whose box intersects it (docs/13 Tier 2). Coordinates are in
 * content space so it works at any zoom/pan.
 *
 * Hold Alt (Option) as the drag starts and it's a lasso instead (docs/26 §6.4):
 * a free path, taking everything whose centre falls inside it — for picking
 * items out of a crowd a rectangle would sweep up.
 */
/**
 * How far the capture surface reaches past the board's origin, in board
 * units. It used to be the viewport-sized box the pan/zoom layer starts as,
 * so once the board was panned, empty canvas outside that box went to the
 * backdrop and no marquee (or lasso) could start there.
 */
const REACH = 50_000;

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
  const [lasso, setLasso] = useState<Array<{ x: number; y: number }> | null>(null);
  // The path itself lives in a ref: moves can arrive faster than renders, and
  // each must add to the latest path, not to the one the last render saw.
  const lassoPath = useRef<Array<{ x: number; y: number }> | null>(null);
  const active = useRef(false);

  const toContent = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale - REACH, y: (e.clientY - r.top) / scale - REACH };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Only start a marquee on a direct hit of this backdrop (empty canvas).
    if (e.target !== e.currentTarget) return;
    active.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toContent(e);
    if (e.altKey) {
      lassoPath.current = [p];
      setLasso([p]);
      return;
    }
    setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!active.current) return;
    const p = toContent(e);
    const path = lassoPath.current;
    if (path) {
      // A point every few screen pixels is plenty for a hand-drawn path.
      const last = path[path.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) * scale >= 4) {
        path.push(p);
        setLasso([...path]);
      }
      return;
    }
    if (!rect) return;
    setRect((r) => (r ? { ...r, x1: p.x, y1: p.y } : r));
  };
  const nodeBox = (n: Node) => ({
    id: n.id,
    x: n.position!.x,
    y: n.position!.y,
    width: n.size?.width ?? 160,
    height: n.size?.height ?? 64,
  });
  const onPointerUp = () => {
    if (!active.current) return;
    active.current = false;
    if (lassoPath.current) {
      const path = lassoPath.current;
      lassoPath.current = null;
      setLasso(null);
      if (path.length < 3) {
        onSelect({ shapes: new Set(), nodes: new Set() });
        return;
      }
      onSelect({
        shapes: lassoHits(
          path,
          shapes.map((s) => ({ id: s.id, ...s.position, ...s.size })),
        ),
        nodes: lassoHits(path, nodes.filter((n) => n.position).map(nodeBox)),
      });
      return;
    }
    if (!rect) return;
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
      const b = nodeBox(n);
      if (b.x < maxX && b.x + b.width > minX && b.y < maxY && b.y + b.height > minY) {
        hitNodes.add(n.id);
      }
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
      className="marquee-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: "absolute",
        left: -REACH,
        top: -REACH,
        width: REACH * 2,
        height: REACH * 2,
        zIndex: Z_MARQUEE,
      }}
    >
      {box && (
        <div
          style={{
            position: "absolute",
            left: box.left + REACH,
            top: box.top + REACH,
            width: box.width,
            height: box.height,
            border: "1px solid var(--amber-2)",
            background: "oklch(0.82 0.15 75 / 0.08)",
            borderRadius: 2,
            pointerEvents: "none",
          }}
        />
      )}
      {lasso && lasso.length > 1 && (
        <svg
          className="lasso-path"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            overflow: "visible",
            pointerEvents: "none",
          }}
          aria-hidden
        >
          <polygon
            points={lasso.map((p) => `${p.x + REACH},${p.y + REACH}`).join(" ")}
            fill="oklch(0.82 0.15 75 / 0.08)"
            stroke="var(--amber-2)"
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
          />
        </svg>
      )}
    </div>
  );
}
