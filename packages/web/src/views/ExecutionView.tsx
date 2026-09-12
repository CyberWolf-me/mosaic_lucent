import { useEffect, useMemo, useState } from "react";
import type { Workspace } from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { executionProjection, planDerivedActionIds } from "../execution.js";
import { IntegrationPanel } from "./IntegrationPanel.js";
import { fetchIntegrationLinks, fetchOrgIntegrations, type IntegrationLink } from "../boards.js";
import { getCurrentOrgId } from "../orgs.js";
import { resolveLocale, t } from "@lucent/i18n";

/** The provider display names, the Intelligence header's own map. */
const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  linear: "Linear",
  github: "GitHub",
  jira: "Jira",
  fake: "Fake",
};

/** Local mirror of what left Lucent (UX-3 execution ledger). */
const SYNC_LEDGER_KEY = "lucent.syncLedger";

function readSyncLedger(): IntegrationLink[] {
  try {
    const raw = localStorage.getItem(SYNC_LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IntegrationLink[]) : [];
  } catch {
    return [];
  }
}

function writeSyncLedger(links: IntegrationLink[]): void {
  try {
    localStorage.setItem(SYNC_LEDGER_KEY, JSON.stringify(links));
  } catch {
    /* storage full or unavailable: the server list remains the truth */
  }
}

/**
 * The Execution view (Stage E2, ADR 0037): one screen answering "how is
 * the work going and what's blocking us". Three surfaces over one pure
 * projection (execution.ts — node-tested per the web suite's convention):
 *
 * - the rollup header — percent complete, a thin progress bar, and the
 *   five counts (completed / in progress / blocked / at risk / overdue);
 *   at-risk keeps ADR 0029's distinction — an analytical signal with a
 *   tooltip, never a status;
 * - "What's blocking us" — per blocked node, its chain rendered as label
 *   chips (blocker → … → target), each chip a reveal jump to the canvas;
 * - "Decisions behind the work" — the E1 payoff made visible: for every
 *   in-progress/blocked action with drives edges, the row
 *   "action ← decision".
 *
 * Pure client-side by design, the Intelligence doctrine applied to
 * execution: no fetches, no routes, no stores — the view renders what the
 * projection decides, and the empty state teaches the loop ("Ask Lucent
 * to create the work, then track it here").
 */
