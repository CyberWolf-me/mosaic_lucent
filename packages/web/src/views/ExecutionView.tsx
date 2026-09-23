import { useEffect, useMemo, useState } from "react";
import type { Node } from "@lucent/core";
import {
  actionNodes,
  decisionsBehindAction,
  derivedExecution,
  isOverdueUnfinished,
} from "@lucent/core";
import { resolveLocale, t } from "@lucent/i18n";
import { useWorkspace } from "../workspace.js";
import { executionProjection, planDerivedActionIds } from "../execution.js";
import { IntegrationPanel } from "./IntegrationPanel.js";
import { fetchIntegrationLinks, fetchOrgIntegrations, type IntegrationLink } from "../boards.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import { getCurrentOrgId } from "../orgs.js";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  FilterChips,
  KindBadge,
  PageHeader,
  Page,
  ProvenanceChip,
  SectionLabel,
  StatTile,
} from "../ui/kit.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { statementIsHistory } from "../statementUi.js";

/** The provider display names, the Intelligence header's own map. */
const PROVIDER_DISPLAY_NAME: Record<string, string> = {
  linear: "Linear",
  github: "GitHub",
  jira: "Jira",
  fake: "Fake",
};

/**
 * Local mirror of what left Lucent (UX-3 execution ledger), keyed per board.
 * It used to be one global key, so a board opened before its links loaded
 * (or a local board, which cannot send at all) showed the ledger of whatever
 * board was viewed last — another board's issues presented as this one's.
 */
const SYNC_LEDGER_KEY = "lucent.syncLedger";

