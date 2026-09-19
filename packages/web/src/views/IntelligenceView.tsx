import { useEffect, useMemo, useState } from "react";
import type { StatementKind, Workspace } from "@lucent/core";
import { resolveLocale, t } from "@lucent/i18n";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import {
  KIND_GLYPH,
  intelligenceSections,
  inboxItems,
  isOverdue,
  isSettled,
  mergeOps,
  mergePreview,
  suppressionKey,
  type InboxItem,
  type IntelligenceRow,
} from "../intelligence.js";
import { KIND_TINT } from "../statementUi.js";
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
import { inboundRowActions, inboundRowIsWarning, pendingInboundCount } from "./inboundRows.js";

/** Stage D8: the providers' display names — the buttons' labels, the
 * not-connected note. One map; adding a provider touches this plus its
 * adapter, nothing else in this view. */
const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  linear: "Linear",
  github: "GitHub",
  jira: "Jira",
};

/**
 * The Intelligence view (Stage C6, ADR 0026): the current semantic workspace,
 * surfaced. Six collapsible sections — every statement kind first-class —
 * with open statements prominent and settled ones dimmed below; every row
 * traceable to its source (click the label → the node on the canvas, ✦ →
 * the meeting at the exact turn). The right pane is the recommendation
 * inbox: possible duplicate topics with evidence, Merge (previewed, then
 * committed through the same validated path as any human edit) or Keep
 * (change-aware, ephemeral).
 *
 * Pure client-side by design: the view reads the workspace the client
 * already holds — shared boards converge on it through the room, local
 * boards hold it in state — no fetches, no routes, no stores. Intelligence
 * is a projection of the current semantic workspace; it does not create
 * new truth, mutate state without approval, or replace History as the
 * source for temporal analysis.
 */
