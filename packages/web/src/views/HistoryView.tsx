import { useState } from "react";
import { Ico } from "../ui/icons.js";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { DiagramLayer } from "../ui/DiagramLayer.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";

/** Version history, ported from reference/screen_history.jsx and wired to the
 * real History.timeline() from @lucent/core. */
export function HistoryView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { history, undo, redo, canUndo, canRedo, restoreVersion, setView } = useWorkspace();
  const { notify } = useToast();
  const entries = history.timeline();
  const [selected, setSelected] = useState(entries.length - 1);
  const current = entries[Math.min(selected, entries.length - 1)];

  const restore = () => {
    restoreVersion(selected);
    setView("canvas");
  };

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
          { label: "History", current: true },
        ]}
        onOpenSettings={onOpenSettings}
        actions={
          <>
            <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label="Undo">
              <Ico.Undo />
            </button>
            <button className="icon-btn" onClick={redo} disabled={!canRedo} aria-label="Redo">
              <Ico.Redo />
            </button>
            <div style={{ width: 6 }} />
            <button className="icon-btn primary" onClick={restore} disabled={entries.length <= 1}>
              Restore version
            </button>
          </>
        }
      />
      <LeftRail />

      {entries.length <= 1 ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.History />
          </div>
          <h2>No history yet</h2>
          <p>
            Every AI change and manual edit becomes a version you can inspect and restore. Make a
            change on the canvas and it will show up here.
          </p>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            top: 76,
            bottom: 30,
            left: 76,
            right: 30,
            display: "grid",
            gridTemplateColumns: "420px 1fr",
            gap: 18,
          }}
        >
          <div
            style={{
              background: "oklch(from var(--canvas-2) l c h / 0.75)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 16,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--stroke-1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Timeline</div>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {entries.length} versions
              </span>
            </div>
            <div
              className="panel-body"
              style={{ flex: 1, overflowY: "auto", padding: "10px 8px 20px" }}
            >
              {entries.map((e, i) => {
                const isSel = i === selected;
                const isAi =
                  e.label !== "initial" && e.label !== "loaded" && !e.label.startsWith("Transform");
                return (
                  <div key={i} style={{ display: "flex", gap: 12, position: "relative" }}>
                    <div style={{ width: 24, position: "relative", flexShrink: 0 }}>
                      {i < entries.length - 1 && (
                        <div
                          style={{
                            position: "absolute",
                            top: 22,
                            bottom: -6,
                            left: 11,
                            width: 1,
                            background: "var(--stroke-1)",
                          }}
                        />
                      )}
                      <div
                        style={{
                          position: "absolute",
                          top: 10,
                          left: 6,
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: isAi
                            ? "linear-gradient(135deg, var(--amber-2), var(--amber-3))"
                            : "var(--canvas-3)",
                          border: `1px solid ${isAi ? "oklch(0.82 0.15 75 / 0.5)" : "var(--stroke-2)"}`,
                          boxShadow: isAi ? "0 0 8px var(--amber-glow)" : "none",
                        }}
                      />
                    </div>
                    <button
                      onClick={() => setSelected(i)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        padding: "8px 12px",
                        marginBottom: 4,
                        borderRadius: 8,
                        background: isSel ? "var(--canvas-3)" : "transparent",
                        border: `1px solid ${isSel ? "var(--stroke-2)" : "transparent"}`,
                      }}
                    >
                      <div
                        style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}
                      >
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                          {new Date(e.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--ink-0)",
                            fontVariationSettings: "'wght' 500",
                            flex: 1,
                          }}
                        >
                          {e.label}
                        </span>
                        {i === entries.length - 1 && (
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              color: "var(--sig-green)",
                              padding: "2px 6px",
                              borderRadius: 3,
                              background: "oklch(0.78 0.11 155 / 0.12)",
                              border: "1px solid oklch(0.78 0.11 155 / 0.25)",
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                            }}
                          >
                            Now
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        {Object.keys(e.workspace.nodes).length} nodes ·{" "}
                        {Object.keys(e.workspace.edges).length} edges
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              background: "var(--canvas-0)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 16,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--stroke-1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                  {current?.label ?? "—"}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}
                >
                  Version #{selected + 1}
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <button
                className="icon-btn"
                style={{ height: 28, fontSize: 11.5 }}
                onClick={() => notify("Side-by-side version compare is coming soon.")}
              >
                Compare
              </button>
              <button
                className="icon-btn primary"
                style={{ height: 28, fontSize: 11.5 }}
                onClick={restore}
              >
                Restore
              </button>
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  transform: "scale(0.6)",
                  transformOrigin: "center",
                }}
              >
                {current && <DiagramLayer workspace={current.workspace} />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
