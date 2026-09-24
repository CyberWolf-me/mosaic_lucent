import {
  useCallback,
  useEffect,
  useRef,
  useState,
  memo,
  type CSSProperties,
  type ReactNode,
} from "react";
import { routedVertices, type StatementFields } from "@lucent/core";
import type { DotColor } from "../scene.js";
import { KIND_LABEL, KIND_TINT, statusLabel } from "../statementUi.js";
import { StatementGlyph } from "./StatementGlyph.js";
import { NodeIcon } from "../icons/Icon.js";
import {
  DRAG_HYSTERESIS_PX,
  VelocityTracker,
  ZOOM_MAX,
  ZOOM_MIN,
  approach,
  projectMomentum,
  softClampZoom,
} from "../board/geometry.js";

/**
 * Visual atoms ported from reference/components/atoms.jsx into typed React.
 * CanvasViewport uses local React state for pan/zoom (no window bus) and
 * exposes zoom to a child via render callback.
 */

/** "2026-09-26" → "Sep 26" (the year only when it isn't this year). */
export function formatDue(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * True when fluid motion is allowed: the OS doesn't ask for reduced motion
 * AND the in-app Motion setting isn't "reduced". When false, every gesture
 * lands immediately — no glide, no smoothing (skill §14).
 */
export function viewportMotionOK(): boolean {
  if (typeof window === "undefined") return false;
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return false;
  }
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced") {
    return false;
  }
  return true;
}

/**
 * Advisory haptic tick (skill §13: causality + utility). Call only on the
 * causal user gesture (snap commit, toggle flip) — never on remote/AI
 * updates — and never when the user asked for reduced motion. No-ops where
 * the Vibration API is absent. Haptics are advisory: failures are swallowed.
 */
export function emitHaptic(pattern: number | number[] = 8): void {
  try {
    if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    navigator.vibrate(pattern);
  } catch {
    // Advisory only.
  }
}

export function CanvasBackdrop({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--paper-1)", ...style }}>
      <div className="paper-bg" />
      <div className="paper-grid" />
      <div className="paper-grain" />
      {children}
    </div>
  );
}

export type NodeState = "" | "selected" | "emerging" | "proposed" | "ghost";

export interface NodeCardProps {
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
  /** The node's chosen registry icon ("simple:postgresql"), if any (docs/26 §6.2). */
  icon?: string | undefined;
  /** The icon its label earns (icons/auto.ts): shown when none was chosen. */
  autoIcon?: string | null | undefined;
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
  /** Action statements: who owns it (issue assignee) and when it is due. */
  statementOwner?: string;
  statementDue?: string;
  /** The statement came out of a meeting — the card says so (✦). */
  fromMeeting?: boolean;
  /**
   * BPMN lens shape (docs/19 V1 core, rendered by Lucent — no external
   * toolkit): event → circle (thin=start, thick=end), gateway → diamond
   * with an X (exclusive) or + (parallel) marker, task → rounded rect.
   * Undefined renders the ordinary card; the LENS decides, never the model.
   */
  bpmnShape?: "event" | "eventEnd" | "gateway" | "gatewayParallel" | "task";
}

