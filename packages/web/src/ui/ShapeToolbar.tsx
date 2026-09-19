import { useEffect, useRef, useState } from "react";
import { ToolIco } from "./icons.js";
import { isImageDataUrl } from "@lucent/core";
import type { Shape } from "@lucent/core";
import { normalizeZ, type DropKind } from "../shapes.js";

export type { DropKind };

/** Render-site guard for embed srcs (M0.5). The op schema already enforces
 * http(s); this is the second line of defence for shapes loaded from an older
 * workspace or pasted from somewhere the schema didn't see. Anything that
 * isn't http(s) becomes `about:blank`, which is harmless even if the iframe
 * tries to script itself. */
function isHttpUrl(src: string | undefined): boolean {
  return src !== undefined && /^https?:\/\//i.test(src);
}

/**
 * Render-site guard for image srcs. The schema lets a `kind: "image"` shape hold
 * an http(s) URL or a strict base64 `data:image/...` URL and nothing else, so
 * this is the same second line of defence `isHttpUrl` gives the embed branch:
 * a shape read back out of an older build's localStorage, or out of an imported
 * JSON file, never met that schema. The data-URL half comes from core rather
 * than a second regex here, so the two ends of the contract cannot drift.
 */
export function isSafeImageSrc(src: string | undefined): boolean {
  return src !== undefined && (isHttpUrl(src) || isImageDataUrl(src));
}

/** Figjam-style shape toolbar + dropped shape element. Shapes are real
 * @lucent/core Shape objects (docs/13), so they persist and undo/redo. */

export type Tool =
  | "select"
  | "hand"
  | "rect"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "star"
  | "sticky"
  | "text"
  | "arrow"
  | "pen"
  | "eraser"
  | "frame"
  | "comment";

/** Tools that create a shape by drawing on the canvas (vs. select/hand/pen/etc.). */
export const SHAPE_KINDS = new Set<Tool>([
  "rect",
  "ellipse",
  "diamond",
  "triangle",
  "star",
  "sticky",
  "text",
  "frame",
]);

export function ShapeToolbar({
  activeTool = "select",
  onSelectTool,
  onEmbed,
  onGenImage,
  orientation = "left",
}: {
  activeTool?: Tool;
  onSelectTool?: (t: Tool) => void;
  onEmbed?: () => void;
  onGenImage?: () => void;
  orientation?: "left" | "bottom";
}) {
  const [tool, setTool] = useState<Tool>(activeTool);

  useEffect(() => setTool(activeTool), [activeTool]);

  // Selecting a shape tool only *arms* it; the user then draws it on the canvas
  // by click-dragging (docs/14). No more auto-dropping at a random spot.
  const pick = (id: Tool) => {
    setTool(id);
    onSelectTool?.(id);
  };

  const T = ({ id, tip, children }: { id: Tool; tip: string; children: React.ReactNode }) => (
    <button
      className={`tool ${tool === id ? "active" : ""}`}
      data-tip={tip}
      // data-tip only drives a CSS tooltip; screen readers need a real name.
      aria-label={tip}
      aria-pressed={tool === id}
      onClick={() => pick(id)}
    >
      {children}
    </button>
  );

  return (
    <div className={`shape-toolbar ${orientation}`}>
      <T id="select" tip="Select · V">
        <ToolIco.Select />
      </T>
      <T id="hand" tip="Hand · H">
        <ToolIco.Hand />
      </T>
      <div className="divider" />
      <T id="rect" tip="Rectangle · R">
        <ToolIco.Rect />
      </T>
      <T id="ellipse" tip="Ellipse · O">
        <ToolIco.Ellipse />
      </T>
      <T id="diamond" tip="Diamond · D">
        <ToolIco.Diamond />
      </T>
      <T id="triangle" tip="Triangle">
        <ToolIco.Triangle />
      </T>
      <T id="star" tip="Star">
        <ToolIco.Star />
      </T>
      <T id="sticky" tip="Sticky · S">
        <ToolIco.Sticky />
      </T>
      <T id="text" tip="Text · T">
        <ToolIco.Text />
      </T>
      <div className="divider" />
      <T id="arrow" tip="Connect · A">
        <ToolIco.Connect />
      </T>
      <T id="pen" tip="Pen · P">
        <ToolIco.Pen />
      </T>
      <T id="eraser" tip="Eraser · E">
        <ToolIco.Eraser />
      </T>
      <div className="divider" />
      <T id="frame" tip="Frame · F">
        <ToolIco.Frame />
      </T>
      <button
        className="tool"
        data-tip="Embed GIF / video / link"
        aria-label="Embed GIF, video, or link"
        onClick={() => onEmbed?.()}
      >
        <ToolIco.Media />
      </button>
      <button
        className="tool"
        data-tip="Generate image with AI"
        aria-label="Generate image with AI"
        onClick={() => onGenImage?.()}
      >
        <ToolIco.Sparkle />
      </button>
      <T id="comment" tip="Comment · C">
        <ToolIco.Comment />
      </T>
    </div>
  );
}