export function IntelligenceView({
  onOpenSettings,
}: {
  onOpenSettings: (section?: string) => void;
}) {
  const { workspace, onCitation, applyManual, send, boardId, projectName, setView } =
    useWorkspace() as unknown as {
      workspace: Workspace;
      onCitation: WorkspaceState["onCitation"];
      applyManual: WorkspaceState["applyManual"];
      send: WorkspaceState["send"];
      boardId: string | null;
      projectName: string;
      setView: WorkspaceState["setView"];
    };
  const locale = useMemo(() => resolveLocale(navigator.language), []);

  const sections = useMemo(() => intelligenceSections(workspace), [workspace]);
  // Stage D6: fetch the links + the org's connection state (the viewer-
  // floor read + the owner-floor admin list read — the honest connection
  // states for the Sync button). Re-fetches when a decision lands.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [boardLinks, orgs, inbound] = await Promise.all([
        boardId ? fetchIntegrationLinks(boardId) : Promise.resolve([]),
        getCurrentOrgId() ? fetchOrgIntegrations(getCurrentOrgId()!) : Promise.resolve([]),
        boardId ? fetchInboundChanges(boardId) : Promise.resolve([] as InboundChangeView[]),
      ]);
      if (cancelled) return;
      setLinks(boardLinks);
      setConnections(orgs);
      setInbound(inbound);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);
  const inbox = useMemo(() => inboxItems(workspace), [workspace]);
  const totalStatements = sections.reduce((n, s) => n + s.rows.length, 0);

  const [filterCategory, setFilterCategory] = useState<string>("all");

  const decisionsCount =
    (sections.find((s) => s.kind === "decision")?.rows.length ?? 0) +
    (sections.find((s) => s.kind === "proposal")?.rows.length ?? 0);
  const actionsCount = sections.find((s) => s.kind === "action")?.rows.length ?? 0;
  const risksCount = sections.find((s) => s.kind === "risk")?.rows.length ?? 0;

  const filteredSections = useMemo(() => {
    if (filterCategory === "all") return sections;
    if (filterCategory === "decision")
      return sections.filter((s) => s.kind === "decision" || s.kind === "proposal");
    if (filterCategory === "action") return sections.filter((s) => s.kind === "action");
    if (filterCategory === "risk") return sections.filter((s) => s.kind === "risk");
    if (filterCategory === "inbox" || filterCategory === "inbound") return [];
    return sections.filter((s) => s.kind === filterCategory);
  }, [sections, filterCategory]);

  /** Sections start expanded when populated, collapsed when empty. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Change-aware Keep dismissals: suppression keys for THIS session only. */
  const [suppressed, setSuppressed] = useState<ReadonlySet<string>>(new Set());
  /** The item whose merge preview is open, per inbox id. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  /** A merge that failed validation (applyManual returned false). */
  const [mergeError, setMergeError] = useState<string | null>(null);
  /** Stage D2: the checked statement rows — the plan request's sources. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  /** Stage D6: the board's external links (the ↗ chips) + the org's
   * connections (the Sync button's honest states) + the panel. */
  const [links, setLinks] = useState<IntegrationLink[]>([]);
  const [connections, setConnections] = useState<
    Array<{
      provider: string;
      status: string;
      config?: Record<string, string>;
      supportsInbound?: boolean;
    }>
  >([]);
  const [panelProvider, setPanelProvider] = useState<string | null>(null);
  /** Stage D7: the inbound queue (the External changes section). */
  const [inbound, setInbound] = useState<InboundChangeView[]>([]);
  /** The inbound row whose decision is in flight (one at a time). */
  const [decidingInbound, setDecidingInbound] = useState<string | null>(null);
  const pendingInbound = pendingInboundCount(inbound);

  const _refreshInbound = async () => {
    if (!boardId) return;
    setInbound(await fetchInboundChanges(boardId));
  };

  const decideInbound = async (changeId: string, decision: "accept" | "dismiss") => {
    if (!boardId || decidingInbound) return;
    setDecidingInbound(changeId);
    try {
      // decideInboundChange is imported lazily to keep this component's
      // import list the D6 shape; the decision refreshes the queue and
      // the links (an accept writes the link's lastSyncedStatus).
      const { decideInboundChange, fetchIntegrationLinks } = await import("../boards.js");
      await decideInboundChange(boardId, changeId, decision);
      const [rows, boardLinks] = await Promise.all([
        fetchInboundChanges(boardId),
        fetchIntegrationLinks(boardId),
      ]);
      setInbound(rows);
      setLinks(boardLinks);
    } finally {
      setDecidingInbound(null);
    }
  };

  const visibleInbox = inbox.filter((item) => !suppressed.has(suppressionKey(item)));
  // Stage D6: the chip's join — node id → the board's links.
  const linksByNode = useMemo(() => {
    const map = new Map<string, IntegrationLink>();
    for (const link of links) map.set(link.nodeId, link);
    return map;
  }, [links]);

  const toggle = (kind: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Stage D2: "Plan from selection" — the kind-aware input surface. The
   * checked statement ids flow through the ordinary send in BOTH channels the
   * request supports (P1-EX-001): the plan attachment (client-side gating +
   * createdFrom stamping) AND the selection argument, so the model actually
   * sees "plan from these statements" instead of the whole board plus a
   * post-hoc local stamp. They used to travel only in the attachment, which
   * the wire never carried.
   *
   * The handoff navigates to the canvas (P1-IA-001): generation phases and
   * the proposal panel live there, so sending from a view that never shows
   * them made the plan feel like it vanished. Small additive batches apply
   * on the board — which is where the user should be looking to see them.
   */
  const planFromSelection = () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    const request = planRequestText(ids.length);
    void send(request, ids, { plan: { statementIds: ids } });
    setChecked(new Set());
    setView("canvas");
  };

  const keepSeparate = (item: InboxItem) => {
    setSuppressed((prev) => new Set(prev).add(suppressionKey(item)));
  };

  const confirmMerge = (item: InboxItem) => {
    setMergeError(null);
    const ops = mergeOps(item, workspace);
    // Only an explicit user action reaches here — the C5 invariant. The ops
    // run through the same validated, logged, undoable path as any human
    // edit; a refusal keeps the card open with the reason shown.
    if (!applyManual(ops, "merge duplicate topics")) {
      setMergeError(t("intel.inbox.merge.failed", locale));
      return;
    }
    setPreviewing(null);
  };

  const sectionHeader = (kind: StatementKind) => {
    const map: Record<StatementKind, string> = {
      decision: t("intel.section.decision", locale),
      proposal: t("intel.section.proposal", locale),
      question: t("intel.section.question", locale),
      action: t("intel.section.action", locale),
      requirement: t("intel.section.requirement", locale),
      risk: t("intel.section.risk", locale),
    };
    return map[kind];
  };

  const rowHint = (row: IntelligenceRow, kind: StatementKind): string =>
    `${row.status}${row.assignee ? ` · ${t("intel.row.assignee", locale, { name: row.assignee })}` : ""}${
      row.supersedes?.length
        ? ` · ${t("intel.row.supersedes", locale, { n: row.supersedes.length })}`
        : ""
    }${row.dueDate ? ` · ${t("intel.row.due", locale, { date: row.dueDate })}` : ""}${
      row.executionStatus ? ` · ${row.executionStatus}` : ""
    }${row.topic ? ` · ${row.topic}` : ""} · ${sectionHeader(kind)}`;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      {/* The shared shell, like every other full surface (the audit's P1-IA-001:
          this view used to render bare, a navigation dead end — no rail, no
          way back to the board). */}
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: projectName, view: "canvas" },
          { label: "Intelligence", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail onOpenSettings={onOpenSettings} />
      <div className="intel-layout">
        {/* KPI Summary Header Cards */}
        <div className="intel-kpi-row">
          <div
            className={`intel-kpi-card ${filterCategory === "all" ? "active" : ""}`}
            onClick={() => setFilterCategory("all")}
          >
            <div>
              <div className="intel-kpi-num">{totalStatements}</div>
              <div className="intel-kpi-label">Total Statements</div>
            </div>
          </div>
          <div
            className={`intel-kpi-card ${filterCategory === "decision" ? "active" : ""}`}
            onClick={() => setFilterCategory("decision")}
          >
            <div>
              <div className="intel-kpi-num" style={{ color: "var(--sig-violet, #a855f7)" }}>
                {decisionsCount}
              </div>
              <div className="intel-kpi-label">Decisions & Proposals</div>
            </div>
          </div>
          <div
            className={`intel-kpi-card ${filterCategory === "action" ? "active" : ""}`}
            onClick={() => setFilterCategory("action")}
          >
            <div>
              <div className="intel-kpi-num" style={{ color: "var(--amber-1, #f59e0b)" }}>
                {actionsCount}
              </div>
              <div className="intel-kpi-label">Actions & Tasks</div>
            </div>
          </div>
          <div
            className={`intel-kpi-card ${filterCategory === "risk" ? "active" : ""}`}
            onClick={() => setFilterCategory("risk")}
          >
            <div>
              <div className="intel-kpi-num" style={{ color: "var(--sig-red, #ef4444)" }}>
                {risksCount}
              </div>
              <div className="intel-kpi-label">Risks & Mitigations</div>
            </div>
          </div>
          <div
            className={`intel-kpi-card ${filterCategory === "inbox" ? "active" : ""}`}
            onClick={() => setFilterCategory("inbox")}
          >
            <div>
              <div className="intel-kpi-num" style={{ color: "var(--sig-blue, #3b82f6)" }}>
                {visibleInbox.length}
              </div>
              <div className="intel-kpi-label">AI Recommendations</div>
            </div>
          </div>
        </div>

        {/* Category Filter Tabs */}
        <div className="intel-tabs">
          {[
            { id: "all", label: "All Intelligence" },
            { id: "decision", label: "Decisions & Proposals" },
            { id: "action", label: "Actions & Tasks" },
            { id: "risk", label: "Risks & Mitigations" },
            { id: "inbound", label: "External Sync" },
          ].map((tab) => (
            <button
              key={tab.id}
              className={`intel-tab-btn ${filterCategory === tab.id ? "active" : ""}`}
              onClick={() => setFilterCategory(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Main Grid */}
        <div className="intel-main-grid">
          {/* — The sections: the six kinds, open first, settled dimmed — */}
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
              <Ico.Sparkle style={{ color: "var(--amber-2)" }} />
              <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                {t("intel.title", locale)}
              </div>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {totalStatements} statement{totalStatements === 1 ? "" : "s"}
              </span>
              <span style={{ flex: 1 }} />
              {checked.size > 0 && (
                <button
                  className="btn amber"
                  style={{ height: 24, fontSize: 11 }}
                  onClick={planFromSelection}
                >
                  {t("intel.plan.from", locale, { n: checked.size })}
                </button>
              )}
              {/* Stage D8: one button per ACTIVE connection, generated from the
              connections — the label follows the architecture: "Sync with"
              when the provider has inbound (supportsInbound), "Send to"
              when outbound-only. The D7 pending badge rides the button of
              the provider whose queue it is (per-provider, pendingInbound
              counts all for now — the queue view is shared). */}
              {connections
                .filter((c) => c.status === "active")
                .map((c) => {
                  const name = PROVIDER_DISPLAY_NAME[c.provider] ?? c.provider;
                  return (
                    <button
                      key={c.provider}
                      className="btn"
                      style={{
                        height: 24,
                        fontSize: 11,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                      title={t("integrations.sync.title", locale)}
                      onClick={() => setPanelProvider(c.provider)}
                    >
                      {t(
                        c.supportsInbound ? "integrations.sync.with" : "integrations.send.to",
                        locale,
                        { provider: name },
                      )}
                      {/* Stage D7: the pending-inbound badge — the queue is one
                      click away from the Sync it relates to. */}
                      {c.supportsInbound && pendingInbound > 0 && (
                        <span
                          className="mono"
                          aria-label={`${pendingInbound} external changes across providers`}
                          style={{
                            fontSize: 10,
                            padding: "1px 6px",
                            borderRadius: 999,
                            background: "var(--sig-amber, #d29922)",
                            color: "#fff",
                          }}
                        >
                          {pendingInbound}
                        </span>
                      )}
                    </button>
                  );
                })}
              {connections.length > 0 && connections.every((c) => c.status !== "active") && (
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                  {t("integrations.not_connected", locale, {
                    provider:
                      PROVIDER_DISPLAY_NAME[connections[0]!.provider] ?? connections[0]!.provider,
                  })}
                </span>
              )}
            </div>
            <div className="panel-body" style={{ overflowY: "auto", padding: 6 }}>
              {totalStatements === 0 ||
              (filteredSections.length === 0 && filterCategory !== "inbound") ? (
                <div className="view-empty" style={{ position: "static", padding: "40px 20px" }}>
                  <div className="view-empty-icon">
                    <Ico.Sparkle />
                  </div>
                  <h2>
                    {totalStatements === 0
                      ? t("intel.empty.view", locale)
                      : "No statements in this category"}
                  </h2>
                  <p>
                    {totalStatements === 0
                      ? t("intel.empty.view.hint", locale)
                      : "Try selecting 'All Intelligence' or another category filter above."}
                  </p>
                </div>
              ) : (
                filteredSections.map((section) => {
                  const isCollapsed = collapsed.has(section.kind);
                  return (
                    <div key={section.kind} style={{ padding: "4px 6px" }}>
                      <button
                        onClick={() => toggle(section.kind)}
                        aria-expanded={!isCollapsed}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          width: "100%",
                          padding: "8px 8px",
                          borderRadius: 8,
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          textAlign: "left",
                          color: KIND_TINT[section.kind],
                        }}
                      >
                        <span className="mono" style={{ fontSize: 11 }}>
                          {KIND_GLYPH[section.kind]}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            flex: 1,
                          }}
                        >
                          {sectionHeader(section.kind)}
                        </span>
                        {/* Counts are ALWAYS visible — collapsed or not. */}
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                          {section.rows.length}
                        </span>
                        <Ico.Down
                          style={{
                            color: "var(--ink-3)",
                            transform: isCollapsed ? "rotate(-90deg)" : "none",
                            transition: "transform 0.15s",
                          }}
                        />
                      </button>
                      {!isCollapsed &&
                        (section.rows.length === 0 ? (
                          <div
                            className="mono"
                            style={{
                              padding: "6px 10px 10px 28px",
                              fontSize: 10.5,
                              color: "var(--ink-3)",
                            }}
                          >
                            {t("intel.empty.section", locale, {
                              kind: sectionHeader(section.kind).toLowerCase(),
                            })}
                          </div>
                        ) : (
                          section.rows.map((row) => (
                            <div
                              key={row.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "7px 10px 7px 28px",
                                borderRadius: 8,
                                opacity: isSettled(row.status) ? 0.55 : 1,
                                // Stage D1: the overdue tint — rendered, computed
                                // from today, never persisted.
                                ...(isOverdue(row.dueDate, row.executionStatus, Date.now())
                                  ? { boxShadow: "inset 2px 0 0 0 var(--sig-red)" }
                                  : {}),
                              }}
                            >
                              {/* Stage D2: the plan-selection checkbox — every
                              statement row is a candidate plan source. */}
                              <input
                                type="checkbox"
                                aria-label={`Select ${row.label} for planning`}
                                checked={checked.has(row.id)}
                                onChange={() => toggleChecked(row.id)}
                                style={{ marginLeft: 2, flexShrink: 0 }}
                              />
                              <button
                                title={rowHint(row, section.kind)}
                                onClick={() => onCitation({ kind: "node", id: row.id })}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  textAlign: "left",
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: 0,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 12.5,
                                    color: "var(--ink-0)",
                                    fontVariationSettings: "'wght' 500",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  {row.label}
                                </div>
                                <div
                                  className="mono"
                                  style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}
                                >
                                  {row.status}
                                  {row.assignee
                                    ? ` · ${t("intel.row.assignee", locale, { name: row.assignee })}`
                                    : ""}
                                  {row.supersedes?.length
                                    ? ` · ${t("intel.row.supersedes", locale, { n: row.supersedes.length })}`
                                    : ""}
                                  {row.dueDate
                                    ? ` · ${t("intel.row.due", locale, { date: row.dueDate })}`
                                    : ""}
                                  {row.executionStatus ? ` · ${row.executionStatus}` : ""}
                                  {row.drivesActions
                                    ? ` · ${t("intel.row.drives", locale, { n: row.drivesActions })}`
                                    : ""}
                                  {row.topic ? ` · ${row.topic}` : ""}
                                </div>
                                {/* Stage D3: the derived lines — computed project
                                truth beside the manual state, never merged. */}
                                {row.blockedBy?.length ? (
                                  <div
                                    className="mono"
                                    style={{ fontSize: 10, color: "var(--sig-red)", marginTop: 1 }}
                                  >
                                    ⚠ {t("intel.row.blocked", locale, { n: row.blockedBy.length })}
                                    : {row.blockedBy.join(", ")}
                                  </div>
                                ) : null}
                                {row.atRiskBy?.length ? (
                                  <div
                                    className="mono"
                                    style={{ fontSize: 10, color: "var(--amber-2)", marginTop: 1 }}
                                  >
                                    ⌛ {t("intel.row.atrisk", locale, { n: row.atRiskBy.length })}:{" "}
                                    {row.atRiskBy.join(", ")}
                                  </div>
                                ) : null}
                              </button>
                              {row.provenance && (
                                <button
                                  className="mono"
                                  title="meeting evidence"
                                  onClick={() =>
                                    onCitation({
                                      kind: "meeting",
                                      id: row.provenance!.meetingId,
                                      ...(row.provenance!.turnRange
                                        ? { turnRange: row.provenance!.turnRange }
                                        : {}),
                                    })
                                  }
                                  style={{
                                    color: "var(--amber-2)",
                                    background: "transparent",
                                    border: "none",
                                    cursor: "pointer",
                                    fontSize: 12,
                                    padding: "2px 6px",
                                  }}
                                >
                                  ✦
                                </button>
                              )}
                              {/* Stage D6: the ↗ chip — the board's external link
                              for this row, straight from the link registry. */}
                              {(() => {
                                const link = linksByNode.get(row.id);
                                if (!link) return null;
                                return (
                                  <a
                                    href={link.url ?? "#"}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="mono"
                                    title={t("integrations.chip.title", locale, {
                                      at: new Date(link.syncedAt).toISOString().slice(0, 10),
                                      // D8: the provider's raw word — the user
                                      // can see what the external system shows.
                                      ...(link.status ? { external: link.status } : {}),
                                    })}
                                    style={{
                                      fontSize: 11,
                                      color: "var(--amber-2)",
                                      textDecoration: "none",
                                      flexShrink: 0,
                                    }}
                                  >
                                    ↗ {link.externalId}
                                  </a>
                                );
                              })()}
                            </div>
                          ))
                        ))}
                    </div>
                  );
                })
              )}
              {/* — Stage D7: External changes — the human-gated inbound queue.
              Pending rows offer Accept/Keep-ours; a warning row (no
              translation) offers Keep-ours only — Accept would require
              guessing a status; decided rows dim with their outcome. — */}
              {inbound.length > 0 && (filterCategory === "all" || filterCategory === "inbound") && (
                <div style={{ padding: "4px 6px 12px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px 4px",
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        flex: 1,
                      }}
                    >
                      {t("integrations.inbound.title", locale)}
                    </span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                      {pendingInbound}
                    </span>
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10, color: "var(--ink-3)", padding: "2px 10px 6px" }}
                  >
                    {t("integrations.inbound.hint", locale)}
                  </div>
                  {inbound.map((row) => {
                    const actions = inboundRowActions(row);
                    const busy = decidingInbound === row.id;
                    return (
                      <div
                        key={row.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "7px 10px",
                          borderRadius: 8,
                          opacity: row.status === "pending" ? 1 : 0.55,
                          ...(row.status === "pending" && !inboundRowIsWarning(row)
                            ? { boxShadow: "inset 2px 0 0 0 var(--amber-2)" }
                            : {}),
                        }}
                      >
                        <button
                          onClick={() => onCitation({ kind: "node", id: row.nodeId })}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            textAlign: "left",
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <div style={{ fontSize: 12.5, color: "var(--ink-0)" }}>
                            {row.nodeLabel}
                          </div>
                          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                            {inboundRowIsWarning(row)
                              ? t("integrations.inbound.warning", locale, {
                                  provider: row.provider,
                                  value: row.externalValue,
                                })
                              : row.resolved
                                ? t("integrations.inbound.resolved", locale, {
                                    value: row.mappedValue ?? "",
                                  })
                                : t("integrations.inbound.row", locale, {
                                    provider: row.provider,
                                    external: row.externalValue,
                                    board: row.boardValue ?? "—",
                                  })}
                          </div>
                          {row.status !== "pending" && (
                            <div
                              className="mono"
                              style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}
                            >
                              {row.status === "applied"
                                ? t("integrations.inbound.applied", locale)
                                : row.status === "dismissed"
                                  ? t("integrations.inbound.dismissed", locale)
                                  : t("integrations.inbound.superseded", locale)}
                            </div>
                          )}
                        </button>
                        {row.url && (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                            title={t("integrations.chip.title", locale, {
                              at: new Date(row.detectedAt).toLocaleString(),
                            })}
                            className="mono"
                            style={{
                              fontSize: 11,
                              color: "var(--amber-2)",
                              padding: "2px 6px",
                              flexShrink: 0,
                            }}
                          >
                            ↗ {row.externalId}
                          </a>
                        )}
                        {actions.canAccept && (
                          <button
                            className="btn amber"
                            style={{ height: 22, fontSize: 10.5, flexShrink: 0 }}
                            disabled={busy}
                            onClick={() => void decideInbound(row.id, "accept")}
                          >
                            {t("integrations.inbound.accept", locale)}
                          </button>
                        )}
                        {actions.canDismiss && (
                          <button
                            className="btn"
                            style={{ height: 22, fontSize: 10.5, flexShrink: 0 }}
                            disabled={busy}
                            onClick={() => void decideInbound(row.id, "dismiss")}
                          >
                            {t("integrations.inbound.dismiss", locale)}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* — The recommendation inbox: detection → recommendation → human
            decision → validated operation (ADR 0025's first consumer) — */}
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
              <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                {t("intel.inbox.title", locale)}
              </div>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {visibleInbox.length} open
              </span>
            </div>
            <div
              className="panel-body"
              style={{ overflowY: "auto", padding: 12, display: "grid", gap: 10 }}
            >
              {visibleInbox.length === 0 ? (
                <div
                  className="mono"
                  style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--ink-3)" }}
                >
                  {t("intel.inbox.empty", locale)}
                </div>
              ) : (
                visibleInbox.map((item) => {
                  const preview = previewing === item.id ? mergePreview(workspace, item) : null;
                  return (
                    <div
                      key={item.id}
                      style={{
                        border: "1px solid var(--amber-2)",
                        borderRadius: 12,
                        padding: 12,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontSize: 12.5, color: "var(--ink-0)" }}>
                        {t("intel.inbox.dup", locale, { dup: item.dup, existing: item.existing })}
                      </div>
                      {/* Evidence (rule 4): counts and meetings, never "looks similar". */}
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                        {t("intel.inbox.evidence", locale, {
                          existing: item.existing,
                          dup: item.dup,
                          a: item.existingStatements,
                          b: item.dupStatements,
                          m: item.meetings.length,
                        })}
                      </div>
                      {preview ? (
                        <>
                          <div
                            className="mono"
                            style={{ fontSize: 10.5, color: "var(--ink-1)", lineHeight: 1.5 }}
                          >
                            {t("intel.inbox.merge.preview", locale, {
                              dup: item.dup,
                              existing: item.existing,
                              n: preview.statementCount,
                            })}
                          </div>
                          {mergeError && (
                            <div
                              className="mono"
                              style={{ fontSize: 10.5, color: "var(--sig-red)" }}
                            >
                              {mergeError}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              className="btn amber"
                              style={{ height: 26, fontSize: 11.5 }}
                              onClick={() => confirmMerge(item)}
                            >
                              {t("intel.inbox.merge.confirm", locale)}
                            </button>
                            <button
                              className="btn"
                              style={{ height: 26, fontSize: 11.5 }}
                              onClick={() => {
                                setPreviewing(null);
                                setMergeError(null);
                              }}
                            >
                              {t("intel.inbox.merge.cancel", locale)}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button
                            className="btn amber"
                            style={{ height: 26, fontSize: 11.5 }}
                            onClick={() => setPreviewing(item.id)}
                          >
                            {t("intel.inbox.merge", locale)}
                          </button>
                          <button
                            className="btn"
                            style={{ height: 26, fontSize: 11.5 }}
                            onClick={() => keepSeparate(item)}
                          >
                            {t("intel.inbox.keep", locale)}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        {panelProvider && (
          <IntegrationPanel
            provider={panelProvider}
            connections={connections}
            onClose={() => setPanelProvider(null)}
            onLinksChanged={() => {
              if (boardId) void fetchIntegrationLinks(boardId).then(setLinks);
            }}
          />
        )}
      </div>
    </div>
  );
}
