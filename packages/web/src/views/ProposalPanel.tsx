import { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import type { Operation } from "@lucent/core";

/** Proposal review panel, ported from reference/screen_proposing.jsx and wired
 * to the real pending proposal + apply-as-one-commit action (docs/15). */
export function ProposalPanel() {
  const { proposal, applyProposal, cancelProposal, chat } = useWorkspace();
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCancel = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      cancelProposal();
    }, 180);
  }, [closing, cancelProposal]);

  const handleApply = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(() => {
      applyProposal();
    }, 180);
  }, [closing, applyProposal]);

  useEffect(() => {
    if (!proposal || closing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleApply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proposal, closing, handleCancel, handleApply]);

  if (!proposal) return null;

  const changes = proposal.operations.map(describe);
  // Partial-application honesty (M1/UX-2): the gate or the server may have
  // skipped ops while proposing the rest. The proposal record itself carries
  // no skipped list, so fall back to the review-gate reply in chat.
  const proposalSkipped = (
    proposal as unknown as { skippedOps?: Array<{ op: string; reason: string }> }
  ).skippedOps;
  const chatSkipped = [...chat].reverse().find((e) => (e.skippedOps?.length ?? 0) > 0)?.skippedOps;
  const skipped = proposalSkipped ?? chatSkipped ?? [];

  return (
    <div className={`right-panel ${closing ? "leaving" : ""}`}>
      <div className="panel-head">
        <div>
          <div className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: "var(--r-sm)",
                background: "linear-gradient(135deg, var(--amber-2), var(--amber-3))",
                display: "grid",
                placeItems: "center",
                color: "var(--canvas-0)",
              }}
            >
              <Ico.Sparkle />
            </span>
            Lucent proposes {proposal.operations.length} changes
          </div>
          <div className="panel-sub">Preview · applies what still fits · reports the rest</div>
          {skipped.length > 0 && (
            <div className="mono" style={{ fontSize: 10.5, color: "var(--amber-2)", marginTop: 4 }}>
              {skipped.length} change{skipped.length === 1 ? "" : "s"} didn&apos;t fit — see chat
              for details
            </div>
          )}
        </div>
        <button className="icon-btn" style={{ padding: 6, height: 28 }} onClick={handleCancel}>
          <Ico.X />
        </button>
      </div>
      <div className="panel-body">
        <div
          style={{
            padding: 12,
            borderRadius: 8,
            background: "oklch(from var(--canvas-2) l c h / 0.6)",
            border: "1px solid var(--stroke-1)",
            marginBottom: 10,
            fontSize: 12,
            color: "var(--ink-1)",
            lineHeight: 1.55,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Request
          </div>
          "{proposal.request}"
        </div>
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            margin: "10px 4px 8px",
          }}
        >
          Proposed edits
        </div>
        {changes.map((c, i) => (
          <div key={i} className="change-item">
            <span className={`change-op ${c.op}`}>{c.op}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="change-title">{c.title}</div>
              <div className="change-sub">{c.sub}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        <button className="btn ghost" onClick={handleCancel} title="Cancel proposal (Esc)">
          Cancel <span style={{ opacity: 0.6, fontSize: 10, marginLeft: 4 }}>Esc</span>
        </button>
        <button
          className="btn amber"
          onClick={handleApply}
          title="Apply all changes (⌘Enter or Ctrl+Enter)"
        >
          <Ico.Check /> Apply all{" "}
          <span style={{ opacity: 0.8, fontSize: 10, marginLeft: 4 }}>⌘↵</span>
        </button>
      </div>
    </div>
  );
}

type OpBadge = "add" | "mod" | "del" | "move";

function describe(op: Operation): { op: OpBadge; title: string; sub: string } {
  switch (op.op) {
    case "CREATE_NODE":
      return { op: "add", title: op.label, sub: `New ${op.nodeType}` };
    case "DELETE_NODE":
      return { op: "del", title: op.id, sub: "Remove node" };
    case "CONNECT_NODES":
      return { op: "add", title: `${op.source} → ${op.target}`, sub: op.relationship };
    case "DISCONNECT_NODES":
      return { op: "del", title: `${op.source} → ${op.target}`, sub: "Remove connection" };
    case "CHANGE_TEXT":
      return { op: "mod", title: op.id, sub: `Rename to "${op.text}"` };
    case "CHANGE_NODE_TYPE":
      return { op: "mod", title: op.id, sub: `Change type to ${op.nodeType}` };
    case "SET_ISSUE":
      return op.issue
        ? { op: "mod", title: op.id, sub: `${op.issue.type} · ${op.issue.status}` }
        : { op: "del", title: op.id, sub: "Clear issue fields" };
    case "UPDATE_ISSUE":
      return {
        op: "mod",
        title: op.id,
        sub: op.status ? `Move to ${op.status}` : "Update issue",
      };
    case "SET_STATEMENT":
      return op.statement
        ? {
            op: "mod",
            title: op.id,
            sub: `${op.statement.kind} · ${op.statement.status}${op.statement.topic ? ` · ${op.statement.topic}` : ""}`,
          }
        : { op: "del", title: op.id, sub: "Clear statement" };
    case "UPDATE_STATEMENT":
      return {
        op: "mod",
        title: op.id,
        sub: op.status
          ? `Statement → ${op.status}`
          : op.supersedes
            ? `Supersedes ${op.supersedes.join(", ")}`
            : "Update statement",
      };
    case "MOVE_NODE":
      return { op: "move", title: op.id, sub: "Reposition node" };
    case "CREATE_GROUP":
      return { op: "add", title: op.label, sub: `Group ${op.children.length} nodes` };
    case "DELETE_GROUP":
      return { op: "del", title: op.id, sub: "Remove group" };
    case "CREATE_DIAGRAM":
      return { op: "mod", title: op.kind, sub: "Set diagram kind" };
    case "SET_GROUP_KIND":
      return {
        op: "mod",
        title: op.id,
        sub: op.kind ? `Region kind → ${op.kind}` : "Clear region kind",
      };
    case "TRANSFORM_DIAGRAM":
      return { op: "move", title: op.to, sub: "Transform representation" };
    case "SET_LAYOUT_INTENT": {
      const parts: string[] = [];
      if (op.direction) parts.push(op.direction);
      if (op.primaryFlow) parts.push(`spine ×${op.primaryFlow.length}`);
      if (op.emphasis) parts.push(`emphasis ×${op.emphasis.length}`);
      return {
        op: "mod",
        title: op.direction ?? "Layout intent",
        sub: parts.length > 0 ? parts.join(" · ") : "Clear layout intent",
      };
    }
    case "CREATE_WIREFRAME":
      return { op: "add", title: op.title, sub: `New ${op.viewport} wireframe` };
    case "DELETE_WIREFRAME":
      return { op: "del", title: op.id, sub: "Remove wireframe" };
    case "CREATE_SHAPE":
      return { op: "add", title: op.text || op.kind, sub: `New ${op.kind}` };
    case "UPDATE_SHAPE":
      return { op: "mod", title: op.id, sub: "Edit shape" };
    case "DELETE_SHAPE":
      return { op: "del", title: op.id, sub: "Remove shape" };
    case "CONNECT_SHAPES":
      return { op: "add", title: `${op.source} → ${op.target}`, sub: op.label ?? "Link" };
    case "UPDATE_LINK":
      return { op: "mod", title: op.id, sub: "Edit connector" };
    case "DISCONNECT_SHAPES":
      return { op: "del", title: op.id, sub: "Remove link" };
    case "GROUP_SHAPES":
      return { op: "mod", title: op.groupId, sub: `Group ${op.ids.length} shapes` };
    case "UNGROUP_SHAPES":
      return { op: "mod", title: op.groupId, sub: "Ungroup shapes" };
    case "ADD_VOTE":
      return { op: "add", title: op.targetId, sub: "Vote" };
    case "REMOVE_VOTE":
      return { op: "del", title: op.id, sub: "Remove vote" };
    case "CLEAR_VOTES":
      return { op: "del", title: op.targetId ?? "board", sub: "Clear votes" };
    case "ADD_REACTION":
      return { op: "add", title: op.targetId, sub: `React ${op.emoji}` };
    case "REMOVE_REACTION":
      return { op: "del", title: op.id, sub: "Remove reaction" };
    case "ADD_COMMENT":
      return { op: "add", title: op.targetId, sub: `Comment: ${op.body.slice(0, 40)}` };
    case "REPLY_COMMENT":
      return { op: "add", title: op.parentId, sub: `Reply: ${op.body.slice(0, 40)}` };
    case "RESOLVE_COMMENT":
      return { op: "mod", title: op.id, sub: op.resolved ? "Resolve thread" : "Reopen thread" };
    case "DELETE_COMMENT":
      return { op: "del", title: op.id, sub: "Delete comment" };
  }
}
