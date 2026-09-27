import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { StatementKind } from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import {
  Button,
  EmptyState,
  KindBadge,
  Page,
  PageHeader,
  SectionLabel,
  StatTile,
} from "../ui/kit.js";
import { loadOrgs, type OrgSummary } from "../orgs.js";
import { hasSession } from "../session.js";
import { listBoards, type BoardSummary } from "../boards.js";
import type { MeetingSummary } from "../meetings.js";
import { KIND_LABEL } from "../statementUi.js";
import {
  createOrgProject,
  getOrgProject,
  listOrgProjects,
  setProjectBoard,
  updateOrgProject,
  type OrgProject,
  type OrgProjectStatus,
  type ProjectPage,
  type WorkspaceStatement,
} from "../orgProjects.js";
import { MeetingRow } from "./MeetingsView.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";

/**
 * Projects (docs/26 J2, ADR 0046) — what a team is working toward, and the
 * boards, meetings and decisions that belong to it. The list shows every
 * project in the workspace with what needs attention in each; a project's
 * page gathers its boards, its meetings and every statement on its boards.
 *
 * A project grants nothing: what shows here is only what this person could
 * see by opening the boards themselves.
 */

const STATUS_LABEL: Record<OrgProjectStatus, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
};

/** Sections on a project page, the same order as a board's Intelligence. */
const SECTION_ORDER: StatementKind[] = [
  "decision",
  "question",
  "action",
  "risk",
  "requirement",
  "proposal",
];

function selectedProject(): string | null {
  return new URLSearchParams(window.location.search).get("project");
}

function setSelectedProject(id: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (id) params.set("project", id);
  else params.delete("project");
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "failed" }
  | { kind: "ready"; org: OrgSummary };

export function ProjectsView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [selected, setSelected] = useState<string | null>(() => selectedProject());

  useEffect(() => {
    if (!hasSession()) {
      setLoad({ kind: "signed-out" });
      return;
    }
    void loadOrgs()
      .then(({ current }) =>
        setLoad(current ? { kind: "ready", org: current } : { kind: "signed-out" }),
      )
      .catch(() => setLoad({ kind: "failed" }));
  }, []);

  // The selection lives in the address bar, so a project page is a link —
  // and leaving the view leaves no stale selection behind for next time.
  const select = useCallback((id: string | null) => {
    setSelectedProject(id);
    setSelected(id);
  }, []);
  useEffect(() => () => setSelectedProject(null), []);

  return (
    <Page
      crumbs={[{ label: "Projects", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="narrow"
    >
      {load.kind === "loading" && (
        <div className="boards-notif-skeleton" role="status" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} />
          ))}
        </div>
      )}
      {load.kind === "signed-out" && (
        <>
          <PageHeader eyebrow="Projects" title="Projects" />
          <EmptyState
            compact
            title="Sign in to see your workspace's projects"
            body="Projects gather shared boards, so they need a signed-in session."
          />
        </>
      )}
      {load.kind === "failed" && (
        <>
          <PageHeader eyebrow="Projects" title="Projects" />
          <EmptyState compact title="Couldn't load your workspace" body="Try again in a moment." />
        </>
      )}
      {load.kind === "ready" &&
        (selected ? (
          <ProjectDetail org={load.org} projectId={selected} onBack={() => select(null)} />
        ) : (
          <ProjectList org={load.org} onOpen={select} />
        ))}
    </Page>
  );
}

/* ------------------------------------------------------------------------ */
/* The list                                                                  */
/* ------------------------------------------------------------------------ */