export function ShapeElement({
  shape,
  selected,
  linkSource,
  scale = 1,
  onSelect,
  onMove,
  onResize,
  onChangeLabel,
  onContextMenu,
  onAltDragDuplicate,
  editRequested = false,
  onEditConsumed,
}: {
  shape: Shape;
  selected?: boolean;
  linkSource?: boolean;
  scale?: number;
  onSelect?: (id: string, additive: boolean) => void;
  onMove?: (id: string, x: number, y: number, commit: boolean) => void;
  onResize?: (id: string, width: number, height: number, commit: boolean) => void;
  onChangeLabel?: (id: string, label: string) => void;
  onContextMenu?: (id: string, x: number, y: number) => void;
  /**
   * Alt/Option-drag duplicates instead of moving (Figma/Miro). Called once at
   * gesture start; the new copy becomes the selection and the drag continues on
   * it, so the original stays where it was.
   */
  onAltDragDuplicate?: (id: string) => void;
  /** When true, open the text editor (keyboard Enter path). */
  editRequested?: boolean;
  /** Called once the requested edit has been consumed. */
  onEditConsumed?: () => void;
}) {
  const { id, kind, position, size, text, path, src, style: sty, rotation } = shape;
  // Legacy boards stored z as Date.now(), which overflows the CSS z-index range
  // and made every shape paint above the tool overlays. Clamp on render so old
  // saved boards behave too, not just newly created shapes.
  const z = normalizeZ(shape.z);
  const x = position.x;
  const y = position.y;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text ?? "");
  const [liveSize, setLiveSize] = useState<{ width: number; height: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    setDraft(text ?? "");
  }, [text]);

  // Keyboard Enter on the selected shape asks the parent to open the editor.
  useEffect(() => {
    if (editRequested) {
      setEditing(true);
      onEditConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequested]);

  // Hidden shapes are not rendered on the canvas (still in the model).
  if (shape.hidden) return null;

  const defaultText =
    text ??
    (kind === "sticky"
      ? "New note"
      : kind === "ellipse"
        ? "Process"
        : kind === "diamond"
          ? "Decision"
          : kind === "text"
            ? "Double-click to edit"
            : "Rectangle");

  const startResize = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseW = size.width;
    const baseH = size.height;
    const onMove2 = (ev: MouseEvent) => {
      const w = Math.max(24, baseW + (ev.clientX - startX) / scale);
      const h = Math.max(24, baseH + (ev.clientY - startY) / scale);
      setLiveSize({ width: w, height: h });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove2);
      window.removeEventListener("mouseup", onUp);
      const w = Math.max(24, baseW + (ev.clientX - startX) / scale);
      const h = Math.max(24, baseH + (ev.clientY - startY) / scale);
      setLiveSize(null);
      onResize?.(id, Math.round(w), Math.round(h), true);
    };
    window.addEventListener("mousemove", onMove2);
    window.addEventListener("mouseup", onUp);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (editing) return;
    e.stopPropagation();
    // Alt/Option-drag duplicates: hand off to the parent, which creates the copy
    // and lets the user drag that instead of the original.
    if (e.altKey && onAltDragDuplicate && !shape.locked) {
      e.preventDefault();
      onAltDragDuplicate(id);
      return;
    }
    onSelect?.(id, e.shiftKey);
    // Locked shapes can be selected but not dragged.
    if (shape.locked) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: x, baseY: y, moved: false };

    const onMouseMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.startX) / scale;
      const dy = (ev.clientY - d.startY) / scale;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      onMove?.(id, d.baseX + dx, d.baseY + dy, false);
    };
    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      const d = dragRef.current;
      if (d?.moved) {
        const dx = (ev.clientX - d.startX) / scale;
        const dy = (ev.clientY - d.startY) / scale;
        onMove?.(id, d.baseX + dx, d.baseY + dy, true);
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const commitLabel = () => {
    setEditing(false);
    onChangeLabel?.(id, draft.trim() || defaultText);
  };

  // Freehand drawing renders as an SVG path; not draggable-as-text.
  if (kind === "draw") {
    return (
      <svg
        className={`shape draw ${selected ? "selected" : ""}`}
        onMouseDown={onMouseDown}
        style={{
          left: x,
          top: y,
          width: size.width,
          height: size.height,
          position: "absolute",
          overflow: "visible",
          zIndex: z,
          cursor: "grab",
        }}
      >
        <path
          d={path ?? ""}
          fill="none"
          stroke={sty?.stroke ?? "var(--ink-0)"}
          strokeWidth={sty?.strokeWidth ?? 2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Frame: a labelled dashed container that groups the shapes inside it.
  if (kind === "frame") {
    const fw = liveSize?.width ?? size.width;
    const fh = liveSize?.height ?? size.height;
    return (
      <div
        className={`shape frame ${selected ? "selected" : ""}`}
        onMouseDown={onMouseDown}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        style={{
          left: x,
          top: y,
          width: fw,
          height: fh,
          position: "absolute",
          zIndex: z ?? 0,
          cursor: "grab",
        }}
      >
        <div className="frame-tag">
          {editing ? (
            <input
              autoFocus
              aria-label="Frame name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                if (e.key === "Escape") setEditing(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                font: "inherit",
                color: "inherit",
                background: "transparent",
                border: "none",
                outline: "none",
              }}
            />
          ) : (
            text || "Frame"
          )}
        </div>
        {selected && <span className="shape-resize" onMouseDown={startResize} title="Resize" />}
      </div>
    );
  }

  // File object: a chip showing a document icon + filename.
  if (kind === "file") {
    return (
      <div
        {...{
          className: `shape file ${selected ? "selected" : ""}`,
          onMouseDown,
          onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu?.(id, e.clientX, e.clientY);
          },
        }}
        style={{
          left: x,
          top: y,
          width: liveSize?.width ?? size.width,
          position: "absolute",
          zIndex: z,
          cursor: "grab",
        }}
      >
        <span className="file-icon">📄</span>
        <span className="file-name">{text || "Document"}</span>
        {selected && <span className="shape-resize" onMouseDown={startResize} title="Resize" />}
      </div>
    );
  }

  if (kind === "image") {
    // A src the guard refuses becomes a placeholder instead of an <img> the
    // browser is told to fetch. The shape stays selectable, resizable and
    // draggable so the user can delete or re-point it rather than hunting for
    // an object that vanished from the board.
    if (!isSafeImageSrc(src)) {
      return (
        <div
          className={`shape image ${selected ? "selected" : ""}`}
          onMouseDown={onMouseDown}
          style={{
            left: x,
            top: y,
            width: liveSize?.width ?? size.width,
            height: liveSize?.height ?? size.height,
            position: "absolute",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: 8,
            boxSizing: "border-box",
            borderRadius: 8,
            background: "var(--canvas-2)",
            border: "1px solid var(--stroke-2)",
            color: "var(--ink-2)",
            fontSize: 12,
            zIndex: z,
            cursor: "grab",
          }}
        >
          Image unavailable
          {selected && <span className="shape-resize" onMouseDown={startResize} title="Resize" />}
        </div>
      );
    }
    return (
      <img
        className={`shape image ${selected ? "selected" : ""}`}
        src={src}
        alt=""
        onMouseDown={onMouseDown}
        style={{
          left: x,
          top: y,
          width: liveSize?.width ?? size.width,
          height: liveSize?.height ?? size.height,
          position: "absolute",
          objectFit: "cover",
          borderRadius: 8,
          zIndex: z,
          cursor: "grab",
        }}
      />
    );
  }

  // Embed: GIF/image via <img>, or web/video via a sandboxed <iframe>. A drag
  // handle bar sits on top so the shape can be moved without stealing iframe
  // pointer events.
  //
  // M0.5: drop `allow-same-origin` — without it the iframe has access to our
  // cookies and localStorage; with it the sandbox is effectively a no-op. We
  // also validate src is http(s) at the render site (the op schema already
  // checks this for new shapes, but a shape imported from JSON may have slipped
  // through an older build). `referrerpolicy="no-referrer"` keeps the embedded
  // page from learning who linked to it.
  if (kind === "embed") {
    const ew = liveSize?.width ?? size.width;
    const eh = liveSize?.height ?? size.height;
    const isIframe = (sty?.fill ?? "") === "iframe"; // fill flag marks iframe vs image
    const safeSrc = isHttpUrl(src) ? src : "about:blank";
    return (
      <div
        className={`shape embed ${selected ? "selected" : ""}`}
        style={{
          left: x,
          top: y,
          width: ew,
          height: eh,
          position: "absolute",
          zIndex: z,
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--canvas-2)",
          border: "1px solid var(--stroke-2)",
        }}
      >
        <div className="embed-drag" onMouseDown={onMouseDown} title="Drag" />
        {isIframe ? (
          <iframe
            src={safeSrc}
            title="embed"
            style={{
              width: "100%",
              height: "100%",
              border: 0,
              pointerEvents: selected ? "auto" : "none",
            }}
            sandbox="allow-scripts allow-presentation"
            allow="autoplay; encrypted-media; picture-in-picture"
            referrerPolicy="no-referrer"
          />
        ) : (
          <img
            src={safeSrc}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            referrerPolicy="no-referrer"
          />
        )}
        {selected && <span className="shape-resize" onMouseDown={startResize} title="Resize" />}
      </div>
    );
  }

  const w = liveSize?.width ?? size.width;
  const h = liveSize?.height ?? size.height;
  const cls = [
    "shape",
    kind,
    selected ? "selected" : "",
    linkSource ? "link-source" : "",
    shape.locked ? "locked" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style: React.CSSProperties = {
    left: x,
    top: y,
    zIndex: z,
    cursor: editing ? "text" : "grab",
    // backwards, not both: a forwards fill pins the final keyframe at
    // animation precedence, which sits above .shape:hover's scale and any
    // later transform forever after the entrance ends.
    animation: "emerge 0.35s var(--e-out) backwards",
    ...(sty?.fill ? { background: sty.fill } : {}),
    ...(sty?.stroke ? { borderColor: sty.stroke } : {}),
    ...(sty?.color ? { color: sty.color } : {}),
    ...(sty?.fontSize ? { fontSize: sty.fontSize } : {}),
    ...(sty?.fontWeight
      ? { fontVariationSettings: `'wght' ${sty.fontWeight}`, fontWeight: sty.fontWeight }
      : {}),
    ...(sty?.align ? { textAlign: sty.align } : {}),
    ...(sty?.opacity !== undefined ? { opacity: sty.opacity } : {}),
    ...(sty?.radius !== undefined ? { borderRadius: sty.radius } : {}),
    ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
  };

  // Inline editing uses a multi-line textarea so text/sticky notes support
  // line breaks (Enter = newline, Shift+Enter also newline, Esc/blur commit).
  const multiline = kind === "sticky" || kind === "text" || kind === "rect";
  const editable = editing ? (
    multiline ? (
      <textarea
        autoFocus
        aria-label="Shape text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            commitLabel();
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        rows={1}
        style={{
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "none",
          outline: "none",
          width: "100%",
          resize: "none",
          textAlign: sty?.align ?? "left",
          lineHeight: 1.4,
          overflow: "hidden",
        }}
      />
    ) : (
      <input
        autoFocus
        aria-label="Shape text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitLabel();
          if (e.key === "Escape") setEditing(false);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          font: "inherit",
          color: "inherit",
          background: "transparent",
          border: "none",
          outline: "none",
          width: "100%",
          textAlign: kind === "diamond" ? "center" : undefined,
        }}
      />
    )
  ) : (
    // Preserve newlines when displaying multi-line text.
    <span style={{ whiteSpace: "pre-wrap" }}>{defaultText}</span>
  );

  const commonProps = {
    className: cls,
    style,
    onMouseDown,
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      setEditing(true);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu?.(id, e.clientX, e.clientY);
    },
  };

  const resizeHandle =
    selected && !shape.locked ? (
      <span className="shape-resize" onMouseDown={startResize} title="Resize" />
    ) : null;

  if (kind === "diamond") {
    return (
      <div {...commonProps} style={{ ...style, width: w, height: h }}>
        <span>{editable}</span>
        {resizeHandle}
      </div>
    );
  }

  // Triangle and star use clip-path over the base shape box.
  if (kind === "triangle" || kind === "star") {
    const clip =
      kind === "triangle"
        ? "polygon(50% 0%, 100% 100%, 0% 100%)"
        : "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";
    return (
      <div
        {...commonProps}
        style={{
          ...style,
          width: w,
          height: h,
          clipPath: clip,
          display: "grid",
          placeItems: "center",
          background: sty?.fill ?? "var(--canvas-3)",
          border: "none",
        }}
      >
        {resizeHandle}
      </div>
    );
  }

  return (
    <div
      {...commonProps}
      style={{ ...style, ...(kind === "text" ? {} : { width: w, minHeight: h }) }}
    >
      {editable}
      {resizeHandle}
    </div>
  );
}

