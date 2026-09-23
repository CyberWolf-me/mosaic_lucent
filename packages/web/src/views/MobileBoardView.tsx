import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBoardSvg } from "../board/geometry.js";
import { nodeIconRefs } from "../icons/exportSvg.js";
import { preloadIcons } from "../icons/registry.js";
import { useWorkspace } from "../workspace.js";
import { Ico } from "../ui/icons.js";

/**
 * The mobile read view (G2: "mobile/tablet read + comment + present").
 *
 * A phone cannot meaningfully edit a dense diagram — the interaction the
 * canvas is built around (pan, marquee, direct manipulation) assumes a
 * pointer with pixels to spare — so this view does not try. It renders the
 * board with `buildBoardSvg`, the same static renderer the PDF export uses,
 * pinch-zoomable with native gesture events. That choice is the whole
 * design: one renderer, already shipped and tested, rather than a second
 * interactive canvas with a mobile-specific bug surface.
 *
 * What a phone *can* do well — read the current state, see who is live,
 * add a comment — is kept: the comment composer posts through the same
 * `applyManual` ADD_COMMENT op the desktop canvas uses, so a comment made
 * here is indistinguishable from one made at a desk, presence and all.
 *
 * The desktop bundle keeps its own CanvasView untouched; this view is
 * selected by viewport (see `MobileGate` below), never by a route, so the
 * same board URL serves both.
 */

/** Below this viewport width, the desktop canvas is a bad experience. */
const MOBILE_MAX_WIDTH = 720;

/**
 * True when the current viewport is phone-shaped. Exposed for tests; the
 * component re-checks on resize because a rotated tablet changes its mind.
 */
export function isMobileViewport(
  width: number = typeof window === "undefined" ? 1024 : window.innerWidth,
): boolean {
  return width < MOBILE_MAX_WIDTH;
}