function readSyncLedger(boardId: string | null): IntegrationLink[] {
  if (!boardId) return [];
  try {
    const raw = localStorage.getItem(`${SYNC_LEDGER_KEY}.${boardId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as IntegrationLink[]) : [];
  } catch {
    return [];
  }
}

function writeSyncLedger(boardId: string, links: IntegrationLink[]): void {
  try {
    localStorage.setItem(`${SYNC_LEDGER_KEY}.${boardId}`, JSON.stringify(links));
  } catch {
    /* storage full or unavailable: the server list remains the truth */
  }
}

/** The canonical execution statuses (ADR 0027) as a person says them. */
const EXEC_STATUS_LABEL: Record<string, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

const PRIORITY_LABEL: Record<string, string> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
  lowest: "Lowest",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A calendar due date (timezone-naive ISO, ADR 0027) as a short phrase. */
function dueText(dueDate: string, now: number, overdue: boolean): string {
  const [y, m, d] = dueDate.split("-").map(Number);
  if (!y || !m || !d) return dueDate;
  const today = new Date(now);
  const days = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) /
      86_400_000,
  );
  const date = `${MONTHS[m - 1]} ${d}${y === today.getFullYear() ? "" : `, ${y}`}`;
  if (overdue) return days === -1 ? "Overdue · was due yesterday" : `Overdue · was due ${date}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${date}`;
}

function dateTime(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

/** Where a node's meeting evidence lives: top-level (CREATE_NODE) or on the statement. */
function meetingOrigin(
  node: Node | undefined,
): { id: string; turnRange?: [number, number]; quote?: string } | undefined {
  const p = node?.provenance?.meetingId ? node.provenance : node?.statement?.provenance;
  if (!p?.meetingId) return undefined;
  return {
    id: p.meetingId,
    ...(p.turnRange ? { turnRange: p.turnRange } : {}),
    ...(p.quote ? { quote: p.quote } : {}),
  };
}

/**
 * Conversation evidence (ADR 0042): Lucent made this from a request typed or
 * spoken to the board, outside a meeting — who asked, when, in which words.
 */
function conversationOrigin(
  node: Node | undefined,
): { at: number; by?: string; quote?: string } | undefined {
  const p = node?.provenance?.conversation ? node.provenance : node?.statement?.provenance;
  if (!p?.conversation) return undefined;
  return {
    at: p.conversation.at,
    ...(p.conversation.by ? { by: p.conversation.by } : {}),
    ...(p.quote ? { quote: p.quote } : {}),
  };
}

type ActionFilter = "all" | "open" | "inProgress" | "blocked" | "overdue" | "done";

/** One action card's worth of derived truth — nothing stored, all read from the board. */
interface ActionRow {
  node: Node;
  done: boolean;
  blocked: boolean;
  inProgress: boolean;
  overdue: boolean;
  /** Blocker-first chain up to (not including) this action. */
  blockedBy: Array<{ id: string; label: string }>;
  /** Upstream items past due and unfinished (ADR 0029's at-risk signal). */
  atRiskBy: Array<{ id: string; label: string }>;
  decisions: Node[];
  meeting?: { id: string; turnRange?: [number, number]; quote?: string };
  /** The chat request behind it, when no meeting is (ADR 0042). */
  conversation?: { at: number; by?: string; quote?: string };
  links: IntegrationLink[];
  rank: number;
}

/**
 * The Execution view (Stage E2, ADR 0037): one screen answering "how is
 * the work going and what's blocking us". Every surface is a projection of
 * the workspace (execution.ts — node-tested per the web suite's convention):
 *
 * - the rollup tiles — open / in progress / blocked / overdue / done %;
 *   at-risk keeps ADR 0029's distinction — an analytical signal with a
 *   tooltip, never a status;
 * - the action cards — owner, due date, execution status, the blocking
 *   and at-risk chains, and the provenance chain back through the
 *   decision(s) that drive the work to the meeting it came from, and out
 *   to the external issue it became (only the links that exist);
 * - "What needs attention", "What's blocking us" and "Decisions behind the
 *   work" — the reveal jumps to the board;
 * - the ledger of what left Lucent, with the org's honest connection state
 *   and the human-gated Send-to-provider bridge (Stage E3).
 *
 * The empty state teaches the loop: actions appear when a decision gets an
 * owner.
 */
export function ExecutionView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, onCitation, projectName, boardId, setView } = useWorkspace();
  const locale = useMemo(() => resolveLocale(navigator.language), []);
  // The whole dashboard is one pure projection of the workspace — derived
  // per render, never stored (ADR 0027). `now` moves with the workspace so
  // the overdue/at-risk reading and the rollup agree with each other.
  const { now, projection } = useMemo(() => {
    const at = Date.now();
    return { now: at, projection: executionProjection(workspace, at) };
  }, [workspace]);
  const { rollup, chains, decisionsBehind, empty, attention } = projection;
  // Stage E3: the bridge — the plan-derived action ids a Send-to-provider
  // button carries, and the org's active connections to offer.
  const bridgeIds = useMemo(() => planDerivedActionIds(workspace), [workspace]);
  const [connections, setConnections] = useState<
    Array<{ provider: string; status: string; supportsInbound?: boolean }>
  >([]);
  const [panelProvider, setPanelProvider] = useState<string | null>(null);
  // UX-3 execution ledger: what left Lucent. Server links are the truth;
  // localStorage keeps this board's last seen list for offline reads.
  const [syncLedger, setSyncLedger] = useState<IntegrationLink[]>(() => readSyncLedger(boardId));
  // Bumped when the integration panel reports new links, so an approved
  // send shows up in the ledger and on its card without leaving the view.
  const [linksVersion, setLinksVersion] = useState(0);
  const [meetings, setMeetings] = useState<Map<string, MeetingTranscript>>(() => new Map());
  const [filter, setFilter] = useState<ActionFilter>("all");

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
    if (!boardId) {
      setSyncLedger([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const links = await fetchIntegrationLinks(boardId);
      if (cancelled) return;
      setSyncLedger(links);
      writeSyncLedger(boardId, links);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, linksVersion]);
  // The board's meetings, so a provenance chain can say *which* meeting
  // (its date, who spoke) rather than a bare id. Shared boards only — a
  // local board has no server transcripts; its chain still links the id.
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void listMeetings(boardId)
      .then((rows) => {
        if (!cancelled) setMeetings(new Map((rows ?? []).map((m) => [m.id, m])));
      })
      .catch(() => {
        /* the chain degrades to the meeting id; nothing to report */
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // Per-action rows: the same derivation the rollup counts (manual status +
  // derived blocking + own due date), so a card and a tile never disagree.
  const rows = useMemo<ActionRow[]>(() => {
    const derived = derivedExecution(workspace, now);
    const labelOf = (id: string) => workspace.nodes[id]?.label ?? id;
    return actionNodes(workspace)
      .map((node) => {
        const issue = node.issue!;
        const d = derived.get(node.id);
        const done = issue.statusCategory === "done";
        const blocked = !done && (issue.status === "blocked" || (d?.blockedBy.length ?? 0) > 0);
        const overdue = !done && isOverdueUnfinished(issue.dueDate, issue.status, now);
        const inProgress = !done && !blocked && issue.statusCategory === "in_progress";
        const chain = chains.find((c) => c.nodeId === node.id);
        const blockedBy = (chain?.chain ?? []).filter((c) => c.id !== node.id);
        const atRiskBy = done ? [] : (d?.atRiskBy ?? []).map((id) => ({ id, label: labelOf(id) }));
        // Decisions behind the work: the drives edges (E1), plus any source
        // statement a plan derivation stamped (createdFrom) that is a decision.
        const decisions = decisionsBehindAction(workspace, node.id);
        for (const id of node.provenance?.createdFrom ?? []) {
          const src = workspace.nodes[id];
          if (src?.statement?.kind === "decision" && !decisions.some((x) => x.id === id)) {
            decisions.push(src);
          }
        }
        const meeting =
          meetingOrigin(node) ??
          decisions.map((x) => meetingOrigin(x)).find((m) => m !== undefined);
        // No meeting behind it: a request made to the board in conversation
        // is the first link instead (ADR 0042) — the action's own, else its
        // decision's. Nothing at all means no chain, never "made by hand".
        const conversation = meeting
          ? undefined
          : (conversationOrigin(node) ??
            decisions.map((x) => conversationOrigin(x)).find((c) => c !== undefined));
        const links = syncLedger.filter((l) => l.nodeId === node.id);
        const rank = blocked ? 0 : overdue ? 1 : inProgress ? 2 : done ? 4 : 3;
        return {
          node,
          done,
          blocked,
          inProgress,
          overdue,
          blockedBy,
          atRiskBy,
          decisions,
          ...(meeting ? { meeting } : {}),
          ...(conversation ? { conversation } : {}),
          links,
          rank,
        };
      })
      .sort((a, b) => a.rank - b.rank || a.node.label.localeCompare(b.node.label));
  }, [workspace, now, chains, syncLedger]);

  const counts: Record<ActionFilter, number> = {
    all: rows.length,
    open: rows.filter((r) => !r.done).length,
    inProgress: rows.filter((r) => r.inProgress).length,
    blocked: rows.filter((r) => r.blocked).length,
    overdue: rows.filter((r) => r.overdue).length,
    done: rows.filter((r) => r.done).length,
  };
  const visible = rows.filter((r) =>
    filter === "all"
      ? true
      : filter === "open"
        ? !r.done
        : filter === "inProgress"
          ? r.inProgress
          : filter === "blocked"
            ? r.blocked
            : filter === "overdue"
              ? r.overdue
              : r.done,
  );
  // One entry per decision, listing the active work it drives — the same
  // rows as the projection, grouped so a decision is named once.
  const decisionGroups: Array<{
    decisionId: string;
    decisionLabel: string;
    actions: Array<{ id: string; label: string }>;
  }> = [];
  for (const row of decisionsBehind) {
    let group = decisionGroups.find((g) => g.decisionId === row.decisionId);
    if (!group) {
      group = { decisionId: row.decisionId, decisionLabel: row.decisionLabel, actions: [] };
      decisionGroups.push(group);
    }
    group.actions.push({ id: row.actionId, label: row.actionLabel });
  }
  const provenanceAnywhere = rows.some(
    (r) => r.meeting || r.conversation || r.decisions.length > 0 || r.links.length > 0,
  );

  const crumbs = [
    { label: "Boards", view: "dashboard" as const },
    { label: projectName || "Untitled board", view: "canvas" as const },
    { label: t("exec.title", locale), current: true },
  ];
  const eyebrow = `${t("exec.title", locale)} · ${projectName || "Untitled board"}`;
  const title = (
    <>
      From decision to <em>done</em>
    </>
  );

  if (empty) {
    return (
      <Page crumbs={crumbs} onOpenSettings={onOpenSettings}>
        <PageHeader eyebrow={eyebrow} title={title} lede="No actions on this board yet." />
        <EmptyState
          glyph={<StatementGlyph kind="action" size={22} />}
          title={t("exec.empty.title", locale)}
          body={
            <>
              Actions appear when a decision gets an owner — from a meeting, from Intelligence, or
              when you ask Lucent to plan the work. Each keeps its chain back to the decision and
              the meeting it came from. {t("exec.empty.hint", locale)}
            </>
          }
          action={
            <>
              <Button variant="primary" size="sm" onClick={() => setView("intelligence")}>
                Open Intelligence
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setView("canvas")}>
                Back to the canvas
              </Button>
            </>
          }
        />
      </Page>
    );
  }

  const activeConnections = connections.filter((c) => c.status === "active");
  // Stage E3: the create-the-work bridge — one Send button per ACTIVE
  // connection, offered only when the board holds plan-derived actions. The
  // panel's Propose carries the ids through the propose-ai narrowing; the
  // approve gate, the warnings ack, and the exactly-once ledger all apply
  // as on any external action.
  const sendButtons =
    bridgeIds.length > 0
      ? activeConnections.map((c) => {
          const name = PROVIDER_DISPLAY_NAME[c.provider] ?? c.provider;
          return (
            <Button
              key={c.provider}
              variant="ghost"
              size="sm"
              title={`${t("integrations.send.to", locale, { provider: name })} — ${bridgeIds.length} plan-derived action${bridgeIds.length === 1 ? "" : "s"}`}
              onClick={() => setPanelProvider(c.provider)}
            >
              {t("integrations.send.to", locale, { provider: name })}
            </Button>
          );
        })
      : [];

  const lede = [
    `${rollup.total} action${rollup.total === 1 ? "" : "s"} on this board`,
    rollup.completed === 0 ? "none done yet" : `${rollup.completed} done`,
    ...(rollup.blocked > 0 ? [`${rollup.blocked} blocked`] : []),
    ...(rollup.overdue > 0 ? [`${rollup.overdue} overdue`] : []),
  ].join(" · ");

  const node = (id: string) => onCitation({ kind: "node", id });
  const openMeeting = (m: { id: string; turnRange?: [number, number] }) =>
    onCitation({ kind: "meeting", id: m.id, ...(m.turnRange ? { turnRange: m.turnRange } : {}) });

  return (
    <Page crumbs={crumbs} onOpenSettings={onOpenSettings}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        lede={lede}
        actions={sendButtons.length > 0 ? sendButtons : undefined}
      />

      {/* — The rollup: the five numbers a stakeholder asks for first — */}
      <div className="exec-stats">
        <StatTile
          label="Open"
          value={counts.open}
          sub={`of ${rollup.total} action${rollup.total === 1 ? "" : "s"}`}
          onClick={() => setFilter("open")}
        />
        <StatTile
          label={t("exec.counts.inProgress", locale)}
          value={rollup.inProgress}
          sub="not blocked"
          onClick={() => setFilter("inProgress")}
        />
        <StatTile
          label={t("exec.counts.blocked", locale)}
          value={rollup.blocked}
          tone={rollup.blocked > 0 ? "alert" : undefined}
          sub={
            rollup.atRisk > 0 ? (
              <span title={t("exec.atRisk.title", locale)}>
                {rollup.atRisk} {t("exec.counts.atRisk", locale).toLowerCase()} upstream
              </span>
            ) : rollup.blocked === 0 ? (
              t("exec.blocking.empty", locale)
            ) : undefined
          }
          onClick={() => setFilter("blocked")}
        />
        <StatTile
          label={t("exec.counts.overdue", locale)}
          value={rollup.overdue}
          tone={rollup.overdue > 0 ? "alert" : undefined}
          sub={rollup.overdue > 0 ? "past their due date" : "nothing past due"}
          onClick={() => setFilter("overdue")}
        />
        <StatTile
          label={t("exec.counts.completed", locale)}
          value={`${rollup.percent}%`}
          sub={
            <span className="exec-progress-sub">
              <span
                className="exec-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={rollup.percent}
                aria-label="Actions completed"
              >
                <span className="exec-progress-fill" style={{ width: `${rollup.percent}%` }} />
              </span>
              {rollup.completed} of {rollup.total}
            </span>
          }
          onClick={() => setFilter("done")}
        />
      </div>

      <div className="exec-layout">
        {/* — The actions: each card owner, due, status, chains, provenance — */}
        <section className="exec-main" aria-label="Actions">
          <SectionLabel count={rows.length} glyph={<StatementGlyph kind="action" size={11} />}>
            Actions
          </SectionLabel>
          <div className="exec-toolbar">
            <FilterChips<ActionFilter>
              label="Filter actions"
              value={filter}
              onChange={setFilter}
              items={(
                [
                  { id: "all", label: "All" },
                  { id: "open", label: "Open" },
                  { id: "inProgress", label: t("exec.counts.inProgress", locale) },
                  { id: "blocked", label: t("exec.counts.blocked", locale) },
                  { id: "overdue", label: t("exec.counts.overdue", locale) },
                  { id: "done", label: "Done" },
                ] as Array<{ id: ActionFilter; label: string }>
              )
                .filter((it) => it.id === "all" || it.id === filter || counts[it.id] > 0)
                .map((it) => ({ ...it, count: counts[it.id] }))}
            />
          </div>
          {!provenanceAnywhere && (
            <p className="exec-note">
              None of these actions records where it came from yet — no meeting, request, or
              decision behind it. Actions extracted from a meeting, made from a request to Lucent,
              or driven by a decision show that chain here.
            </p>
          )}
          {visible.length === 0 ? (
            <EmptyState
              compact
              title="No actions match this filter"
              action={
                <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                  Show all actions
                </Button>
              }
            />
          ) : (
            <div className="exec-cards">
              {visible.map((row) => (
                <ActionCard
                  key={row.node.id}
                  row={row}
                  now={now}
                  meetings={meetings}
                  atRiskTitle={t("exec.atRisk.title", locale)}
                  onNode={node}
                  onMeeting={openMeeting}
                />
              ))}
            </div>
          )}
        </section>

        <aside className="exec-side" aria-label="Execution signals">
          {/* — What needs attention (Phase 3): each item a reveal jump to its
            node. Renders only when something actually needs it. — */}
          {attention.items.length > 0 && (
            <>
              <SectionLabel count={attention.items.length}>
                {t("exec.attention.title", locale)}
              </SectionLabel>
              <Card className="exec-side-card">
                <ul className="exec-list">
                  {attention.items.map((item) => {
                    const kind = workspace.nodes[item.nodeId]?.statement?.kind;
                    return (
                      <li key={`${item.kind}-${item.nodeId}`} className="exec-attn">
                        <span className={`exec-attn-tag tone-${item.kind}`}>
                          {item.kind === "openDecision" ? (
                            <StatementGlyph kind="decision" size={10} />
                          ) : item.kind === "newStatement" && kind ? (
                            <StatementGlyph kind={kind} size={10} />
                          ) : (
                            <span className="exec-attn-dot" aria-hidden />
                          )}
                          {item.kind === "blocked"
                            ? "Blocked"
                            : item.kind === "overdue"
                              ? "Overdue"
                              : item.kind === "openDecision"
                                ? "Open decision"
                                : "From a meeting"}
                        </span>
                        <button
                          type="button"
                          className="exec-link"
                          title={`Show on the board — ${item.reason}`}
                          onClick={() => node(item.nodeId)}
                        >
                          {item.label}
                        </button>
                        <span className="exec-attn-reason">
                          {item.reason}
                          {item.meetingId && (
                            <ProvenanceChip
                              label="Open meeting"
                              title="Open the meeting this came from"
                              onClick={() => openMeeting({ id: item.meetingId! })}
                            />
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </>
          )}

          {/* — What's blocking us: the chains, blocker-first, every chip a jump — */}
          <SectionLabel count={chains.length || undefined}>
            {t("exec.blocking.title", locale)}
          </SectionLabel>
          <Card className="exec-side-card">
            {chains.length === 0 ? (
              <p className="exec-quiet">{t("exec.blocking.empty", locale)}</p>
            ) : (
              <ul className="exec-list">
                {chains.map((chain) => (
                  <li key={chain.nodeId}>
                    <ol className="exec-mini-chain" aria-label="Blocking chain, blocker first">
                      {chain.chain.map((n, i) => (
                        <li key={`${chain.nodeId}-${n.id}`}>
                          <button
                            type="button"
                            className={`exec-node-chip ${i === chain.chain.length - 1 ? "is-target" : ""}`}
                            title={n.id}
                            onClick={() => node(n.id)}
                          >
                            {n.label}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* — Decisions behind the work: the E1 payoff made visible — */}
          <SectionLabel
            count={decisionGroups.length || undefined}
            glyph={<StatementGlyph kind="decision" size={11} />}
          >
            {t("exec.decisions.title", locale)}
          </SectionLabel>
          <Card className="exec-side-card">
            {decisionsBehind.length === 0 ? (
              <p className="exec-quiet">{t("exec.decisions.empty", locale)}</p>
            ) : (
              <ul className="exec-list">
                {decisionGroups.map((g) => (
                  <li key={g.decisionId} className="exec-behind">
                    <button
                      type="button"
                      className="exec-behind-decision"
                      title={g.decisionId}
                      onClick={() => node(g.decisionId)}
                    >
                      <StatementGlyph kind="decision" size={10} />
                      <span>{g.decisionLabel}</span>
                    </button>
                    <span className="exec-behind-arrow" aria-hidden>
                      drives
                    </span>
                    {g.actions.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className="exec-link"
                        title={a.id}
                        onClick={() => node(a.id)}
                      >
                        {a.label}
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* — UX-3 execution ledger: what left Lucent (approved external sends) — */}
          <SectionLabel count={syncLedger.length || undefined}>
            Sent externally — what left Lucent
          </SectionLabel>
          <Card className="exec-side-card">
            {syncLedger.length === 0 ? (
              <p className="exec-quiet">
                Nothing sent externally yet — approved sends appear here.
              </p>
            ) : (
              <ul className="exec-list">
                {syncLedger.map((link) => (
                  <li
                    key={`${link.provider}-${link.externalId}-${link.nodeId}`}
                    className="exec-ledger"
                  >
                    <div className="exec-ledger-head">
                      <span className="exec-provider">
                        {PROVIDER_DISPLAY_NAME[link.provider] ?? link.provider}
                      </span>
                      {link.url ? (
                        <a
                          className="exec-ext-id"
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${link.externalId} in ${PROVIDER_DISPLAY_NAME[link.provider] ?? link.provider}`}
                        >
                          {link.externalId} ↗
                        </a>
                      ) : (
                        <span className="exec-ext-id">{link.externalId}</span>
                      )}
                      <span className="exec-ledger-status">{link.status}</span>
                    </div>
                    <div className="exec-ledger-meta">
                      {workspace.nodes[link.nodeId] ? (
                        <button
                          type="button"
                          className="exec-link"
                          onClick={() => node(link.nodeId)}
                        >
                          {workspace.nodes[link.nodeId]!.label}
                        </button>
                      ) : (
                        <span>no longer on the board</span>
                      )}
                      <span className="exec-ledger-time">{dateTime(link.syncedAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {/* The honest connection state: what is connected, what is not,
              and why there may be no Send button. Never a "Sync" offer
              without an active connection. */}
            <p className="exec-conn">
              {activeConnections.length > 0 ? (
                <>
                  Connected:{" "}
                  {activeConnections
                    .map((c) => PROVIDER_DISPLAY_NAME[c.provider] ?? c.provider)
                    .join(", ")}
                  .{" "}
                  {bridgeIds.length > 0
                    ? "Every send is proposed, reviewed, and approved before anything leaves."
                    : "Send appears once the board holds plan-derived actions."}
                </>
              ) : connections.length > 0 ? (
                t("integrations.not_connected", locale, {
                  provider:
                    PROVIDER_DISPLAY_NAME[connections[0]!.provider] ?? connections[0]!.provider,
                })
              ) : (
                "No tracker connected. Nothing leaves Lucent without a connection and your approval."
              )}
            </p>
          </Card>
        </aside>
      </div>

      {panelProvider && (
        <IntegrationPanel
          provider={panelProvider}
          connections={connections}
          nodeIds={bridgeIds}
          onClose={() => setPanelProvider(null)}
          onLinksChanged={() => setLinksVersion((v) => v + 1)}
        />
      )}
    </Page>
  );
}

