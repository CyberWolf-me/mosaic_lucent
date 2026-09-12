import { useMemo } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { buildAttention, type AttentionItem } from "../attention.js";

/**
 * UX-3 attention queue panel: every item is a jump to the thing itself.
 * Accepts prebuilt items, or derives them from live workspace state when
 * omitted (proposal + skipped ops from chat).
 */
export function AttentionPanel({ items: provided }: { items?: AttentionItem[] }) {
  const { workspace, proposal, chat, setView } = useWorkspace();

  const items = useMemo<AttentionItem[]>(() => {
    if (provided) return provided;
    const skippedCount =
      [...chat].reverse().find((e) => (e.skippedOps?.length ?? 0) > 0)?.skippedOps?.length ?? 0;
    return buildAttention(workspace, {
      proposal: proposal
        ? { operations: proposal.operations, request: proposal.request }
        : null,
      skippedCount,
      disconnected: false,
    });
  }, [provided, workspace, proposal, chat]);

  const go = (item: AttentionItem) => {
    if (item.target.reveal) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("reveal", item.target.reveal);
        if (item.target.lens) url.searchParams.set("lens", item.target.lens);
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* non-browser or opaque URL: navigation still works */
      }
    } else if (item.target.lens) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("lens", item.target.lens);
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* ignore */
      }
    }
    setView(item.target.view as View);
  };

  if (items.length === 0) {
    return (
      <div className="attention-panel" role="status">
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          All clear — nothing needs review.
        </div>
      </div>
    );
  }

  return (
    <div className="attention-panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item) => (
        <button
          key={item.id}
          className="btn ghost"
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            textAlign: "left",
            height: "auto",
            padding: "8px 10px",
          }}
          title={item.detail}
          onClick={() => go(item)}
        >
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {item.kind}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-0)" }}>{item.title}</span>
            {item.detail && (
              <span
                className="mono"
                style={{ display: "block", fontSize: 10.5, color: "var(--ink-3)" }}
              >
                {item.detail}
              </span>
            )}
          </span>
          {typeof item.count === "number" && (
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-1)" }}>
              {item.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
