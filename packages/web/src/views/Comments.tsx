import { useState } from "react";
import type { Operation, Workspace } from "@lucent/core";
import { Ico } from "../ui/icons.js";
import {
  addCommentOps,
  commentAnchorLabel,
  commentThreads,
  deleteCommentOps,
  knownMentionNames,
  mentionSegments,
  openCommentCounts,
  openMentions,
  replyCommentOps,
  resolveCommentOps,
} from "../board/comments.js";

/**
 * Comment surfaces (docs/12 collaboration).
 *
 * - `CommentPins` marks objects that carry unresolved threads.
 * - `CommentPanel` is the thread reader/composer for one object.
 * - `NotificationBell` lists open @mentions.
 *
 * Everything is driven by operations, so threads persist, undo, and are readable
 * by the AI. Single-user for now; presence changes only the author identity.
 */

/** Body text with @mentions highlighted. Segments, never raw HTML. */
function CommentBody({ body }: { body: string }) {
  return (
    <div className="cmt-body">
      {mentionSegments(body).map((seg, i) =>
        seg.mention ? (
          <span key={i} className="cmt-mention">
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  );
}

function timeLabel(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function CommentPanel({
  workspace,
  targetId,
  onApply,
  onClose,
}: {
  workspace: Workspace;
  targetId: string;
  onApply: (ops: Operation[], label: string) => boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const threads = commentThreads(workspace, targetId);
  const names = knownMentionNames(workspace);

  const submitThread = () => {
    const ops = addCommentOps(targetId, draft);
    if (ops.length && onApply(ops, "Add comment")) setDraft("");
  };

  const submitReply = (parentId: string) => {
    const ops = replyCommentOps(parentId, replyDraft);
    if (ops.length && onApply(ops, "Reply to comment")) {
      setReplyDraft("");
      setReplyTo(null);
    }
  };

  return (
    <div className="comment-panel" role="dialog" aria-label="Comments">
      <div className="cmt-head">
        <Ico.Comment />
        <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Comments</div>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          {commentAnchorLabel(workspace, targetId).slice(0, 24)}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close comments" aria-label="Close comments">
          <Ico.X />
        </button>
      </div>

      <div className="cmt-threads">
        {threads.length === 0 && <div className="cmt-empty">No comments yet.</div>}
        {threads.map(({ root, replies }) => (
          <div key={root.id} className={`cmt-thread ${root.resolved ? "resolved" : ""}`}>
            <div className="cmt-row">
              <div className="cmt-avatar">{root.by.slice(0, 1).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cmt-meta">
                  <span className="cmt-author">{root.by}</span>
                  <span className="mono cmt-time">{timeLabel(root.createdAt)}</span>
                  {root.resolved && <span className="cmt-resolved-tag">Resolved</span>}
                </div>
                <CommentBody body={root.body} />
              </div>
            </div>

            {replies.map((r) => (
              <div key={r.id} className="cmt-row cmt-reply">
                <div className="cmt-avatar small">{r.by.slice(0, 1).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cmt-meta">
                    <span className="cmt-author">{r.by}</span>
                    <span className="mono cmt-time">{timeLabel(r.createdAt)}</span>
                  </div>
                  <CommentBody body={r.body} />
                </div>
              </div>
            ))}

            {replyTo === root.id ? (
              <div className="cmt-reply-box">
                <input
                  autoFocus
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitReply(root.id);
                    if (e.key === "Escape") setReplyTo(null);
                  }}
                  placeholder="Reply… use @name to mention"
                />
                <button className="cmt-send" onClick={() => submitReply(root.id)}>
                  Reply
                </button>
              </div>
            ) : (
              <div className="cmt-actions">
                <button
                  onClick={() => {
                    setReplyTo(root.id);
                    setReplyDraft("");
                  }}
                >
                  Reply
                </button>
                <button
                  onClick={() =>
                    onApply(
                      resolveCommentOps(root.id, !root.resolved),
                      root.resolved ? "Reopen thread" : "Resolve thread",
                    )
                  }
                >
                  {root.resolved ? "Reopen" : "Resolve"}
                </button>
                <button
                  className="danger"
                  onClick={() => onApply(deleteCommentOps(root.id), "Delete comment")}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="cmt-compose">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitThread();
          }}
          placeholder="Comment… use @name to mention"
        />
        <button className="cmt-send" onClick={submitThread}>
          Send
        </button>
      </div>
      {names.length > 0 && (
        <div className="cmt-names mono">Mentioned here: {names.map((n) => `@${n}`).join(", ")}</div>
      )}
    </div>
  );
}

/**
 * Unresolved-thread markers pinned to their objects. Rendered inside the
 * pan/zoom layer so they track content coordinates.
 */
export function CommentPins({
  workspace,
  onOpen,
}: {
  workspace: Workspace;
  onOpen: (targetId: string) => void;
}) {
  const counts = openCommentCounts(workspace);
  const ids = Object.keys(counts);
  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => {
        const node = workspace.nodes[id];
        const shape = workspace.shapes[id];
        const box =
          node?.position && node.size
            ? { x: node.position.x, y: node.position.y, width: node.size.width }
            : shape
              ? { x: shape.position.x, y: shape.position.y, width: shape.size.width }
              : null;
        if (!box || shape?.hidden) return null;
        return (
          <button
            key={id}
            className="comment-pin"
            style={{ left: box.x + box.width - 6, top: box.y - 10 }}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(id);
            }}
            title={`${counts[id]} open comment${counts[id] === 1 ? "" : "s"}`}
          >
            <Ico.Comment />
            {counts[id]! > 1 && <span className="pin-count">{counts[id]}</span>}
          </button>
        );
      })}
    </>
  );
}

/**
 * Every thread on the board, filterable by state. This is the "advanced
 * comments" surface: per-object pins answer "is there feedback here?", while
 * this answers "what is outstanding across the whole board?".
 */
export function CommentInbox({
  workspace,
  onApply,
  onOpenTarget,
  onClose,
}: {
  workspace: Workspace;
  onApply: (ops: Operation[], label: string) => boolean;
  onOpenTarget: (targetId: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const all = commentThreads(workspace);
  const threads = all.filter((t) =>
    filter === "all" ? true : filter === "open" ? !t.root.resolved : Boolean(t.root.resolved),
  );
  const counts = {
    open: all.filter((t) => !t.root.resolved).length,
    resolved: all.filter((t) => t.root.resolved).length,
    all: all.length,
  };

  return (
    <div className="comment-inbox" role="dialog" aria-label="All comments">
      <div className="cmt-head">
        <Ico.Comment />
        <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>All comments</div>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close" aria-label="Close all comments">
          <Ico.X />
        </button>
      </div>

      <div className="cmt-filters">
        {(["open", "resolved", "all"] as const).map((f) => (
          <button
            key={f}
            className={`cmt-chip ${filter === f ? "active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f[0]!.toUpperCase()}
            {f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>

      <div className="cmt-inbox-list">
        {threads.length === 0 ? (
          <div className="cmt-empty">
            {filter === "open" ? "Nothing outstanding." : "No threads here."}
          </div>
        ) : (
          threads.map(({ root, replies }) => (
            <div key={root.id} className={`cmt-inbox-row ${root.resolved ? "resolved" : ""}`}>
              <button className="cmt-inbox-main" onClick={() => onOpenTarget(root.targetId)}>
                <div className="notif-target mono">
                  {commentAnchorLabel(workspace, root.targetId).slice(0, 30)}
                  {replies.length > 0 &&
                    ` · ${replies.length} repl${replies.length === 1 ? "y" : "ies"}`}
                </div>
                <CommentBody body={root.body} />
              </button>
              <button
                className="cmt-inbox-resolve"
                onClick={() =>
                  onApply(
                    resolveCommentOps(root.id, !root.resolved),
                    root.resolved ? "Reopen thread" : "Resolve thread",
                  )
                }
                title={root.resolved ? "Reopen" : "Resolve"}
              >
                {root.resolved ? "↩" : "✓"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Open @mentions across the board — the minimal notification surface. */
export function NotificationBell({
  workspace,
  onOpenTarget,
}: {
  workspace: Workspace;
  onOpenTarget: (targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const mentions = openMentions(workspace);
  const threads = commentThreads(workspace).filter(
    (t) =>
      !t.root.resolved && (t.root.mentions?.length || t.replies.some((r) => r.mentions?.length)),
  );

  return (
    <>
      <button
        className={`notif-btn ${mentions.length ? "has" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={mentions.length ? `${mentions.length} mentioned` : "No open mentions"}
      >
        <Ico.Comment />
        {mentions.length > 0 && <span className="notif-dot">{threads.length}</span>}
      </button>
      {open && (
        <div className="notif-pop" role="dialog" aria-label="Mentions">
          <div className="notif-head">
            <span style={{ fontSize: 12.5, fontVariationSettings: "'wght' 550" }}>Mentions</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setOpen(false)} aria-label="Close mentions">
              <Ico.X />
            </button>
          </div>
          {threads.length === 0 ? (
            <div className="cmt-empty">No open mentions.</div>
          ) : (
            threads.map((t) => (
              <button
                key={t.root.id}
                className="notif-row"
                onClick={() => {
                  onOpenTarget(t.root.targetId);
                  setOpen(false);
                }}
              >
                <div className="notif-target mono">
                  {commentAnchorLabel(workspace, t.root.targetId).slice(0, 28)}
                </div>
                <div className="notif-body">{t.root.body.slice(0, 70)}</div>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
