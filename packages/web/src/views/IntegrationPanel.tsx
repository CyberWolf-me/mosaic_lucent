import { useMemo, useState } from "react";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import {
  decideIntegrationAction,
  proposeIntegration,
  type IntegrationDecisionResult,
  type IntegrationLink,
  type IntegrationPreview,
} from "../boards.js";
import { resolveLocale, t } from "@lucent/i18n";

/**
 * The external-action panel (Stage D6, ADR 0032): the D5 frozen-preview
 * shape RENDERED, not redesigned — the statement verbatim in the request
 * slot, creates as add-rows (title · assignee · dueDate · status), updates
 * as mod-rows (externalId · title), Approve/Reject in the foot, and the
 * post-approve results with their ↗ links. The connection-changed 409
 * renders as the panel's error (the review's safety check made visible).
 *
 * Opened from the Intelligence header's Sync button (whole-board — the
 * propose route's own semantics; per-node propose does not exist).
 */

export function IntegrationPanel({
  provider,
  connections,
  onClose,
  onLinksChanged,
}: {
  provider: string;
  connections: Array<{ provider: string; status: string; config?: Record<string, string> }>;
  onClose: () => void;
  onLinksChanged: () => void;
}) {
  const { boardId } = useWorkspace() as unknown as { boardId: string | null };
  const locale = useMemo(() => resolveLocale(navigator.language), []);
  const [preview, setPreview] = useState<IntegrationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<IntegrationDecisionResult | null>(null);
  const [links, setLinks] = useState<IntegrationLink[] | null>(null);

  const connection = connections.find((c) => c.provider === provider);
  const teamLabel = connection?.config?.teamId
    ? t("integrations.team", locale, { team: connection.config.teamId })
    : "";

  const propose = async () => {
    if (!boardId) return;
    setBusy(true);
    setError(null);
    const result = await proposeIntegration(boardId, provider);
    setBusy(false);
    if (result === null) {
      setError(t("integrations.error.offline", locale));
      return;
    }
    if ("error" in result) {
      setError(result.error ?? "propose failed");
      return;
    }
    setPreview(result);
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!boardId || !preview) return;
    setBusy(true);
    setError(null);
    const result = await decideIntegrationAction(boardId, preview.action.id, decision);
    setBusy(false);
    if (result === null) {
      setError(t("integrations.error.offline", locale));
      return;
    }
    if ("error" in result) {
      setError(result.error ?? "decision failed");
      return;
    }
    setResults(result);
    onLinksChanged();
  };

  const close = () => {
    if (results) {
      // After a decision the chips must appear — the caller refetches links.
    }
    onClose();
  };

  const entryStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderRadius: 8,
    background: active ? "var(--canvas-3)" : "transparent",
  });

  const header = (text: string): React.ReactNode => (
    <div
      className="mono"
      style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-3)", padding: "10px 12px 4px" }}
    >
      {text}
    </div>
  );

  return (
    <div
      role="dialog"
      aria-label={t("integrations.panel.title", locale, { provider })}
      style={{
        position: "absolute",
        top: 76,
        bottom: 30,
        left: 76,
        right: 30,
        display: "grid",
        gridTemplateColumns: "minmax(420px, 520px) 1fr",
        gap: 18,
        zIndex: 40,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          background: "oklch(from var(--canvas-2) l c h / 0.9)",
          border: "1px solid var(--stroke-2)",
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
          <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550", flex: 1 }}>
            {t("integrations.panel.title", locale, { provider })}
          </div>
          {teamLabel && (
            <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
              {teamLabel}
            </span>
          )}
          <button className="icon-btn" title="Close" onClick={close}>
            ✕
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: 6, flex: 1 }}>
          {/* The connection-state UX (the review's ask): never pretend the
              feature is self-service when the admin route is API-only. */}
          {!connection && (
            <div className="mono" style={{ padding: 24, fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
              {t("integrations.not_connected", locale, { provider })}
            </div>
          )}
          {connection && connection.status !== "active" && (
            <div className="mono" style={{ padding: 24, fontSize: 12, color: "var(--sig-red)", textAlign: "center" }}>
              {t("integrations.connection_disabled", locale, { provider })}
            </div>
          )}
          {connection && connection.status === "active" && !preview && !results && (
            <div className="mono" style={{ padding: 24, fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>
              {t("integrations.panel.hint", locale)}
            </div>
          )}

          {preview && (
            <>
              {header(t("integrations.preview.statement", locale))}
              <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--ink-1)", lineHeight: 1.5 }}>
                {preview.preview.statement}
              </div>
              {preview.preview.creates.length > 0 && header(
                t("integrations.preview.creates", locale, { n: preview.preview.creates.length }),
              )}
              {preview.preview.creates.map((c) => (
                <div key={c.nodeId} style={entryStyle(false)}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--sig-green)" }}>＋</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink-0)" }}>{c.title}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      {[c.assignee, c.dueDate, c.status].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
              ))}
              {preview.preview.updates.length > 0 && header(
                t("integrations.preview.updates", locale, { n: preview.preview.updates.length }),
              )}
              {preview.preview.updates.map((u) => (
                <div key={u.nodeId} style={entryStyle(false)}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--amber-2)" }}>↺</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: "var(--ink-0)" }}>{u.title}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      {[u.externalId, u.status].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}

          {results && (
            <>
              {header(t("integrations.results.title", locale))}
              <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--ink-1)" }}>
                {results.duplicate
                  ? t("integrations.results.duplicate", locale)
                  : t("integrations.results.counts", locale, {
                      applied: results.applied ?? 0,
                      failed: results.failed ?? 0,
                    })}
              </div>
              {results.results?.map((r, i) => (
                <div key={i} style={entryStyle(false)}>
                  <span className="mono" style={{ fontSize: 10, color: r.action === "failed" ? "var(--sig-red)" : "var(--sig-green)" }}>
                    {r.action === "failed" ? "✕" : "✓"}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-1)" }}>
                      {String(r.nodeId)} → {String(r.externalId ?? r.action)}
                    </div>
                    {typeof r.url === "string" && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mono"
                        style={{ fontSize: 10, color: "var(--amber-2)" }}
                      >
                        ↗ {String(r.externalId ?? r.url)}
                      </a>
                    )}
                    {typeof r.reason === "string" && (
                      <div className="mono" style={{ fontSize: 10, color: "var(--sig-red)" }}>
                        {r.reason}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {error && (
            <div className="mono" style={{ padding: "10px 12px", fontSize: 11, color: "var(--sig-red)" }}>
              {error}
            </div>
          )}
        </div>

        {connection && connection.status === "active" && (
          <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--stroke-1)" }}>
            {!preview && !results && (
              <button className="btn amber" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={propose}>
                {busy ? "…" : t("integrations.panel.propose", locale)}
              </button>
            )}
            {preview && !results && (
              <>
                <button className="btn amber" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => decide("approve")}>
                  {busy ? "…" : t("integrations.panel.approve", locale)}
                </button>
                <button className="btn" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => decide("reject")}>
                  {t("integrations.panel.reject", locale)}
                </button>
              </>
            )}
            {results && (
              <button className="btn" style={{ height: 28, fontSize: 12 }} onClick={close}>
                {t("integrations.panel.done", locale)}
              </button>
            )}
          </div>
        )}
      </div>

      {/* The right pane: what this panel means (the context slot). */}
      <div
        style={{
          background: "oklch(from var(--canvas-2) l c h / 0.75)",
          border: "1px solid var(--stroke-1)",
          borderRadius: 16,
          padding: 24,
          fontSize: 12.5,
          color: "var(--ink-2)",
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontSize: 13, color: "var(--ink-0)", fontVariationSettings: "'wght' 550", marginBottom: 10 }}>
          {t("integrations.context.title", locale)}
        </div>
        <p>{t("integrations.context.body", locale)}</p>
      </div>
    </div>
  );
}
