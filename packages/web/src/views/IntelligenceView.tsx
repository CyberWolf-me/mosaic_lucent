import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { StatementKind, StatementStatus } from "@lucent/core";
import { resolveLocale, t } from "@lucent/i18n";
import { useWorkspace } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  FilterChips,
  KindBadge,
  Page,
  PageHeader,
  ProvenanceChip,
  SectionLabel,
  type FilterItem,
} from "../ui/kit.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import {
  SECTION_ORDER,
  intelligenceSections,
  inboxItems,
  isOverdue,
  isSettled,
  mergeOps,
  mergePreview,
  suppressionKey,
  type InboxItem,
  type IntelligenceRow,
  type IntelligenceSection,
} from "../intelligence.js";
import { KIND_LABEL, KIND_TINT, statementIsHistory, statusLabel } from "../statementUi.js";
import { planRequestText } from "../planGate.js";
import {
  fetchInboundChanges,
  fetchIntegrationLinks,
  fetchOrgIntegrations,
  type InboundChangeView,
  type IntegrationLink,
} from "../boards.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import { getCurrentOrgId } from "../orgs.js";
import { hasSession } from "../session.js";
import { WorkspaceIntelligence } from "./WorkspaceIntelligence.js";
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

/** The tab a reader picks: every statement, or one kind. */
type Filter = "all" | StatementKind;

/** The kind as a tab/title noun. "Open questions" is the section's name;
 * as a tab it would lie about the answered ones it also counts. */
const TAB_LABEL: Record<StatementKind, string> = {
  decision: "Decisions",
  proposal: "Proposals",
  question: "Questions",
  action: "Actions",
  requirement: "Requirements",
  risk: "Risks",
};

const STATUS_ORDER: StatementStatus[] = ["open", "resolved", "rejected", "superseded"];

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a or b", "a, b or c" — the missing-kinds sentence. */
function orList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** A calendar date (ISO YYYY-MM-DD) as "Sep 30" — timezone-naive, like the
 * field itself (ADR 0027): parsed as a local date, never as an instant. */
