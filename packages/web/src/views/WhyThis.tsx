import { useState } from "react";
import { useWorkspace } from "../workspace.js";

/**
 * UX-2 "Why this?" — the audit answer for one node: who made it and from
 * what evidence. There is no core op that clears node provenance (CREATE_NODE
 * stamps it once; SET_STATEMENT only replaces statement evidence), so Unlink
 * is deliberately absent — Copy quote + Undo cover the honest actions.
 */
export function WhyThis({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { workspace, setView, undo, onCitation } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const node = workspace.nodes[nodeId];

  if (!node) {
    return (
      <div className="why-this" role="dialog" aria-label="Why this">
        <div style={{ fontSize: 12.5, color: "var(--ink-1)" }}>Node not found.</div>
        <button className="btn ghost" onClick={onClose} style={{ marginTop: 8 }}>
          Close
        </button>
      </div>
    );
  }

  const provenance = node.provenance ?? node.statement?.provenance;
  const createdBy = provenance ? "Lucent" : "human";
  const meetingId = provenance?.meetingId;
  const turnRange = provenance?.turnRange;
  const quote = provenance?.quote;
  const createdFrom = provenance?.createdFrom ?? [];

  const viewSource = () => {
    if (!meetingId) return;
    try {
      onCitation({ kind: "meeting", id: meetingId, ...(turnRange ? { turnRange } : {}) });
    } catch {
      setView("meeting");
    }
  };

  const copyQuote = async () => {
    if (!quote) return;
    try {
      await navigator.clipboard.writeText(quote);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className="why-this"
      role="dialog"
      aria-label={`Why this node: ${node.label}`}
      style={{
        border: "1px solid var(--stroke-1)",
        borderRadius: 12,
        padding: "12px 14px",
        background: "oklch(from var(--canvas-2) l c h / 0.85)",
        maxWidth: 320,
      }}
    >
      <div style={{ fontSize: 12.5, fontVariationSettings: "'wght' 550" }}>{node.label}</div>
      <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
        Created by {createdBy}
      </div>
      {meetingId && (
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-1)", marginTop: 6 }}>
          Meeting: {meetingId}
        </div>
      )}
      {turnRange && (
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-1)", marginTop: 2 }}>
          Turns {turnRange[0]}–{turnRange[1]}
        </div>
      )}
      {quote && (
        <div style={{ fontSize: 12, color: "var(--ink-1)", fontStyle: "italic", marginTop: 8 }}>
          “{quote}”
        </div>
      )}
      {createdFrom.length > 0 && (
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
          From: {createdFrom.join(", ")}
        </div>
      )}
      {!provenance && (
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
          No recorded source — created by hand.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {meetingId && (
          <button className="btn amber" style={{ height: 28, fontSize: 12 }} onClick={viewSource}>
            View source
          </button>
        )}
        {quote && (
          <button
            className="btn ghost"
            style={{ height: 28, fontSize: 12 }}
            onClick={() => void copyQuote()}
          >
            {copied ? "Copied" : "Copy quote"}
          </button>
        )}
        <button
          className="btn ghost"
          style={{ height: 28, fontSize: 12 }}
          onClick={() => {
            undo();
            onClose();
          }}
        >
          Undo
        </button>
        <button className="btn ghost" style={{ height: 28, fontSize: 12 }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
