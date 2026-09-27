import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  statementNodes,
  type StatementFields,
  type Workspace,
} from "@lucent/core";
import { Ico } from "../ui/icons.js";
import { DIAGRAM_LABELS } from "../scene.js";
import { Button, Card, EmptyState, FilterChips, Page, PageHeader, type FilterItem } from "../ui/kit.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { Dialog } from "../ui/primitives.js";
import { reviewWorkspace, useWorkspace } from "../workspace.js";
import {
  boardIdOfMirror,
  deleteProject,
  listProjects,
  loadProject,
  mirrorProjectId,
  saveProject,
} from "../persistence.js";
import { MiniPreview, type MiniKind } from "./MiniPreview.js";
import { csvToStickyOps } from "../board/serialize.js";
import {
  classifyImport,
  documentToOps,
  pdfIsCompressed,
  pdfToOps,
  svgToOps,
} from "../board/importers.js";
import { useToast } from "../ui/Toast.js";
import { hasSession } from "../session.js";
import { loadOrgs, setCurrentOrgId, type OrgSummary } from "../orgs.js";
import { listBoards, listSharedWithMe, type BoardSummary } from "../boards.js";
import { trashBoard } from "../trash.js";
import { KIND_TINT, statementIsHistory } from "../statementUi.js";
import { TEMPLATES, type Template } from "../templates.js";

/**
 * Boards — every board this person can open, in one grid (Atelier, fig. 12).
 *
 * Three sources, each labelled for what it is: projects saved in this browser
 * (`persistence`), the active org's server boards and the boards shared with
 * this user (`listBoards`). Local boards are read whole from localStorage, so
 * their cards carry a real sketch of the board and a real count of what it
 * has decided and left open; server boards are NOT fetched one by one, so
 * their cards say only what the list endpoint says.
 */

/** Where a card's board lives. `copy` is this browser's autosave of a server board. */
type Scope = "local" | "team" | "shared" | "copy";

type Filter = "all" | "local" | "team" | "shared" | "templates";

interface StatementTally {
  /** Current decisions: pending or decided, not rejected/superseded. */
  decisions: number;
  decided: number;
  openQuestions: number;
  openRisks: number;
  openActions: number;
}

interface BoardEntry {
  /** Local project id, or the server board id for team/shared boards. */
  id: string;
  name: string;
  updatedAt: number;
  scope: Scope;
  /** Server board a `copy` belongs to. */
  boardId?: string;
  nodes: number;
  /** Manual-layer objects (stickies, frames…), when the workspace was read. */
  shapes?: number;
  /** Singular diagram kind, when the workspace was read. */
  kind?: string;
  sketch: Sketch | null;
  /** Only for boards read from this browser; absent means "not known here". */
  tally?: StatementTally;
}

const KIND_NAME = DIAGRAM_LABELS;

const SCOPE_BADGE: Record<Scope, { label: string; title: string }> = {
  local: { label: "Local", title: "Saved in this browser only" },
  team: { label: "Team", title: "Stored on the server for your workspace" },
  shared: { label: "Shared", title: "Shared with you by someone else" },
  copy: {
    label: "Offline copy",
    title: "This browser's copy of a server board that isn't in the list right now",
  },
};