/** Renders manual connectors (ShapeLink) between shape centers, re-routing live
 * while a shape is being dragged. Supports straight/elbow/curved variants and an
 * optional double arrowhead (docs/13 Tier 2, docs/14 connectors). */
export function ShapeLinkLayer({
  workspace,
  dragOverride,
  selectedLink,
  onSelectLink,
}: {
  workspace: import("@lucent/core").Workspace;
  dragOverride: { id: string; x: number; y: number } | null;
  selectedLink?: string | null;
  onSelectLink?: (id: string) => void;
}) {
  const links = Object.values(workspace.shapeLinks);
  if (links.length === 0) return null;
  const centerOf = (id: string) => {
    const s = workspace.shapes[id];
    if (!s) return null;
    const pos = dragOverride?.id === id ? { x: dragOverride.x, y: dragOverride.y } : s.position;
    return { x: pos.x + s.size.width / 2, y: pos.y + s.size.height / 2 };
  };

  const anchorOf = (sId: string, otherCenter: { x: number; y: number }) => {
    const s = workspace.shapes[sId];
    if (!s) return null;
    const pos = dragOverride?.id === sId ? { x: dragOverride.x, y: dragOverride.y } : s.position;
    const cx = pos.x + s.size.width / 2;
    const cy = pos.y + s.size.height / 2;
    const dx = otherCenter.x - cx;
    const dy = otherCenter.y - cy;
    if (Math.abs(dx) * s.size.height > Math.abs(dy) * s.size.width) {
      return { x: dx > 0 ? pos.x + s.size.width : pos.x, y: cy };
    } else {
      return { x: cx, y: dy > 0 ? pos.y + s.size.height : pos.y };
    }
  };

  const pathFor = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    variant: string | undefined,
  ) => {
    if (variant === "straight") return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (variant === "elbow") {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (Math.abs(dx) >= Math.abs(dy)) {
        return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
      } else {
        return `M ${a.x} ${a.y} L ${a.x} ${my} L ${b.x} ${my} L ${b.x} ${b.y}`;
      }
    }
    // curved (default) - smooth bezier
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = (a.x + b.x) / 2;
      return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
    } else {
      const my = (a.y + b.y) / 2;
      return `M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
    }
  };
  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <defs>
        <marker
          id="shape-arr"
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
          id="shape-arr-start"
          viewBox="0 0 10 10"
          refX="1"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M10 0 L0 5 L10 10 z" fill="var(--stroke-3)" />
        </marker>
      </defs>
      {links.map((l) => {
        const ca = centerOf(l.source);
        const cb = centerOf(l.target);
        if (!ca || !cb) return null;
        const a = anchorOf(l.source, cb) ?? ca;
        const b = anchorOf(l.target, ca) ?? cb;
        const mx = (a.x + b.x) / 2;
        const sel = selectedLink === l.id;
        return (
          <g key={l.id}>
            <path
              d={pathFor(a, b, l.variant)}
              fill="none"
              stroke={sel ? "var(--amber-2)" : "var(--stroke-3)"}
              strokeWidth={sel ? 2.25 : 1.5}
              markerEnd="url(#shape-arr)"
              markerStart={l.doubleArrow ? "url(#shape-arr-start)" : undefined}
            />
            {/* Wide invisible hit target for selecting the connector. */}
            <path
              d={pathFor(a, b, l.variant)}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                onSelectLink?.(l.id);
              }}
            />
            {l.label && (
              <text
                x={mx}
                y={(a.y + b.y) / 2 - 6}
                textAnchor="middle"
                fontSize="11"
                fill="var(--ink-2)"
                fontFamily="var(--font-mono)"
              >
                {l.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