function formatDue(iso: string, now: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** When a meeting happened, as a person would say it. */
function formatMeetingDay(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return "today";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Turn indexes are 0-based in the data; people count from 1. */
function turnsLabel(range: [number, number]): string {
  return range[0] === range[1] ? `turn ${range[0] + 1}` : `turns ${range[0] + 1}–${range[1] + 1}`;
}

/** When a conversation request was made: a time today, a date otherwise. */
function formatRequestTime(at: number, now: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** The provisional stamp of a capture that ran without a saved transcript. */
const LIVE_SESSION = "live-session";

const rowDomId = (id: string) => `intel-row-${id}`;

/**
 * The Intelligence view (Stage C6, ADR 0026): the current semantic workspace,
 * surfaced — the team's memory. Every statement kind first-class, open
 * statements prominent and settled ones dimmed below; every row traceable
 * to its source (the label or "Show on board" → the node on the canvas, the
 * meeting chip → the meeting at the exact turn). The side column is the
 * recommendation inbox — possible duplicate topics with evidence, Merge
 * (previewed, then committed through the same validated path as any human
 * edit) or Keep (change-aware, ephemeral) — and the human-gated external
 * change queue.
 *
 * Intelligence is a projection of the current semantic workspace; it does
 * not create new truth, mutate state without approval, or replace History
 * as the source for temporal analysis. The only reads beyond the workspace
 * are the board's external links/inbound queue (Stage D6/D7) and its saved
 * meetings — the latter only to say *when* and *who* for provenance the
 * statements already carry.
 */
export function IntelligenceView({
  onOpenSettings,
}: {
  onOpenSettings: (section?: string) => void;
}) {
  // docs/26 J3 (ADR 0046): the same view across the whole workspace, from
  // the server's index — signed in only; the scope rides the address bar.
  const [scope, setScope] = useState<"board" | "workspace">(() =>
    new URLSearchParams(window.location.search).get("scope") === "workspace"
      ? "workspace"
      : "board",
  );
  const choose = (next: "board" | "workspace") => {
    const params = new URLSearchParams(window.location.search);
    if (next === "workspace") params.set("scope", "workspace");
    else params.delete("scope");
    window.history.replaceState(null, "", `?${params.toString()}`);
    setScope(next);
  };
  const scopeSwitch = hasSession() ? (
    <div className="segmented" role="radiogroup" aria-label="Intelligence scope">
      <button
        type="button"
        className={scope === "board" ? "active" : ""}
        aria-pressed={scope === "board"}
        onClick={() => choose("board")}
      >
        This board
      </button>
      <button
        type="button"
        className={scope === "workspace" ? "active" : ""}
        aria-pressed={scope === "workspace"}
        onClick={() => choose("workspace")}
      >
        Workspace
      </button>
    </div>
  ) : null;
  return scope === "workspace" && scopeSwitch ? (
    <WorkspaceIntelligence onOpenSettings={onOpenSettings} scopeSwitch={scopeSwitch} />
  ) : (
    <BoardIntelligenceView onOpenSettings={onOpenSettings} scopeSwitch={scopeSwitch} />
  );
}

function BoardIntelligenceView({
  onOpenSettings,
  scopeSwitch,
}: {
  onOpenSettings: (section?: string) => void;
  scopeSwitch: ReactNode;
}) {
  const { workspace, onCitation, applyManual, send, boardId, projectName, setView, readOnly } =
    useWorkspace();
  const locale = useMemo(() => resolveLocale(navigator.language), []);

  const sections = useMemo(() => intelligenceSections(workspace), [workspace]);
  const inbox = useMemo(() => inboxItems(workspace), [workspace]);
  const totalStatements = sections.reduce((n, s) => n + s.rows.length, 0);
  const sectionOf = (kind: StatementKind): IntelligenceSection =>
    sections.find((s) => s.kind === kind) ?? { kind, rows: [] };

  /** The chosen tab. A kind whose last statement goes away (a merge, an
   * undo) falls back to All rather than stranding the reader on nothing. */
  const [filter, setFilter] = useState<Filter>("all");
  const activeFilter: Filter =
    filter !== "all" && sectionOf(filter).rows.length === 0 ? "all" : filter;

  /** Sections start expanded; the header toggles them (aria-expanded). */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Change-aware Keep dismissals: suppression keys for THIS session only. */
  const [suppressed, setSuppressed] = useState<ReadonlySet<string>>(new Set());
  /** The item whose merge preview is open, per inbox id. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  /** A merge that failed validation (applyManual returned false). */
  const [mergeError, setMergeError] = useState<string | null>(null);
  /** Stage D2: the checked statement rows — the plan request's sources. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  /** A supersession jump: the row to scroll to and briefly mark. */
  const [focusId, setFocusId] = useState<string | null>(null);
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
  /** The board's saved meetings — when a statement's meeting happened and
   * who spoke its turns. Empty for local boards or when the read fails. */
  const [meetings, setMeetings] = useState<MeetingTranscript[]>([]);
  const pendingInbound = pendingInboundCount(inbound);

  // Stage D6: fetch the links + the org's connection state (the viewer-
  // floor read + the owner-floor admin list read — the honest connection
  // states for the Sync button), the inbound queue, and the meetings the
  // provenance chips name.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgId = getCurrentOrgId();
      const [boardLinks, orgs, queue, saved] = await Promise.all([
        boardId ? fetchIntegrationLinks(boardId) : Promise.resolve([]),
        orgId ? fetchOrgIntegrations(orgId) : Promise.resolve([]),
        boardId ? fetchInboundChanges(boardId) : Promise.resolve([] as InboundChangeView[]),
        boardId ? listMeetings(boardId).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setLinks(boardLinks);
      setConnections(orgs);
      setInbound(queue);
      setMeetings(saved ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // The supersession jump lands after the render that expanded its section.
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(rowDomId(focusId));
    if (el) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => setFocusId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [focusId]);

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
  const meetingsById = useMemo(() => new Map(meetings.map((m) => [m.id, m])), [meetings]);
  /** The reverse of `supersedes`: which statement replaced this one. */
  const supersededBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const node of Object.values(workspace.nodes)) {
      for (const old of node.statement?.supersedes ?? []) {
        map.set(old, [...(map.get(old) ?? []), node.id]);
      }
    }
    return map;
  }, [workspace]);

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

  /** Jump to a related statement in this list (a supersession link): show
   * its section, then scroll to it. Anything that is not a statement row
   * here opens on the canvas instead. */
  const jumpTo = (id: string) => {
    const kind = workspace.nodes[id]?.statement?.kind;
    if (!kind) {
      onCitation({ kind: "node", id });
      return;
    }
    if (activeFilter !== "all" && activeFilter !== kind) setFilter("all");
    setCollapsed((prev) => {
      if (!prev.has(kind)) return prev;
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
    setFocusId(id);
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

  const labelOf = (id: string): string | null => workspace.nodes[id]?.label ?? null;
  const now = Date.now();

  /* ------------------------------------------------------------ the lede */

  const openCount = (kind: StatementKind) =>
    sectionOf(kind).rows.filter((r) => !isSettled(r.status)).length;
  const overdueCount = sectionOf("action").rows.filter((r) =>
    isOverdue(r.dueDate, r.executionStatus, now),
  ).length;

  const boardLede = (): string => {
    const parts = [plural(totalStatements, "statement")];
    const decided = sectionOf("decision").rows.filter((r) => r.status === "resolved").length;
    if (decided) parts.push(`${decided} decided`);
    const pending = openCount("decision");
    if (pending) parts.push(plural(pending, "pending decision"));
    const openWords: Array<[StatementKind, string]> = [
      ["proposal", "open proposal"],
      ["question", "open question"],
      ["action", "open action"],
      ["requirement", "open requirement"],
      ["risk", "open risk"],
    ];
    for (const [kind, word] of openWords) {
      const n = openCount(kind);
      if (n) parts.push(plural(n, word));
    }
    if (overdueCount) parts.push(`${overdueCount} overdue`);
    return parts.join(" · ");
  };

  const kindLede = (kind: StatementKind): string => {
    const rows = sectionOf(kind).rows;
    const parts = [plural(rows.length, KIND_LABEL[kind].one.toLowerCase())];
    for (const status of STATUS_ORDER) {
      const n = rows.filter((r) => r.status === status).length;
      if (n) parts.push(`${n} ${statusLabel(kind, status).toLowerCase()}`);
    }
    if (kind === "action") {
      const blocked = rows.filter((r) => r.blockedBy?.length).length;
      if (blocked) parts.push(`${blocked} blocked`);
      if (overdueCount) parts.push(`${overdueCount} overdue`);
    }
    return parts.join(" · ");
  };

  const title: ReactNode =
    activeFilter === "all" ? (
      <>
        What this board <em>knows</em>
      </>
    ) : activeFilter === "decision" ? (
      "Decisions log"
    ) : (
      TAB_LABEL[activeFilter]
    );

  /* ------------------------------------------------------- header actions */

  const activeConnections = connections.filter((c) => c.status === "active");
  const headerActions =
    connections.length > 0 ? (
      <>
        {/* Stage D8: one button per ACTIVE connection, generated from the
            connections — the label follows the architecture: "Sync with"
            when the provider has inbound (supportsInbound), "Send to" when
            outbound-only. The D7 pending badge rides the button of the
            provider whose queue it is (per-provider, pendingInbound counts
            all for now — the queue view is shared). */}
        {activeConnections.map((c) => {
          const name = PROVIDER_DISPLAY_NAME[c.provider] ?? c.provider;
          return (
            <Button
              key={c.provider}
              variant="ghost"
              size="sm"
              title={t("integrations.sync.title", locale)}
              onClick={() => setPanelProvider(c.provider)}
            >
              {t(c.supportsInbound ? "integrations.sync.with" : "integrations.send.to", locale, {
                provider: name,
              })}
              {c.supportsInbound && pendingInbound > 0 && (
                <span
                  className="intel-badge"
                  aria-label={`${pendingInbound} external changes across providers`}
                >
                  {pendingInbound}
                </span>
              )}
            </Button>
          );
        })}
        {connections.length > 0 && activeConnections.length === 0 && (
          <span className="intel-note mono">
            {t("integrations.not_connected", locale, {
              provider: PROVIDER_DISPLAY_NAME[connections[0]!.provider] ?? connections[0]!.provider,
            })}
          </span>
        )}
      </>
    ) : undefined;

  /* --------------------------------------------------------------- a row */

  const renderRow = (row: IntelligenceRow) => {
    const node = workspace.nodes[row.id];
    const prov = node?.provenance ?? node?.statement?.provenance;
    const quote = prov?.quote;
    const createdFrom = (prov?.createdFrom ?? []).filter((id) => id !== row.id);
    // ADR 0042: a board request made in conversation is evidence too — who
    // asked and when. Only when there is no meeting evidence (the meeting
    // is the more specific source when both exist).
    const conversation = !row.provenance ? prov?.conversation : undefined;
    const live = row.provenance?.meetingId === LIVE_SESSION;
    const meeting = row.provenance ? meetingsById.get(row.provenance.meetingId) : undefined;
    const range = row.provenance?.turnRange;
    const speakers =
      meeting && range
        ? [
            ...new Set(
              meeting.turns
                .slice(Math.max(0, range[0]), range[1] + 1)
                .map((turn) => turn.speaker)
                .filter(Boolean),
            ),
          ]
        : [];
    const replacedBy = supersededBy.get(row.id) ?? [];
    const link = linksByNode.get(row.id);
    const overdue = isOverdue(row.dueDate, row.executionStatus, now);
    const history = statementIsHistory(row.status);
    const settled = isSettled(row.status);
    const decided = row.kind === "decision" && row.status === "resolved";
    const hasFoot = Boolean(
      row.assignee ||
        row.dueDate ||
        row.executionStatus ||
        row.drivesActions ||
        row.provenance ||
        conversation ||
        createdFrom.some((id) => workspace.nodes[id]),
    );

    return (
      <Card
        key={row.id}
        id={rowDomId(row.id)}
        tabIndex={-1}
        className={`intel-row${settled ? " settled" : ""}${decided ? " decided" : ""}${history ? " history" : ""}${
          overdue ? " overdue" : ""
        }${focusId === row.id ? " flash" : ""}`}
        style={{ ["--kind" as string]: KIND_TINT[row.kind] }}
      >
        {/* Stage D2: the plan-selection checkbox — every statement row is a
            candidate plan source (hidden for viewers: send refuses them). */}
        {!readOnly && (
          <input
            type="checkbox"
            className="intel-check"
            aria-label={`Select ${row.label} for planning`}
            checked={checked.has(row.id)}
            onChange={() => toggleChecked(row.id)}
          />
        )}
        <div className="intel-row-body">
          <div className="intel-row-top">
            <KindBadge kind={row.kind} status={row.status} />
            {row.topic && (
              <span className="intel-topic mono" title="Topic">
                {row.topic}
              </span>
            )}
            {overdue && <span className="intel-flag alert mono">Overdue</span>}
            {/* Stage D6: the ↗ chip — the board's external link for this
                row, straight from the link registry. */}
            {link && (
              <a
                href={link.url ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="intel-ext mono"
                title={t("integrations.chip.title", locale, {
                  at: new Date(link.syncedAt).toISOString().slice(0, 10),
                  // D8: the provider's raw word — the user can see what the
                  // external system shows.
                  ...(link.status ? { external: link.status } : {}),
                })}
              >
                ↗ {link.externalId}
              </a>
            )}
            <ProvenanceChip
              icon={<Ico.Layers aria-hidden />}
              label="Show on board"
              title={`Select “${row.label}” on the canvas`}
              onClick={() => onCitation({ kind: "node", id: row.id })}
            />
          </div>

          <button
            type="button"
            className={`intel-row-label${decided ? " serif" : ""}`}
            title={rowHint(row, row.kind)}
            onClick={() => onCitation({ kind: "node", id: row.id })}
          >
            {row.label}
          </button>

          {/* The words behind a meeting statement, attributed to the turns'
              speakers. A conversation request's words ride its chip as a
              tooltip instead: one request often builds many statements, and
              repeating it on every row would drown the rows themselves. */}
          {quote && !conversation && (
            <blockquote className="intel-quote">
              <span className="serif">“{quote}”</span>
              {speakers.length > 0 && (
                <span className="intel-quote-by mono">— {speakers.slice(0, 3).join(", ")}</span>
              )}
            </blockquote>
          )}

          {(row.supersedes?.length || replacedBy.length > 0) && (
            <div className="intel-lineage mono">
              {row.supersedes?.map((id) => {
                const label = labelOf(id);
                return (
                  <span key={`s-${id}`} className="intel-lineage-item">
                    supersedes{" "}
                    {label ? (
                      <button type="button" onClick={() => jumpTo(id)}>
                        {label}
                      </button>
                    ) : (
                      <em>a removed statement</em>
                    )}
                  </span>
                );
              })}
              {replacedBy.map((id) => (
                <span key={`r-${id}`} className="intel-lineage-item">
                  superseded by{" "}
                  <button type="button" onClick={() => jumpTo(id)}>
                    {labelOf(id) ?? id}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Stage D3: the derived lines — computed project truth beside the
              manual state, never merged. */}
          {row.blockedBy?.length ? (
            <div className="intel-derived alert mono">
              {t("intel.row.blocked", locale, { n: row.blockedBy.length })}:{" "}
              {row.blockedBy.map((id) => labelOf(id) ?? id).join(", ")}
            </div>
          ) : null}
          {row.atRiskBy?.length ? (
            <div className="intel-derived caution mono">
              {t("intel.row.atrisk", locale, { n: row.atRiskBy.length })}:{" "}
              {row.atRiskBy.map((id) => labelOf(id) ?? id).join(", ")}
            </div>
          ) : null}

          {hasFoot && (
            <div className="intel-row-foot">
              {row.assignee && (
                <span className="intel-owner">
                  <Avatar name={row.assignee} size={18} />
                  {row.assignee}
                </span>
              )}
              {row.dueDate && (
                <span className={`intel-meta mono${overdue ? " alert" : ""}`}>
                  due {formatDue(row.dueDate, now)}
                </span>
              )}
              {row.executionStatus && (
                <span className="intel-meta mono">{row.executionStatus.replace(/_/g, " ")}</span>
              )}
              {row.drivesActions ? (
                <span className="intel-meta mono">
                  {t("intel.row.drives", locale, { n: row.drivesActions })}
                </span>
              ) : null}
              {createdFrom.slice(0, 2).map((id) => {
                const src = workspace.nodes[id];
                if (!src) return null;
                return (
                  <ProvenanceChip
                    key={`from-${id}`}
                    icon={
                      src.statement ? (
                        <StatementGlyph kind={src.statement.kind} size={11} />
                      ) : (
                        <Ico.Arrow aria-hidden />
                      )
                    }
                    label={`from ${src.label}`}
                    title="The statement this was planned from"
                    onClick={() => jumpTo(id)}
                  />
                );
              })}
              {row.provenance && (
                <ProvenanceChip
                  icon={<Ico.Present aria-hidden />}
                  label={[
                    live ? "Live meeting" : "Meeting",
                    ...(meeting ? [formatMeetingDay(meeting.startedAt, now)] : []),
                    ...(range ? [turnsLabel(range)] : []),
                  ].join(" · ")}
                  title={
                    live
                      ? "Captured live — open the meeting view"
                      : "Open the meeting at the words that produced this"
                  }
                  onClick={() =>
                    // The live-session placeholder has no saved transcript
                    // to jump into — open the meeting view itself.
                    live
                      ? setView("meeting")
                      : onCitation({
                          kind: "meeting",
                          id: row.provenance!.meetingId,
                          ...(row.provenance!.turnRange
                            ? { turnRange: row.provenance!.turnRange }
                            : {}),
                        })
                  }
                />
              )}
              {conversation && (
                <ProvenanceChip
                  icon={<Ico.Comment aria-hidden />}
                  label={`From ${
                    conversation.by ? `${conversation.by.trim().split(/\s+/)[0]}'s` : "a"
                  } request · ${formatRequestTime(conversation.at, now)}`}
                  title={quote ? `“${quote}”` : "Asked in this board's conversation"}
                />
              )}
            </div>
          )}
        </div>
      </Card>
    );
  };

  /**
   * Open rows first (the projection's order), then the settled record under
   * quiet dividers: resolved statements — still current truth, a decided
   * decision is the board's answer — before the history (superseded and
   * rejected), which is kept visible, never deleted.
   */
  const renderRows = (rows: IntelligenceRow[]) => {
    const open = rows.filter((r) => !isSettled(r.status));
    const resolved = rows.filter((r) => isSettled(r.status) && !statementIsHistory(r.status));
    const past = rows.filter((r) => statementIsHistory(r.status));
    return (
      <div className="intel-rows">
        {open.map(renderRow)}
        {open.length > 0 && resolved.length > 0 && (
          <div className="intel-settled-label mono" role="separator">
            Settled · {resolved.length}
          </div>
        )}
        {resolved.map(renderRow)}
        {open.length + resolved.length > 0 && past.length > 0 && (
          <div className="intel-settled-label mono" role="separator">
            Superseded &amp; rejected · {past.length}
          </div>
        )}
        {past.map(renderRow)}
      </div>
    );
  };

  /* ----------------------------------------------------------- side column */

  const recommendations = (
    <section className="intel-side-block" aria-label={t("intel.inbox.title", locale)}>
      <SectionLabel count={visibleInbox.length}>{t("intel.inbox.title", locale)}</SectionLabel>
      {visibleInbox.length === 0 ? (
        <EmptyState
          compact
          title={t("intel.inbox.empty", locale)}
          body="When two topics look like the same subject, Lucent flags them here with the evidence. Nothing merges until you confirm."
        />
      ) : (
        <div className="intel-side-list">
          {visibleInbox.map((item) => {
            const preview = previewing === item.id ? mergePreview(workspace, item) : null;
            return (
              <Card key={item.id} className="intel-rec">
                <div className="intel-rec-eyebrow mono">Possible duplicate topic</div>
                <div className="intel-rec-topics">
                  <span className="intel-topic mono">{item.dup}</span>
                  <span className="intel-rec-approx" aria-hidden>
                    ≈
                  </span>
                  <span className="intel-topic mono">{item.existing}</span>
                </div>
                <div className="sr-only">
                  {t("intel.inbox.dup", locale, { dup: item.dup, existing: item.existing })}
                </div>
                {/* Evidence (rule 4): counts and meetings, never "looks similar". */}
                <div className="intel-rec-evidence">
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
                    <div className="intel-rec-preview">
                      <div>
                        {t("intel.inbox.merge.preview", locale, {
                          dup: item.dup,
                          existing: item.existing,
                          n: preview.statementCount,
                        })}
                      </div>
                      <ul>
                        {preview.changes.slice(0, 5).map((c) => (
                          <li key={c.nodeId}>{labelOf(c.nodeId) ?? c.nodeId}</li>
                        ))}
                        {preview.changes.length > 5 && (
                          <li className="more">and {preview.changes.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                    {mergeError && (
                      <div className="intel-error" role="alert">
                        {mergeError}
                      </div>
                    )}
                    <div className="intel-rec-actions">
                      <Button variant="primary" size="sm" onClick={() => confirmMerge(item)}>
                        {t("intel.inbox.merge.confirm", locale)}
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => {
                          setPreviewing(null);
                          setMergeError(null);
                        }}
                      >
                        {t("intel.inbox.merge.cancel", locale)}
                      </Button>
                    </div>
                  </>
                ) : (
                  !readOnly && (
                    <div className="intel-rec-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setMergeError(null);
                          setPreviewing(item.id);
                        }}
                      >
                        {t("intel.inbox.merge", locale)}…
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => keepSeparate(item)}>
                        {t("intel.inbox.keep", locale)}
                      </Button>
                    </div>
                  )
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );

  /* — Stage D7: External changes — the human-gated inbound queue. Pending
     rows offer Accept/Keep-ours; a warning row (no translation) offers
     Keep-ours only — Accept would require guessing a status; decided rows
     dim with their outcome. — */
  const externalChanges =
    inbound.length > 0 ? (
      <section className="intel-side-block" aria-label={t("integrations.inbound.title", locale)}>
        <SectionLabel count={pendingInbound}>
          {t("integrations.inbound.title", locale)}
        </SectionLabel>
        <p className="intel-side-hint">{t("integrations.inbound.hint", locale)}</p>
        <div className="intel-side-list">
          {inbound.map((row) => {
            const actions = inboundRowActions(row);
            const busy = decidingInbound === row.id;
            const warning = inboundRowIsWarning(row);
            return (
              <Card
                key={row.id}
                className={`intel-inbound${row.status === "pending" ? " pending" : " decided"}${
                  warning ? " warning" : ""
                }`}
              >
                <div className="intel-inbound-head">
                  <button
                    type="button"
                    className="intel-inbound-label"
                    onClick={() => onCitation({ kind: "node", id: row.nodeId })}
                  >
                    {row.nodeLabel}
                  </button>
                  {row.url && (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="intel-ext mono"
                      title={t("integrations.chip.title", locale, {
                        at: new Date(row.detectedAt).toLocaleString(),
                      })}
                    >
                      ↗ {row.externalId}
                    </a>
                  )}
                </div>
                <div className="intel-inbound-line">
                  {warning
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
                  <div className="intel-inbound-outcome mono">
                    {row.status === "applied"
                      ? t("integrations.inbound.applied", locale)
                      : row.status === "dismissed"
                        ? t("integrations.inbound.dismissed", locale)
                        : t("integrations.inbound.superseded", locale)}
                  </div>
                )}
                {!readOnly && (actions.canAccept || actions.canDismiss) && (
                  <div className="intel-rec-actions">
                    {actions.canAccept && (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void decideInbound(row.id, "accept")}
                      >
                        {t("integrations.inbound.accept", locale)}
                      </Button>
                    )}
                    {actions.canDismiss && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void decideInbound(row.id, "dismiss")}
                      >
                        {t("integrations.inbound.dismiss", locale)}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </section>
    ) : null;

  /* ------------------------------------------------------------- the page */

  const tabs: FilterItem<Filter>[] = [
    { id: "all", label: "All", count: totalStatements },
    ...SECTION_ORDER.filter((kind) => sectionOf(kind).rows.length > 0).map((kind) => ({
      id: kind,
      label: TAB_LABEL[kind],
      count: sectionOf(kind).rows.length,
    })),
  ];
  const populated = sections.filter((s) => s.rows.length > 0);
  const missingKinds = sections.filter((s) => s.rows.length === 0).map((s) => s.kind);

  return (
    <>
      {/* The shared shell, like every other full surface (the audit's
          P1-IA-001: this view used to render bare, a navigation dead end). */}
      <Page
        crumbs={[
          { label: "Boards", view: "dashboard" },
          { label: projectName || "Untitled board", view: "canvas" },
          { label: t("intel.title", locale), current: true },
        ]}
        onOpenSettings={onOpenSettings}
        width="wide"
      >
        <PageHeader
          eyebrow={`${t("intel.title", locale)} · ${projectName}`}
          title={title}
          lede={
            totalStatements === 0
              ? t("intel.empty.view.hint", locale)
              : activeFilter === "all"
                ? boardLede()
                : kindLede(activeFilter)
          }
          actions={
            scopeSwitch || headerActions ? (
              <>
                {scopeSwitch}
                {headerActions}
              </>
            ) : undefined
          }
        />

        {totalStatements === 0 ? (
          <div className="intel-empty">
            <EmptyState
              glyph={
                <span className="intel-empty-glyphs" aria-hidden>
                  {SECTION_ORDER.map((kind) => (
                    <StatementGlyph key={kind} kind={kind} size={16} />
                  ))}
                </span>
              }
              title={t("intel.empty.view", locale)}
              body="Describe a decision in the canvas composer, or start a meeting — Lucent types every statement it hears as a decision, proposal, question, action, requirement or risk, tracks whether it is still open, and links it back to the words that produced it."
              action={
                <>
                  <Button variant="primary" onClick={() => setView("canvas")}>
                    Open the canvas
                  </Button>
                  {!readOnly && (
                    <Button variant="ghost" onClick={() => setView("meeting")}>
                      <Ico.Present aria-hidden /> Start a meeting
                    </Button>
                  )}
                </>
              }
            />
            {externalChanges}
          </div>
        ) : (
          <>
            <div className="intel-tabs-row">
              <FilterChips
                items={tabs}
                value={activeFilter}
                onChange={setFilter}
                label="Filter statements by kind"
              />
            </div>

            <div className="intel-grid">
              <div className="intel-main">
                {activeFilter === "all" ? (
                  <>
                    {populated.map((section) => {
                      const isCollapsed = collapsed.has(section.kind);
                      return (
                        <section
                          key={section.kind}
                          className="intel-section"
                          style={{ ["--kind" as string]: KIND_TINT[section.kind] }}
                          aria-label={sectionHeader(section.kind)}
                        >
                          <h2 className="intel-section-head">
                            <button
                              type="button"
                              className="intel-section-toggle"
                              onClick={() => toggle(section.kind)}
                              aria-expanded={!isCollapsed}
                            >
                              <StatementGlyph kind={section.kind} size={13} />
                              <span className="intel-section-name">
                                {sectionHeader(section.kind)}
                              </span>
                              {/* Counts are ALWAYS visible — collapsed or not. */}
                              <span className="section-count">{section.rows.length}</span>
                              <Ico.Down
                                className={`intel-chevron${isCollapsed ? " closed" : ""}`}
                                aria-hidden
                              />
                            </button>
                          </h2>
                          {!isCollapsed && renderRows(section.rows)}
                        </section>
                      );
                    })}
                    {missingKinds.length > 0 && (
                      <p className="intel-missing">
                        {t("intel.empty.section", locale, {
                          kind: orList(missingKinds.map((k) => sectionHeader(k).toLowerCase())),
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  renderRows(sectionOf(activeFilter).rows)
                )}

                {checked.size > 0 && !readOnly && (
                  <div className="intel-plan-bar" role="region" aria-label="Plan from selection">
                    <span className="intel-plan-count">
                      {plural(checked.size, "statement")} selected
                    </span>
                    <Button variant="quiet" size="sm" onClick={() => setChecked(new Set())}>
                      Clear
                    </Button>
                    <Button variant="primary" size="sm" onClick={planFromSelection}>
                      <Ico.Sparkle aria-hidden />
                      {t("intel.plan.from", locale, { n: checked.size })}
                    </Button>
                  </div>
                )}
              </div>

              <aside className="intel-side">
                {recommendations}
                {externalChanges}
              </aside>
            </div>
          </>
        )}
      </Page>
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
    </>
  );
}
