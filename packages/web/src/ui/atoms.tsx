import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from "react";
import type { DotColor } from "../scene.js";

/**
 * Visual atoms ported from reference/components/atoms.jsx into typed React.
 * CanvasViewport uses local React state for pan/zoom (no window bus) and
 * exposes zoom to a child via render callback.
 */

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function CanvasBackdrop({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--canvas-1)", ...style }}>
      <div className="canvas-grid" />
      <div className="canvas-vignette" />
      {children}
    </div>
  );
}

export type NodeState = "" | "selected" | "emerging" | "proposed" | "ghost";

export function NodeCard({
  x,
  y,
  w,
  h,
  title,
  meta,
  sub,
  dot,
  state = "",
  delay = 0,
  appear = false,
  dimmed = false,
  onClick,
  mark,
  draggable = false,
  scale = 1,
  opacity,
  onMove,
  onRename,
  editRequested = false,
  onEditConsumed,
  statement,
  statementTint,
  bpmnShape,
}: {
  x: number;
  y: number;
  w?: number;
  /** Explicit height so anchors/bounds match what the layout engine reserved. */
  h?: number;
  title: string;
  meta?: string;
  sub?: string;
  dot?: DotColor;
  state?: NodeState;
  delay?: number;
  appear?: boolean;
  dimmed?: boolean;
  onClick?: (additive: boolean) => void;
  /** Recognizable technology glyph + tint, when the label names one. */
  mark?: { tint: string; Glyph: (p: SVGProps<SVGSVGElement>) => JSX.Element } | null;
  /** Enable Miro-style click-drag repositioning. */
  draggable?: boolean;
  /** Viewport zoom factor, so drag distance maps to content space. */
  scale?: number;
  /**
   * Selection-focus grade (P1): 1 for prominent, <1 for subdued. Unlike
   * `dimmed` (the exclusive spotlight of Focus/Present mode), this is a
   * soft, layered recede — the selected node's neighbourhood stays legible.
   */
  opacity?: number;
  onMove?: (x: number, y: number, commit: boolean) => void;
  /** Double-click to relabel the node (emits CHANGE_TEXT via the parent). */
  onRename?: (label: string) => void;
  /** When true, open the rename editor (keyboard Enter path). */
  editRequested?: boolean;
  /** Called once the requested edit has been consumed, so it fires once. */
  onEditConsumed?: () => void;
  /**
   * The node's semantic statement (Stage C2): renders as a kind·status chip
   * under the label. Presentation-only — the tint map and dim rule live in
   * statementUi.ts so they are node-testable.
   */
  statement?: { kind: string; status: string };
  /** The chip's tint, by kind (statementUi.KIND_TINT at the call site). */
  statementTint?: string;
  /**
   * BPMN lens shape (docs/19 V1 core, rendered by Lucent — no external
   * toolkit): event → circle (thin=start, thick=end), gateway → diamond
   * with an X (exclusive) or + (parallel) marker, task → rounded rect.
   * Undefined renders the ordinary card; the LENS decides, never the model.
   */
  bpmnShape?: "event" | "eventEnd" | "gateway" | "gatewayParallel" | "task";
}) {
  const cls = [
    "node",
    state,
    appear ? "appear" : "",
    dimmed ? "dimmed" : "",
    draggable ? "draggable" : "",
    bpmnShape === "task"
      ? "bpmn-task"
      : bpmnShape === "event"
        ? "bpmn-event"
        : bpmnShape === "eventEnd"
          ? "bpmn-event-end"
          : bpmnShape === "gateway"
            ? "bpmn-gateway"
            : bpmnShape === "gatewayParallel"
              ? "bpmn-gateway-parallel"
              : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Drag is tracked on window so the pointer can leave the card mid-move; a
  // gesture under the threshold is treated as a click, not a move.
  const drag = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  // Inline rename, matching double-click-to-edit on shapes.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => {
    setDraft(title);
  }, [title]);

  // Keyboard Enter on the selected node asks the parent to open the editor.
  useEffect(() => {
    if (editRequested && onRename) {
      setEditing(true);
      onEditConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequested]);

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
    else setDraft(title);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (editing) return;
    if (!draggable || !onMove) return;
    // Middle-drag still pans the viewport underneath. Shift is reserved for
    // additive selection on nodes, so it must not fall through to panning.
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    drag.current = { sx: e.clientX, sy: e.clientY, moved: false };

    const move = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = (ev.clientX - d.sx) / scale;
      const dy = (ev.clientY - d.sy) / scale;
      if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.moved = true;
      onMove(x + dx, y + dy, false);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.moved) {
        onMove(x + (ev.clientX - d.sx) / scale, y + (ev.clientY - d.sy) / scale, true);
      } else {
        onClick?.(additive);
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className={cls}
      tabIndex={0}
      role="button"
      aria-label={title}
      onClick={draggable ? undefined : (e) => onClick?.(e.shiftKey || e.metaKey || e.ctrlKey)}
      onMouseDown={onMouseDown}
      onDoubleClick={onRename ? () => setEditing(true) : undefined}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          if (onRename) setEditing(true);
          else onClick?.(false);
        }
      }}
      style={{
        left: x,
        top: y,
        width: w ?? 150,
        // Height must be explicit: the layout engine reserves h and every
        // connector anchor, minimap box, and comment pin is computed from it.
        // Letting content decide the height detached edges from card edges.
        ...(h ? { height: h } : {}),
        ...(opacity !== undefined && opacity !== 1
          ? { opacity, transition: "opacity 160ms ease" }
          : {}),
        animationDelay: state === "emerging" ? `${delay}ms, ${delay + 400}ms` : `${delay}ms`,
      }}
    >
      {(bpmnShape === "gateway" || bpmnShape === "gatewayParallel") && (
        // The BPMN marker: X = exactly one path (exclusive), + = all paths
        // (parallel). Drawn counter-rotated inside the rotated diamond card
        // so it stays upright; the CSS class handles the counter-rotation.
        <span className="node-mark bpmn-gateway-marker" style={{ color: "var(--amber-2)" }}>
          {bpmnShape === "gateway" ? (
            <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden>
              <path d="M2 2 L11 11 M11 2 L2 11" stroke="currentColor" strokeWidth={1.8} fill="none" />
            </svg>
          ) : (
            <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden>
              <path d="M6.5 1.5 V11.5 M1.5 6.5 H11.5" stroke="currentColor" strokeWidth={1.8} fill="none" />
            </svg>
          )}
        </span>
      )}
      {meta && (
        <div className="node-meta">
          {mark ? (
            <span className="node-mark" style={{ color: mark.tint }}>
              <mark.Glyph width={12} height={12} />
            </span>
          ) : (
            dot && <span className={`node-dot ${dot}`} />
          )}
          {meta}
        </div>
      )}
      {editing ? (
        <input
          className="node-title-input"
          autoFocus
          aria-label="Node label"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="node-title">{title}</div>
      )}
      {sub && <div className="node-sub">{sub}</div>}
      {statement && (
        <div
          className="node-statement-chip"
          style={{
            marginTop: 6,
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 9.5,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 999,
            border: `1px solid ${statementTint ?? "var(--stroke-2)"}`,
            color: statementTint ?? "var(--ink-2)",
            // A closed lifecycle reads settled — the chip recedes rather
            // than shouting (statementUi.statementChipDim is the rule; the
            // status is all the caller needs here).
            opacity: statement.status === "open" ? 1 : 0.75,
          }}
        >
          <span aria-hidden>✦</span>
          {statement.kind} · {statement.status}
        </div>
      )}
    </div>
  );
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Cubic-bezier path between two anchor points. `dir` 'h' = horizontal-first.
 * `spread` fans parallel edges apart: 0 is the centre line, ±n bows the curve
 * so two relationships between the same pair are both readable.
 *
 * With `route` bend points (the layout's corridor for a long edge), the path
 * is the routed polyline instead: anchor → each waypoint → anchor, with
 * small rounded joins so the bends read as drawn corners rather than a
 * sawtooth. `pathLength` normalisation downstream still applies (dash
 * animations measure the whole polyline).
 */
export function makePath(a: Point, b: Point, dir: "h" | "v" = "h", spread = 0, route: Point[] = []): string {
  if (route.length > 0) {
    const pts = [a, ...route, b];
    let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
    }
    return d;
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dir === "h") {
    const mid = a.x + dx * 0.55;
    return `M ${a.x} ${a.y} C ${mid} ${a.y + spread}, ${mid} ${b.y + spread}, ${b.x} ${b.y}`;
  }
  if (dir === "v") {
    const mid = a.y + dy * 0.55;
    return `M ${a.x} ${a.y} C ${a.x + spread} ${mid}, ${b.x + spread} ${mid}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

export function ConnectorDefs() {
  return (
    <defs>
      <marker
        id="arr"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0 0 L10 5 L0 10 z" fill="var(--stroke-3)" />
      </marker>
      <marker
        id="arr-amber"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="7"
        markerHeight="7"
        orient="auto"
      >
        <path d="M0 0 L10 5 L0 10 z" fill="var(--amber-2)" />
      </marker>
    </defs>
  );
}

/** Anchor a point on a node box side. */
export function anchor(
  node: { cx: number; cy: number; w: number; h: number },
  side: "l" | "r" | "t" | "b",
): Point {
  const left = node.cx - node.w / 2;
  const top = node.cy - node.h / 2;
  if (side === "r") return { x: left + node.w, y: node.cy };
  if (side === "l") return { x: left, y: node.cy };
  if (side === "t") return { x: node.cx, y: top };
  return { x: node.cx, y: top + node.h };
}

/**
 * Pan/zoom viewport. Wheel+ctrl (pinch) zooms, plain wheel pans, hand tool or
 * shift/middle-drag pans. Zoom is reported through onZoom so a ZoomBadge can
 * display it; setControls hands imperative zoom controls back to the parent.
 */
/**
 * Chrome that floats over the canvas. Any "fit"/"center" calculation must keep
 * content inside this safe area, or a freshly-loaded board lands underneath the
 * toolbars and reads as broken.
 */
export const CHROME_INSET = {
  left: 84, // left shape toolbar
  right: 84, // right rail
  top: 130, // top bar + mode bar
  bottom: 160, // AI pill + zoom/status badges
} as const;

export interface ViewportControls {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  getZoom: () => number;
  /**
   * Center the viewport on a point in content coordinates (the same space node
   * positions live in), optionally setting zoom. This is the shared primitive
   * behind Presentation mode and, later, remote Follow/Spotlight modes
   * (docs/12).
   */
  focusOn: (cx: number, cy: number, zoomPercent?: number) => void;
  /**
   * Fit a content-space bounding box into the visible area, honoring chrome
   * insets (top bar, side toolbars, bottom pill) so nothing lands hidden.
   */
  fitBounds: (box: { x: number; y: number; width: number; height: number }) => void;
  /**
   * The region currently visible, in content coordinates. Lets the minimap draw
   * a "you are here" rectangle instead of only showing what exists.
   */
  visibleBox: () => { x: number; y: number; width: number; height: number } | null;
}

export function CanvasViewport({
  children,
  initialZoom = 85,
  tool = "select",
  onZoom,
  onViewport,
  setControls,
}: {
  children: ReactNode;
  initialZoom?: number;
  tool?: "select" | "hand";
  onZoom?: (z: number) => void;
  /**
   * Reports the visible content-space region whenever pan or zoom changes.
   * Reading it off the imperative controls during render doesn't work: the
   * controls ref is populated in an effect, so the first render always saw null.
   */
  onViewport?: (box: { x: number; y: number; width: number; height: number }) => void;
  setControls?: (c: ViewportControls) => void;
}) {
  const [zoom, setZoom] = useState(initialZoom);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef({ dragging: false, startX: 0, startY: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onZoom?.(zoom);
  }, [zoom, onZoom]);

  // Push the visible region out on every pan/zoom so the minimap can track it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onViewport) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const s = zoom / 100;
    const ox = 0.5 * w;
    const oy = 0.4 * h;
    const toContent = (sx: number, sy: number) => ({
      x: (sx - pan.x - ox) / s + ox,
      y: (sy - pan.y - oy) / s + oy,
    });
    const tl = toContent(CHROME_INSET.left, CHROME_INSET.top);
    const br = toContent(w - CHROME_INSET.right, h - CHROME_INSET.bottom);
    onViewport({ x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y });
  }, [zoom, pan, onViewport]);

  useEffect(() => {
    setControls?.({
      zoomIn: () => setZoom((z) => clamp(z * 1.2, 25, 400)),
      zoomOut: () => setZoom((z) => clamp(z / 1.2, 25, 400)),
      reset: () => {
        setZoom(100);
        setPan({ x: 0, y: 0 });
      },
      getZoom: () => zoom,
      focusOn: (cx, cy, zoomPercent) => {
        const el = containerRef.current;
        if (!el) return;
        const { width: w, height: h } = el.getBoundingClientRect();
        const nextZoom = clamp(zoomPercent ?? zoom, 25, 400);
        const s = nextZoom / 100;
        // Match the inner transform: origin at (0.5w, 0.4h), so solve for the
        // pan that maps content point (cx,cy) to the viewport center.
        const ox = 0.5 * w;
        const oy = 0.4 * h;
        setZoom(nextZoom);
        setPan({
          x: w / 2 - ox - s * (cx - ox),
          y: h / 2 - oy - s * (cy - oy),
        });
      },
      fitBounds: (box) => {
        const el = containerRef.current;
        if (!el) return;
        const { width: w, height: h } = el.getBoundingClientRect();
        const availW = Math.max(120, w - CHROME_INSET.left - CHROME_INSET.right);
        const availH = Math.max(120, h - CHROME_INSET.top - CHROME_INSET.bottom);
        const pad = 1.1; // a little breathing room around content
        const fit = Math.min(availW / (box.width * pad), availH / (box.height * pad));
        const nextZoom = clamp(fit * 100, 25, 200);
        const s = nextZoom / 100;
        const ox = 0.5 * w;
        const oy = 0.4 * h;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Target screen center shifted to account for asymmetric insets.
        const targetX = CHROME_INSET.left + availW / 2;
        const targetY = CHROME_INSET.top + availH / 2;
        setZoom(nextZoom);
        setPan({
          x: targetX - ox - s * (cx - ox),
          y: targetY - oy - s * (cy - oy),
        });
      },
      visibleBox: () => {
        const el = containerRef.current;
        if (!el) return null;
        const { width: w, height: h } = el.getBoundingClientRect();
        const s = zoom / 100;
        const ox = 0.5 * w;
        const oy = 0.4 * h;
        // Invert the render transform: screen = pan + origin + s*(content-origin).
        const toContent = (sx: number, sy: number) => ({
          x: (sx - pan.x - ox) / s + ox,
          y: (sy - pan.y - oy) / s + oy,
        });
        const tl = toContent(CHROME_INSET.left, CHROME_INSET.top);
        const br = toContent(w - CHROME_INSET.right, h - CHROME_INSET.bottom);
        return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
      },
    });
  }, [zoom, pan, setControls]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.006);
      setZoom((z) => clamp(z * factor, 25, 400));
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (!(e.button === 1 || tool === "hand" || e.shiftKey)) return;
    drag.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d.dragging) return;
    setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
  };
  const onMouseUp = () => {
    drag.current.dragging = false;
  };

  const cursor = tool === "hand" ? "grab" : "default";

  return (
    <div
      ref={containerRef}
      // Focusable so keyboard users can enter the canvas and then Tab through
      // its objects (the window-level handler in CanvasView does the cycling).
      tabIndex={0}
      role="application"
      aria-label="Canvas — press Tab to move between objects, Enter to edit, arrow keys to nudge"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{ position: "absolute", inset: 0, overflow: "hidden", cursor, touchAction: "none" }}
    >
      <CanvasBackdrop />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
          transformOrigin: "50% 40%",
          transition: drag.current.dragging ? "none" : "transform 0.35s var(--e-out)",
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