export function DashboardView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const {
    newProject,
    openProject,
    openBoard,
    importWorkspace,
    projectId,
    boardId: openBoardId,
    setProjectName,
  } = useWorkspace();
  const { notify } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);

  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [currentOrg, setCurrentOrg] = useState<OrgSummary | null>(null);
  const [cloudBoards, setCloudBoards] = useState<BoardSummary[]>([]);
  const [sharedBoards, setSharedBoards] = useState<BoardSummary[]>([]);
  /** docs/26 A6: boards other workspaces gave you — a guest's way back to them. */
  const [guestBoards, setGuestBoards] = useState<BoardSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listSharedWithMe().then((boards) => {
      if (!cancelled) setGuestBoards(boards);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // "idle" when signed out: there is no server list to wait for.
  const [cloudState, setCloudState] = useState<"idle" | "loading" | "ready" | "offline">(() =>
    hasSession() ? "loading" : "idle",
  );

  // Bumped after a rename/delete so the localStorage read runs again.
  const [localRev, setLocalRev] = useState(0);
  const [renaming, setRenaming] = useState<BoardEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<BoardEntry | null>(null);

  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { orgs: list, current } = await loadOrgs();
        if (cancelled) return;
        setOrgs(list);
        setCurrentOrg(current);
        if (!current) setCloudState("ready");
      } catch {
        // Offline or backend unavailable: local boards remain accessible.
        if (!cancelled) setCloudState("offline");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    setCloudState("loading");
    void (async () => {
      try {
        const [orgBoards, shared] = await Promise.all([
          listBoards(currentOrg.id),
          listBoards(currentOrg.id, "shared"),
        ]);
        if (cancelled) return;
        setCloudBoards(orgBoards);
        const orgBoardIds = new Set(orgBoards.map((b) => b.id));
        setSharedBoards(shared.filter((b) => !orgBoardIds.has(b.id)));
        setCloudState("ready");
      } catch {
        if (!cancelled) setCloudState("offline");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  const switchOrg = (id: string) => {
    const next = orgs.find((o) => o.id === id);
    if (!next || next.id === currentOrg?.id) return;
    setCurrentOrgId(next.id);
    setCloudBoards([]);
    setSharedBoards([]);
    setCurrentOrg(next);
  };

  /**
   * Hand a board to the workspace only once it passes the same schema check
   * importWorkspace applies. That check's refusal is otherwise written into
   * the canvas chat — on this page, where the chat isn't shown, a refused
   * import or template looked like a button that did nothing.
   */
  const adopt = (ws: unknown, name: string, what: string): boolean => {
    const review = reviewWorkspace(ws, what);
    if (!review.workspace) {
      notify(review.error ?? `${what} isn't a valid Lucent board.`);
      return false;
    }
    importWorkspace(review.workspace, name);
    return true;
  };

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    const name = file.name.replace(/\.[^.]+$/, "") || "Imported board";
    const kind = classifyImport(file.name, file.type);

    reader.onload = () => {
      const content = String(reader.result);

      if (kind === "json") {
        try {
          const data = JSON.parse(content);
          // Accept either a raw workspace or a saved project { workspace }.
          const ws = data.workspace ?? data;
          if (ws && typeof ws === "object" && ws.nodes) {
            adopt(ws, name, "That file");
            return;
          }
          notify("That JSON doesn't look like a Lucent board.");
        } catch {
          notify("Couldn't read that JSON file.");
        }
        return;
      }

      // Everything else becomes board objects in a fresh workspace.
      const ops =
        kind === "csv"
          ? csvToStickyOps(content)
          : kind === "svg"
            ? svgToOps(content)
            : kind === "pdf"
              ? pdfToOps(content)
              : kind === "document"
                ? documentToOps(content)
                : [];

      if (ops.length === 0) {
        // Say which case failed rather than importing an empty board silently.
        if (kind === "pdf") {
          notify(
            pdfIsCompressed(content)
              ? "That PDF's text is compressed, so it can't be read. Try exporting it as text."
              : "No readable text found in that PDF — it may be a scan.",
          );
        } else if (kind === "image") {
          notify("Drop an image straight onto the canvas to place it.");
        } else if (kind === "unknown") {
          notify("Unsupported file type. Try JSON, CSV, SVG, PDF, Markdown, or text.");
        } else {
          notify("Nothing importable found in that file.");
        }
        return;
      }

      if (!adopt(applyOperations(createWorkspace({ name }), ops), name, "That file")) return;
      notify(`Imported ${ops.length} object${ops.length > 1 ? "s" : ""} from ${file.name}.`);
    };

    reader.onerror = () => notify("Couldn't read that file.");
    // PDFs are parsed as text: the content streams we read are ASCII.
    reader.readAsText(file);
  };

  const localBoards: BoardEntry[] = useMemo(() => {
    // `localRev` is the re-read trigger after a rename or delete.
    void localRev;
    return readLocalBoards();
  }, [localRev]);

  const serverBoards: BoardEntry[] = useMemo(() => {
    const list: BoardEntry[] = [];
    const seen = new Set<string>();
    const add = (b: BoardSummary, scope: Scope) => {
      if (seen.has(b.id)) return;
      seen.add(b.id);
      // This browser's autosave of the board, when it has one, supplies the
      // thumbnail. Its statement counts are NOT shown: the copy can be behind
      // the server, and a stale "2 open questions" would read as current.
      const copy = loadProject(mirrorProjectId(b.id))?.workspace;
      list.push({
        id: b.id,
        name: b.name,
        updatedAt: b.updatedAt,
        scope,
        nodes: b.nodes ?? 0,
        sketch: copy ? sketchOf(copy) : null,
      });
    };
    for (const b of cloudBoards) add(b, "team");
    for (const b of sharedBoards) add(b, "shared");
    for (const b of guestBoards) add(b, "shared");
    return list;
  }, [cloudBoards, sharedBoards, guestBoards]);

  const boards: BoardEntry[] = useMemo(() => {
    const serverIds = new Set(serverBoards.map((b) => b.id));
    // A local copy of a board the server list already shows is the same board;
    // listing both put every opened team board on the grid twice.
    const locals = localBoards.filter(
      (p) => !serverIds.has(p.id) && !(p.boardId && serverIds.has(p.boardId)),
    );
    return [...serverBoards, ...locals].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [serverBoards, localBoards]);

  const templates = useMemo(() => TEMPLATES.map(templateEntry), []);

  const counts = useMemo(() => {
    const c = { local: 0, team: 0, shared: 0 };
    for (const b of boards) {
      if (b.scope === "local" || b.scope === "copy") c.local += 1;
      else c[b.scope] += 1;
    }
    return c;
  }, [boards]);

  const kinds = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of boards) if (b.kind) m.set(b.kind, (m.get(b.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [boards]);

  const localTotals = useMemo(() => {
    const t = { decisions: 0, openQuestions: 0 };
    for (const b of boards) {
      if (!b.tally) continue;
      t.decisions += b.tally.decisions;
      t.openQuestions += b.tally.openQuestions;
    }
    return t;
  }, [boards]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = boards;
    if (filter === "local") list = list.filter((b) => b.scope === "local" || b.scope === "copy");
    else if (filter === "team") list = list.filter((b) => b.scope === "team");
    else if (filter === "shared") list = list.filter((b) => b.scope === "shared");
    if (kindFilter !== "all") list = list.filter((b) => b.kind === kindFilter);
    if (q) {
      list = list.filter(
        (b) => b.name.toLowerCase().includes(q) || (b.kind ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [boards, filter, kindFilter, q]);

  const filteredTemplates = useMemo(
    () =>
      q
        ? templates.filter(
            (t) => t.name.toLowerCase().includes(q) || t.kind.toLowerCase().includes(q),
          )
        : templates,
    [templates, q],
  );

  const openEntry = async (b: BoardEntry) => {
    if (b.scope === "local") {
      openProject(b.id);
      return;
    }
    // A server board is opened live (its realtime room), never from the local
    // copy: opening the copy as a local project used to leave the shared
    // session and fork the board silently.
    const serverId = b.scope === "copy" ? b.boardId! : b.id;
    let ok = false;
    try {
      ok = await openBoard(serverId);
    } catch {
      ok = false;
    }
    if (ok) return;
    const localSlot = b.scope === "copy" ? b.id : mirrorProjectId(b.id);
    if (loadProject(localSlot)) {
      openProject(localSlot);
      notify("Couldn't reach that board on the server — opened this browser's copy.");
    } else {
      notify("That board isn't available to you any more.");
    }
  };

  const startFromTemplate = (t: Template) => {
    const ws = applyOperations(createWorkspace({ name: t.name }), t.build());
    adopt(ws, t.name, `The ${t.name} template`);
  };

  const showTemplates = () => {
    setFilter("templates");
    // After the grid swaps in; focus the section so keyboard users land on it.
    window.requestAnimationFrame(() => templatesRef.current?.focus());
  };

  const commitRename = () => {
    if (!renaming) return;
    const next = renameDraft.trim();
    if (!next || next === renaming.name) {
      setRenaming(null);
      return;
    }
    if (renaming.id === projectId) setProjectName(next);
    const data = loadProject(renaming.id);
    if (data) {
      const { updatedAt: _updatedAt, ...record } = data;
      saveProject({ ...record, name: next });
    }
    setRenaming(null);
    setLocalRev((r) => r + 1);
    notify(`Renamed to “${next}”.`);
  };

  const commitDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    if (target.scope === "team") {
      // docs/26 A6: a team board goes to the trash for 30 days.
      const result = await trashBoard(target.id);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      setCloudBoards((rows) => rows.filter((b) => b.id !== target.id));
      notify(`Moved “${target.name}” to the trash — restore it from Admin → Trash for 30 days.`);
      return;
    }
    deleteProject(target.id);
    notify(`Deleted “${target.name}”.`);
    setLocalRev((r) => r + 1);
  };

  const orgLabel = currentOrg?.name ?? "Personal";
  const filterItems: FilterItem<Filter>[] = [
    { id: "all", label: "All", count: boards.length },
    ...(counts.local > 0
      ? [{ id: "local" as const, label: "On this device", count: counts.local }]
      : []),
    ...(counts.team > 0 ? [{ id: "team" as const, label: "Team", count: counts.team }] : []),
    ...(counts.shared > 0
      ? [{ id: "shared" as const, label: "Shared with me", count: counts.shared }]
      : []),
    { id: "templates", label: "Templates", count: TEMPLATES.length },
  ];

  const lede =
    boards.length === 0 && cloudState === "loading"
      ? "Looking for your boards…"
      : boardsLede(boards.length, counts, orgLabel, localTotals);
  const now = Date.now();
  const firstRun = boards.length === 0 && cloudState !== "loading";

  return (
    <Page
      crumbs={[{ label: "Boards", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="wide"
    >
      <PageHeader
        eyebrow={`Boards · ${orgLabel}`}
        title={
          <>
            Every board, <em>one memory</em>
          </>
        }
        lede={lede}
        actions={
          <>
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>
              <Ico.Attach /> Import
            </Button>
            <Button variant="ghost" onClick={showTemplates}>
              <Ico.Book /> From template
            </Button>
            <Button variant="primary" onClick={newProject}>
              <Ico.Plus /> New board
            </Button>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        className="boards-file"
        tabIndex={-1}
        aria-hidden="true"
        accept=".json,.csv,.tsv,.svg,.pdf,.md,.markdown,.txt,application/json,text/csv,image/svg+xml,application/pdf,text/plain,text/markdown"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImportFile(f);
          e.currentTarget.value = "";
        }}
      />

      {firstRun && filter !== "templates" ? (
        <>
          <EmptyState
            glyph={<Ico.Folder width={22} height={22} />}
            title="Your first board starts with a sentence"
            body="Describe a system, a flow or a decision — typed or spoken — and Lucent builds a board you can edit. Each board shows up here with what it has decided and what is still open."
            action={
              <>
                <Button variant="primary" onClick={newProject}>
                  <Ico.Plus /> New board
                </Button>
                <Button variant="ghost" onClick={() => fileRef.current?.click()}>
                  <Ico.Attach /> Import a file
                </Button>
              </>
            }
          />
          {cloudState === "offline" && <OfflineNote />}
          <div className="section-label boards-section">
            <span>Or start from a template</span>
            <span className="section-count">{templates.length}</span>
          </div>
          <TemplateGrid templates={templates} onUse={startFromTemplate} />
        </>
      ) : (
        <>
          <div className="boards-toolbar">
            <FilterChips
              items={filterItems}
              value={filter}
              onChange={(id) => setFilter(id)}
              label="Which boards"
            />
            <div className="boards-toolbar-end">
              {orgs.length > 1 && (
                <label className="boards-select-wrap">
                  <span className="sr-only">Workspace</span>
                  <select
                    className="boards-select"
                    value={currentOrg?.id ?? ""}
                    onChange={(e) => switchOrg(e.target.value)}
                  >
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {filter !== "templates" && kinds.length > 1 && (
                <label className="boards-select-wrap">
                  <span className="sr-only">Diagram kind</span>
                  <select
                    className="boards-select"
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value)}
                  >
                    <option value="all">All kinds</option>
                    {kinds.map(([k, n]) => (
                      <option key={k} value={k}>
                        {k} · {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="boards-search">
                <Ico.Search width={13} height={13} aria-hidden="true" />
                <span className="sr-only">
                  {filter === "templates" ? "Search templates" : "Search boards"}
                </span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={filter === "templates" ? "Search templates" : "Search boards"}
                />
              </label>
            </div>
          </div>

          {cloudState === "loading" && (
            <p className="boards-note" role="status">
              Loading boards from {orgLabel}…
            </p>
          )}
          {cloudState === "offline" && <OfflineNote />}

          {filter === "templates" ? (
            <div
              ref={templatesRef}
              tabIndex={-1}
              className="boards-focus-target"
              aria-label="Templates"
            >
              {filteredTemplates.length === 0 ? (
                <EmptyState
                  compact
                  title={`No template matches “${search.trim()}”`}
                  action={
                    <Button size="sm" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  }
                />
              ) : (
                <TemplateGrid templates={filteredTemplates} onUse={startFromTemplate} />
              )}
            </div>
          ) : filtered.length === 0 && boards.length === 0 && cloudState === "loading" ? null : filtered.length === 0 ? (
            <EmptyState
              compact
              title={q ? `No board matches “${search.trim()}”` : "No boards in this view"}
              body={
                q
                  ? "Search looks at board names and diagram kinds."
                  : "Switch back to all boards, or start a new one."
              }
              action={
                <>
                  {q && (
                    <Button size="sm" onClick={() => setSearch("")}>
                      Clear search
                    </Button>
                  )}
                  {(filter !== "all" || kindFilter !== "all") && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setFilter("all");
                        setKindFilter("all");
                      }}
                    >
                      Show all boards
                    </Button>
                  )}
                </>
              }
            />
          ) : (
            <div className="boards-grid">
              {filtered.map((b) => (
                <BoardCard
                  key={`${b.scope}:${b.id}`}
                  board={b}
                  now={now}
                  isOpen={
                    b.scope === "local" || b.scope === "copy"
                      ? b.id === projectId
                      : b.id === openBoardId
                  }
                  onOpen={() => void openEntry(b)}
                  onRename={
                    b.scope === "local"
                      ? () => {
                          setRenameDraft(b.name);
                          setRenaming(b);
                        }
                      : undefined
                  }
                  // The open board can't be deleted from here: its next
                  // autosave would write it straight back.
                  onDelete={
                    (b.scope === "local" && b.id !== projectId) ||
                    (b.scope === "team" && b.id !== openBoardId)
                      ? () => setDeleting(b)
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </>
      )}

      {renaming && (
        <Dialog onClose={() => setRenaming(null)} title="Rename board">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commitRename();
            }}
          >
            <label className="boards-dialog-field">
              <span className="sr-only">Board name</span>
              <input
                className="boards-dialog-input"
                value={renameDraft}
                maxLength={120}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setRenameDraft(e.target.value)}
              />
            </label>
            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={!renameDraft.trim()}>
                Rename
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      {deleting && (
        <Dialog onClose={() => setDeleting(null)} title={`Delete “${deleting.name}”?`}>
          <div className="confirm-body">
            {deleting.scope === "team"
              ? "It moves to the trash for 30 days: gone for everyone, and restorable from Admin → Trash until then."
              : "This removes the board and its conversation from this browser. It can't be undone."}
          </div>
          <div className="confirm-actions">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void commitDelete()}>
              {deleting.scope === "team" ? "Move to trash" : "Delete board"}
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}

function OfflineNote() {
  return (
    <p className="boards-note" role="status">
      Couldn&apos;t reach the server, so team and shared boards aren&apos;t listed. Everything saved
      in this browser is here.
    </p>
  );
}

/** The header's lede: real counts only, and only the ones that are known. */
function boardsLede(
  total: number,
  counts: { local: number; team: number; shared: number },
  orgLabel: string,
  totals: { decisions: number; openQuestions: number },
): string {
  if (total === 0) {
    return "Nothing here yet. A board is where a conversation turns into structure you can edit.";
  }
  const where: string[] = [];
  if (counts.local > 0) where.push(`${counts.local} on this device`);
  if (counts.team > 0) where.push(`${counts.team} in ${orgLabel}`);
  if (counts.shared > 0) where.push(`${counts.shared} shared with you`);
  let text = `${plural(total, "board")}`;
  if (where.length > 1) text += ` — ${joinList(where)}`;
  else if (counts.local === total) text += " saved on this device";
  text += ".";
  const held: string[] = [];
  if (totals.decisions > 0) held.push(plural(totals.decisions, "decision"));
  if (totals.openQuestions > 0) held.push(plural(totals.openQuestions, "open question"));
  if (held.length > 0) {
    const subject =
      counts.local > 1
        ? "The boards on this device hold"
        : counts.local === total
          ? "It holds"
          : "The board on this device holds";
    text += ` ${subject} ${joinList(held)}.`;
  }
  return text;
}

function BoardCard({
  board,
  now,
  isOpen,
  onOpen,
  onRename,
  onDelete,
}: {
  board: BoardEntry;
  now: number;
  isOpen: boolean;
  onOpen: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const badge = SCOPE_BADGE[board.scope];
  const meta = [
    board.kind ?? (board.scope === "team" || board.scope === "shared" ? "Server board" : "Board"),
    ...(board.nodes > 0 || !board.shapes ? [plural(board.nodes, "node")] : []),
    ...(board.shapes ? [plural(board.shapes, "shape")] : []),
    updatedLabel(board.updatedAt, now),
  ];
  return (
    <Card interactive className="boards-card">
      <button
        type="button"
        className="boards-card-open"
        onClick={onOpen}
        title={`Open ${board.name}`}
      >
        <div className="boards-thumb">
          {board.sketch ? (
            <BoardSketch sketch={board.sketch} />
          ) : (
            <span className="boards-thumb-empty mono-caps">
              {board.nodes > 0 && (board.scope === "team" || board.scope === "shared")
                ? "Preview after first open"
                : "Empty board"}
            </span>
          )}
          <span className="boards-badges">
            <span className={`boards-badge ${board.scope}`} title={badge.title}>
              {badge.label}
            </span>
            {isOpen && <span className="boards-badge open">Open now</span>}
          </span>
        </div>
        <div className="boards-card-body">
          <div className="boards-card-name">{board.name}</div>
          <div className="boards-card-meta mono" title={new Date(board.updatedAt).toLocaleString()}>
            {meta.join(" · ")}
          </div>
          {board.tally ? (
            <TallyRow tally={board.tally} />
          ) : (
            <div className="boards-tally none">
              Open it to see what it has decided and left open.
            </div>
          )}
        </div>
      </button>
      {(onRename || onDelete) && (
        <div className="boards-card-tools">
          {onRename && (
            <button
              type="button"
              className="boards-tool"
              onClick={onRename}
              aria-label={`Rename ${board.name}`}
            >
              Rename
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="boards-tool danger"
              onClick={onDelete}
              aria-label={`Delete ${board.name}`}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function TallyRow({ tally }: { tally: StatementTally }) {
  const all: { kind: StatementFields["kind"]; n: number; label: string; title: string }[] = [
    {
      kind: "decision",
      n: tally.decisions,
      label: plural(tally.decisions, "decision"),
      title: `${tally.decided} decided · ${tally.decisions - tally.decided} pending`,
    },
    {
      kind: "question",
      n: tally.openQuestions,
      label: plural(tally.openQuestions, "open question"),
      title: plural(tally.openQuestions, "question") + " still open",
    },
    {
      kind: "risk",
      n: tally.openRisks,
      label: plural(tally.openRisks, "open risk"),
      title: plural(tally.openRisks, "risk") + " not yet mitigated",
    },
    {
      kind: "action",
      n: tally.openActions,
      label: plural(tally.openActions, "open action"),
      title: plural(tally.openActions, "action") + " not done",
    },
  ];
  const items = all.filter((i) => i.n > 0);
  if (items.length === 0) {
    return <div className="boards-tally none">No decisions or open questions yet</div>;
  }
  return (
    <ul className="boards-tally">
      {items.map((i) => (
        <li key={i.kind} title={i.title}>
          <StatementGlyph kind={i.kind} size={11} />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

interface TemplateEntry {
  template: Template;
  name: string;
  kind: string;
  sketch: Sketch | null;
  mini: MiniKind;
}

function TemplateGrid({
  templates,
  onUse,
}: {
  templates: TemplateEntry[];
  onUse: (t: Template) => void;
}) {
  return (
    <div className="boards-grid">
      {templates.map((t) => (
        <Card key={t.template.id} interactive className="boards-card">
          <button
            type="button"
            className="boards-card-open"
            onClick={() => onUse(t.template)}
            title={`New board from the ${t.name} template`}
          >
            <div className="boards-thumb template">
              {t.sketch ? <BoardSketch sketch={t.sketch} /> : <MiniPreview kind={t.mini} />}
              <span className="boards-badges">
                <span className="boards-badge template">Template</span>
              </span>
            </div>
            <div className="boards-card-body">
              <div className="boards-card-name">{t.name}</div>
              <div className="boards-card-meta mono">{t.kind} · creates a new board</div>
            </div>
          </button>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ sketch */

type SketchTone = "node" | "frame" | "sticky" | "shape" | StatementFields["kind"];

interface SketchBox {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: SketchTone;
  round?: boolean;
}

interface Sketch {
  view: { x: number; y: number; w: number; h: number };
  boxes: SketchBox[];
  lines: [number, number, number, number][];
}

/** Enough marks to read a board's shape; a 2,000-node board needn't draw them all. */
const SKETCH_CAP = 260;

/**
 * The board, drawn small from its own geometry: the layout engine's node
 * positions, the manual layer's frames and stickies, and the edges between
 * nodes. Null when nothing on the board has a position yet.
 */
function sketchOf(ws: Workspace): Sketch | null {
  const boxes: SketchBox[] = [];
  const centre = new Map<string, [number, number]>();
  for (const s of Object.values(ws.shapes ?? {})) {
    if (!s.position || !s.size || s.kind === "draw" || s.kind === "text") continue;
    boxes.push({
      x: s.position.x,
      y: s.position.y,
      w: s.size.width,
      h: s.size.height,
      tone: s.kind === "frame" ? "frame" : s.kind === "sticky" ? "sticky" : "shape",
      round: s.kind === "ellipse",
    });
  }
  for (const n of Object.values(ws.nodes)) {
    if (!n.position) continue;
    const w = n.size?.width ?? 160;
    const h = n.size?.height ?? 72;
    boxes.push({
      x: n.position.x,
      y: n.position.y,
      w,
      h,
      tone: n.statement?.kind ?? "node",
    });
    centre.set(n.id, [n.position.x + w / 2, n.position.y + h / 2]);
  }
  if (boxes.length === 0) return null;
  const lines: [number, number, number, number][] = [];
  for (const e of Object.values(ws.edges)) {
    const a = centre.get(e.source);
    const b = centre.get(e.target);
    if (a && b) lines.push([a[0], a[1], b[0], b[1]]);
    if (lines.length >= SKETCH_CAP) break;
  }
  // Frames sit behind everything they contain.
  boxes.sort((p, q) => Number(p.tone !== "frame") - Number(q.tone !== "frame"));
  const drawn = boxes.slice(0, SKETCH_CAP);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of drawn) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const pad = Math.max(maxX - minX, maxY - minY) * 0.05 + 8;
  return {
    view: { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 },
    boxes: drawn,
    lines,
  };
}

function BoardSketch({ sketch }: { sketch: Sketch }) {
  const { view } = sketch;
  return (
    <svg
      className="boards-sketch"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {sketch.lines.map(([x1, y1, x2, y2], i) => (
        <line
          key={`l${i}`}
          className="boards-sk-edge"
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {sketch.boxes.map((b, i) => {
        const statement = b.tone in KIND_TINT;
        const cls = statement ? "boards-sk-statement" : `boards-sk-${b.tone}`;
        const style = statement
          ? { ["--kind" as string]: KIND_TINT[b.tone as StatementFields["kind"]] }
          : undefined;
        return b.round ? (
          <ellipse
            key={`b${i}`}
            className={cls}
            cx={b.x + b.w / 2}
            cy={b.y + b.h / 2}
            rx={b.w / 2}
            ry={b.h / 2}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <rect
            key={`b${i}`}
            className={cls}
            style={style}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={Math.min(b.w, b.h) * (b.tone === "frame" ? 0.04 : 0.14)}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------- data reads */

function readLocalBoards(): BoardEntry[] {
  return listProjects().map((p) => {
    const ws = loadProject(p.id)?.workspace;
    const copyOf = boardIdOfMirror(p.id);
    return {
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      scope: copyOf ? "copy" : "local",
      ...(copyOf ? { boardId: copyOf } : {}),
      nodes: ws ? Object.keys(ws.nodes).length : 0,
      shapes: ws ? Object.keys(ws.shapes ?? {}).length : 0,
      // A board with no diagram nodes has no diagram kind worth naming: a
      // sticky-only board would otherwise read as "Flowchart", the default.
      ...(ws && Object.keys(ws.nodes).length > 0
        ? { kind: KIND_NAME[ws.diagramKind] ?? "Board" }
        : {}),
      sketch: ws ? sketchOf(ws) : null,
      ...(ws ? { tally: tallyOf(ws) } : {}),
    };
  });
}

function tallyOf(ws: Workspace): StatementTally {
  const t: StatementTally = {
    decisions: 0,
    decided: 0,
    openQuestions: 0,
    openRisks: 0,
    openActions: 0,
  };
  for (const n of statementNodes(ws)) {
    const s = n.statement!;
    if (s.kind === "decision") {
      if (statementIsHistory(s.status)) continue;
      t.decisions += 1;
      if (s.status === "resolved") t.decided += 1;
    } else if (s.status === "open") {
      if (s.kind === "question") t.openQuestions += 1;
      else if (s.kind === "risk") t.openRisks += 1;
      else if (s.kind === "action") t.openActions += 1;
    }
  }
  return t;
}

/** A template's own board, built and laid out once so its card shows it. */
function templateEntry(t: Template): TemplateEntry {
  const mini: MiniKind = t.id === "mindmap-seed" ? "mind" : t.id === "swot" ? "arch" : "flow";
  let sketch: Sketch | null = null;
  try {
    let ws = applyOperations(createWorkspace({ name: t.name }), t.build());
    if (Object.values(ws.nodes).some((n) => !n.position)) ws = applyLayout(ws, computeLayout(ws));
    sketch = sketchOf(ws);
  } catch {
    sketch = null;
  }
  return { template: t, name: t.name, kind: t.kind, sketch, mini };
}

/* ---------------------------------------------------------------- wording */

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function updatedLabel(at: number, now: number): string {
  const mins = Math.floor(Math.max(0, now - at) / 60_000);
  if (mins < 1) return "updated just now";
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "updated yesterday";
  if (days < 7) return `updated ${days}d ago`;
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `updated ${d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })}`;
}
