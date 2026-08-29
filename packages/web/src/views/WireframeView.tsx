import { useState } from "react";
import { TopBar, LeftRail, StatusBadge } from "../ui/Chrome.js";
import { AIPill } from "../ui/AIPill.js";
import { Ico } from "../ui/icons.js";
import { WireframeRenderer } from "../ui/WireframeRenderer.js";
import { useWorkspace } from "../workspace.js";
import type { Wireframe } from "@lucent/core";

const VIEWPORT_SIZE: Record<Wireframe["viewport"], { w: number; label: string }> = {
  desktop: { w: 820, label: "Desktop · 1440" },
  tablet: { w: 620, label: "Tablet · 834" },
  mobile: { w: 360, label: "Mobile · 390" },
};

/** Wireframe artifact. Now data-driven: renders real workspace.wireframes
 * produced by CREATE_WIREFRAME operations (docs/03, docs/05). Falls back to a
 * prompt when none exist yet. */
export function WireframeView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView } = useWorkspace();
  const [message, setMessage] = useState("");

  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    // A generated wireframe lands on the canvas as a CREATE_WIREFRAME op; switch
    // there so the result is visible instead of silently changing the board
    // behind this view (matches ER/Sequence/Document).
    setView("canvas");
    void send(text);
  };

  const wireframes = Object.values(workspace.wireframes);
  const wireframe = wireframes[0];
  const size = wireframe ? VIEWPORT_SIZE[wireframe.viewport] : VIEWPORT_SIZE.desktop;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: "Workspace", view: "canvas" },
          { label: wireframe?.title ?? "Wireframe", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail />

      {wireframe ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 76,
            bottom: 96,
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            overflow: "auto",
            padding: "0 40px",
          }}
        >
          <div
            className="frame"
            style={{
              position: "relative",
              width: size.w,
              margin: "0 auto",
              padding: "32px 16px 16px",
            }}
          >
            <div className="frame-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Ico.Grid /> {wireframe.title} · Wireframe · {size.label}
            </div>
            <div className="wf-browser">
              <div className="wf-browser-bar">
                <span className="wf-dot" />
                <span className="wf-dot" />
                <span className="wf-dot" />
                <div className="wf-url">shop.example.com/checkout</div>
              </div>
              <div className="wf-canvas">
                <WireframeRenderer wireframe={wireframe} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: "0 40px",
          }}
        >
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 12,
              background: "var(--canvas-3)",
              display: "grid",
              placeItems: "center",
              color: "var(--ink-2)",
            }}
          >
            <Ico.Grid />
          </div>
          <h2
            style={{
              fontSize: 22,
              letterSpacing: "-0.02em",
              color: "var(--ink-0)",
              textAlign: "center",
            }}
          >
            No wireframe yet
          </h2>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--ink-2)",
              maxWidth: 420,
              textAlign: "center",
              lineHeight: 1.55,
            }}
          >
            Describe a screen and Lucent builds an editable wireframe from your workspace — try
            "design a checkout wireframe".
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {[
              "Design a checkout wireframe",
              "Wireframe a dashboard with a sidebar",
              "Mock up a sign-in screen",
            ].map((s) => (
              <button
                key={s}
                onClick={() => setMessage(s)}
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  padding: "6px 12px",
                  border: "1px solid var(--stroke-1)",
                  borderRadius: 999,
                  background: "oklch(from var(--canvas-1) l c h / 0.5)",
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <AIPill
        placeholder={
          wireframe
            ? "Refine the wireframe — 'move payment above shipping'…"
            : "Describe a screen to wireframe…"
        }
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        history={chat}
      />
      <StatusBadge>
        <Ico.Grid style={{ color: "var(--ink-3)" }} />
        <span>{wireframe ? size.label : "No wireframe"}</span>
      </StatusBadge>
    </div>
  );
}
