import { useEffect, useRef, useState } from "react";
import type { Operation } from "@lucent/core";
import { shapeId, Z_OVERLAY_PEN } from "../shapes.js";

const PEN_COLORS = [
  { label: "Ink", value: "var(--ink-0, #111)" },
  { label: "Blue", value: "oklch(0.62 0.18 250)" },
  { label: "Red", value: "oklch(0.62 0.22 25)" },
  { label: "Green", value: "oklch(0.65 0.18 145)" },
  { label: "Amber", value: "oklch(0.75 0.18 75)" },
  { label: "Purple", value: "oklch(0.62 0.22 300)" },
];

const PEN_WIDTHS = [
  { label: "Fine", value: 1.5 },
  { label: "Medium", value: 2.5 },
  { label: "Bold", value: 4.5 },
];

/**
 * Freehand pen. Captures pointer strokes in content coordinates and, on release,
 * emits a CREATE_SHAPE {kind:"draw"} with an SVG path so the drawing becomes a
 * real model shape (persists + undo/redo, docs/13).
 *
 * Keeps pen active across multiple strokes until user clicks Done or presses Esc.
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
  const [penColor, setPenColor] = useState(stroke);
  const [penWidth, setPenWidth] = useState(2.5);
  const drawing = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const toContent = (e: React.PointerEvent) => {
    const target = svgRef.current;
    if (!target) return { x: e.clientX / scale, y: e.clientY / scale };
    const rect = target.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    drawing.current = true;
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {}
    const pt = toContent(e);
    setPoints([pt]);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.stopPropagation();
    e.preventDefault();
    const pt = toContent(e);
    setPoints((p) => [...p, pt]);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    e.stopPropagation();
    drawing.current = false;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {}
    setPoints((pts) => {
      commit(pts);
      return [];
    });
  };

  const commit = (pts: { x: number; y: number }[]) => {
    if (pts.length === 0) return;
    // Single tap/dot becomes a small visible stroke
    const effectivePts =
      pts.length === 1
        ? [
            { x: pts[0]!.x, y: pts[0]!.y },
            { x: pts[0]!.x + 1.5, y: pts[0]!.y + 1.5 },
          ]
        : pts;

    const xs = effectivePts.map((p) => p.x);
    const ys = effectivePts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    // Smooth path string
    const d = effectivePts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${(p.x - minX).toFixed(1)} ${(p.y - minY).toFixed(1)}`)
      .join(" ");

    const op: Operation = {
      op: "CREATE_SHAPE",
      id: shapeId(),
      kind: "draw",
      position: { x: minX, y: minY },
      size: { width: Math.max(3, maxX - minX), height: Math.max(3, maxY - minY) },
      path: d,
      style: { stroke: penColor, strokeWidth: penWidth },
      z: 1,
    };
    onCommit(op);
  };

  const previewPath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <>
      <svg
        ref={svgRef}
        className="pen-layer"
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
          pointerEvents: "all",
          background: "transparent",
        }}
      >
        <rect
          x={-50000}
          y={-50000}
          width={100000}
          height={100000}
          fill="transparent"
          pointerEvents="all"
        />
        {points.length > 1 && (
          <path
            d={previewPath}
            fill="none"
            stroke={penColor}
            strokeWidth={penWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            pointerEvents="none"
          />
        )}
      </svg>

      {/* Floating Pen HUD: color, thickness, and explicit exit */}
      <div
        className="pen-hud"
        style={{
          position: "fixed",
          top: 72,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: Z_OVERLAY_PEN + 5,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 14px",
          background: "oklch(from var(--canvas-2) l c h / 0.95)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderRadius: 999,
          border: "1px solid var(--stroke-1)",
          boxShadow: "var(--elev-3)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 13 }}>✏️</span>
          <span className="mono small" style={{ color: "var(--ink-1)", fontWeight: 600 }}>
            Pen
          </span>
        </div>
        <div style={{ width: 1, height: 16, background: "var(--stroke-2)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {PEN_COLORS.map((c) => (
            <button
              key={c.label}
              title={c.label}
              onClick={() => setPenColor(c.value)}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: c.value,
                border: penColor === c.value ? "2px solid var(--amber-2, #f59e0b)" : "1px solid var(--stroke-2)",
                boxShadow: penColor === c.value ? "0 0 0 2px var(--canvas-0)" : "none",
                transform: penColor === c.value ? "scale(1.15)" : "scale(1)",
                cursor: "pointer",
                padding: 0,
                transition: "transform 0.15s ease",
              }}
            />
          ))}
        </div>
        <div style={{ width: 1, height: 16, background: "var(--stroke-2)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          {PEN_WIDTHS.map((w) => (
            <button
              key={w.label}
              title={w.label}
              onClick={() => setPenWidth(w.value)}
              style={{
                padding: "2px 8px",
                borderRadius: 6,
                fontSize: 11,
                background: penWidth === w.value ? "var(--canvas-3)" : "transparent",
                color: penWidth === w.value ? "var(--ink-0)" : "var(--ink-3)",
                fontWeight: penWidth === w.value ? 600 : 400,
                border: "none",
                cursor: "pointer",
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div style={{ width: 1, height: 16, background: "var(--stroke-2)" }} />
        <button
          className="btn primary"
          style={{ height: 26, padding: "0 10px", fontSize: 11, borderRadius: 999 }}
          onClick={() => onDone?.()}
          title="Done drawing (Esc)"
        >
          ✓ Done
        </button>
      </div>
    </>
  );
}
