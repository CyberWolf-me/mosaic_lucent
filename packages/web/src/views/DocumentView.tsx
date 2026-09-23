import { useState } from "react";
import { TopBar, LeftRail, StatusBadge } from "../ui/Chrome.js";
import { AIPill } from "../ui/AIPill.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { boardToMarkdown } from "../board/serialize.js";

/** Board → Document (docs/15 Phase D). Renders the board as a readable
 * Markdown-style outline; the underlying text is the same boardToMarkdown used
 * for export, so the view and the file stay in sync. */
export function DocumentView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView , projectName } = useWorkspace();
  const [message, setMessage] = useState("");
  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setView("canvas");
    void send(text);
  };

  const md = boardToMarkdown(workspace);
  const lines = md.split("\n");
  const isEmpty =
    Object.keys(workspace.nodes).length === 0 && Object.keys(workspace.shapes).length === 0;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      <TopBar
        crumbs={[
          { label: "Boards", view: "dashboard" },
          { label: projectName || "Untitled board", view: "canvas" },
          { label: "Document", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail />

      {isEmpty ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.Book />
          </div>
          <h2>Nothing to write up yet</h2>
          <p>
            This document is generated from your board — sections come from nodes and groups.
            Describe something below and it will appear here.
          </p>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            top: 90,
            left: "50%",
            transform: "translateX(-50%)",
            width: 720,
            maxWidth: "calc(100vw - 200px)",
            bottom: 96,
            overflow: "auto",
          }}
        >
          <div className="doc-page">
            {lines.map((line, i) => {
              if (line.startsWith("# "))
                return (
                  <h1 key={i} className="doc-h1">
                    {line.slice(2)}
                  </h1>
                );
              if (line.startsWith("## "))
                return (
                  <h2 key={i} className="doc-h2">
                    {line.slice(3)}
                  </h2>
                );
              if (line.startsWith("### "))
                return (
                  <h3 key={i} className="doc-h3">
                    {line.slice(4)}
                  </h3>
                );
              if (line.startsWith("- "))
                return (
                  <div key={i} className="doc-li">
                    • {renderInline(line.slice(2))}
                  </div>
                );
              if (line.trim() === "") return <div key={i} style={{ height: 8 }} />;
              return (
                <div key={i} className="doc-p">
                  {renderInline(line)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <AIPill
        placeholder="Refine the document or ask a question…"
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        history={chat}
      />
      <StatusBadge>
        <Ico.Book style={{ color: "var(--ink-3)" }} />
        <span>Document · {Object.keys(workspace.nodes).length} sections</span>
      </StatusBadge>
    </div>
  );
}

/** Render **bold** and _italic_ inline markers without a full markdown lib. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("_") && p.endsWith("_")) return <em key={i}>{p.slice(1, -1)}</em>;
    return <span key={i}>{p}</span>;
  });
}
