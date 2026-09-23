import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StatementKind, Workspace } from "@lucent/core";
import { resolveLocale, t } from "@lucent/i18n";
import { useWorkspace, type View } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
  FilterBar,
  ProvenanceChip,
  DecisionIcon,
  ActionIcon,
  RiskIcon,
  QuestionIcon,
  LinearMark,
} from "../ui/atelierAtoms.js";
import {
  intelligenceSections,
  inboxItems,
  isSettled,
  mergeOps,
  suppressionKey,
  type InboxItem,
  type IntelligenceRow,
} from "../intelligence.js";
import { planRequestText } from "../planGate.js";
import {
  fetchInboundChanges,
  fetchIntegrationLinks,
  fetchOrgIntegrations,
  type InboundChangeView,
  type IntegrationLink,
} from "../boards.js";
import { getCurrentOrgId } from "../orgs.js";
import { IntegrationPanel } from "./IntegrationPanel.js";

type IntelTab = "decisions" | "actions" | "questions" | "risks" | "knowledge";

interface DecisionDisplay {
  id?: string;
  title: string;
  status: "active" | "review" | "pending" | "superseded";
  owner: string;
  ownerColor: string;
  date: string;
  evidence?: string;
  from?: { icon?: ReactNode; label: string };
  superseded?: string;
  nodeId?: string;
}

const DEMO_DECISIONS: DecisionDisplay[] = [
  {
    title: "Payment Service goes behind the API gateway",
    status: "active",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    date: "14:32 today",
    evidence: "Behind the gateway — same as everything else.",
    from: { label: "Checkout review · today" },
  },
  {
    title: "Guest checkout is the default checkout path",
    status: "active",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    date: "14:32 today",
    evidence: "No forced signup — biggest drop-off in the funnel.",
    from: { label: "Checkout review · today" },
  },
  {
    title: "Support Klarna as a payment method at launch",
    status: "review",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    date: "14:34 today",
    evidence: "Klarna alone lifted conversion 8% at Northbeam.",
    from: { label: "Checkout review · today" },
  },
  {
    title: "Silent retry policy on Stripe intermittency",
    status: "active",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    date: "14:36 today",
    evidence: "Two retries before showing an error.",
    from: { label: "Checkout review · today" },
  },
  {
    title: "Defer Klarna support to Q1 2027",
    status: "superseded",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    date: "Sep 12",
    superseded: "today's decision",
    evidence: "Not enough eng bandwidth for Q4.",
    from: { label: "Product review · Sep 12" },
  },
  {
    title: "Standardize on Postgres 16 for all services",
    status: "active",
    owner: "Kim",
    ownerColor: "oklch(0.55 0.16 300)",
    date: "Sep 8",
    from: { label: "Data platform review" },
  },
  {
    title: "OAuth over SAML for enterprise auth in v3",
    status: "active",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    date: "Sep 5",
    evidence: "SAML complexity not worth it for our tier.",
    from: { label: "Auth v3 kickoff" },
  },
  {
    title: "Ship redesigned checkout by Black Friday",
    status: "active",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    date: "Aug 28",
    from: { label: "Q4 planning" },
  },
  {
    title: "Move analytics to ClickHouse",
    status: "pending",
    owner: "Marco",
    ownerColor: "oklch(0.55 0.14 200)",
    date: "Aug 22",
    evidence: "Query latency has become untenable.",
    from: { label: "Data platform" },
  },
];

interface ActionDisplay {
  title: string;
  owner: string;
  ownerColor: string;
  due?: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  project?: string;
  decision?: string;
  external?: string;
  status?: "todo" | "doing" | "blocked" | "done";
  nodeId?: string;
}