export function MobileBoardView(): React.ReactElement {
  const { workspace, boardId, syncStatus, peers, applyManual, readOnly, projectName } =
    useWorkspace();
  // The mobile board is the SVG export, which draws only loaded icons: warm
  // this board's buckets, then redraw once with them (docs/26 §6.2).
  const [iconsLoaded, setIconsLoaded] = useState(0);
  useEffect(() => {
    let live = true;
    void preloadIcons(nodeIconRefs(Object.values(workspace.nodes))).then(() => {
      if (live) setIconsLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [workspace.nodes]);
  // iconsLoaded is the recompute signal: the export reads icons from the
  // registry's module cache, which React can't see change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const svg = useMemo(() => buildBoardSvg(workspace), [workspace, iconsLoaded]);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef<number>(1);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentTarget, setCommentTarget] = useState<string | null>(null);
  const [presenting, setPresenting] = useState(false);

  useEffect(() => {
    const onResize = (): void => {
      if (!isMobileViewport()) {
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setIsPanning(true);
    if (activePointersRef.current.size === 2) {
      const pts = Array.from(activePointersRef.current.values());
      pinchStartDistRef.current = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      pinchStartScaleRef.current = scale;
    }
  }, [scale]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    const prev = activePointersRef.current.get(e.pointerId);
    if (!prev) return;

    if (activePointersRef.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    } else if (activePointersRef.current.size === 2) {
      activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = Array.from(activePointersRef.current.values());
      const currentDist = Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
      if (pinchStartDistRef.current && pinchStartDistRef.current > 0) {
        const ratio = currentDist / pinchStartDistRef.current;
        const nextScale = Math.min(4, Math.max(0.5, pinchStartScaleRef.current * ratio));
        setScale(nextScale);
      }
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    activePointersRef.current.delete(e.pointerId);
    if (activePointersRef.current.size < 2) {
      pinchStartDistRef.current = null;
    }
    if (activePointersRef.current.size === 0) {
      setIsPanning(false);
    }
  }, []);

  // Escape closes the comment sheets (target picker or composer).
  useEffect(() => {
    if (!commentOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setCommentOpen(false);
        setCommentTarget(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [commentOpen]);

  const openCommentOn = (targetId: string): void => {
    setCommentTarget(targetId);
    setCommentOpen(true);
  };

  const submitComment = (): void => {
    const text = commentText.trim();
    if (!text || !commentTarget) return;
    // The same op board/comments.ts mints for the desktop composer — same
    // reducer, same validation, same notification to peers. `by` is stamped
    // by the workspace layer, not here, exactly as desktop does.
    const applied = applyManual(
      [
        {
          op: "ADD_COMMENT",
          id: `cmt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          targetId: commentTarget,
          body: text,
        },
      ],
      "Add comment (mobile)",
    );
    if (applied) {
      setCommentText("");
      setCommentOpen(false);
      setCommentTarget(null);
    }
    // A refusal (validation, read-only role) leaves the composer open with
    // the text intact — losing a typed comment to a silent failure is the
    // worst outcome available.
  };

  // The commentable objects on this board, by label. A phone's comment
  // affordance is a bottom sheet listing targets rather than a tap-on-canvas
  // hit test — the SVG is static markup, and threading click targets through
  // it would rebuild the desktop canvas's interaction model on mobile.
  const commentTargets = useMemo(
    () =>
      Object.values(workspace.nodes)
        .slice(0, 30)
        .map((n) => ({ id: n.id, label: n.label || n.nodeType })),
    [workspace.nodes],
  );

  return (
    <div className="mobile-board" role="region" aria-label={`${projectName} (mobile view)`}>
      <header className="mobile-head">
        <span className="mobile-title">{projectName}</span>
        <span className={`mobile-sync ${syncStatus === "online" ? "ok" : ""}`}>
          {syncStatus === "online" ? `${peers.length + 1} live` : syncStatus}
        </span>
      </header>

      <div
        className="mobile-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => {
          setScale(1);
          setPan({ x: 0, y: 0 });
        }}
        style={{ touchAction: "none", cursor: isPanning ? "grabbing" : "grab" }}
      >
        <div
          className="mobile-canvas-inner"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
            transition: isPanning ? "none" : "transform 120ms ease-out",
            willChange: "transform",
          }}
          // The SVG is static markup from buildBoardSvg: same origin, no
          // scripts, and the geometry module's escaping already covers text
          // content (svg-escaping.test.ts pins it).
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <div className="mobile-zoom">
        <button
          className="icon-btn"
          aria-label="Zoom out"
          onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}
        >
          <Ico.Search />
        </button>
        <span className="mono small">{Math.round(scale * 100)}%</span>
        <button
          className="icon-btn"
          aria-label="Zoom in"
          onClick={() => setScale((s) => Math.min(4, s + 0.25))}
        >
          <Ico.Search />
        </button>
      </div>

      {!readOnly && (
        <button
          className="btn primary mobile-comment-btn"
          onClick={() => setCommentOpen((v) => !v)}
        >
          Comment
        </button>
      )}

      {presenting && (
        <MobilePresentOverlay svg={svg} workspace={workspace} onExit={() => setPresenting(false)} />
      )}
      {!presenting && (
        <button className="btn mobile-present-btn" onClick={() => setPresenting(true)}>
          Present
        </button>
      )}

      {commentOpen && !commentTarget && (
        <div
          className="mobile-comment-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Choose a comment target"
        >
          <div className="mobile-comment-list">
            {commentTargets.length === 0 && (
              <p className="muted small">Nothing to comment on yet.</p>
            )}
            {commentTargets.map((t) => (
              <button
                key={t.id}
                className="mobile-comment-target"
                onClick={() => openCommentOn(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setCommentOpen(false)}>
            Cancel
          </button>
        </div>
      )}

      {commentOpen && commentTarget && (
        <div
          className="mobile-comment-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Add a comment"
        >
          <textarea
            autoFocus
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="Say something about this…"
            rows={3}
          />
          <div className="mobile-comment-actions">
            <button className="btn" onClick={() => setCommentTarget(null)}>
              Back
            </button>
            <button className="btn primary" onClick={submitComment} disabled={!commentText.trim()}>
              Post
            </button>
          </div>
        </div>
      )}

      {boardId && (
        <footer className="mobile-foot mono small">
          shared board · {Object.keys(workspace.nodes).length} nodes
        </footer>
      )}
    </div>
  );
}

/**
 * Mobile presentation (G2's "present"): the same static SVG, fullscreen,
 * stepping through the board's top-level frames. A frame-shaped presentation
 * (sections in reading order) is what a phone presents — slide-like, one
 * section per swipe. A board with no frames falls back to whole-board view
 * with a plain step counter of 1/1, which is still a presentation: the
 * board, large, with nothing else on screen.
 *
 * The SVG is cropped per frame by setting the viewBox to the frame's bounds —
 * the renderer's own coordinate math, not a second renderer.
 */
function MobilePresentOverlay({
  svg,
  workspace,
  onExit,
}: {
  svg: string;
  workspace: import("@lucent/core").Workspace;
  onExit: () => void;
}): React.ReactElement {
  const frames = useMemo(
    () =>
      Object.values(workspace.shapes)
        .filter((s) => s.kind === "frame")
        .map((s) => ({
          id: s.id,
          label: s.text ?? "Frame",
          x: s.position.x,
          y: s.position.y,
          w: s.size.width,
          h: s.size.height,
        })),
    [workspace.shapes],
  );
  const [step, setStep] = useState(0);
  const slides = frames.length > 0 ? frames : null;
  const total = slides ? slides.length : 1;

  // Escape and the arrow keys: a presenter with a bluetooth clicker should
  // get the same controls a keyboard gives the desktop present mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onExit();
      if (e.key === "ArrowRight") setStep((s) => Math.min(total - 1, s + 1));
      if (e.key === "ArrowLeft") setStep((s) => Math.max(0, s - 1));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onExit, total]);

  // Crop the rendered SVG by rewriting its viewBox to the current frame —
  // one regex over the static markup the renderer already escaped, applied
  // to the attribute only. No re-render, no second geometry implementation.
  const cropped = useMemo(() => {
    if (!slides) return svg;
    const f = slides[step]!;
    const vb = `${f.x - 24} ${f.y - 24} ${f.w + 48} ${f.h + 48}`;
    const withViewBox = svg.replace(/viewBox="[^"]*"/, `viewBox="${vb}"`);
    return withViewBox.replace(/<svg /, '<svg preserveAspectRatio="xMidYMid meet" ');
  }, [svg, slides, step]);

  const label = slides ? slides[step]!.label : "Board";

  return (
    <div className="mobile-present" role="region" aria-label={`Presenting ${label}`}>
      <div className="mobile-present-stage" dangerouslySetInnerHTML={{ __html: cropped }} />
      <div className="mobile-present-bar">
        <button className="btn" onClick={onExit} aria-label="Exit presentation">
          Exit
        </button>
        <span className="mono small" style={{ color: "var(--ink-2)" }}>
          {step + 1} / {total} · {label}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button
            className="icon-btn"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            aria-label="Previous"
          >
            <Ico.Left />
          </button>
          <button
            className="icon-btn"
            onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
            disabled={step >= total - 1}
            aria-label="Next"
          >
            <Ico.Right />
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The viewport gate. Rendered by the router where CanvasView would be; picks
 * the mobile view only when the viewport is phone-shaped AND the board has
 * something to read. An empty board on a phone is better served by the
 * normal hero prompt (the user is about to describe something, and the
 * mobile keyboard handles text fine).
 */
export function MobileGate({ desktop }: { desktop: React.ReactElement }): React.ReactElement {
  const [mobile, setMobile] = useState(isMobileViewport);
  useEffect(() => {
    const onResize = (): void => setMobile(isMobileViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const { workspace } = useWorkspace();
  const hasContent = Object.keys(workspace.nodes).length + Object.keys(workspace.shapes).length > 0;
  if (mobile && hasContent) return <MobileBoardView />;
  return desktop;
}
