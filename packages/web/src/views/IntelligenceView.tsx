import { useMemo, useState } from "react";
import type { StatementKind, Workspace } from "@lucent/core";
import { resolveLocale, t } from "@lucent/i18n";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import { Ico } from "../ui/icons.js";
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
export function IntelligenceView(_: { onOpenSettings?: (section?: string) => void }) {
  const { workspace, onCitation, applyManual, send } = useWorkspace() as unknown as {
    workspace: Workspace;
    onCitation: WorkspaceState["onCitation"];
    applyManual: WorkspaceState["applyManual"];
    send: WorkspaceState["send"];
  };
  const locale = useMemo(() => resolveLocale(navigator.language), []);

  const sections = useMemo(() => intelligenceSections(workspace), [workspace]);
  const inbox = useMemo(() => inboxItems(workspace), [workspace]);
  const totalStatements = sections.reduce((n, s) => n + s.rows.length, 0);

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

  const visibleInbox = inbox.filter((item) => !suppressed.has(suppressionKey(item)));

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
   * checked statement ids flow through the ordinary send with the plan
   * attachment: the model's ops get gated (PLAN_SAFE_OPS) and stamped
   * (createdFrom) in the send path, then the >5-op batch opens the proposal
   * panel like any large change — the B3 gate is the plan's approval.
   */
  const planFromSelection = () => {
    const ids = [...checked];
    if (ids.length === 0) return;
    void send(planRequestText(ids.length), undefined, { plan: { statementIds: ids } });
    setChecked(new Set());
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
      row.supersedes?.length ? ` · ${t("intel.row.supersedes", locale, { n: row.supersedes.length })}` : ""
    }${row.dueDate ? ` · ${t("intel.row.due", locale, { date: row.dueDate })}` : ""}${
      row.executionStatus ? ` · ${row.executionStatus}` : ""
    }${row.topic ? ` · ${row.topic}` : ""} · ${sectionHeader(kind)}`;

  return (
    <div
      style={{
        position: "absolute",
        top: 76,
        bottom: 30,
        left: 76,
        right: 30,
        display: "grid",
        gridTemplateColumns: "minmax(420px, 520px) 1fr",
        gap: 18,
      }}
    >
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
        </div>
        <div className="panel-body" style={{ overflowY: "auto", padding: 6 }}>
          {totalStatements === 0 ? (
            <div className="view-empty" style={{ position: "static", padding: "40px 20px" }}>
              <div className="view-empty-icon">
                <Ico.Sparkle />
              </div>
              <h2>{t("intel.empty.view", locale)}</h2>
              <p>{t("intel.empty.view.hint", locale)}</p>
            </div>
          ) : (
            sections.map((section) => {
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
                        {t("intel.empty.section", locale, { kind: sectionHeader(section.kind).toLowerCase() })}
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
                            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}>
                              {row.status}
                              {row.assignee
                                ? ` · ${t("intel.row.assignee", locale, { name: row.assignee })}`
                                : ""}
                              {row.supersedes?.length
                                ? ` · ${t("intel.row.supersedes", locale, { n: row.supersedes.length })}`
                                : ""}
                              {row.dueDate ? ` · ${t("intel.row.due", locale, { date: row.dueDate })}` : ""}
                              {row.executionStatus ? ` · ${row.executionStatus}` : ""}
                              {row.topic ? ` · ${row.topic}` : ""}
                            </div>
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
                        </div>
                      ))
                    ))}
                </div>
              );
            })
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
        <div className="panel-body" style={{ overflowY: "auto", padding: 12, display: "grid", gap: 10 }}>
          {visibleInbox.length === 0 ? (
            <div className="mono" style={{ padding: 24, textAlign: "center", fontSize: 12, color: "var(--ink-3)" }}>
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
                      a: item.existingStatements,
                      b: item.dupStatements,
                      m: item.meetings.length,
                    })}
                  </div>
                  {preview ? (
                    <>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-1)", lineHeight: 1.5 }}>
                        {t("intel.inbox.merge.preview", locale, {
                          dup: item.dup,
                          existing: item.existing,
                          n: preview.statementCount,
                        })}
                      </div>
                      {mergeError && (
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--sig-red)" }}>
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
  );
}
