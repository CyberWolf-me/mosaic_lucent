import { useState } from "react";
import { TopBar, LeftRail, StatusBadge } from "../ui/Chrome.js";
import { AIPill } from "../ui/AIPill.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { toEr } from "../board/er.js";

/** Entity-relationship view — derived from the semantic graph (docs/15 Phase D).
 * Each node becomes an entity table — its columns from the node's details
 * when it has them (V4) — and edges become labelled relationships. */
export function ErView({
  onOpenSettings,
  embedded = false,
  onSelectPrompt,
  onSendPrompt,
}: {
  onOpenSettings?: (section?: string) => void;
  embedded?: boolean;
  onSelectPrompt?: (text: string) => void;
  onSendPrompt?: (text: string) => void;
}) {
  const { workspace, chat, send, projectName } = useWorkspace();
  const [message, setMessage] = useState("");
  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    void send(text);
  };

  const model = toEr(workspace);

  const erBody =
    model.entities.length === 0 ? (
      <div className="view-empty" style={embedded ? { top: 90, bottom: 96 } : undefined}>
        <div className="view-empty-icon">
          <Ico.Layers />
        </div>
        <h2>No entities yet</h2>
        <p>
          Entity tables derive from your board's nodes, and relationships from the connections
          between them. Describe a data model below and Lucent builds it.
        </p>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 12,
          }}
        >
          {[
            "Create an ER diagram for Users, Orders, Products, and Payments",
            "Generate data model entities",
          ].map((s) => (
            <button
              key={s}
              onClick={() => {
                if (onSendPrompt) onSendPrompt(s);
                else if (onSelectPrompt) onSelectPrompt(s);
                else setMessage(s);
              }}
              style={{
                fontSize: 12,
                color: "var(--ink-2)",
                padding: "6px 12px",
                border: "1px solid var(--stroke-1)",
                borderRadius: 999,
                background: "oklch(from var(--canvas-1) l c h / 0.5)",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    ) : (
      <div
        style={{
          position: "absolute",
          top: 90,
          left: embedded ? 80 : 90,
          right: 30,
          bottom: 96,
          overflow: "auto",
          display: "flex",
          flexWrap: "wrap",
          gap: 24,
          alignContent: "flex-start",
        }}
      >
        {model.entities.map((e) => (
          <div key={e.id} className="er-entity">
            <div className="er-entity-head">{e.label}</div>
            {e.attributes.map((a, i) => (
              <div key={i} className={`er-attr ${a.key ? "key" : ""}`}>
                {a.key ? "🔑 " : ""}
                {a.name}
              </div>
            ))}
            <div className="er-rels">
              {model.relationships
                .filter((r) => r.source === e.id)
                .map((r, i) => (
                  <div key={i} className="er-rel">
                    → {workspace.nodes[r.target]?.label ?? r.target}{" "}
                    <span className="mono">
                      {r.label} · {r.cardinality}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    );

  if (embedded) {
    return (
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <div className="canvas-grid" />
          <div className="canvas-vignette" />
        </div>
        {erBody}
      </div>
    );
  }

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
          { label: "ER diagram", current: true },
        ]}
        onOpenSettings={onOpenSettings ?? (() => {})}
      />
      <LeftRail />

      {erBody}

      <AIPill
        placeholder="Add an entity, a relationship, or transform…"
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        history={chat}
      />
      <StatusBadge>
        <Ico.Layers style={{ color: "var(--ink-3)" }} />
        <span>
          ER · {model.entities.length} entities · {model.relationships.length} relationships
        </span>
      </StatusBadge>
    </div>
  );
}