function ProjectList({ org, onOpen }: { org: OrgSummary; onOpen: (id: string) => void }) {
  const { notify } = useToast();
  const [projects, setProjects] = useState<OrgProject[] | null | "failed">(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const canEdit = org.role !== "viewer";

  const refresh = useCallback(async () => {
    const rows = await listOrgProjects(org.id, { archived: showArchived });
    setProjects(rows ?? "failed");
  }, [org.id, showArchived]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = Array.isArray(projects) ? projects : [];
  const newButton = canEdit ? (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Ico.Plus /> New project
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Projects"
        title={
          rows.length > 0 ? (
            <>
              {rows.length} <em>{rows.length === 1 ? "project" : "projects"}</em>
            </>
          ) : (
            "Projects"
          )
        }
        lede="What the team is working toward — each project gathers its boards, their meetings, and every decision and open question on them."
        actions={rows.length > 0 ? newButton : undefined}
      />

      {creating && (
        <NewProjectForm
          org={org}
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            notify(`Created “${p.name}”`);
            onOpen(p.id);
          }}
        />
      )}

      {projects === null && (
        <div className="boards-notif-skeleton" role="status" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} />
          ))}
        </div>
      )}
      {projects === "failed" && (
        <div role="alert">
          <EmptyState
            compact
            title="Couldn't load projects"
            body="The Lucent server didn't answer, or answered with an error."
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {Array.isArray(projects) && projects.length === 0 && !creating && (
        <EmptyState
          glyph={<Ico.Grid width={22} height={22} />}
          title={showArchived ? "No archived projects" : "No projects yet"}
          body={
            canEdit
              ? "Start one for something the team is working toward, and add the boards where the work happens."
              : "Projects your workspace creates appear here."
          }
          action={showArchived ? undefined : newButton}
        />
      )}

      {rows.length > 0 && (
        <ul className="boards-notif-list" aria-label="Projects">
          {rows.map((p) => (
            <li key={p.id}>
              <button type="button" className="boards-notif-row read" onClick={() => onOpen(p.id)}>
                <span className="boards-notif-ico" aria-hidden="true">
                  <Ico.Grid />
                </span>
                <span className="boards-notif-main">
                  <span className="boards-notif-meta">
                    <span className="mono-caps">
                      {p.boards.length} {p.boards.length === 1 ? "board" : "boards"}
                    </span>
                    {p.status !== "active" && (
                      <span className="boards-notif-new">{STATUS_LABEL[p.status]}</span>
                    )}
                    {p.archivedAt !== null && <span className="boards-notif-new">Archived</span>}
                  </span>
                  <span className="boards-notif-title">{p.name}</span>
                  <span className="boards-notif-body">
                    {projectSignals(p) || p.objective || "No objective yet"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="projects-footer">
        <Button variant="quiet" size="sm" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Show active projects" : "Show archived"}
        </Button>
      </div>
    </>
  );
}

/** "2 blocked · 3 open questions" — what needs attention, or nothing. */
function projectSignals(p: OrgProject): string {
  const s = p.stats;
  if (!s) return "";
  return [
    s.blocked > 0 ? `${s.blocked} blocked` : null,
    s.openQuestions > 0
      ? `${s.openQuestions} open question${s.openQuestions === 1 ? "" : "s"}`
      : null,
    s.openActions > 0 ? `${s.openActions} open action${s.openActions === 1 ? "" : "s"}` : null,
    s.openRisks > 0 ? `${s.openRisks} open risk${s.openRisks === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function NewProjectForm({
  org,
  onCancel,
  onCreated,
}: {
  org: OrgSummary;
  onCancel: () => void;
  onCreated: (p: OrgProject) => void;
}) {
  const ids = { name: useId(), objective: useId() };
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void listBoards(org.id)
      .then(setBoards)
      .catch(() => setBoards([]));
  }, [org.id]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const result = await createOrgProject(org.id, {
      name: name.trim(),
      objective: objective.trim(),
      boardIds: [...chosen],
    });
    setSaving(false);
    if (result.ok) onCreated(result.value);
    else setError(result.error);
  };

  return (
    <form className="projects-form" onSubmit={(e) => void submit(e)} aria-label="New project">
      <div className="field auth-field">
        <label className="field-label" htmlFor={ids.name}>
          Name
        </label>
        <input
          id={ids.name}
          className="field-input auth-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Q4 pricing"
          maxLength={120}
          autoFocus
        />
      </div>
      <div className="field auth-field">
        <label className="field-label" htmlFor={ids.objective}>
          Objective
        </label>
        <textarea
          id={ids.objective}
          className="field-input auth-input"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="What this project is for, in a sentence or two."
          rows={2}
          maxLength={2000}
        />
      </div>
      <fieldset className="projects-boards-pick">
        <legend className="field-label">Boards</legend>
        {boards === null ? (
          <p className="sched-note">Loading boards…</p>
        ) : boards.length === 0 ? (
          <p className="sched-note">No shared boards yet — you can add boards later.</p>
        ) : (
          <ul>
            {boards.map((b) => (
              <li key={b.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(b.id)}
                    onChange={(e) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(b.id);
                        else next.delete(b.id);
                        return next;
                      })
                    }
                  />{" "}
                  {b.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && (
        <p className="sched-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!name.trim() || saving}>
          {saving ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------ */
/* One project                                                               */
/* ------------------------------------------------------------------------ */

function ProjectDetail({
  org,
  projectId,
  onBack,
}: {
  org: OrgSummary;
  projectId: string;
  onBack: () => void;
}) {
  const { boardId, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [page, setPage] = useState<ProjectPage | null | "missing">(null);
  const [orgBoards, setOrgBoards] = useState<BoardSummary[]>([]);
  const [editing, setEditing] = useState(false);
  const canEdit = org.role !== "viewer";

  const refresh = useCallback(async () => {
    const next = await getOrgProject(org.id, projectId);
    setPage(next ?? "missing");
  }, [org.id, projectId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!canEdit) return;
    void listBoards(org.id)
      .then(setOrgBoards)
      .catch(() => setOrgBoards([]));
  }, [org.id, canEdit]);

  const save = async (patch: Parameters<typeof updateOrgProject>[2]) => {
    const result = await updateOrgProject(org.id, projectId, patch);
    if (!result.ok) {
      notify(result.error, undefined, "error");
      return false;
    }
    await refresh();
    return true;
  };

  const link = async (id: string, linked: boolean) => {
    const result = await setProjectBoard(org.id, projectId, id, linked);
    if (!result.ok) notify(result.error, undefined, "error");
    else await refresh();
  };

  /** Open a board — and, given a node, select and centre it there. */
  const openOn = async (target: string, nodeId?: string) => {
    if (nodeId) {
      const params = new URLSearchParams(window.location.search);
      params.set("reveal", nodeId);
      window.history.replaceState(null, "", `?${params.toString()}`);
    }
    if (target === boardId) {
      setView("canvas");
      return;
    }
    if (!(await openBoard(target))) {
      notify("That board isn't available any more — it may have been deleted or unshared.");
    }
  };

  const openMeeting = async (m: MeetingSummary) => {
    if (m.boardId !== boardId && !(await openBoard(m.boardId))) {
      notify("Couldn't open that meeting's board — you may no longer have access.");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("meeting", m.id);
    params.set("board", m.boardId);
    window.history.replaceState(null, "", `?${params.toString()}`);
    setView("meeting");
  };

  const sections = useMemo(() => {
    const rows = page && page !== "missing" ? page.statements : [];
    return SECTION_ORDER.map((kind) => {
      const all = rows.filter((r) => r.kind === kind);
      return {
        kind,
        rows: [
          ...all.filter((r) => r.status === "open"),
          ...all.filter((r) => r.status !== "open"),
        ],
      };
    }).filter((s) => s.rows.length > 0);
  }, [page]);

  if (page === null) {
    return (
      <div className="boards-notif-skeleton" role="status" aria-label="Loading the project">
        {[0, 1, 2].map((i) => (
          <div key={i} />
        ))}
      </div>
    );
  }
  if (page === "missing") {
    return (
      <>
        <PageHeader eyebrow="Projects" title="Project not found" />
        <EmptyState
          compact
          title="This project isn't here"
          body="It may have been removed, or none of its boards are shared with you."
          action={
            <Button size="sm" onClick={onBack}>
              All projects
            </Button>
          }
        />
      </>
    );
  }

  const { project, meetings } = page;
  const stats = project.stats;
  const unlinked = orgBoards.filter((b) => !project.boards.some((pb) => pb.id === b.id));
  const liveOrNext = meetings.filter((m) => m.status === "live" || m.status === "scheduled");
  const past = meetings.filter((m) => m.status !== "live" && m.status !== "scheduled");

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            Project · {STATUS_LABEL[project.status]}
            {project.archivedAt !== null ? " · Archived" : ""}
          </>
        }
        title={project.name}
        lede={
          project.objective ||
          (canEdit ? "No objective yet — edit the project to add one." : undefined)
        }
        actions={
          <>
            <Button variant="quiet" onClick={onBack}>
              <Ico.Left /> All projects
            </Button>
            {canEdit && (
              <label className="projects-status">
                <span className="sr-only">Status</span>
                <select
                  className="field-input auth-input"
                  aria-label="Project status"
                  value={project.status}
                  onChange={(e) => void save({ status: e.target.value as OrgProjectStatus })}
                >
                  {(Object.keys(STATUS_LABEL) as OrgProjectStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {canEdit && (
              <Button onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</Button>
            )}
          </>
        }
      />

      {editing && (
        <EditProjectForm
          project={project}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            if (await save(patch)) setEditing(false);
          }}
          onArchive={async () => {
            if (await save({ archived: project.archivedAt === null })) {
              notify(project.archivedAt === null ? "Project archived" : "Project restored");
              setEditing(false);
            }
          }}
          archived={project.archivedAt !== null}
        />
      )}

      {stats && (
        <div className="projects-stats">
          <StatTile label="Open questions" value={stats.openQuestions} tone="question" />
          <StatTile label="Open actions" value={stats.openActions} tone="action" />
          <StatTile
            label="Blocked"
            value={stats.blocked}
            tone={stats.blocked > 0 ? "alert" : undefined}
          />
          <StatTile label="Decisions" value={stats.decisions} tone="decision" />
          <StatTile label="Open risks" value={stats.openRisks} tone="risk" />
        </div>
      )}

      <section className="boards-notif-group" aria-label="Boards">
        <SectionLabel count={project.boards.length}>Boards</SectionLabel>
        {project.boards.length === 0 ? (
          <p className="sched-note">
            {canEdit
              ? "No boards yet — add the boards where this work happens."
              : "No boards shared with you."}
          </p>
        ) : (
          <ul className="boards-notif-list">
            {project.boards.map((b) => (
              <li key={b.id} className="projects-board">
                <button
                  type="button"
                  className="boards-notif-row read"
                  onClick={() => void openOn(b.id)}
                >
                  <span className="boards-notif-ico" aria-hidden="true">
                    <Ico.Layers />
                  </span>
                  <span className="boards-notif-main">
                    <span className="boards-notif-title">{b.name}</span>
                    <span className="boards-notif-body">
                      edited{" "}
                      {new Date(b.updatedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </span>
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="projects-unlink"
                    aria-label={`Remove ${b.name} from the project`}
                    title="Remove from the project"
                    onClick={() => void link(b.id, false)}
                  >
                    <Ico.X />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && unlinked.length > 0 && (
          <label className="projects-add-board">
            <span className="field-label">Add a board</span>
            <select
              className="field-input auth-input"
              value=""
              onChange={(e) => {
                if (e.target.value) void link(e.target.value, true);
              }}
            >
              <option value="">Choose a board…</option>
              {unlinked.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {meetings.length > 0 && (
        <section className="boards-notif-group" aria-label="Meetings">
          <SectionLabel count={meetings.length}>Meetings</SectionLabel>
          <ul className="boards-notif-list">
            {[...liveOrNext, ...past].slice(0, 8).map((m) => (
              <MeetingRow key={m.id} meeting={m} onOpen={() => void openMeeting(m)} />
            ))}
          </ul>
        </section>
      )}

      {sections.length === 0 ? (
        <section className="boards-notif-group" aria-label="Intelligence">
          <SectionLabel>Decisions and open questions</SectionLabel>
          <p className="sched-note">
            Nothing yet. Decisions, questions, actions and risks on this project's boards collect
            here — from meetings, from what you ask Lucent, and from what you add by hand.
          </p>
        </section>
      ) : (
        sections.map((section) => (
          <section
            key={section.kind}
            className="boards-notif-group"
            aria-label={KIND_LABEL[section.kind].many}
          >
            <SectionLabel count={section.rows.length}>{KIND_LABEL[section.kind].many}</SectionLabel>
            <ul className="boards-notif-list">
              {section.rows.map((row) => (
                <StatementRow
                  key={`${row.boardId}:${row.id}`}
                  row={row}
                  showBoard={project.boards.length > 1}
                  onOpen={() => void openOn(row.boardId, row.id)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

function StatementRow({
  row,
  showBoard,
  onOpen,
}: {
  row: WorkspaceStatement;
  showBoard: boolean;
  onOpen: () => void;
}) {
  const detail = [
    showBoard ? row.boardName : null,
    row.assignee ?? null,
    row.dueDate ? `due ${row.dueDate}` : null,
    row.blocked && row.status === "open" ? "blocked" : null,
    row.provenance ? "from a meeting" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li>
      <button
        type="button"
        className={`boards-notif-row ${row.status === "open" ? "read" : "read settled"}`}
        onClick={onOpen}
        title="Open it on its board"
      >
        <span className="boards-notif-ico" aria-hidden="true">
          <StatementGlyph kind={row.kind} size={14} />
        </span>
        <span className="boards-notif-main">
          <span className="boards-notif-meta">
            <KindBadge kind={row.kind} status={row.status} />
            {row.trust === "ai-suggested" && (
              <span
                className="trust-chip"
                title="Lucent suggested this; no one has reviewed it yet"
              >
                Suggested
              </span>
            )}
          </span>
          <span className="boards-notif-title">{row.label}</span>
          {detail && <span className="boards-notif-body">{detail}</span>}
        </span>
      </button>
    </li>
  );
}

function EditProjectForm({
  project,
  archived,
  onCancel,
  onSave,
  onArchive,
}: {
  project: OrgProject;
  archived: boolean;
  onCancel: () => void;
  onSave: (patch: { name: string; objective: string }) => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const ids = { name: useId(), objective: useId() };
  const [name, setName] = useState(project.name);
  const [objective, setObjective] = useState(project.objective);
  return (
    <form
      className="projects-form"
      aria-label="Edit project"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void onSave({ name: name.trim(), objective: objective.trim() });
      }}
    >
      <div className="field auth-field">
        <label className="field-label" htmlFor={ids.name}>
          Name
        </label>
        <input
          id={ids.name}
          className="field-input auth-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>
      <div className="field auth-field">
        <label className="field-label" htmlFor={ids.objective}>
          Objective
        </label>
        <textarea
          id={ids.objective}
          className="field-input auth-input"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={3}
          maxLength={2000}
        />
      </div>
      <div className="confirm-actions">
        <Button variant="quiet" onClick={() => void onArchive()}>
          {archived ? "Restore project" : "Archive project"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!name.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