const DEMO_ACTIONS: ActionDisplay[] = [
  {
    title: "Draft cart-review wireframes (screens 1–2)",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    due: "Fri",
    priority: "P1",
    project: "Payment launch",
    decision: "Guest checkout default",
  },
  {
    title: "Integrate Klarna sandbox in staging",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    due: "Mon",
    priority: "P0",
    project: "Payment launch",
    external: "LIN-482",
    decision: "Klarna at launch",
    status: "doing",
  },
  {
    title: "Add /pay route to API Gateway",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    due: "OVERDUE · yesterday",
    priority: "P0",
    project: "Payment launch",
    external: "LIN-476",
    status: "blocked",
  },
  {
    title: "Spec gift-wrapping micro-flow",
    owner: "Sarah",
    ownerColor: "oklch(0.55 0.11 220)",
    due: "Wed",
    priority: "P2",
    project: "Payment launch",
  },
  {
    title: "Validate 3DS callback in Stripe test mode",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    due: "Tomorrow",
    priority: "P1",
    project: "Payment launch",
    decision: "Silent retry policy",
  },
  {
    title: "Announce checkout redesign in #product",
    owner: "Alex",
    ownerColor: "oklch(0.55 0.16 25)",
    due: "Next Mon",
    priority: "P3",
    project: "Payment launch",
  },
  {
    title: "Migrate users table to Postgres 16",
    owner: "Kim",
    ownerColor: "oklch(0.55 0.16 300)",
    due: "Oct 15",
    priority: "P1",
    project: "DB migration",
    decision: "Postgres 16 standard",
    status: "done",
  },
  {
    title: "Deprecate legacy auth endpoints",
    owner: "John",
    ownerColor: "oklch(0.55 0.14 148)",
    due: "Nov 1",
    priority: "P2",
    project: "Auth v3",
    decision: "OAuth over SAML",
    status: "done",
  },
];

