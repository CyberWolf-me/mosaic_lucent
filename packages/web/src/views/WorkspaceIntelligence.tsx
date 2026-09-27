import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { isOverdueUnfinished, type StatementKind } from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { Button, EmptyState, FilterChips, KindBadge, Page, PageHeader } from "../ui/kit.js";
import { KIND_LABEL, KIND_TINT } from "../statementUi.js";
import { loadOrgs } from "../orgs.js";
import { hasSession } from "../session.js";
import {
  listOrgProjects,
  loadWorkspaceIntelligence,
  type OrgProject,
  type WorkspaceIntelligence as Answer,
  type WorkspaceStatement,
} from "../orgProjects.js";

/**
 * Intelligence across the workspace (docs/26 J3, ADR 0046): every decision,
 * question, action, requirement, risk and proposal on the boards this person
 * can read, from the server's index — the same rows each board's own view
 * shows, gathered. Narrowed by kind, by project, to what's still open, or to
 * work assigned to this person. A row opens its statement on its board.
 */

const SECTION_ORDER: StatementKind[] = [
  "decision",
  "question",
  "action",
  "risk",
  "requirement",
  "proposal",
];

type Filter = "all" | StatementKind;

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "failed" }
  | { kind: "ready"; answer: Answer };

export function WorkspaceIntelligence({
  onOpenSettings,
  scopeSwitch,
}: {
  onOpenSettings: (section?: string) => void;
  scopeSwitch: ReactNode;
}) {
  const { boardId, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [projects, setProjects] = useState<OrgProject[]>([]);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [openOnly, setOpenOnly] = useState(true);
  const [mine, setMine] = useState(false);
  const [project, setProject] = useState("");

  useEffect(() => {
    if (!hasSession()) {
      setLoad({ kind: "signed-out" });
      return;
    }
    void loadOrgs()
      .then(async ({ current }) => {
        if (!current) return setLoad({ kind: "signed-out" });
        setOrgId(current.id);
        setProjects((await listOrgProjects(current.id)) ?? []);
      })
      .catch(() => setLoad({ kind: "failed" }));
  }, []);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoad({ kind: "loading" });
    const answer = await loadWorkspaceIntelligence(orgId, {
      ...(openOnly ? { statuses: ["open"] } : {}),
      ...(mine ? { assignee: "me" } : {}),
      ...(project ? { project } : {}),
      limit: 2000,
    });
    setLoad(answer ? { kind: "ready", answer } : { kind: "failed" });
  }, [orgId, openOnly, mine, project]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => (load.kind === "ready" ? load.answer.statements : []), [load]);
  const byKind = useMemo(() => {
    const map = new Map<StatementKind, WorkspaceStatement[]>();
    for (const kind of SECTION_ORDER) map.set(kind, []);
    for (const row of rows) map.get(row.kind)?.push(row);
    return map;
  }, [rows]);
  const active: Filter =
    filter !== "all" && (byKind.get(filter)?.length ?? 0) === 0 ? "all" : filter;
  const boardCount = new Set(rows.map((r) => r.boardId)).size;

  const open = async (row: WorkspaceStatement) => {
    const params = new URLSearchParams(window.location.search);
    params.set("reveal", row.id);
    params.delete("scope");
    window.history.replaceState(null, "", `?${params.toString()}`);
    if (row.boardId === boardId) {
      setView("canvas");
      return;
    }
    if (!(await openBoard(row.boardId))) {
      notify("That board isn't available any more — it may have been deleted or unshared.");
    }
  };

  const counts = load.kind === "ready" ? load.answer.counts : null;
  const lede =
    load.kind !== "ready"
      ? undefined
      : rows.length === 0
        ? undefined
        : [
            `${rows.length} ${openOnly ? "open " : ""}${rows.length === 1 ? "statement" : "statements"} across ${boardCount} ${boardCount === 1 ? "board" : "boards"}`,
            counts && counts.question.open
              ? `${counts.question.open} open ${counts.question.open === 1 ? "question" : "questions"}`
              : null,
            counts && counts.decision.total
              ? `${counts.decision.total} ${counts.decision.total === 1 ? "decision" : "decisions"}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");

  const tabs: Array<{ id: Filter; label: string; count: number }> = [
    { id: "all", label: "All", count: rows.length },
    ...SECTION_ORDER.filter((k) => (byKind.get(k)?.length ?? 0) > 0).map((k) => ({
      id: k,
      label: KIND_LABEL[k].many,
      count: byKind.get(k)!.length,
    })),
  ];

  const renderRows = (list: WorkspaceStatement[]) => (
    <ul className="boards-notif-list">
      {list.map((row) => (
        <WorkspaceRow key={`${row.boardId}:${row.id}`} row={row} onOpen={() => void open(row)} />
      ))}
    </ul>
  );

  return (
    <Page
      crumbs={[{ label: "Intelligence", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="wide"
    >
      <PageHeader
        eyebrow="Intelligence · Workspace"
        title={
          <>
            What the workspace <em>knows</em>
          </>
        }
        lede={lede}
        actions={scopeSwitch}
      />

      <div className="wsi-toolbar">
        <label className="wsi-toggle">
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />{" "}
          Open only
        </label>
        <label className="wsi-toggle">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />{" "}
          Assigned to me
        </label>
        {projects.length > 0 && (
          <label className="wsi-toggle">
            <span className="sr-only">Project</span>
            <select
              className="field-input auth-input"
              aria-label="Project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">Every project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {load.kind === "loading" && (
        <div className="boards-notif-skeleton" role="status" aria-label="Loading intelligence">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} />
          ))}
        </div>
      )}
      {load.kind === "signed-out" && (
        <EmptyState
          compact
          title="Sign in to see your workspace's intelligence"
          body="The workspace view reads every shared board you can open, so it needs a signed-in session. This board's own view still works."
        />
      )}
      {load.kind === "failed" && (
        <div role="alert">
          <EmptyState
            compact
            title="Couldn't load the workspace's intelligence"
            body="The Lucent server didn't answer, or answered with an error."
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {load.kind === "ready" && rows.length === 0 && (
        <EmptyState
          glyph={<Ico.Sparkle width={22} height={22} />}
          title={mine ? "Nothing assigned to you" : openOnly ? "Nothing open" : "Nothing yet"}
          body="Decisions, questions, actions and risks from every board you can open collect here — from meetings, from what you ask Lucent, and from what you add by hand."
        />
      )}
      {load.kind === "ready" && rows.length > 0 && (
        <>
          <div className="intel-tabs-row">
            <FilterChips
              items={tabs}
              value={active}
              onChange={setFilter}
              label="Filter statements by kind"
            />
          </div>
          {active === "all"
            ? SECTION_ORDER.filter((k) => (byKind.get(k)?.length ?? 0) > 0).map((kind) => (
                <section
                  key={kind}
                  className="intel-section"
                  style={{ ["--kind" as string]: KIND_TINT[kind] }}
                  aria-label={KIND_LABEL[kind].many}
                >
                  <h2 className="intel-section-head">
                    <span className="intel-section-toggle">
                      <StatementGlyph kind={kind} size={13} />
                      <span className="intel-section-name">{KIND_LABEL[kind].many}</span>
                      <span className="section-count">{byKind.get(kind)!.length}</span>
                    </span>
                  </h2>
                  {renderRows(byKind.get(kind)!)}
                </section>
              ))
            : renderRows(byKind.get(active) ?? [])}
          {load.answer.truncated && (
            <p className="intel-missing">
              Showing the first {rows.length} of {load.answer.total}. Narrow by project or kind to
              see the rest.
            </p>
          )}
        </>
      )}
    </Page>
  );
}

function WorkspaceRow({ row, onOpen }: { row: WorkspaceStatement; onOpen: () => void }) {
  const late = isOverdueUnfinished(row.dueDate, row.executionStatus, Date.now());
  const detail = [
    row.assignee ?? null,
    row.dueDate ? (late ? `overdue since ${row.dueDate}` : `due ${row.dueDate}`) : null,
    row.blocked && row.status === "open" ? "blocked" : null,
    row.provenance ? "from a meeting" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        className="boards-notif-row read"
        onClick={onOpen}
        title="Open it on its board"
      >
        <span className="boards-notif-ico" aria-hidden="true">
          <StatementGlyph kind={row.kind} size={14} />
        </span>
        <span className="boards-notif-main">
          <span className="boards-notif-meta">
            <span className="mono-caps">{row.boardName || "Board"}</span>
            <KindBadge kind={row.kind} status={row.status} showKind={false} />
          </span>
          <span className="boards-notif-title">{row.label}</span>
          {detail && <span className="boards-notif-body">{detail}</span>}
        </span>
      </button>
    </li>
  );
}
