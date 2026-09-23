import { useState } from "react";
import { TopBar, StatusBadge } from "../ui/Chrome.js";
import { GlobalRail } from "../ui/atelierAtoms.js";
import { AIPill } from "../ui/AIPill.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { toEr } from "../board/er.js";

/** Entity-relationship view — derived from the semantic graph (docs/15 Phase D).
 * Each node becomes an entity table; edges become labelled relationships. */
export function ErView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView } = useWorkspace();
  const [message, setMessage] = useState("");
  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setView("canvas");
    void send(text);
  };

  const model = toEr(workspace);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--paper-1)" }}>
      <div className="paper-bg" />
      <div className="paper-grid" />
      <div className="paper-grain" />
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: "Workspace", view: "canvas" },
          { label: "ER diagram", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <GlobalRail active="board" onOpenSettings={onOpenSettings} />

      {model.entities.length === 0 ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.Layers />
          </div>
          <h2>No entities yet</h2>
          <p>
            Entity tables derive from your board's nodes, and relationships from the connections
            between them. Describe a data model below and Lucent builds it.
          </p>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            top: 90,
            left: 90,
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
              {e.attributes.map((a) => (
                <div key={a.name} className={`er-attr ${a.key ? "key" : ""}`}>
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
      )}

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