export function IntelligenceView({
  onOpenSettings,
}: {
  onOpenSettings?: (section?: string) => void;
}) {
  const { workspace, onCitation, send, boardId, setView, view } =
    useWorkspace() as unknown as {
      workspace: Workspace;
      onCitation: WorkspaceState["onCitation"];
      send: WorkspaceState["send"];
      boardId: string | null;
      setView: WorkspaceState["setView"];
      view: View;
    };
  const [activeTab, setActiveTab] = useState<IntelTab>("decisions");
  // The global rail and command palette navigate by `view` key (decisions /
  // actions / ask / knowledge). Without this sync every one of them landed on
  // the Decisions tab, so "Actions" and "Ask" in the rail were dead ends.
  useEffect(() => {
    const map: Partial<Record<View, IntelTab>> = {
      decisions: "decisions",
      actions: "actions",
      ask: "knowledge",
      knowledge: "knowledge",
    };
    const next = map[view];
    if (next) setActiveTab(next);
  }, [view]);
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [actionScope, setActionScope] = useState("mine");
  const [detailDecision, setDetailDecision] = useState<DecisionDisplay | null>(null);

  // External sync connections
  const [connections, setConnections] = useState<
    Array<{ provider: string; status: string; supportsInbound?: boolean }>
  >([]);
  const [panelProvider, setPanelProvider] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgId = getCurrentOrgId();
      if (orgId) {
        const orgs = await fetchOrgIntegrations(orgId);
        if (!cancelled) setConnections(orgs);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Merge live workspace statements with canonical demo lists
  const sections = useMemo(() => intelligenceSections(workspace), [workspace]);

  const liveDecisions: DecisionDisplay[] = useMemo(() => {
    const decSection = sections.find((s) => s.kind === "decision");
    const propSection = sections.find((s) => s.kind === "proposal");
    const rows = [...(decSection?.rows ?? []), ...(propSection?.rows ?? [])];
    if (rows.length === 0) return DEMO_DECISIONS;

    const mapped: DecisionDisplay[] = rows.map((r) => ({
      id: r.id,
      nodeId: r.id,
      title: r.label,
      status: (isSettled(r.status) ? "active" : r.status === "superseded" ? "superseded" : "review") as "active" | "review" | "pending" | "superseded",
      owner: r.assignee || "Alex",
      ownerColor: "oklch(0.55 0.16 25)",
      date: "today",
      evidence: r.topic || "Extracted from workspace canvas",
      from: { label: "Canvas statement" },
    }));
    const existing = new Set(mapped.map((d) => d.title.toLowerCase()));
    const extra = DEMO_DECISIONS.filter((d) => !existing.has(d.title.toLowerCase()));
    return [...mapped, ...extra];
  }, [sections]);

  const liveActions: ActionDisplay[] = useMemo(() => {
    const actSection = sections.find((s) => s.kind === "action");
    const rows = actSection?.rows ?? [];
    if (rows.length === 0) return DEMO_ACTIONS;

    const mapped: ActionDisplay[] = rows.map((r) => ({
      nodeId: r.id,
      title: r.label,
      owner: r.assignee || "Alex",
      ownerColor: "oklch(0.55 0.16 25)",
      due: r.dueDate || "Fri",
      priority: "P1",
      status: r.executionStatus === "in_progress" ? "doing" : r.executionStatus === "blocked" ? "blocked" : "todo",
      decision: r.topic,
    }));
    const existing = new Set(mapped.map((a) => a.title.toLowerCase()));
    const extra = DEMO_ACTIONS.filter((a) => !existing.has(a.title.toLowerCase()));
    return [...mapped, ...extra];
  }, [sections]);

  // Tab labels for crumbs
  const tabLabelMap: Record<IntelTab, string> = {
    decisions: "Decisions",
    actions: "Actions",
    questions: "Questions",
    risks: "Risks",
    knowledge: "Knowledge · Ask",
  };

  return (
    <AtelierAppShell
      activeArea="intel"
      crumbs={[
        { label: "Personal", onClick: () => setView("workspace" as View) },
        { label: "Intelligence", onClick: () => setActiveTab("decisions") },
        { label: tabLabelMap[activeTab], current: true },
      ]}
      onOpenSettings={onOpenSettings}
    >
      {/* Subnav */}
      <IntelSubnav active={activeTab} onSelect={setActiveTab} />

      <div style={{ padding: "20px 40px 60px", maxWidth: 1240, margin: "0 auto" }}>
        {activeTab === "decisions" && (
          <DecisionsTab
            decisions={liveDecisions}
            filter={decisionFilter}
            onFilterChange={setDecisionFilter}
            onSelectDecision={setDetailDecision}
            onNewDecision={() => setView("canvas" as View)}
          />
        )}

        {activeTab === "actions" && (
          <ActionsTab
            actions={liveActions}
            scope={actionScope}
            onScopeChange={setActionScope}
            onSyncLinear={() => setPanelProvider(connections[0]?.provider ?? "linear")}
            onCitation={onCitation}
          />
        )}

        {activeTab === "questions" && <QuestionsTab onCitation={onCitation} />}
        {activeTab === "risks" && <RisksTab onCitation={onCitation} />}
        {activeTab === "knowledge" && <KnowledgeTab />}
      </div>

      {/* Decision Detail Modal */}
      {detailDecision && (
        <DecisionDetailModal
          decision={detailDecision}
          onClose={() => setDetailDecision(null)}
          onGoBoard={() => {
            if (detailDecision.nodeId) {
              onCitation({ kind: "node", id: detailDecision.nodeId });
            } else {
              setView("canvas" as View);
            }
            setDetailDecision(null);
          }}
          onGoMeeting={() => {
            setView("meeting" as View);
            setDetailDecision(null);
          }}
          onGoAction={() => {
            setActiveTab("actions");
            setDetailDecision(null);
          }}
        />
      )}

      {/* Integration Panel Modal */}
      {panelProvider && (
        <IntegrationPanel
          provider={panelProvider}
          connections={connections}
          onClose={() => setPanelProvider(null)}
          onLinksChanged={() => {}}
        />
      )}
    </AtelierAppShell>
  );
}

function IntelSubnav({
  active,
  onSelect,
}: {
  active: IntelTab;
  onSelect: (tab: IntelTab) => void;
}) {
  const tabs: Array<{ id: IntelTab; label: string; icon: ReactNode }> = [
    { id: "decisions", label: "Decisions", icon: <DecisionIcon /> },
    { id: "actions", label: "Actions", icon: <ActionIcon /> },
    { id: "questions", label: "Questions", icon: <QuestionIcon /> },
    { id: "risks", label: "Risks", icon: <RiskIcon /> },
    { id: "knowledge", label: "Knowledge · Ask", icon: <Ico.Sparkle /> },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: "0 40px",
        borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        background: "oklch(from var(--paper-0) l c h / 0.7)",
      }}
    >
      {tabs.map((t) => {
        const isA = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "12px 14px",
              borderBottom: `2px solid ${isA ? "var(--ink-0)" : "transparent"}`,
              color: isA ? "var(--ink-0)" : "var(--ink-2)",
              fontWeight: isA ? 600 : 400,
              fontSize: 13,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              transition: "all 0.12s var(--e-out)",
            }}
          >
            <span style={{ color: isA ? "var(--ink-0)" : "var(--ink-3)" }}>{t.icon}</span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function DecisionsTab({
  decisions,
  filter,
  onFilterChange,
  onSelectDecision,
  onNewDecision,
}: {
  decisions: DecisionDisplay[];
  filter: string;
  onFilterChange: (f: string) => void;
  onSelectDecision: (d: DecisionDisplay) => void;
  onNewDecision: () => void;
}) {
  const filters = [
    { id: "all", label: "All", count: decisions.length },
    { id: "active", label: "Active", count: decisions.filter((d) => d.status === "active").length },
    { id: "review", label: "In review", count: decisions.filter((d) => d.status === "review").length },
    { id: "pending", label: "Pending", count: decisions.filter((d) => d.status === "pending").length },
    { id: "superseded", label: "Superseded", count: decisions.filter((d) => d.status === "superseded").length },
  ];

  const shown = filter === "all" ? decisions : decisions.filter((d) => d.status === filter);

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 14 · Intelligence · Decisions"
        title="Decisions log"
        meta={`${decisions.length} decisions · 4 today`}
        actions={
          <>
            <button
              type="button"
              className="icon-btn"
              onClick={() => window.dispatchEvent(new CustomEvent("lucent:open-command-overlay"))}
            >
              <Ico.Search /> Search…
            </button>
            <button type="button" className="icon-btn primary" onClick={onNewDecision}>
              <Ico.Plus /> New decision
            </button>
          </>
        }
      />
      <FilterBar filters={filters} active={filter} onChange={onFilterChange} />
      <div style={{ display: "grid", gap: 12 }}>
        {shown.map((d, i) => (
          <DecisionRowCard key={i} decision={d} onClick={() => onSelectDecision(d)} />
        ))}
      </div>
    </>
  );
}

function DecisionRowCard({
  decision,
  onClick,
}: {
  decision: DecisionDisplay;
  onClick: () => void;
}) {
  const statusMap = {
    active: { bg: "oklch(from var(--moss) l c h / 0.12)", color: "var(--moss)", label: "ACTIVE" },
    review: { bg: "var(--bloom-wash)", color: "var(--bloom-2)", label: "IN REVIEW" },
    pending: { bg: "oklch(from var(--saffron) l c h / 0.18)", color: "oklch(0.5 0.14 65)", label: "PENDING" },
    superseded: { bg: "oklch(from var(--ink-3) l c h / 0.12)", color: "var(--ink-2)", label: "SUPERSEDED" },
  }[decision.status];

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onClick();
      }}
      style={{
        padding: "16px 20px",
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
        borderRadius: 14,
        cursor: "pointer",
        transition: "transform 0.14s var(--e-out), box-shadow 0.14s var(--e-out), border-color 0.14s var(--e-out)",
        boxShadow: "var(--shadow-1)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = "var(--shadow-2)";
        e.currentTarget.style.borderColor = "var(--ink-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "var(--shadow-1)";
        e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.6)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          className="mono"
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
            background: statusMap.bg,
            color: statusMap.color,
          }}
        >
          {statusMap.label}
        </span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {decision.date}
        </span>
      </div>

      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 18,
          fontWeight: 500,
          color: "var(--ink-0)",
          textDecoration: decision.status === "superseded" ? "line-through" : "none",
          marginBottom: 10,
        }}
      >
        {decision.title}
      </div>

      {decision.evidence && (
        <div
          style={{
            padding: "10px 14px",
            borderLeft: "3px solid var(--bloom-2)",
            background: "oklch(from var(--paper-2) l c h / 0.5)",
            borderRadius: "0 8px 8px 0",
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontSize: 13.5,
            lineHeight: 1.45,
            color: "var(--ink-1)",
            marginBottom: 12,
          }}
        >
          &ldquo;{decision.evidence}&rdquo;
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--ink-1)",
          }}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: 999,
              background: decision.ownerColor,
              color: "white",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
            }}
          >
            {decision.owner[0]}
          </span>
          {decision.owner}
        </span>

        {decision.from && (
          <ProvenanceChip
            icon={<Ico.Present />}
            label={decision.from.label}
          />
        )}
      </div>
    </div>
  );
}

