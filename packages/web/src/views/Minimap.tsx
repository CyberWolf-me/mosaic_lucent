import type { Workspace } from "@lucent/core";
import { contentBounds } from "../board/geometry.js";
import { Ico } from "../ui/icons.js";

/**
 * Board overview: a scaled-down map of all nodes + shapes in the corner, for
 * orienting on large boards (docs/14 §17). Clicking or dragging inside it pans
 * the real viewport, and the current viewport is drawn as a rectangle so the map
 * shows *where you are*, not just what exists.
 *
 * It carries an explicit "Overview" label because unlabelled it reads as a
 * mysterious duplicate of the board.
 */
export function Minimap({
  workspace,
  onClose,
  viewport,
  onNavigate,
}: {
  workspace: Workspace;
  onClose?: () => void;
  /** Visible region in content coordinates, when the canvas can report it. */
  viewport?: { x: number; y: number; width: number; height: number } | null;
  /** Centre the real viewport on this content-space point. */
  onNavigate?: (cx: number, cy: number) => void;
}) {
  const bounds = contentBounds(workspace);
  if (!bounds || bounds.width === 0 || bounds.height === 0) return null;

  const W = 168;
  const H = 116;
  const pad = 20;
  // Include the viewport in the mapped extent so the rectangle stays visible
  // even when the camera is parked away from the content.
  const extent = viewport
    ? {
        x: Math.min(bounds.x, viewport.x),
        y: Math.min(bounds.y, viewport.y),
        width:
          Math.max(bounds.x + bounds.width, viewport.x + viewport.width) -
          Math.min(bounds.x, viewport.x),
        height:
          Math.max(bounds.y + bounds.height, viewport.y + viewport.height) -
          Math.min(bounds.y, viewport.y),
      }
    : bounds;
  const scale = Math.min((W - pad) / extent.width, (H - pad) / extent.height);
  const ox = (W - extent.width * scale) / 2;
  const oy = (H - extent.height * scale) / 2;
  const tx = (x: number) => ox + (x - extent.x) * scale;
  const ty = (y: number) => oy + (y - extent.y) * scale;
  /** Map a point inside the SVG back to content coordinates. */
  const toContent = (px: number, py: number) => ({
    x: extent.x + (px - ox) / scale,
    y: extent.y + (py - oy) / scale,
  });

  const nodeRects = Object.values(workspace.nodes).filter((n) => n.position && n.size);
  const shapeRects = Object.values(workspace.shapes);

  const navigateFromEvent = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onNavigate) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = toContent(e.clientX - r.left, e.clientY - r.top);
    onNavigate(p.x, p.y);
  };

  return (
    <div className="minimap">
      <div className="minimap-head">
        <span className="mono">Overview</span>
        {onClose && (
          <button onClick={onClose} title="Hide overview" aria-label="Hide overview">
            <Ico.X />
          </button>
        )}
      </div>
      {/* The map is a pointer-only convenience: it exposes a labelled image
          role rather than hiding from the accessibility tree, but dragging it
          is still pointer-only. Keyboard navigation of the canvas is provided
          elsewhere — Fit (Shift+1), zoom to selection (Shift+2), and
          Ctrl +/-/0 — so no capability is lost by not operating the map
          from the keyboard. */}
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={`Board overview: ${nodeRects.length} nodes, ${shapeRects.length} shapes${viewport ? "; viewport rectangle shown" : ""}`}
        style={onNavigate ? { cursor: "pointer", pointerEvents: "auto" } : undefined}
        onPointerDown={(e) => {
          if (!onNavigate) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          navigateFromEvent(e);
        }}
        onPointerMove={(e) => {
          // Only track while the button is held (drag to scrub the viewport).
          if (e.buttons === 1) navigateFromEvent(e);
        }}
      >
        {nodeRects.map((n) => (
          <rect
            key={n.id}
            x={tx(n.position!.x)}
            y={ty(n.position!.y)}
            width={Math.max(4, n.size!.width * scale)}
            height={Math.max(4, n.size!.height * scale)}
            rx={1.5}
            fill="var(--ink-2)"
            opacity={0.7}
          />
        ))}
        {shapeRects.map((s) => (
          <rect
            key={s.id}
            x={tx(s.position.x)}
            y={ty(s.position.y)}
            width={Math.max(4, s.size.width * scale)}
            height={Math.max(4, s.size.height * scale)}
            rx={s.kind === "ellipse" ? 4 : 1.5}
            fill={s.kind === "frame" ? "none" : "var(--amber-2)"}
            stroke={s.kind === "frame" ? "var(--stroke-3)" : "none"}
            strokeDasharray={s.kind === "frame" ? "3 2" : undefined}
            opacity={0.8}
          />
        ))}
        {viewport && (
          <rect
            x={tx(viewport.x)}
            y={ty(viewport.y)}
            width={Math.max(4, viewport.width * scale)}
            height={Math.max(4, viewport.height * scale)}
            fill="oklch(0.86 0.14 78 / 0.10)"
            stroke="var(--amber-1)"
            strokeWidth={1}
            rx={2}
          />
        )}
        {/* Region counts (UX-4): past this many nodes the 4px rects merge into
            a wash, so say so instead of pretending each rect is readable. */}
        {nodeRects.length > 150 && (
          <text x={8} y={H - 8} fontSize={9} fill="var(--ink-3)" fontFamily="var(--font-mono)">
            {nodeRects.length} nodes — zoom in for detail
          </text>
        )}
      </svg>
    </div>
  );
}