/** One action: what it is, who owns it, when it's due, what holds it, where it came from. */
function ActionCard({
  row,
  now,
  meetings,
  atRiskTitle,
  onNode,
  onMeeting,
}: {
  row: ActionRow;
  now: number;
  meetings: Map<string, MeetingTranscript>;
  atRiskTitle: string;
  onNode: (id: string) => void;
  onMeeting: (m: { id: string; turnRange?: [number, number] }) => void;
}) {
  const { node } = row;
  const issue = node.issue!;
  const statementStatus = node.statement?.status;
  const statusText =
    row.blocked && issue.status !== "blocked"
      ? "Blocked upstream"
      : (EXEC_STATUS_LABEL[issue.status] ?? issue.status);
  const tone = row.blocked
    ? "blocked"
    : row.done
      ? issue.status === "cancelled"
        ? "muted"
        : "done"
      : row.inProgress
        ? "progress"
        : "open";
  const meeting = row.meeting ? meetings.get(row.meeting.id) : undefined;
  const speaker =
    meeting && row.meeting?.turnRange ? meeting.turns[row.meeting.turnRange[0]] : undefined;
  const hasChain =
    row.meeting || row.conversation || row.decisions.length > 0 || row.links.length > 0;

  return (
    <Card className={`exec-card ${row.blocked ? "is-blocked" : ""} ${row.done ? "is-done" : ""}`}>
      <div className="exec-card-head">
        <KindBadge
          kind="action"
          status={
            statementStatus && statementIsHistory(statementStatus) ? statementStatus : undefined
          }
        />
        <span className={`exec-status tone-${tone}`}>{statusText}</span>
        {issue.dueDate && (
          <span className={`exec-due ${row.overdue ? "is-overdue" : ""}`}>
            {dueText(issue.dueDate, now, row.overdue)}
          </span>
        )}
      </div>

      <button
        type="button"
        className="exec-card-title"
        title="Show on the board"
        onClick={() => onNode(node.id)}
      >
        {node.label}
      </button>
      {issue.description && <p className="exec-card-desc">{issue.description}</p>}

      <div className="exec-card-meta">
        {issue.assignee ? (
          <span className="exec-owner">
            <Avatar name={issue.assignee} size={20} />
            {issue.assignee}
          </span>
        ) : (
          <span className="exec-owner is-none">No owner yet</span>
        )}
        {issue.priority && (
          <span className="exec-meta-item">
            <span className="mono-caps">Priority</span> {PRIORITY_LABEL[issue.priority]}
          </span>
        )}
        {issue.storyPoints !== undefined && (
          <span className="exec-meta-item">
            <span className="mono-caps">Points</span> {issue.storyPoints}
          </span>
        )}
      </div>

      {row.blockedBy.length > 0 && (
        <div className="exec-flag tone-blocked">
          <span className="exec-flag-label">Blocked by</span>
          <ol className="exec-mini-chain" aria-label="Blocking chain, blocker first">
            {row.blockedBy.map((b) => (
              <li key={b.id}>
                <button type="button" className="exec-node-chip" onClick={() => onNode(b.id)}>
                  {b.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {row.atRiskBy.length > 0 && (
        <div className="exec-flag tone-risk" title={atRiskTitle}>
          <span className="exec-flag-label">At risk · upstream overdue</span>
          <ul className="exec-chip-row">
            {row.atRiskBy.map((b) => (
              <li key={b.id}>
                <button type="button" className="exec-node-chip" onClick={() => onNode(b.id)}>
                  {b.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The provenance chain: meeting → decision(s) → this action → the
        external issue. Only the links that exist are drawn. */}
      {hasChain && (
        <ol className="exec-chain" aria-label="Where this action came from">
          {row.meeting && (
            <li>
              <button
                type="button"
                className="exec-step"
                title="Open the meeting transcript"
                onClick={() => onMeeting(row.meeting!)}
              >
                <span className="exec-step-kind">Meeting</span>
                <span className="exec-step-label">
                  {meeting ? dateTime(meeting.startedAt) : "Transcript"}
                </span>
                {row.meeting.quote && (
                  <span className="exec-step-quote">
                    “{row.meeting.quote}”{speaker ? ` — ${speaker.speaker}` : ""}
                  </span>
                )}
              </button>
            </li>
          )}
          {row.conversation && (
            <li>
              <span
                className="exec-step"
                title={row.conversation.quote ? `“${row.conversation.quote}”` : undefined}
              >
                <span className="exec-step-kind">Conversation</span>
                <span className="exec-step-label">
                  {row.conversation.by
                    ? `From ${row.conversation.by}’s request`
                    : "From a request to Lucent"}{" "}
                  · {dateTime(row.conversation.at)}
                </span>
              </span>
            </li>
          )}
          {row.decisions.length > 0 && (
            <li className="exec-step-group">
              {row.decisions.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="exec-step is-decision"
                  title="Show the decision on the board"
                  onClick={() => onNode(d.id)}
                >
                  <span className="exec-step-kind">
                    <StatementGlyph kind="decision" size={10} />
                    Decision
                  </span>
                  <span className="exec-step-label serif">{d.label}</span>
                </button>
              ))}
            </li>
          )}
          <li>
            <span className="exec-step is-self">
              <span className="exec-step-kind">
                <StatementGlyph kind="action" size={10} />
                This action
              </span>
              <span className="exec-step-label">{statusText}</span>
            </span>
          </li>
          {row.links.length > 0 && (
            <li className="exec-step-group">
              {row.links.map((link) => {
                const provider = PROVIDER_DISPLAY_NAME[link.provider] ?? link.provider;
                const body = (
                  <>
                    <span className="exec-step-kind">{provider}</span>
                    <span className="exec-step-label mono">
                      {link.externalId}
                      {link.url ? " ↗" : ""}
                    </span>
                    <span className="exec-step-quote">{link.status}</span>
                  </>
                );
                return link.url ? (
                  <a
                    key={`${link.provider}-${link.externalId}`}
                    className="exec-step is-external"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open ${link.externalId} in ${provider}`}
                  >
                    {body}
                  </a>
                ) : (
                  <span
                    key={`${link.provider}-${link.externalId}`}
                    className="exec-step is-external"
                  >
                    {body}
                  </span>
                );
              })}
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}