function ActionsTab({
  actions,
  scope,
  onScopeChange,
  onSyncLinear,
  onCitation,
}: {
  actions: ActionDisplay[];
  scope: string;
  onScopeChange: (s: string) => void;
  onSyncLinear: () => void;
  onCitation: (c: { kind: "node"; id: string }) => void;
}) {
  const scopes = [
    { id: "mine", label: "Mine", count: actions.filter((a) => a.owner === "Alex").length },
    { id: "team", label: "Team", count: actions.length },
    { id: "blocked", label: "Blocked", count: actions.filter((a) => a.status === "blocked").length },
    {
      id: "overdue",
      label: "Overdue",
      count: actions.filter((a) => a.due && a.due.startsWith("OVERDUE")).length,
    },
    { id: "done", label: "Done", count: actions.filter((a) => a.status === "done").length },
  ];

  const shown =
    scope === "mine"
      ? actions.filter((a) => a.owner === "Alex")
      : scope === "blocked"
        ? actions.filter((a) => a.status === "blocked")
        : scope === "overdue"
          ? actions.filter((a) => a.due && a.due.startsWith("OVERDUE"))
          : scope === "done"
            ? actions.filter((a) => a.status === "done")
            : actions;

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 15 · Intelligence · Actions"
        title="Actions"
        meta={`${actions.length} across 3 projects · 1 blocked · 1 overdue`}
        actions={
          <>
            <button type="button" className="icon-btn" onClick={onSyncLinear}>
              <LinearMark /> Sync with Linear
            </button>
            <button type="button" className="icon-btn primary">
              <Ico.Plus /> New action
            </button>
          </>
        }
      />
      <FilterBar filters={scopes} active={scope} onChange={onScopeChange} />
      <div style={{ display: "grid", gap: 8 }}>
        {shown.map((a, i) => (
          <div
            key={i}
            style={{
              padding: "14px 18px",
              borderRadius: 12,
              background: "var(--paper-0)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 500,
                  color: "var(--ink-0)",
                  textDecoration: a.status === "done" ? "line-through" : "none",
                  marginBottom: 6,
                }}
              >
                {a.title}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: "var(--ink-2)",
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: a.ownerColor,
                      color: "white",
                      fontFamily: "var(--font-mono)",
                      fontSize: 8,
                      fontWeight: 700,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {a.owner[0]}
                  </span>
                  {a.owner}
                </span>
                {a.due && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      color: a.due.startsWith("OVERDUE") ? "var(--madder)" : "var(--ink-3)",
                      fontWeight: a.due.startsWith("OVERDUE") ? 600 : 400,
                    }}
                  >
                    {a.due}
                  </span>
                )}
                {a.priority && (
                  <span
                    className="mono"
                    style={{
                      padding: "1px 6px",
                      borderRadius: 3,
                      fontSize: 9.5,
                      fontWeight: 700,
                      color: "white",
                      background:
                        a.priority === "P0"
                          ? "var(--madder)"
                          : a.priority === "P1"
                            ? "oklch(0.55 0.16 40)"
                            : "var(--ink-3)",
                    }}
                  >
                    {a.priority}
                  </span>
                )}
                {a.project && <ProvenanceChip icon={<Ico.Folder />} label={a.project} />}
                {a.decision && <ProvenanceChip icon={<DecisionIcon />} label={a.decision} />}
                {a.external && (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 6px",
                      background: "oklch(0.55 0.14 265 / 0.12)",
                      color: "oklch(0.5 0.14 265)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontWeight: 600,
                      borderRadius: 4,
                    }}
                  >
                    <LinearMark /> {a.external}
                  </span>
                )}
              </div>
            </div>
            {a.nodeId && (
              <button
                type="button"
                className="btn-atelier ghost"
                style={{ height: 28, fontSize: 11.5 }}
                onClick={() => onCitation({ kind: "node", id: a.nodeId! })}
              >
                Reveal
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function QuestionsTab({ onCitation }: { onCitation: (c: { kind: "node"; id: string }) => void }) {
  const questions = [
    {
      q: "Should we support Klarna at launch?",
      author: "Alex Kim",
      date: "today",
      status: "open",
    },
    {
      q: "What is the fallback when 3DS verification fails?",
      author: "Sarah Chen",
      date: "yesterday",
      status: "answered",
      answer: "Display retry modal with alternative card prompt.",
    },
    {
      q: "Is guest checkout compatible with stored cards?",
      author: "John Torres",
      date: "Sep 15",
      status: "answered",
      answer: "No, stored cards require an authenticated user profile.",
    },
  ];

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 14 · Intelligence · Questions"
        title="Open questions"
        meta="3 questions raised in meetings and design reviews"
      />
      <div style={{ display: "grid", gap: 12 }}>
        {questions.map((q, i) => (
          <div
            key={i}
            style={{
              padding: 18,
              borderRadius: 14,
              background: "var(--paper-0)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span
                className="mono-caps"
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  background:
                    q.status === "open"
                      ? "oklch(from var(--saffron) l c h / 0.2)"
                      : "oklch(from var(--moss) l c h / 0.12)",
                  color: q.status === "open" ? "oklch(0.4 0.14 60)" : "var(--moss)",
                  fontWeight: 700,
                }}
              >
                {q.status.toUpperCase()}
              </span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {q.date} · {q.author}
              </span>
            </div>
            <div
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 17,
                color: "var(--ink-0)",
                fontWeight: 500,
                marginBottom: q.answer ? 10 : 0,
              }}
            >
              {q.q}
            </div>
            {q.answer && (
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "oklch(from var(--paper-2) l c h / 0.6)",
                  fontSize: 13,
                  color: "var(--ink-1)",
                }}
              >
                <b>Answer:</b> {q.answer}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function RisksTab({ onCitation }: { onCitation: (c: { kind: "node"; id: string }) => void }) {
  const risks = [
    {
      title: "Stripe API latency spikes during peak checkout",
      severity: "high",
      mitigation: "Configured 2-retry silent policy with timeout fallback",
      owner: "John Torres",
    },
    {
      title: "Klarna compliance review pending regulatory sign-off",
      severity: "med",
      mitigation: "Launch gated behind legal approval by Oct 30",
      owner: "Alex Kim",
    },
    {
      title: "Cart abandonment rate in multi-step flow",
      severity: "low",
      mitigation: "Defaulting to single-page guest checkout",
      owner: "Sarah Chen",
    },
  ];

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 14 · Intelligence · Risks"
        title="Risks &amp; mitigations"
        meta="3 active risks monitored across architecture and execution"
      />
      <div style={{ display: "grid", gap: 12 }}>
        {risks.map((r, i) => (
          <div
            key={i}
            style={{
              padding: 18,
              borderRadius: 14,
              background: "var(--paper-0)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span
                className="mono-caps"
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  background:
                    r.severity === "high"
                      ? "oklch(from var(--madder) l c h / 0.15)"
                      : r.severity === "med"
                        ? "oklch(from var(--saffron) l c h / 0.2)"
                        : "oklch(from var(--moss) l c h / 0.12)",
                  color:
                    r.severity === "high"
                      ? "var(--madder)"
                      : r.severity === "med"
                        ? "oklch(0.4 0.14 60)"
                        : "var(--moss)",
                }}
              >
                {r.severity.toUpperCase()} RISK
              </span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                Owner · {r.owner}
              </span>
            </div>
            <div
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 17,
                color: "var(--ink-0)",
                fontWeight: 500,
                marginBottom: 8,
              }}
            >
              {r.title}
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>
              <b>Mitigation:</b> {r.mitigation}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function KnowledgeTab() {
  const [query, setQuery] = useState("Which decisions have we made about payments?");

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 16 · Intelligence · Knowledge"
        title="Ask Lucent"
        meta="Reasoning over everything · with evidence"
      />

      {/* Ask Input Card */}
      <div
        style={{
          padding: "18px 22px",
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 16,
          marginBottom: 24,
          boxShadow: "var(--shadow-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: "var(--bloom-wash)",
              border: "1px solid var(--bloom-wash-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--bloom-2)",
            }}
          >
            <Ico.Sparkle />
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              fontSize: 17,
              color: "var(--ink-0)",
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              border: "none",
              background: "transparent",
              outline: "none",
            }}
          />
          <button
            type="button"
            className="btn-atelier bloom"
            style={{ height: 36, padding: "0 16px", flex: "none" }}
          >
            Ask · ↵
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", paddingLeft: 44 }}>
          <span className="mono-caps" style={{ marginRight: 4, fontSize: 10 }}>
            Scope
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              background: "var(--ink-0)",
              color: "var(--paper-0)",
              fontSize: 11,
              fontWeight: 500,
            }}
          >
            This workspace
          </span>
          <span
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              background: "oklch(from var(--paper-2) l c h / 0.7)",
              color: "var(--ink-2)",
              fontSize: 11,
            }}
          >
            Last 30 days
          </span>
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            16 boards · 42 decisions · 208 utterances
          </span>
        </div>
      </div>

      {/* Answer Container */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 24 }}>
        <div
          style={{
            padding: "22px 26px",
            background: "var(--paper-0)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            borderRadius: 14,
          }}
        >
          <div className="mono-caps" style={{ marginBottom: 12, color: "var(--bloom-2)" }}>
            <Ico.Sparkle style={{ display: "inline", verticalAlign: -2, marginRight: 4 }} />
            Answer · confidence 0.91
          </div>
          <div
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 16,
              lineHeight: 1.6,
              color: "var(--ink-0)",
              marginBottom: 20,
            }}
          >
            You&apos;ve made <b>four active decisions</b> about payments in the last month, plus one
            that was superseded today.
            <br />
            <br />
            Today&apos;s Checkout review established that the Payment Service will sit behind the API
            gateway, guest checkout is the default flow, and Stripe intermittency is handled by a
            silent two-retry policy. Klarna support at launch is <em>in review</em>: it supersedes
            the Sep 12 decision to defer it to Q1.
          </div>
        </div>

        {/* Citations / Related */}
        <div
          style={{
            padding: "22px 24px",
            background: "var(--paper-0)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            borderRadius: 14,
          }}
        >
          <div className="mono-caps" style={{ marginBottom: 12 }}>
            Cited decisions
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {[
              { n: 1, t: "Payment Service goes behind API gateway", from: "Checkout review · today" },
              { n: 2, t: "Guest checkout is default checkout path", from: "Checkout review · today" },
              { n: 3, t: "Silent retry policy on Stripe intermittency", from: "Checkout review · today" },
            ].map((c) => (
              <div
                key={c.n}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "oklch(from var(--paper-2) l c h / 0.6)",
                  border: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: "var(--bloom-2)",
                    color: "white",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9.5,
                    fontWeight: 700,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  {c.n}
                </span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink-0)" }}>{c.t}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                    {c.from}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function DecisionDetailModal({
  decision,
  onClose,
  onGoBoard,
  onGoMeeting,
  onGoAction,
}: {
  decision: DecisionDisplay;
  onClose: () => void;
  onGoBoard: () => void;
  onGoMeeting: () => void;
  onGoAction: () => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 200,
          background: "oklch(0.20 0.02 60 / 0.35)",
          backdropFilter: "blur(8px)",
        }}
      />
      <div
        style={{
          position: "fixed",
          zIndex: 201,
          top: "10vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: 640,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "80vh",
          overflowY: "auto",
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 16,
          boxShadow: "var(--shadow-3)",
          padding: "28px 32px 24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className="mono-caps" style={{ color: "var(--bloom-2)" }}>
            DECISION · {decision.date}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{ padding: 6, color: "var(--ink-3)", background: "none", border: 0, cursor: "pointer" }}
            title="Close"
          >
            <Ico.X />
          </button>
        </div>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
            color: "var(--ink-0)",
            textDecoration: decision.status === "superseded" ? "line-through" : "none",
            marginBottom: 18,
          }}
        >
          {decision.title}
        </div>

        {decision.evidence && (
          <>
            <div className="mono-caps" style={{ marginBottom: 8 }}>
              Evidence · from transcript
            </div>
            <div
              style={{
                padding: "12px 16px",
                borderLeft: "3px solid var(--bloom-2)",
                background: "oklch(from var(--bloom-1) l c h / 0.05)",
                borderRadius: "0 8px 8px 0",
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--ink-0)",
                marginBottom: 20,
              }}
            >
              &ldquo;{decision.evidence}&rdquo;
            </div>
          </>
        )}

        <div className="mono-caps" style={{ marginBottom: 8 }}>
          Metadata
        </div>
        <div style={{ display: "grid", gap: 8, marginBottom: 22, fontSize: 13 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span className="mono-caps" style={{ width: 120, flexShrink: 0 }}>
              Status
            </span>
            <span
              className="mono"
              style={{
                padding: "2px 8px",
                borderRadius: 4,
                background: "var(--bloom-wash)",
                color: "var(--bloom-2)",
                fontSize: 10.5,
                fontWeight: 700,
              }}
            >
              {decision.status.toUpperCase()}
            </span>
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span className="mono-caps" style={{ width: 120, flexShrink: 0 }}>
              Owner
            </span>
            <span>{decision.owner}</span>
          </div>
          {decision.from && (
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <span className="mono-caps" style={{ width: 120, flexShrink: 0 }}>
                Extracted from
              </span>
              <span style={{ color: "var(--bloom-2)" }}>{decision.from.label}</span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.5)", paddingTop: 16 }}>
          <button
            type="button"
            className="btn-atelier ghost"
            onClick={onGoMeeting}
            style={{ flex: 1 }}
          >
            <Ico.Present /> View in Meeting Doc
          </button>
          <button
            type="button"
            className="btn-atelier bloom"
            onClick={onGoBoard}
            style={{ flex: 1 }}
          >
            <Ico.Layers /> Reveal on Canvas
          </button>
        </div>
      </div>
    </>
  );
}
