import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { DIAGRAM_KINDS, representationLabel, type DiagramKind, type Operation } from "@lucent/core";

/**
 * A diagram kind as the reviewer reads it ("State machine", not
 * "statemachine"), from the representation registry. Guarded because a
 * pending proposal is restored from localStorage — a record written by a build
 * that knew a kind this one does not must still render, as its raw id.
 */
function kindLabel(kind: DiagramKind): string {
  return (DIAGRAM_KINDS as readonly string[]).includes(kind)
    ? representationLabel(kind)
    : String(kind);
}

/**
 * Proposal review panel, styled in the Atelier design system and wired
 * to the real pending proposal + apply-as-one-commit action (docs/15).
 */
/**
 * `docked`: in the page's flow instead of floating over its right edge — the
 * meeting view, whose own panel (transcript, notes) lives on that edge and was
 * hidden behind a pending proposal.
 */
export function ProposalPanel({ docked = false }: { docked?: boolean } = {}) {
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

  const changes = useMemo(() => {
    if (!proposal) return [];
    return proposal.operations.map(describe);
  }, [proposal]);

  const additions = useMemo(() => changes.filter((c) => c.op === "add"), [changes]);
  const modifications = useMemo(
    () => changes.filter((c) => c.op === "mod" || c.op === "move"),
    [changes],
  );
  const removals = useMemo(() => changes.filter((c) => c.op === "del"), [changes]);

  if (!proposal) return null;

  // Partial-application honesty (M1/UX-2): the gate or the server may have
  // skipped ops while proposing the rest. The proposal record itself carries
  // no skipped list, so fall back to the review-gate reply in chat.
  const proposalSkipped = (
    proposal as unknown as { skippedOps?: Array<{ op: string; reason: string }> }
  ).skippedOps;
  const chatSkipped = [...chat].reverse().find((e) => (e.skippedOps?.length ?? 0) > 0)?.skippedOps;
  const skipped = proposalSkipped ?? chatSkipped ?? [];

  return (
    <div
      role="dialog"
      aria-label="Proposed changes"
      className={`right-panel${docked ? " docked" : ""} ${closing ? "leaving" : ""}`}
      style={{
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.8)",
        boxShadow: "var(--shadow-3)",
      }}
    >
      <div
        className="panel-head"
        style={{ borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div className="panel-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  background: "var(--bloom-wash)",
                  display: "grid",
                  placeItems: "center",
                  color: "var(--bloom-2)",
                }}
              >
                <Ico.Sparkle style={{ width: 13, height: 13 }} />
              </span>
              <span>Lucent proposes {proposal.operations.length} changes</span>
            </div>
            <div className="panel-sub" style={{ marginTop: 4 }}>
              Preview · applies what fits · reports remainder
            </div>
            {skipped.length > 0 && (
              <div
                className="mono"
                style={{ fontSize: 10.5, color: "var(--amber-2)", marginTop: 4 }}
              >
                {skipped.length} change{skipped.length === 1 ? "" : "s"} didn&apos;t fit — see chat
                for details
              </div>
            )}
          </div>
          <button
            type="button"
            className="icon-btn"
            style={{
              padding: 6,
              height: 28,
              color: "var(--ink-3)",
              background: "none",
              border: 0,
              cursor: "pointer",
            }}
            onClick={handleCancel}
            title="Dismiss proposal (Escape)"
          >
            <Ico.X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>

      <div className="panel-body">
        {/* Request prompt card */}
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: "var(--paper-1)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
            marginBottom: 14,
            fontSize: 12.5,
            color: "var(--ink-1)",
            lineHeight: 1.5,
          }}
        >
          <div
            className="mono-caps"
            style={{
              fontSize: 9.5,
              color: "var(--ink-3)",
              marginBottom: 4,
            }}
          >
            {proposal.turns?.length ? "From the meeting" : "Origin Prompt"}
          </div>
          {/* A meeting-captured batch was asked for by an internal extraction
              prompt, not a person — show what was actually said instead. */}
          {proposal.turns?.length ? (
            <div style={{ display: "grid", gap: 4 }}>
              {proposal.turns.slice(-4).map((turn, i) => (
                <div key={i}>&ldquo;{turn}&rdquo;</div>
              ))}
            </div>
          ) : (
            <>&ldquo;{proposal.request}&rdquo;</>
          )}
        </div>

        {/* Additions Section */}
        {additions.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div
              className="mono-caps"
              style={{ color: "var(--moss)", marginBottom: 6, fontSize: 10 }}
            >
              {additions.length} addition{additions.length === 1 ? "" : "s"}
            </div>
            {additions.map((c, i) => (
              <div key={`add-${i}`} className="change-item">
                <span className="change-op add">Add</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="change-title">{c.title}</div>
                  <div className="change-sub">{c.sub}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Modifications Section */}
        {modifications.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div
              className="mono-caps"
              style={{ color: "var(--bloom-2)", marginBottom: 6, fontSize: 10 }}
            >
              {modifications.length} modification{modifications.length === 1 ? "" : "s"}
            </div>
            {modifications.map((c, i) => (
              <div key={`mod-${i}`} className="change-item">
                <span className={`change-op ${c.op}`}>{c.op === "move" ? "Move" : "Mod"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="change-title">{c.title}</div>
                  <div className="change-sub">{c.sub}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Removals Section */}
        {removals.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div
              className="mono-caps"
              style={{ color: "var(--madder)", marginBottom: 6, fontSize: 10 }}
            >
              {removals.length} removal{removals.length === 1 ? "" : "s"}
            </div>
            {removals.map((c, i) => (
              <div key={`del-${i}`} className="change-item">
                <span className="change-op del">Del</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="change-title"
                    style={{ textDecoration: "line-through", opacity: 0.8 }}
                  >
                    {c.title}
                  </div>
                  <div className="change-sub">{c.sub}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className="panel-foot"
        style={{
          borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
          padding: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="btn-atelier ghost"
          onClick={handleCancel}
          title="Cancel proposal (Esc)"
          style={{ height: 32, fontSize: 12 }}
        >
          Cancel{" "}
          <span className="mono" style={{ opacity: 0.6, fontSize: 10, marginLeft: 4 }}>
            Esc
          </span>
        </button>
        <button
          type="button"
          className="btn-atelier primary"
          onClick={handleApply}
          title="Apply all changes (⌘Enter or Ctrl+Enter)"
          style={{ height: 32, fontSize: 12, padding: "0 14px" }}
        >
          <Ico.Check style={{ width: 14, height: 14 }} />
          <span>Apply all</span>
          <span className="mono" style={{ opacity: 0.8, fontSize: 10, marginLeft: 4 }}>
            ⌘↵
          </span>
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
    case "SET_NODE_ICON":
      return op.icon
        ? { op: "mod", title: op.id, sub: `Icon: ${op.icon.split(":")[1]}` }
        : { op: "mod", title: op.id, sub: "Automatic icon" };
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
      return { op: "mod", title: kindLabel(op.kind), sub: "Set diagram kind" };
    case "SET_GROUP_KIND":
      return {
        op: "mod",
        title: op.id,
        sub: op.kind ? `Region kind → ${kindLabel(op.kind)}` : "Clear region kind",
      };
    case "TRANSFORM_DIAGRAM":
      return { op: "move", title: kindLabel(op.to), sub: "Transform representation" };
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
    default: {
      // An operation this panel has no wording for yet (one newer than this
      // list): still listed, by its target and name — the review must never
      // hide a change it is asking the person to approve.
      const other = op as { op: string; id?: unknown };
      return {
        op: "mod",
        title: typeof other.id === "string" ? other.id : other.op,
        sub: other.op,
      };
    }
  }
}