export function ExecutionView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, onCitation, projectName } = useWorkspace() as unknown as {
    workspace: Workspace;
    onCitation: WorkspaceState["onCitation"];
    projectName: string;
  };
  const locale = useMemo(() => resolveLocale(navigator.language), []);
  // The whole dashboard is one pure projection of the workspace — derived
  // per render, never stored (ADR 0027).
  const projection = useMemo(
    () => executionProjection(workspace, Date.now()),
    [workspace],
  );
  const { rollup, chains, decisionsBehind, empty, attention } = projection;
  // Stage E3: the bridge — the plan-derived action ids a Send-to-provider
  // button carries, and the org's active connections to offer.
  const bridgeIds = useMemo(() => planDerivedActionIds(workspace), [workspace]);
  const [connections, setConnections] = useState<
    Array<{ provider: string; status: string; supportsInbound?: boolean }>
  >([]);
  const [panelProvider, setPanelProvider] = useState<string | null>(null);
  const { boardId } = useWorkspace() as unknown as { boardId: string | null };
  // UX-3 execution ledger: what left Lucent. Server links are the truth;
  // localStorage keeps the last seen list for offline reads.
  const [syncLedger, setSyncLedger] = useState<IntegrationLink[]>(() => readSyncLedger());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgId = getCurrentOrgId();
      const orgs = orgId ? await fetchOrgIntegrations(orgId) : [];
      if (cancelled) return;
      setConnections(orgs);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      const links = await fetchIntegrationLinks(boardId);
      if (cancelled) return;
      setSyncLedger(links);
      writeSyncLedger(links);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  if (empty) {
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <div className="canvas-grid" />
          <div className="canvas-vignette" />
        </div>
        {/* The shared shell on the empty state too (P1-IA-001): the hint says
            "ask Lucent to create the work", and the way back to the composer
            must be one click, not a dead end. */}
        <TopBar
          crumbs={[
            { label: "Personal" },
            { label: projectName, view: "canvas" },
            { label: "Execution", current: true },
          ]}
          onOpenSettings={onOpenSettings}
        />
        <LeftRail onOpenSettings={onOpenSettings} />
        <div
          style={{
            position: "absolute",
            top: 76,
            bottom: 30,
            left: 76,
            right: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "oklch(from var(--canvas-2) l c h / 0.75)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 16,
              padding: "36px 44px",
              textAlign: "center",
              maxWidth: 420,
            }}
          >
            <Ico.Gauge style={{ color: "var(--ink-3)" }} />
            <div style={{ fontSize: 14, fontVariationSettings: "'wght' 550", marginTop: 12 }}>
              {t("exec.empty.title", locale)}
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
              {t("exec.empty.hint", locale)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const counts: Array<{ label: string; value: number; color: string; title?: string }> = [
    { label: t("exec.counts.completed", locale), value: rollup.completed, color: "var(--sig-green, #3fb950)" },
    { label: t("exec.counts.inProgress", locale), value: rollup.inProgress, color: "var(--ink-0)" },
    { label: t("exec.counts.blocked", locale), value: rollup.blocked, color: "var(--sig-red)" },
    {
      label: t("exec.counts.atRisk", locale),
      value: rollup.atRisk,
      color: "var(--amber-2)",
      title: t("exec.atRisk.title", locale),
    },
    { label: t("exec.counts.overdue", locale), value: rollup.overdue, color: "var(--sig-red)" },
  ];

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      {/* The shared shell, like every other full surface (P1-IA-001). */}
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: projectName, view: "canvas" },
          { label: "Execution", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail onOpenSettings={onOpenSettings} />
      <div
        style={{
          position: "absolute",
          top: 76,
          bottom: 30,
          left: 76,
          right: 30,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          overflow: "auto",
        }}
      >
      {/* — The rollup header: percent + the progress bar + the counts — */}
      <div
        style={{
          background: "oklch(from var(--canvas-2) l c h / 0.75)",
          border: "1px solid var(--stroke-1)",
          borderRadius: 16,
          padding: "16px 20px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Ico.Gauge style={{ color: "var(--amber-2)" }} />
          <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
            {t("exec.title", locale)}
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {rollup.total} action{rollup.total === 1 ? "" : "s"}
          </span>
          <span style={{ flex: 1 }} />
          {/* Stage E3: the create-the-work bridge — one Send button per
              ACTIVE connection, offered only when the board holds
              plan-derived actions. The panel's Propose carries the ids
              through the propose-ai narrowing; the approve gate, the
              warnings ack, and the exactly-once ledger all apply as on
              any external action. */}
          {bridgeIds.length > 0 &&
            connections
              .filter((c) => c.status === "active")
              .map((c) => {
                const name = PROVIDER_DISPLAY_NAME[c.provider] ?? c.provider;
                return (
                  <button
                    key={c.provider}
                    className="btn"
                    style={{ height: 24, fontSize: 11 }}
                    title={`${t("integrations.send.to", locale, { provider: name })} — ${bridgeIds.length} plan-derived action${bridgeIds.length === 1 ? "" : "s"}`}
                    onClick={() => setPanelProvider(c.provider)}
                  >
                    {t("integrations.send.to", locale, { provider: name })}
                  </button>
                );
              })}
          <div style={{ fontSize: 22, fontVariationSettings: "'wght' 650" }}>
            {rollup.percent}%
          </div>
        </div>
        {/* The thin progress bar: completed over total, the one number a
            stakeholder asks for first. */}
        <div
          style={{
            marginTop: 10,
            height: 4,
            borderRadius: 2,
            background: "var(--stroke-2)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${rollup.percent}%`,
              height: "100%",
              background: "var(--sig-green, #3fb950)",
              transition: "width 240ms ease",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            gap: 22,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          {counts.map((c) => (
            <div
              key={c.label}
              title={c.title}
              style={{ display: "flex", alignItems: "baseline", gap: 6 }}
            >
              <span className="mono" style={{ fontSize: 15, color: c.color }}>
                {c.value}
              </span>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {c.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* — What needs my attention (Phase 3): the four signals, each item a
          reveal jump to its node — the review's "needs attention" surface.
          Renders only when something actually needs it. — */}
      {attention.items.length > 0 && (
        <div
          style={{
            background: "oklch(from var(--canvas-2) l c h / 0.75)",
            border: "1px solid var(--stroke-1)",
            borderRadius: 14,
            padding: "16px 20px",
            marginBottom: 18,
          }}
        >
          <div
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: "0.08em" }}
          >
            {t("exec.attention.title", locale)}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {attention.items.map((item) => (
              <button
                key={`${item.kind}-${item.nodeId}`}
                className="btn ghost"
                style={{ fontSize: 11, height: 26, padding: "0 10px" }}
                title={item.reason}
                onClick={() => onCitation({ kind: "node", id: item.nodeId })}
              >
                {item.kind === "blocked" ? "⚠" : item.kind === "overdue" ? "⏰" : item.kind === "openDecision" ? "?" : "✦"}{" "}
                {item.label}
                <span style={{ color: "var(--ink-3)" }}> — {item.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, flex: 1, minHeight: 0 }}>
        {/* — What's blocking us: the chains, blocker-first, every chip a jump — */}
        <div
          style={{
            background: "oklch(from var(--canvas-2) l c h / 0.75)",
            border: "1px solid var(--stroke-1)",
            borderRadius: 16,
            padding: "14px 18px",
            overflow: "auto",
          }}
        >
          <div style={{ fontSize: 12.5, fontVariationSettings: "'wght' 550", marginBottom: 10 }}>
            {t("exec.blocking.title", locale)}
          </div>
          {chains.length === 0 ? (
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {t("exec.blocking.empty", locale)}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {chains.map((chain) => (
                <div
                  key={chain.nodeId}
                  style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
                >
                  {chain.chain.map((node, i) => (
                    <span key={`${chain.nodeId}-${node.id}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {i > 0 && (
                        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          →
                        </span>
                      )}
                      <button
                        className="mono"
                        title={node.id}
                        onClick={() => onCitation({ kind: "node", id: node.id })}
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 8,
                          border: `1px solid ${i === chain.chain.length - 1 ? "var(--sig-red)" : "var(--stroke-2)"}`,
                          background: "transparent",
                          color: i === chain.chain.length - 1 ? "var(--sig-red)" : "var(--ink-0)",
                          cursor: "pointer",
                        }}
                      >
                        {node.label}
                      </button>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* — Decisions behind the work: the E1 payoff made visible — */}
        <div
          style={{
            background: "oklch(from var(--canvas-2) l c h / 0.75)",
            border: "1px solid var(--stroke-1)",
            borderRadius: 16,
            padding: "14px 18px",
            overflow: "auto",
          }}
        >
          <div style={{ fontSize: 12.5, fontVariationSettings: "'wght' 550", marginBottom: 10 }}>
            {t("exec.decisions.title", locale)}
          </div>
          {decisionsBehind.length === 0 ? (
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {t("exec.decisions.empty", locale)}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {decisionsBehind.map((row) => (
                <div
                  key={`${row.actionId}-${row.decisionId}`}
                  style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                >
                  <button
                    className="mono"
                    title={row.actionId}
                    onClick={() => onCitation({ kind: "node", id: row.actionId })}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 8,
                      border: "1px solid var(--stroke-2)",
                      background: "transparent",
                      color: "var(--ink-0)",
                      cursor: "pointer",
                    }}
                  >
                    {row.actionLabel}
                  </button>
                  <span className="mono" style={{ fontSize: 11, color: "var(--amber-2)" }}>
                    ←
                  </span>
                  <button
                    className="mono"
                    title={row.decisionId}
                    onClick={() => onCitation({ kind: "node", id: row.decisionId })}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 8,
                      border: "1px solid var(--amber-2)",
                      background: "transparent",
                      color: "var(--amber-2)",
                      cursor: "pointer",
                    }}
                  >
                    {row.decisionLabel}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* — UX-3 execution ledger: what left Lucent (approved external sends) — */}
      <div
        style={{
          background: "oklch(from var(--canvas-2) l c h / 0.75)",
          border: "1px solid var(--stroke-1)",
          borderRadius: 16,
          padding: "14px 18px",
        }}
      >
        <div style={{ fontSize: 12.5, fontVariationSettings: "'wght' 550" }}>
          Sent externally — what left Lucent
        </div>
        {syncLedger.length === 0 ? (
          <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
            Nothing sent externally yet — approved sends appear here.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
            {syncLedger.map((link) => (
              <div
                key={`${link.provider}-${link.externalId}-${link.nodeId}`}
                style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
              >
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-0)" }}>
                  {link.externalId}
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {link.provider} · {link.status}
                </span>
                {link.url && (
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                    style={{ fontSize: 11, color: "var(--amber-2)" }}
                  >
                    ↗ open
                  </a>
                )}
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {new Date(link.syncedAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {panelProvider && (
        <IntegrationPanel
          provider={panelProvider}
          connections={connections}
          nodeIds={bridgeIds}
          onClose={() => setPanelProvider(null)}
          onLinksChanged={() => {
            // Links refetch is the Board surface's concern; the panel's
            // own results view carries the outcome here.
          }}
        />
      )}
      </div>
    </div>
  );
}