export const NodeCard = memo(function NodeCard({
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
  icon,
  autoIcon,
  draggable = false,
  scale = 1,
  opacity,
  onMove,
  onRename,
  editRequested = false,
  onEditConsumed,
  statement,
  statementTint,
  statementOwner,
  statementDue,
  fromMeeting = false,
  bpmnShape,
}: NodeCardProps) {
  const drag = useRef<{ sx: number; sy: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  // A node that carries a statement renders as a statement card: the kind
  // is the headline, not a chip under the label. The BPMN lens keeps its
  // own shapes, so only ordinary cards take the statement treatment.
  const stmt = statement && !bpmnShape ? (statement as StatementFields) : null;
  const cls = [
    "node",
    stmt ? `stmt stmt-${stmt.kind} is-${stmt.status}` : "",
    state,
    appear ? "appear" : "",
    dimmed ? "dimmed" : "",
    draggable ? "draggable" : "",
    dragging ? "dragging" : "",
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

  // Drag uses Pointer Events with capture (skill §2: direct manipulation), so
  // tracking continues when the pointer leaves the card — touch and pen
  // included, which the old window mousemove/mouseup pair never saw. A gesture
  // under the hysteresis threshold is a click, not a move. Release is a hard
  // stop on purpose: node placement is precision work (Figma/Miro parity), so
  // unlike viewport pans there is no momentum projection here.
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

  const commitDrag = (clientX: number, clientY: number) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (d.moved) {
      onMove?.(x + (clientX - d.sx) / scale, y + (clientY - d.sy) / scale, true);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    if (!draggable || !onMove) return;
    // Middle-drag still pans the viewport underneath. Shift is reserved for
    // additive selection on nodes, so it must not fall through to panning.
    if (e.button !== 0) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Figma/Miro standard: select immediately on pointerdown unless additive or already selected (to allow multi-node drag)
    if (!additive && state !== "selected") {
      onClick?.(false);
    }
    drag.current = { sx: e.clientX, sy: e.clientY, moved: false };
    // Capture keeps the move/up stream glued to the card even when the
    // pointer leaves its bounds (skill §2: respect the grab, track 1:1).
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort (already-released pointers throw); the
      // handlers below still fire for in-bounds movement.
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !onMove) return;
    // Hysteresis in screen px: a tap that jitters a few pixels stays a click.
    if (!d.moved && Math.abs(e.clientX - d.sx) < DRAG_HYSTERESIS_PX && Math.abs(e.clientY - d.sy) < DRAG_HYSTERESIS_PX) {
      return;
    }
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    onMove(x + (e.clientX - d.sx) / scale, y + (e.clientY - d.sy) / scale, false);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    commitDrag(e.clientX, e.clientY);
    if (d && !d.moved && (additive || state === "selected")) {
      onClick?.(additive);
    }
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    // The system took the gesture (scroll takeover, alert, …): keep the last
    // live position rather than snapping back to the pre-drag one.
    commitDrag(e.clientX, e.clientY);
  };

  return (
    <div
      className={cls}
      tabIndex={0}
      role="button"
      aria-label={title}
      onClick={draggable ? undefined : (e) => onClick?.(e.shiftKey || e.metaKey || e.ctrlKey)}
      onPointerDown={draggable ? onPointerDown : undefined}
      onPointerMove={draggable ? onPointerMove : undefined}
      onPointerUp={draggable ? onPointerUp : undefined}
      onPointerCancel={draggable ? onPointerCancel : undefined}
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
        ...(stmt ? ({ "--stmt-tint": statementTint ?? KIND_TINT[stmt.kind] } as CSSProperties) : {}),
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
              <path
                d="M2 2 L11 11 M11 2 L2 11"
                stroke="currentColor"
                strokeWidth={1.8}
                fill="none"
              />
            </svg>
          ) : (
            <svg width={13} height={13} viewBox="0 0 13 13" aria-hidden>
              <path
                d="M6.5 1.5 V11.5 M1.5 6.5 H11.5"
                stroke="currentColor"
                strokeWidth={1.8}
                fill="none"
              />
            </svg>
          )}
        </span>
      )}
      {stmt && (
        <div className="stmt-head">
          <StatementGlyph kind={stmt.kind} size={11} />
          <span className="stmt-kind">{KIND_LABEL[stmt.kind].one}</span>
          <span className="stmt-status">{statusLabel(stmt.kind, stmt.status)}</span>
        </div>
      )}
      {!stmt && meta && (
        <div className="node-meta">
          {icon || autoIcon ? (
            <NodeIcon icon={icon} fallback={autoIcon} />
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
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="node-title">{title}</div>
      )}
      {!stmt && sub && <div className="node-sub">{sub}</div>}
      {stmt && (statementOwner || statementDue || fromMeeting) && (
        <div className="stmt-foot">
          {statementOwner && (
            <span className="stmt-owner">
              <span className="stmt-owner-dot" aria-hidden>
                {statementOwner.trim().charAt(0).toUpperCase()}
              </span>
              {statementOwner}
            </span>
          )}
          {statementDue && <span className="stmt-due">due {formatDue(statementDue)}</span>}
          {fromMeeting && (
            <span className="stmt-src" title="Extracted from a meeting">
              ✦ meeting
            </span>
          )}
        </div>
      )}
      {/* BPMN-shaped nodes keep their shape; the statement rides as a chip. */}
      {!stmt && statement && (
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
});

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
 * is the routed corridor instead, in the style the board's family chose
 * (Phase 5, advisory V10 — routeStyleFor): polyline = straight segments
 * through each waypoint; ortho = the squared corners of core's
 * routedVertices (BPMN/process); spline = Catmull-Rom through the waypoints
 * so a long corridor reads as one curve instead of a sawtooth
 * (architecture/journey). `pathLength` normalisation downstream still
 * applies (dash animations measure the whole path whatever its shape).
 *
 * The vertex list comes from core's `routedVertices` — the shared drawn
 * truth — passed by the caller as `vertices`, so the canvas, the labels, the
 * culling spans, and the export all draw the same points the benchmark
 * counted. `route` stays for the route-less call sites.
 */
export function makePath(
  a: Point,
  b: Point,
  dir: "h" | "v" = "h",
  spread = 0,
  route: Point[] = [],
  style: "polyline" | "ortho" | "spline" = "polyline",
  vertices?: Point[],
): string {
  if (route.length > 0) {
    // `vertices` lets a caller that computed the drawn points once (the
    // render loop shares them with the label midpoint) pass them through;
    // otherwise the style derives them here — same derivation, no second
    // truth.
    const pts = vertices ?? routedVertices(a, b, route, style);
    if (style === "spline") return splinePath(pts);
    if (style === "ortho") return orthoRoundedPath(pts, 10);
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

/**
 * Renders orthogonal paths with smooth filleted/rounded corners (Eraser.io style).
 * Every 90-degree corner turns into a gentle arc (Q) rather than a harsh jagged join.
 */
function orthoRoundedPath(pts: Point[], radius = 10): string {
  if (pts.length < 3) {
    let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
    return d;
  }
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const curr = pts[i]!;
    const next = pts[i + 1]!;

    const d1x = curr.x - prev.x;
    const d1y = curr.y - prev.y;
    const len1 = Math.hypot(d1x, d1y);

    const d2x = next.x - curr.x;
    const d2y = next.y - curr.y;
    const len2 = Math.hypot(d2x, d2y);

    if (len1 < 1 || len2 < 1) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const r = Math.min(radius, len1 / 2, len2 / 2);
    const startX = curr.x - (d1x / len1) * r;
    const startY = curr.y - (d1y / len1) * r;
    const endX = curr.x + (d2x / len2) * r;
    const endY = curr.y + (d2y / len2) * r;

    d += ` L ${startX} ${startY} Q ${curr.x} ${curr.y} ${endX} ${endY}`;
  }
  d += ` L ${pts[pts.length - 1]!.x} ${pts[pts.length - 1]!.y}`;
  return d;
}

/**
 * Catmull-Rom spline through `pts` as SVG cubic segments: each interior
 * vertex becomes the joint of one C command whose control arms are the
 * neighbouring-vertex tangents at 1/6 the segment length — the standard
 * uniform Catmull-Rom → Bézier conversion. Deterministic, passes exactly
 * through every waypoint, never overshoots the corridor by more than the
 * tangent length (bounded, unlike a naive quadratic through all points).
 */
function splinePath(pts: Point[]): string {
  if (pts.length < 3) {
    let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x} ${pts[i]!.y}`;
    return d;
  }
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
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
  /**
   * The exact camera, and a glide back to one (docs/26 §6.4 camera history).
   * Exact on purpose: restoring through focusOn/fitBounds would drift by the
   * chrome insets and fit padding on every round trip.
   */
  getCamera: () => Camera;
  setCamera: (camera: Camera) => void;
}

export interface Camera {
  zoom: number;
  pan: { x: number; y: number };
}

export function CanvasViewport({
  children,
  initialZoom = 85,
  tool = "select",
  onZoom,
  onViewport,
  setControls,
  className,
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
  className?: string;
}) {
  const [zoom, setZoom] = useState(initialZoom);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const drag = useRef({ dragging: false, startX: 0, startY: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  // --- Fluid viewport motion (skill §3–6, §9) ---
  // The rAF loop steers the rendered values toward their targets with
  // critically-damped approach steps: no fixed durations, so any new input
  // re-targets from the live on-screen value and motion stays continuous
  // through interruption. Rendered values are mirrored into refs because the
  // loop runs outside React state reads.
  const zoomTarget = useRef(initialZoom);
  const panTarget = useRef<Point | null>(null);
  const zoomRendered = useRef(initialZoom);
  const panRendered = useRef<Point>({ x: 0, y: 0 });
  const raf = useRef(0);
  const lastT = useRef(0);
  const tracker = useRef<VelocityTracker | null>(null);
  const settleTimer = useRef(0);

  const step = useCallback(() => {
    raf.current = 0;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const dt = Math.min(0.064, Math.max(0.001, (now - lastT.current) / 1000));
    lastT.current = now;
    const zt = zoomTarget.current;
    const zn = approach(zoomRendered.current, zt, 14, dt);
    if (zn !== zoomRendered.current) {
      zoomRendered.current = zn;
      setZoom(zn);
    }
    const pt = panTarget.current;
    if (pt) {
      const pr = panRendered.current;
      const nx = approach(pr.x, pt.x, 10, dt);
      const ny = approach(pr.y, pt.y, 10, dt);
      if (nx !== pr.x || ny !== pr.y) {
        panRendered.current = { x: nx, y: ny };
        setPan({ x: nx, y: ny });
      } else {
        panTarget.current = null;
      }
    }
    if (zoomRendered.current !== zt || panTarget.current) {
      lastT.current = typeof performance !== "undefined" ? performance.now() : 0;
      if (typeof requestAnimationFrame === "function") {
        raf.current = requestAnimationFrame(step);
      }
    }
  }, []);

  const ensureLoop = useCallback(() => {
    if (!raf.current && typeof requestAnimationFrame === "function") {
      lastT.current = typeof performance !== "undefined" ? performance.now() : 0;
      raf.current = requestAnimationFrame(step);
    }
  }, [step]);

  // Never leave a loop or timer running past unmount.
  useEffect(() => {
    return () => {
      if (raf.current && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      if (settleTimer.current && typeof window !== "undefined") {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = 0;
      }
    };
  }, []);

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
    // Programmatic moves go through the same targets as gestures, so a
    // button press mid-glide re-targets instead of jumping (skill §3).
    const glideTo = (z: number, p: Point) => {
      zoomTarget.current = z;
      if (!viewportMotionOK()) {
        zoomRendered.current = z;
        panRendered.current = p;
        setZoom(z);
        setPan(p);
        panTarget.current = null;
        return;
      }
      panTarget.current = p;
      ensureLoop();
    };
    setControls?.({
      zoomIn: () => {
        const t = clamp(zoomTarget.current * 1.2, ZOOM_MIN, ZOOM_MAX);
        glideTo(t, panRendered.current);
      },
      zoomOut: () => {
        const t = clamp(zoomTarget.current / 1.2, ZOOM_MIN, ZOOM_MAX);
        glideTo(t, panRendered.current);
      },
      reset: () => {
        glideTo(100, { x: 0, y: 0 });
      },
      getZoom: () => zoom,
      getCamera: () => ({ zoom, pan: { ...pan } }),
      setCamera: (camera) => {
        glideTo(clamp(camera.zoom, ZOOM_MIN, ZOOM_MAX), { ...camera.pan });
      },
      focusOn: (cx, cy, zoomPercent) => {
        const el = containerRef.current;
        if (!el) return;
        const { width: w, height: h } = el.getBoundingClientRect();
        const nextZoom = clamp(zoomPercent ?? zoom, ZOOM_MIN, ZOOM_MAX);
        const s = nextZoom / 100;
        // Match the inner transform: origin at (0.5w, 0.4h), so solve for the
        // pan that maps content point (cx,cy) to the viewport center.
        const ox = 0.5 * w;
        const oy = 0.4 * h;
        glideTo(nextZoom, {
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
        const nextZoom = clamp(fit * 100, ZOOM_MIN, 100);
        const s = nextZoom / 100;
        const ox = 0.5 * w;
        const oy = 0.4 * h;
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        // Target screen center shifted to account for asymmetric insets.
        const targetX = CHROME_INSET.left + availW / 2;
        const targetY = CHROME_INSET.top + availH / 2;
        glideTo(nextZoom, {
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
  }, [zoom, pan, setControls, ensureLoop]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      // e.preventDefault() prevents native browser page zoom (Ctrl+wheel / trackpad pinch)
      e.preventDefault();
      // Any wheel input takes over from a pan glide immediately (skill §3).
      panTarget.current = null;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.006);
        // Soft-clamped: overshoot meets resistance instead of a hard stop.
        const next = softClampZoom(zoomTarget.current * factor);
        zoomTarget.current = next;
        if (!viewportMotionOK()) {
          const hard = clamp(next, ZOOM_MIN, ZOOM_MAX);
          zoomTarget.current = hard;
          zoomRendered.current = hard;
          setZoom(hard);
        } else {
          ensureLoop();
          // Settle back inside the hard limits once the gesture pauses.
          window.clearTimeout(settleTimer.current);
          settleTimer.current = window.setTimeout(() => {
            const t = zoomTarget.current;
            const hard = clamp(t, ZOOM_MIN, ZOOM_MAX);
            if (hard !== t) {
              zoomTarget.current = hard;
              ensureLoop();
            }
          }, 160);
        }
      } else {
        // Plain-wheel pan stays 1:1 with the gesture — direct, no smoothing.
        const dx = e.deltaX;
        const dy = e.deltaY;
        setPan((p) => {
          const n = { x: p.x - dx, y: p.y - dy };
          panRendered.current = n;
          return n;
        });
      }
    };
    const preventGesture = (e: Event) => e.preventDefault();

    el.addEventListener("wheel", handleWheel, { passive: false });
    el.addEventListener("gesturestart", preventGesture);
    el.addEventListener("gesturechange", preventGesture);
    return () => {
      el.removeEventListener("wheel", handleWheel);
      el.removeEventListener("gesturestart", preventGesture);
      el.removeEventListener("gesturechange", preventGesture);
    };
  }, [ensureLoop]);

  // Hand-tool / middle-drag / shift-drag pans as Pointer Events (skill §2),
  // so touch pans too. Release hands velocity to the glide loop (skill §5–6).
  const onPointerDown = (e: React.PointerEvent) => {
    if (!(e.button === 1 || tool === "hand" || e.shiftKey)) return;
    // New gesture takes over from any glide (skill §3: redirectable).
    panTarget.current = null;
    if (!tracker.current) tracker.current = new VelocityTracker();
    tracker.current.reset();
    tracker.current.push(e.clientX, e.clientY);
    drag.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      panX: panRendered.current.x,
      panY: panRendered.current.y,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort; in-bounds movement still pans.
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.dragging) return;
    tracker.current?.push(e.clientX, e.clientY);
    // 1:1 with the pointer the whole way through — feedback during the
    // gesture, never only at the end (skill §1–2).
    const n = { x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) };
    panRendered.current = n;
    setPan(n);
  };
  const endPanDrag = (_e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.dragging) return;
    drag.current.dragging = false;
    const v = tracker.current?.velocity() ?? { x: 0, y: 0 };
    // Momentum handoff: continue at the finger's velocity toward the
    // projected resting point. Slow pans stop dead; reduced motion never
    // glides — the pan the gesture left is the pan that stays.
    if (Math.hypot(v.x, v.y) > 80 && viewportMotionOK()) {
      const p = panRendered.current;
      panTarget.current = { x: p.x + projectMomentum(v.x), y: p.y + projectMomentum(v.y) };
      ensureLoop();
    } else {
      panTarget.current = null;
    }
  };

  const cursor = tool === "hand" ? "grab" : "default";

  return (
    <div
      ref={containerRef}
      className={["canvas-viewport", className].filter(Boolean).join(" ")}
      // Focusable so keyboard users can enter the canvas and then Tab through
      // its objects (the window-level handler in CanvasView does the cycling).
      tabIndex={0}
      role="application"
      aria-label="Canvas — press Tab to move between objects, Enter to edit, arrow keys to nudge"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPanDrag}
      onPointerCancel={endPanDrag}
      style={{ position: "absolute", inset: 0, overflow: "hidden", cursor, touchAction: "none" }}
    >
      <CanvasBackdrop />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
          transformOrigin: "50% 40%",
          // No CSS transition: the rAF loop owns smoothing from the live
          // value, so re-targets never jump (skill §3–4).
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
