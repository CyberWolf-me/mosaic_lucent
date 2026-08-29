import { useEffect, useMemo, useState } from "react";
import { buildBoardSvg } from "../board/geometry.js";
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
  const svg = useMemo(() => buildBoardSvg(workspace), [workspace]);
  const [scale, setScale] = useState(1);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentTarget, setCommentTarget] = useState<string | null>(null);

  useEffect(() => {
    const onResize = (): void => {
      if (!isMobileViewport()) {
        setScale(1);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
        onDoubleClick={() => {
          setScale(1);
        }}
      >
        <div
          className="mobile-canvas-inner"
          style={{ transform: `scale(${scale})` }}
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

      {commentOpen && !commentTarget && (
        <div className="mobile-comment-sheet" role="dialog" aria-label="Choose a comment target">
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
        <div className="mobile-comment-sheet" role="dialog" aria-label="Add a comment">
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
