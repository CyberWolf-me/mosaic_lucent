import { useState } from "react";
import { TopBar, StatusBadge } from "../ui/Chrome.js";
import { GlobalRail } from "../ui/atelierAtoms.js";
import { AIPill } from "../ui/AIPill.js";
import { ConnectorDefs } from "../ui/atoms.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { toSequence } from "../board/sequence.js";

/** Sequence diagram — data-driven from the semantic graph (docs/15 Phase D).
 * When the board has nodes, actors/messages derive from them. When it doesn't,
 * an empty state explains that rather than showing a demo flow that reads as
 * real board data; the sample is available behind an explicit toggle. */
export function SequenceView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView } = useWorkspace();
  const [message, setMessage] = useState("");
  const [showSample, setShowSample] = useState(false);
  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setView("canvas");
    void send(text);
  };

  const derived = toSequence(workspace);
  const usingReal = derived.actors.length > 0;

  const DEMO_ACTORS = [
    { id: "user", label: "Customer", x: 160 },
    { id: "web", label: "Web App", x: 340 },
    { id: "api", label: "API", x: 520 },
    { id: "stripe", label: "Stripe", x: 700 },
    { id: "db", label: "Postgres", x: 880 },
  ];
  const DEMO_MESSAGES = [
    { from: "user", to: "web", y: 160, label: 'Click "Place order"', kind: "sync" as const },
    { from: "web", to: "api", y: 210, label: "POST /checkout", kind: "sync" as const },
    { from: "api", to: "stripe", y: 260, label: "Create charge", kind: "sync" as const },
    { from: "stripe", to: "api", y: 310, label: "200 · charge.succeeded", kind: "return" as const },
    { from: "api", to: "db", y: 360, label: "INSERT order", kind: "sync" as const },
    { from: "db", to: "api", y: 410, label: "order_id", kind: "return" as const },
    { from: "api", to: "web", y: 460, label: "201 · Created", kind: "return" as const },
    { from: "web", to: "user", y: 510, label: "Show confirmation", kind: "sync" as const },
  ];

  const showingSample = !usingReal && showSample;
  const actors = usingReal ? derived.actors : DEMO_ACTORS;
  const messages = usingReal ? derived.messages : DEMO_MESSAGES;
  const byId = Object.fromEntries(actors.map((a) => [a.id, a]));
  const bottomY = Math.max(580, MSG_bottom(messages) + 60);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--paper-1)" }}>
      <div className="paper-bg" />
      <div className="paper-grid" />
      <div className="paper-grain" />
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: "Workspace", view: "canvas" },
          { label: "Sequence", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <GlobalRail active="board" onOpenSettings={onOpenSettings} />

      {!usingReal && !showSample ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.Flow />
          </div>
          <h2>No sequence yet</h2>
          <p>
            Actors and messages are derived from your board's nodes and connections. Describe a flow
            below and Lucent builds it, or look at a sample first.
          </p>
          <button className="btn ghost" onClick={() => setShowSample(true)}>
            Show a sample sequence
          </button>
        </div>
      ) : (
        <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
          {showingSample && (
            <div className="sample-banner">
              Sample data — not your board.
              <button onClick={() => setShowSample(false)}>Hide</button>
            </div>
          )}
          <div
            className="frame"
            style={{
              left: 80,
              top: 90,
              width: Math.max(900, (actors.at(-1)?.x ?? 900) + 120),
              height: bottomY - 60,
            }}
          >
            <div className="frame-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Ico.Flow /> {usingReal ? "Sequence · from board" : "Checkout · Sample"}
            </div>
          </div>

          {actors.map((a) => (
            <div key={a.id} style={{ position: "absolute", left: a.x - 60, top: 110, width: 120 }}>
              <div
                className="node"
                style={{ width: "100%", textAlign: "center", padding: "10px 14px" }}
              >
                <div className="node-meta" style={{ justifyContent: "center" }}>
                  <span className="node-dot violet" /> ACTOR
                </div>
                <div className="node-title">{a.label}</div>
              </div>
            </div>
          ))}

          <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            <ConnectorDefs />
            {actors.map((a) => (
              <line
                key={a.id}
                x1={a.x}
                y1={168}
                x2={a.x}
                y2={bottomY}
                stroke="var(--stroke-1)"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            ))}
            {messages.map((m, i) => {
              const from = byId[m.from];
              const to = byId[m.to];
              if (!from || !to) return null;
              const isReturn = m.kind === "return";
              return (
                <line
                  key={i}
                  x1={from.x}
                  y1={m.y}
                  x2={to.x}
                  y2={m.y}
                  stroke={isReturn ? "var(--ink-3)" : "var(--stroke-3)"}
                  strokeWidth={isReturn ? 1 : 1.4}
                  strokeDasharray={isReturn ? "4 3" : ""}
                  markerEnd="url(#arr)"
                />
              );
            })}
          </svg>

          {messages.map((m, i) => {
            const from = byId[m.from];
            const to = byId[m.to];
            if (!from || !to) return null;
            const isReturn = m.kind === "return";
            const cx = (from.x + to.x) / 2;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: cx,
                  top: m.y - 22,
                  transform: "translateX(-50%)",
                  padding: "3px 10px",
                  background: "var(--canvas-1)",
                  border: `1px solid ${isReturn ? "var(--stroke-1)" : "var(--stroke-2)"}`,
                  borderRadius: "var(--r-sm)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: isReturn ? "var(--ink-2)" : "var(--ink-1)",
                  whiteSpace: "nowrap",
                }}
              >
                {m.label}
              </div>
            );
          })}
        </div>
      )}

      <AIPill
        placeholder="Add a step, show alternate path, or transform…"
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        history={chat}
      />
      <StatusBadge>
        <Ico.Flow style={{ color: "var(--ink-3)" }} />
        <span>
          {usingReal
            ? `Sequence · ${messages.length} messages · ${actors.length} actors`
            : showingSample
              ? "Sample sequence"
              : "No sequence yet"}
        </span>
      </StatusBadge>
    </div>
  );
}

function MSG_bottom(messages: { y: number }[]): number {
  return messages.reduce((m, x) => Math.max(m, x.y), 0);
}
