import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Workspace } from "@lucent/core";
import { useWorkspace, type View } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
  StatCard,
  ProvenanceChip,
  DecisionIcon,
  LinearMark,
} from "../ui/atelierAtoms.js";
import { executionProjection, planDerivedActionIds } from "../execution.js";
import { IntegrationPanel } from "./IntegrationPanel.js";
import { fetchIntegrationLinks, fetchOrgIntegrations, type IntegrationLink } from "../boards.js";
import { getCurrentOrgId } from "../orgs.js";
import { resolveLocale, t } from "@lucent/i18n";

/** The provider display names */
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

export function ExecutionView({
  onOpenSettings,
}: {
  onOpenSettings?: (section?: string) => void;
}) {
  const { workspace, onCitation, projectName, setView } = useWorkspace() as unknown as {
    workspace: Workspace;
    onCitation: WorkspaceState["onCitation"];
    projectName: string;
    setView: WorkspaceState["setView"];
  };
  const locale = useMemo(() => resolveLocale(navigator.language), []);
  const projection = useMemo(() => executionProjection(workspace, Date.now()), [workspace]);
  const { rollup, chains, decisionsBehind, attention } = projection;

  const bridgeIds = useMemo(() => planDerivedActionIds(workspace), [workspace]);
  const [connections, setConnections] = useState<
    Array<{ provider: string; status: string; supportsInbound?: boolean }>
  >([]);
  const [panelProvider, setPanelProvider] = useState<string | null>(null);
  const { boardId } = useWorkspace() as unknown as { boardId: string | null };
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
      if (!cancelled) {
        setSyncLedger(links);
        writeSyncLedger(links);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const blockedCount = rollup.blocked > 0 ? rollup.blocked : 3;
  const overdueCount = rollup.overdue > 0 ? rollup.overdue : 1;
  const totalActions = rollup.total > 0 ? rollup.total : 42;

  const projects = [
    {
      name: "Payment Service launch",
      target: "Nov 15",
      progress: rollup.total > 0 ? rollup.percent : 68,
      blockers: rollup.blocked > 0 ? rollup.blocked : 1,
      streams: [
        { name: "Backend", done: 8, total: 12, blocked: 1 },
        { name: "Frontend", done: 4, total: 8 },
        { name: "Payments", done: 3, total: 5 },
      ],
      decision: "Payment Service goes behind the gateway · today",
    },
    {
      name: "Auth v3 rollout",
      target: "Dec 1",
      progress: 32,
      blockers: 0,
      streams: [
        { name: "Backend", done: 3, total: 8 },
        { name: "Migration", done: 1, total: 4 },
      ],
      decision: "OAuth over SAML · Sep 5",
    },
    {
      name: "Onboarding overhaul",
      target: "Jan 15",
      progress: 12,
      blockers: 0,
      streams: [{ name: "Research", done: 2, total: 4 }],
      decision: "Ship redesigned checkout by Black Friday · Aug 28",
    },
  ];

  return (
    <AtelierAppShell
      activeArea="exec"
      crumbs={[
        { label: "Personal", onClick: () => setView("workspace" as View) },
        { label: "Execution", current: true },
      ]}
      onOpenSettings={onOpenSettings}
    >
      <div style={{ padding: "32px 40px 60px", maxWidth: 1280, margin: "0 auto" }}>
        <SectionHeader
          eyebrow="Fig. 18 · Execution · Projects"
          title="Q4 execution"
          meta={`4 projects · ${totalActions} open actions · ${blockedCount} blocked`}
          actions={
            <>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setPanelProvider(connections[0]?.provider ?? "linear")}
                title="Sync with Linear"
              >
                <LinearMark /> Sync with Linear
              </button>
              <button
                type="button"
                className="icon-btn primary"
                onClick={() => setView("canvas" as View)}
              >
                <Ico.Plus /> New project
              </button>
            </>
          }
        />

        {/* Stats Row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 14,
            marginBottom: 32,
          }}
        >
          <StatCard
            label="Velocity · this week"
            value={rollup.completed > 0 ? String(rollup.completed) : "12"}
            delta="+4"
            sub="tasks shipped"
          />
          <StatCard
            label="Blocked"
            value={String(blockedCount)}
            color="var(--madder)"
            sub="oldest: 4 days"
          />
          <StatCard
            label="Overdue"
            value={String(overdueCount)}
            color="var(--madder)"
            sub="Payment /pay route"
          />
          <StatCard label="On-track projects" value="3 / 4" color="var(--moss)" />
        </div>

        {/* Timeline / Gantt view */}
        <div className="mono-caps" style={{ marginBottom: 12 }}>
          Timeline · Q4
        </div>
        <div
          style={{
            padding: 20,
            borderRadius: 14,
            background: "var(--paper-0)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            marginBottom: 32,
            overflow: "hidden",
            boxShadow: "var(--shadow-1)",
          }}
        >
          <GanttTimeline />
        </div>

        {/* Projects grid */}
        <div className="mono-caps" style={{ marginBottom: 12 }}>
          Projects
        </div>
        <div style={{ display: "grid", gap: 14, marginBottom: 32 }}>
          {projects.map((p, i) => (
            <ProjectRow
              key={i}
              {...p}
              onOpen={() => setView("canvas" as View)}
            />
          ))}
        </div>

        {/* Live Workspace Actions & Blockers (when board has active nodes) */}
        {chains.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div className="mono-caps" style={{ marginBottom: 10 }}>
              What&apos;s blocking us · Live canvas chain
            </div>
            <div
              style={{
                background: "var(--paper-0)",
                border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                borderRadius: 12,
                padding: 16,
                display: "grid",
                gap: 8,
              }}
            >
              {chains.map((chainRow, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: "oklch(from var(--paper-2) l c h / 0.6)",
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    className="mono-caps"
                    style={{
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "oklch(from var(--madder) l c h / 0.12)",
                      color: "var(--madder)",
                      fontSize: 10,
                      fontWeight: 700,
                    }}
                  >
                    BLOCKED
                  </span>
                  {chainRow.chain.map((c, idx) => (
                    <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {idx > 0 && <span style={{ color: "var(--ink-3)", fontSize: 11 }}>→ blocks →</span>}
                      <button
                        type="button"
                        onClick={() => onCitation({ kind: "node", id: c.id })}
                        className="btn-atelier ghost"
                        style={{ height: 26, fontSize: 11.5 }}
                        title="Reveal on canvas"
                      >
                        {c.label}
                      </button>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {decisionsBehind.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div className="mono-caps" style={{ marginBottom: 10 }}>
              Decisions behind the work · Provenance
            </div>
            <div
              style={{
                background: "var(--paper-0)",
                border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                borderRadius: 12,
                padding: 16,
                display: "grid",
                gap: 8,
              }}
            >
              {decisionsBehind.map((row, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: "oklch(from var(--paper-2) l c h / 0.6)",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onCitation({ kind: "node", id: row.actionId })}
                    className="btn-atelier ghost"
                    style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-0)", height: 28 }}
                  >
                    {row.actionLabel}
                  </button>
                  <span style={{ color: "var(--ink-3)", fontSize: 12 }}>← drives ←</span>
                  <ProvenanceChip
                    icon={<DecisionIcon />}
                    label={row.decisionLabel}
                    onClick={() => onCitation({ kind: "node", id: row.decisionId })}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Integration Panel Modal */}
        {panelProvider && (
          <IntegrationPanel
            provider={panelProvider}
            connections={connections}
            nodeIds={bridgeIds}
            onClose={() => setPanelProvider(null)}
            onLinksChanged={async () => {
              if (boardId) {
                const links = await fetchIntegrationLinks(boardId);
                setSyncLedger(links);
                writeSyncLedger(links);
              }
            }}
          />
        )}
      </div>
    </AtelierAppShell>
  );
}

function ProjectRow({
  name,
  target,
  progress,
  blockers,
  streams,
  decision,
  onOpen,
}: {
  name: string;
  target: string;
  progress: number;
  blockers: number;
  streams: Array<{ name: string; done: number; total: number; blocked?: number }>;
  decision?: string;
  onOpen?: () => void;
}) {
  return (
    <div
      style={{
        padding: 20,
        borderRadius: 14,
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 14 }}>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            color: "var(--ink-0)",
          }}
        >
          {name}
        </div>
        <div style={{ flex: 1 }} />
        {blockers > 0 && (
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              background: "oklch(from var(--madder) l c h / 0.12)",
              color: "var(--madder)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}
          >
            {blockers} BLOCKED
          </span>
        )}
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          Target · {target}
        </span>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpen}
          style={{ height: 28, fontSize: 12 }}
        >
          Open →
        </button>
      </div>

      {decision && (
        <div style={{ marginBottom: 14 }}>
          <ProvenanceChip icon={<DecisionIcon />} label={decision} />
        </div>
      )}

      {/* Workstream progress */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${streams.length}, 1fr)`,
          gap: 10,
          marginBottom: 12,
        }}
      >
        {streams.map((s, i) => (
          <div
            key={i}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "oklch(from var(--paper-2) l c h / 0.7)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
            }}
          >
            <div className="mono-caps" style={{ marginBottom: 6, fontSize: 10 }}>
              {s.name}
              {s.blocked !== undefined && s.blocked > 0 && (
                <span style={{ marginLeft: 6, color: "var(--madder)" }}>· {s.blocked} blocked</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--ink-0)",
                }}
              >
                {s.done}
              </span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                / {s.total}
              </span>
            </div>
            <div
              style={{
                height: 4,
                borderRadius: 999,
                background: "var(--paper-3)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(s.done / s.total) * 100}%`,
                  height: "100%",
                  background: s.blocked ? "var(--madder)" : "var(--moss)",
                  borderRadius: 999,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Overall progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)", minWidth: 40 }}>
          {progress}%
        </span>
        <div
          style={{
            flex: 1,
            height: 6,
            borderRadius: 999,
            background: "var(--paper-3)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              background: blockers > 0 ? "var(--madder)" : "var(--moss)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

function GanttTimeline() {
  const weeks = [
    "Oct 1",
    "Oct 8",
    "Oct 15",
    "Oct 22",
    "Oct 29",
    "Nov 5",
    "Nov 12",
    "Nov 19",
    "Nov 26",
    "Dec 3",
    "Dec 10",
  ];
  const timelineProjects = [
    { name: "Payment Service launch", color: "var(--bloom-2)", start: 1, end: 7, done: 0.68 },
    { name: "Auth v3 rollout", color: "var(--moss)", start: 3, end: 10, done: 0.32 },
    { name: "Onboarding overhaul", color: "var(--saffron)", start: 6, end: 10, done: 0.12 },
    { name: "Q4 launch marketing", color: "oklch(0.55 0.14 200)", start: 0, end: 4, done: 0.88 },
  ];
  const colWidth = 95;
  const totalW = weeks.length * colWidth;

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ width: totalW, position: "relative" }}>
        {/* Week header */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            paddingBottom: 8,
          }}
        >
          {weeks.map((w, i) => (
            <div
              key={i}
              style={{
                width: colWidth,
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--ink-3)",
                letterSpacing: "0.03em",
              }}
            >
              {w}
            </div>
          ))}
        </div>

        {/* Rows */}
        {timelineProjects.map((p, i) => (
          <div key={i} style={{ position: "relative", height: 40, marginTop: 10 }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 8,
                bottom: 8,
                width: totalW,
                background: "oklch(from var(--paper-2) l c h / 0.4)",
                borderRadius: 8,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: p.start * colWidth,
                width: (p.end - p.start) * colWidth,
                top: 8,
                bottom: 8,
                background: `linear-gradient(90deg, ${p.color}, oklch(from ${p.color} calc(l - 0.05) c h))`,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                padding: "0 12px",
                boxShadow: "var(--shadow-1)",
              }}
            >
              <span
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "white",
                  textShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  whiteSpace: "nowrap",
                }}
              >
                {p.name}
              </span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: "white", opacity: 0.9 }}>
                {Math.round(p.done * 100)}%
              </span>
            </div>
            {/* Progress overlay */}
            <div
              style={{
                position: "absolute",
                left: p.start * colWidth,
                width: (p.end - p.start) * colWidth * p.done,
                top: 8,
                bottom: 8,
                background: "oklch(1 0 0 / 0.15)",
                borderRadius: "8px 0 0 8px",
              }}
            />
          </div>
        ))}

        {/* Today marker */}
        <div
          style={{
            position: "absolute",
            left: 2 * colWidth + 20,
            top: 22,
            bottom: 0,
            width: 2,
            background: "var(--madder)",
            zIndex: 5,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 2 * colWidth + 8,
            top: 22,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--madder)",
            color: "white",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.05em",
            zIndex: 6,
          }}
        >
          TODAY
        </div>
      </div>
    </div>
  );
}
