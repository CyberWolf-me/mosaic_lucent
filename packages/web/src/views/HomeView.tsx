import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { getSessionUser, hasSession } from "../session.js";
import { boardIdOfMirror, listProjects, loadProject } from "../persistence.js";
import { listBoards, type BoardSummary } from "../boards.js";
import { loadOrgs } from "../orgs.js";
import { listWorkspaceMeetings, meetingName, type MeetingSummary } from "../meetings.js";
import { listOrgProjects, loadWorkspaceIntelligence, type OrgProject } from "../orgProjects.js";
import { listFavorites, loadActivity, type ActivityItem, type FavoriteView } from "../me.js";
import { ScopedAsk } from "../ui/ScopedAsk.js";
import { threadScope } from "../workspaceAsk.js";
import {
  busiestBoard,
  dueLabel,
  greetingFor,
  isQuestionText,
  pulseLede,
  timeAgo,
  workspacePulse,
  type IndexedPulseRow,
  type PulseBoardInput,
  type PulseItem,
  type PulseNotice,
} from "../pulse.js";
import { Ico, ToolIco } from "../ui/icons.js";
import { useToast } from "../ui/Toast.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import {
  Avatar,
  Button,
  EmptyState,
  KindBadge,
  Page,
  PageHeader,
  ProvenanceChip,
  SectionLabel,
  StatTile,
} from "../ui/kit.js";

/**
 * Home — the workspace pulse. A returning user lands here (landing.ts) and it
 * answers three things from real data: what needs me, what changed, where do
 * I pick up. It is deliberately NOT a board list: the rows are statements
 * (open questions, pending decisions, late or blocked work) across boards,
 * each one click from the node itself.
 *
 * Scope: the open board (live), the local boards in storage, and — signed
 * in — every server board this person can read, whose statements come from
 * the workspace index (ADR 0046) rather than from loading each board. Meetings
 * and projects are the workspace's too. A server board the index can't speak
 * for (it failed, or the board holds no statements) is named as uncounted,
 * never guessed at.
 */

/** How many local boards Home reads (each is a storage read + parse). */
const LOCAL_BOARD_CAP = 12;
/** Rows before "Show all". */
const NEEDS_PREVIEW = 6;
const RECENT_LIMIT = 5;
const STARRED_PREVIEW = 6;
const ACTIVITY_PREVIEW = 6;

/** How a board key opens: a local project slot, a server board, or both. */
interface Opener {
  local?: string;
  cloud?: string;
}

const MISSING_BOARD = "That board isn't available any more — it may have been deleted or unshared.";

export function HomeView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const {
    setView,
    workspace,
    projectId,
    projectName,
    boardId,
    busy,
    openProject,
    openBoard,
    newProject,
    startNewBoardFor,
    ask,
    setPillMode,
    onCitation,
  } = useWorkspace();
  const { notify } = useToast();

  // A clock for the eyebrow and the relative times; a minute is precise enough.
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const user = getSessionUser();
  const firstName = user?.name?.trim().split(/\s+/)[0] ?? "";

  /* ------------------------------ sources ------------------------------ */

  // Local projects, newest first — read once per open board (the open board
  // itself comes live from the workspace, never from its autosave).
  const local = useMemo(() => {
    try {
      const metas = listProjects();
      const current = metas.find((p) => p.id === projectId) ?? null;
      const others = metas
        .filter((p) => p.id !== projectId)
        .slice(0, LOCAL_BOARD_CAP)
        .flatMap((p) => {
          const data = loadProject(p.id);
          return data ? [{ ...p, workspace: data.workspace }] : [];
        });
      return { current, others };
    } catch {
      return { current: null, others: [] };
    }
  }, [projectId]);

  // Server boards: names and edit times only (contents are not fetched here).
  const [cloud, setCloud] = useState<{ loaded: boolean; boards: BoardSummary[] }>(() => ({
    loaded: !hasSession(),
    boards: [],
  }));
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { current } = await loadOrgs();
        if (!current) return;
        const [own, shared] = await Promise.all([
          listBoards(current.id),
          listBoards(current.id, "shared"),
        ]);
        const seen = new Set<string>();
        const boards = [...own, ...shared].filter((b) =>
          seen.has(b.id) ? false : (seen.add(b.id), true),
        );
        if (!cancelled) setCloud({ loaded: true, boards });
      } catch {
        /* offline or signed out: local boards still answer */
      } finally {
        if (!cancelled) setCloud((c) => (c.loaded ? c : { ...c, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Yours across workspaces (docs/26 A6): what you starred, and what others
  // changed lately on the boards you follow. Either failing just hides it.
  const [mine, setMine] = useState<{
    loaded: boolean;
    starred: FavoriteView[];
    activity: ActivityItem[];
  }>(() => ({ loaded: !hasSession(), starred: [], activity: [] }));
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void Promise.all([listFavorites(), loadActivity()]).then(([starred, activity]) => {
      if (!cancelled) setMine({ loaded: true, starred: starred ?? [], activity: activity ?? [] });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The workspace's own reads (ADR 0046): every readable board's statements
  // from the index, the workspace's meetings, and its active projects. Each
  // part fails on its own — Home still answers from what it has.
  const [org, setOrg] = useState<{
    id: string | null;
    indexed: Map<string, IndexedPulseRow[]> | null;
    meetings: MeetingSummary[];
    projects: OrgProject[];
  }>({ id: null, indexed: null, meetings: [], projects: [] });
  /** A question Home's composer asked of the whole workspace (ADR 0048). */
  const [workspaceQuestion, setWorkspaceQuestion] = useState<string | null>(null);
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { current } = await loadOrgs();
        if (!current) return;
        const [intelligence, meetings, projects] = await Promise.all([
          loadWorkspaceIntelligence(current.id, { limit: 2000 }),
          listWorkspaceMeetings(current.id),
          listOrgProjects(current.id),
        ]);
        if (cancelled) return;
        let indexed: Map<string, IndexedPulseRow[]> | null = null;
        // A truncated answer would undercount; better uncounted than wrong.
        if (intelligence && !intelligence.truncated) {
          indexed = new Map();
          for (const row of intelligence.statements) {
            const list = indexed.get(row.boardId) ?? [];
            list.push(row);
            indexed.set(row.boardId, list);
          }
        }
        setOrg({ id: current.id, indexed, meetings: meetings ?? [], projects: projects ?? [] });
      } catch {
        /* offline: local boards still answer */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live first, then what's coming up soonest, then the most recent.
  const meetings = useMemo(() => {
    const live = org.meetings.filter((m) => m.status === "live");
    const upcoming = org.meetings
      .filter((m) => m.status === "scheduled" && (m.scheduledFor ?? 0) >= now - 60 * 60_000)
      .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0));
    const past = org.meetings.filter(
      (m) => m.status !== "live" && m.status !== "scheduled" && m.status !== "cancelled",
    );
    return [...live, ...upcoming, ...past];
  }, [org.meetings, now]);

  /* ------------------------------ the pulse ----------------------------- */

  const currentKey = boardIdOfMirror(projectId) ?? projectId;

  const { inputs, openers } = useMemo(() => {
    const openers = new Map<string, Opener>();
    const byKey = new Map<string, PulseBoardInput>();
    byKey.set(currentKey, {
      id: currentKey,
      name: projectName || local.current?.name || "This board",
      // A board never autosaved yet is as fresh as this visit.
      updatedAt: local.current?.updatedAt ?? mountedAt,
      workspace,
      isCurrent: true,
    });
    openers.set(currentKey, { local: projectId, ...(boardId ? { cloud: boardId } : {}) });
    for (const p of local.others) {
      const serverId = boardIdOfMirror(p.id);
      const key = serverId ?? p.id;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        id: key,
        name: p.name,
        updatedAt: p.updatedAt,
        workspace: p.workspace,
        isCurrent: false,
      });
      openers.set(key, { local: p.id, ...(serverId ? { cloud: serverId } : {}) });
    }
    for (const b of cloud.boards) {
      const known = byKey.get(b.id);
      if (known) {
        // The server's name and edit time are the truth for a shared board.
        if (!known.isCurrent) known.name = b.name;
        known.updatedAt = Math.max(known.updatedAt, b.updatedAt);
        openers.set(b.id, { ...openers.get(b.id), cloud: b.id });
        continue;
      }
      byKey.set(b.id, {
        id: b.id,
        name: b.name,
        updatedAt: b.updatedAt,
        workspace: null,
        // From the index when it answered: a board with no rows there holds
        // no statements, which is known, not unknown.
        indexed: org.indexed ? (org.indexed.get(b.id) ?? []) : null,
        isCurrent: false,
      });
      openers.set(b.id, { cloud: b.id });
    }
    return { inputs: [...byKey.values()], openers };
  }, [
    currentKey,
    projectId,
    projectName,
    boardId,
    workspace,
    local,
    cloud.boards,
    org.indexed,
    mountedAt,
  ]);

  const pulse = useMemo(() => workspacePulse(inputs, now), [inputs, now]);
  const lede = pulseLede(pulse);

  // Server boards neither loaded here nor spoken for by the index.
  const serverOnly = cloud.boards.filter((b) => {
    const input = inputs.find((i) => i.id === b.id);
    return input ? input.workspace === null && !input.indexed : false;
  });
  const serverOnlyWithContent = serverOnly.filter((b) => b.nodes === undefined || b.nodes > 0);
  // Something starred, or a teammate's recent change, is work to come back to.
  const hasWork =
    pulse.boardsWithContent > 0 ||
    serverOnlyWithContent.length > 0 ||
    mine.starred.length > 0 ||
    mine.activity.length > 0;
  const firstRun = !hasWork && cloud.loaded && mine.loaded;
  const settling = !hasWork && !(cloud.loaded && mine.loaded);

  /* ----------------------------- navigation ----------------------------- */

  /** Open a board by key; resolves false (and says so) when it is gone. */
  const openKey = useCallback(
    async (key: string): Promise<boolean> => {
      if (key === currentKey) return true;
      const target = openers.get(key);
      if (target?.cloud && (await openBoard(target.cloud))) return true;
      if (target?.local) {
        openProject(target.local);
        return true;
      }
      notify(MISSING_BOARD, undefined, "error");
      return false;
    },
    [currentKey, openers, openBoard, openProject, notify],
  );

  /** A board's view (Intelligence, Execution, canvas) — switching boards first when needed. */
  const goTo = useCallback(
    (key: string | null, view: View) => {
      if (!key || key === currentKey) {
        setView(view);
        return;
      }
      const target = openers.get(key);
      if (target?.local && !target.cloud) {
        // Synchronous: one render lands on the right board AND the right view.
        openProject(target.local);
        setView(view);
        return;
      }
      void openKey(key).then((ok) => {
        if (ok) setView(view);
      });
    },
    [currentKey, openers, openProject, openKey, setView],
  );

  /** The node itself: open its board, then select and centre it on the canvas. */
  const reveal = useCallback(
    (key: string, nodeId: string) => {
      if (key === currentKey) {
        onCitation({ kind: "node", id: nodeId });
        return;
      }
      const target = openers.get(key);
      if (target?.local && !target.cloud) {
        // Batched with the board switch, so the canvas mounts on the new board
        // with ?reveal= already set — the same path an Ask citation takes.
        openProject(target.local);
        onCitation({ kind: "node", id: nodeId });
        return;
      }
      // A server board loads asynchronously: park the reveal first so the
      // canvas consumes it when it mounts on the fetched board, not before.
      const params = new URLSearchParams(window.location.search);
      params.set("reveal", nodeId);
      window.history.replaceState(null, "", `?${params.toString()}`);
      void openKey(key).then((ok) => {
        if (ok) return;
        const clear = new URLSearchParams(window.location.search);
        clear.delete("reveal");
        window.history.replaceState(null, "", `?${clear.toString()}`);
      });
    },
    [currentKey, openers, openProject, onCitation, openKey],
  );

  /** A workspace meeting, on its own board (the Meetings view's route). */
  const openMeeting = async (m: MeetingSummary): Promise<void> => {
    if (m.boardId !== boardId && !(await openBoard(m.boardId))) {
      notify(MISSING_BOARD, undefined, "error");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("meeting", m.id);
    params.set("board", m.boardId);
    window.history.replaceState(null, "", `?${params.toString()}`);
    setView("meeting");
  };

  const openOrgProject = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("project", id);
    window.history.replaceState(null, "", `?${params.toString()}`);
    setView("projects");
  };

  /** A server board by id — a starred one, or one the feed names. */
  const openServerBoard = async (id: string): Promise<void> => {
    if (id === boardId) {
      setView("canvas");
      return;
    }
    if (!(await openBoard(id))) notify(MISSING_BOARD, undefined, "error");
  };

  const openRecent = (key: string) => {
    if (key === currentKey) setView("canvas");
    else void openKey(key);
  };

  /* ------------------------------ composer ------------------------------ */

  const [draft, setDraft] = useState("");
  const text = draft.trim();
  const asQuestion = isQuestionText(text);
  const boardLabel = projectName || "this board";

  const runAsk = (question: string) => {
    setDraft("");
    // Signed in, Home's question is about the work, not one board: it asks
    // the whole workspace, and the answer appears here (ADR 0048).
    if (org.id) {
      setWorkspaceQuestion(question);
      return;
    }
    // The canvas's Ask mode owns the answer — and the honest refusal on a
    // local board, whose history is not on the server to be asked.
    setPillMode("ask");
    void ask(question);
    setView("canvas");
  };
  const runBuild = (description: string) => {
    setDraft("");
    setPillMode("build");
    startNewBoardFor(description);
  };
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text || busy) return;
    if (asQuestion) runAsk(text);
    else runBuild(text);
  };

  const hint = busy
    ? "Lucent is still working on your last request."
    : !text
      ? org.id
        ? "Describe something new to start a board, or ask about anything across your workspace."
        : boardId
          ? `Describe something new to start a board, or ask a question about “${boardLabel}”.`
          : `Describe something new to start a board, or ask about “${boardLabel}”.`
      : asQuestion
        ? org.id
          ? "Enter asks Lucent across your workspace — every board, meeting and decision you can open."
          : `Enter asks Lucent about “${boardLabel}”.`
        : "Enter starts a new board from this description.";

  /* ------------------------------- tiles -------------------------------- */

  const c = pulse.counts;
  const boardsPhrase = (match: (i: PulseItem) => boolean): string => {
    const boards = new Set(pulse.items.filter(match).map((i) => i.boardName));
    if (boards.size === 1) return `on “${[...boards][0]}”`;
    return `across ${boards.size} boards`;
  };
  const isQuestion = (i: PulseItem) => i.kind === "question";
  const isPending = (i: PulseItem) => i.kind === "decision" || i.kind === "proposal";
  const isAction = (i: PulseItem) => i.kind === "action";
  const isOverdue = (i: PulseItem) => i.signal === "overdue";
  // From the items, not the notices: a notice may skip an action whose
  // blocking chain already tells its story, but the tile counts it.
  const oldestDue = pulse.items
    .filter(isOverdue)
    .map((i) => i.dueDate ?? "")
    .filter(Boolean)
    .sort()[0];

  /* ------------------------------- render ------------------------------- */

  const [showAll, setShowAll] = useState(false);
  const needs = showAll ? pulse.items : pulse.items.slice(0, NEEDS_PREVIEW);
  const recent = pulse.boards.filter((b) => b.hasContent !== false).slice(0, RECENT_LIMIT);
  const countedBoards = pulse.boards.filter((b) => b.hasContent !== null).length;

  const today = new Date(now);
  const eyebrow = [
    today.toLocaleDateString(undefined, { weekday: "long" }),
    today.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    today.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  ].join(" · ");
  // One board holding everything: naming it on every row is noise.
  const showBoard = pulse.boardsWithItems > 1;

  return (
    <Page
      crumbs={[{ label: "Home", current: true }]}
      onOpenSettings={onOpenSettings}
      width="wide"
      boardScoped={false}
    >
      <div className="home">
        <PageHeader
          eyebrow={eyebrow}
          title={`${greetingFor(new Date(now))}${firstName ? `, ${firstName}` : ""}.`}
          lede={
            firstRun
              ? "Describe an idea, hold a meeting, or start from a template — Lucent turns the conversation into a board you can edit."
              : (lede ??
                (serverOnlyWithContent.length > 0
                  ? `${serverOnlyWithContent.length} shared ${serverOnlyWithContent.length === 1 ? "board is" : "boards are"} waiting on the server — open one to see what needs you there.`
                  : undefined))
          }
        />

        {org.id && workspaceQuestion && (
          <section className="home-ask" aria-label="Ask your workspace">
            <SectionLabel>Across your workspace</SectionLabel>
            <ScopedAsk
              orgId={org.id}
              scope={{}}
              threadKey={threadScope.workspace(org.id)}
              placeholder="Ask a follow-up about your work…"
              ask={workspaceQuestion}
            />
          </section>
        )}

        <form className="home-composer" onSubmit={onSubmit}>
          <div className="home-composer-row">
            <span className="home-composer-mark" aria-hidden>
              <Ico.Sparkle />
            </span>
            <input
              className="home-composer-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Describe an idea — or ask about your work…"
              aria-label="Describe an idea, or ask about your work"
              aria-describedby="home-composer-hint"
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={!text || busy}
              onClick={() => runAsk(text)}
              title={
                org.id ? "Ask Lucent across your workspace" : `Ask Lucent about “${boardLabel}”`
              }
            >
              Ask
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => (text ? runBuild(text) : newProject())}
              title={text ? "Start a new board from this description" : "Start a blank board"}
            >
              <Ico.Plus /> New board
            </Button>
          </div>
          <div className="home-composer-hint" id="home-composer-hint" aria-live="polite">
            {text && !busy && <span className="home-kbd">↵</span>}
            {hint}
          </div>
        </form>

        {settling ? null : firstRun ? (
          <FirstRun
            onDescribe={() => setView("canvas")}
            onMeeting={() => setView("meeting")}
            onTemplate={() => setView("dashboard")}
          />
        ) : (
          <>
            <div className="home-tiles">
              <StatTile
                label="Open questions"
                value={c.openQuestions}
                tone={c.openQuestions ? "question" : undefined}
                sub={c.openQuestions ? boardsPhrase(isQuestion) : "None open"}
                onClick={
                  c.openQuestions
                    ? () => goTo(busiestBoard(pulse.items, isQuestion), "intelligence")
                    : undefined
                }
              />
              <StatTile
                label="Pending decisions"
                value={c.pendingDecisions + c.openProposals}
                tone={c.pendingDecisions + c.openProposals ? "decision" : undefined}
                sub={
                  c.pendingDecisions + c.openProposals
                    ? [
                        c.pendingDecisions
                          ? `${c.pendingDecisions} decision${c.pendingDecisions === 1 ? "" : "s"}`
                          : "",
                        c.openProposals
                          ? `${c.openProposals} proposal${c.openProposals === 1 ? "" : "s"}`
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Nothing awaiting a call"
                }
                onClick={
                  c.pendingDecisions + c.openProposals
                    ? () => goTo(busiestBoard(pulse.items, isPending), "intelligence")
                    : undefined
                }
              />
              <StatTile
                label="Open actions"
                value={c.openActions}
                tone={c.openActions ? "action" : undefined}
                sub={
                  c.openActions
                    ? c.blocked
                      ? `${c.blocked} blocked`
                      : boardsPhrase(isAction)
                    : "No tracked work open"
                }
                onClick={
                  c.openActions
                    ? () => goTo(busiestBoard(pulse.items, isAction), "execution")
                    : undefined
                }
              />
              <StatTile
                label="Overdue"
                value={c.overdue}
                tone={c.overdue ? "alert" : undefined}
                sub={
                  c.overdue
                    ? oldestDue
                      ? `Oldest ${dueLabel(oldestDue, now).replace(/^was /, "")}`
                      : "Past due"
                    : "Nothing late"
                }
                onClick={
                  c.overdue
                    ? () => goTo(busiestBoard(pulse.items, isOverdue), "execution")
                    : undefined
                }
              />
            </div>
            {serverOnly.length > 0 && (
              <p className="home-scope">
                Counts cover {countedBoards === 1 ? "one board" : `${countedBoards} boards`}.{" "}
                {serverOnly.length} shared{" "}
                {serverOnly.length === 1 ? "board isn't" : "boards aren't"} counted yet — the
                workspace index didn't answer for {serverOnly.length === 1 ? "it" : "them"}; opening{" "}
                {serverOnly.length === 1 ? "it" : "one"} here counts it.
              </p>
            )}

            <div className="home-cols">
              <div className="home-col">
                <SectionLabel count={pulse.items.length}>Needs you</SectionLabel>
                {pulse.items.length === 0 ? (
                  <EmptyState
                    compact
                    glyph={<Ico.Check />}
                    title="Nothing needs you right now"
                    body="Open questions, pending decisions and late or blocked work from your boards collect here as they appear."
                  />
                ) : (
                  <>
                    <ul className="home-needs">
                      {needs.map((item) => (
                        <NeedRow
                          key={`${item.boardId}:${item.nodeId}`}
                          item={item}
                          now={now}
                          showBoard={showBoard || !item.isCurrent}
                          onReveal={() => reveal(item.boardId, item.nodeId)}
                          onMeeting={
                            item.fromMeeting && item.isCurrent && boardId
                              ? () =>
                                  onCitation({
                                    kind: "meeting",
                                    id: item.fromMeeting!,
                                    ...(item.turnRange ? { turnRange: item.turnRange } : {}),
                                  })
                              : undefined
                          }
                        />
                      ))}
                    </ul>
                    {pulse.items.length > NEEDS_PREVIEW && (
                      <Button
                        variant="quiet"
                        size="sm"
                        className="home-more"
                        aria-expanded={showAll}
                        onClick={() => setShowAll((v) => !v)}
                      >
                        {showAll ? "Show fewer" : `Show all ${pulse.items.length}`}
                      </Button>
                    )}
                  </>
                )}

                {meetings.length > 0 && (
                  <>
                    <SectionLabel count={meetings.length}>Meetings</SectionLabel>
                    <ul className="home-meetings">
                      {meetings.slice(0, 3).map((m) => (
                        <MeetingRow key={m.id} meeting={m} onOpen={() => void openMeeting(m)} />
                      ))}
                    </ul>
                    {meetings.length > 3 && (
                      <Button
                        variant="quiet"
                        size="sm"
                        className="home-more"
                        onClick={() => setView("meetings")}
                      >
                        All meetings
                      </Button>
                    )}
                  </>
                )}

                {mine.activity.length > 0 && (
                  <>
                    <SectionLabel>From your team</SectionLabel>
                    <ul className="home-activity">
                      {mine.activity.slice(0, ACTIVITY_PREVIEW).map((a) => (
                        <ActivityRow
                          key={`${a.boardId}:${a.seq}`}
                          item={a}
                          now={now}
                          onOpen={() => void openServerBoard(a.boardId)}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div className="home-col">
                {mine.starred.length > 0 && (
                  <>
                    <SectionLabel count={mine.starred.length}>Starred</SectionLabel>
                    <ul className="home-boards">
                      {mine.starred.slice(0, STARRED_PREVIEW).map((f) => (
                        <li key={`${f.kind}:${f.id}`}>
                          <button
                            type="button"
                            className={`home-board ${f.id === boardId ? "current" : ""}`}
                            onClick={() =>
                              f.kind === "board" ? void openServerBoard(f.id) : openOrgProject(f.id)
                            }
                          >
                            <ToolIco.Star className="home-star" aria-hidden />
                            <span className="home-board-text">
                              <span className="home-board-name">{f.name}</span>
                              <span className="home-board-meta">
                                {f.kind === "board" ? "board" : "project"} · updated{" "}
                                {timeAgo(f.updatedAt, now)}
                              </span>
                            </span>
                            <Ico.Arrow className="home-board-arrow" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {org.projects.length > 0 && (
                  <>
                    <SectionLabel count={org.projects.length}>Projects</SectionLabel>
                    <ul className="home-boards">
                      {org.projects.slice(0, 4).map((p) => (
                        <ProjectRow key={p.id} project={p} onOpen={() => openOrgProject(p.id)} />
                      ))}
                    </ul>
                  </>
                )}
                <SectionLabel>Pick up where you left off</SectionLabel>
                {recent.length === 0 ? (
                  <EmptyState
                    compact
                    title="No boards yet"
                    body="Boards you build or open appear here, most recent first."
                  />
                ) : (
                  <ul className="home-boards">
                    {recent.map((b) => (
                      <li key={b.id}>
                        <button
                          type="button"
                          className={`home-board ${b.isCurrent ? "current" : ""}`}
                          onClick={() => openRecent(b.id)}
                        >
                          <span className="home-board-text">
                            <span className="home-board-name">{b.name}</span>
                            <span className="home-board-meta">
                              {[
                                b.isCurrent ? "open now" : `edited ${timeAgo(b.updatedAt, now)}`,
                                b.openItems === null
                                  ? "shared board"
                                  : b.openItems
                                    ? `${b.openItems} open`
                                    : b.statements
                                      ? "all settled"
                                      : "",
                                b.nodes ? `${b.nodes} node${b.nodes === 1 ? "" : "s"}` : "",
                                b.actions && b.actions.total
                                  ? `${b.actions.completed}/${b.actions.total} actions done`
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                          <Ico.Arrow className="home-board-arrow" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {pulse.boards.filter((b) => b.hasContent !== false).length > RECENT_LIMIT && (
                  <Button
                    variant="quiet"
                    size="sm"
                    className="home-more"
                    onClick={() => setView("dashboard")}
                  >
                    All boards
                  </Button>
                )}

                {pulse.noticed.length > 0 && (
                  <>
                    <SectionLabel glyph={<Ico.Sparkle className="home-noticed-glyph" />}>
                      What Lucent noticed
                    </SectionLabel>
                    <div className="home-noticed">
                      {pulse.noticed.map((n, i) => (
                        <Notice key={i} notice={n} now={now} onReveal={reveal} onGoTo={goTo} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Page>
  );
}

/* -------------------------------------------------------------------------- */

function NeedRow({
  item,
  now,
  showBoard,
  onReveal,
  onMeeting,
}: {
  item: PulseItem;
  now: number;
  showBoard: boolean;
  onReveal: () => void;
  onMeeting?: () => void;
}) {
  return (
    <li className={`home-need ${item.signal}`}>
      <button
        type="button"
        className="home-need-main"
        onClick={onReveal}
        title={`Show on ${item.boardName}`}
      >
        <span className="home-need-top">
          <KindBadge kind={item.kind} status={item.status} />
          {item.signal === "overdue" && <span className="home-flag">Overdue</span>}
          {item.blocked && <span className="home-flag">Blocked</span>}
        </span>
        <span className={`home-need-label ${item.kind === "decision" ? "serif" : ""}`}>
          {item.label}
        </span>
        <span className="home-need-meta">
          {showBoard && (
            <span className="home-need-board">
              <Ico.Layers aria-hidden />
              {item.boardName}
              {item.isCurrent && <span className="home-need-here"> · open now</span>}
            </span>
          )}
          {item.assignee && (
            <span className="home-need-owner">
              <Avatar name={item.assignee} size={16} />
              {item.assignee}
            </span>
          )}
          {item.dueDate && (
            <span className={item.signal === "overdue" ? "home-need-due late" : "home-need-due"}>
              {dueLabel(item.dueDate, now)}
            </span>
          )}
        </span>
      </button>
      {item.fromMeeting && (
        <span className="home-need-side">
          <ProvenanceChip
            icon={<Ico.Present aria-hidden />}
            label="From a meeting"
            title={
              onMeeting
                ? "Open the transcript this came from"
                : "Captured in a meeting — open this board to see the transcript"
            }
            onClick={onMeeting}
          />
        </span>
      )}
      {!item.fromMeeting && item.fromRequest && (
        <span className="home-need-side">
          <ProvenanceChip
            icon={<Ico.Comment aria-hidden />}
            label={item.fromRequest.by ? `From ${item.fromRequest.by}’s request` : "From a request"}
            title={`Lucent made this from a request to the board, ${timeAgo(item.fromRequest.at, now)}`}
          />
        </span>
      )}
    </li>
  );
}

function MeetingRow({ meeting: m, onOpen }: { meeting: MeetingSummary; onOpen: () => void }) {
  const when = new Date(m.status === "scheduled" ? (m.scheduledFor ?? m.startedAt) : m.startedAt);
  const minutes =
    m.endedAt !== null ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000)) : null;
  const meta =
    m.status === "live"
      ? "Live now"
      : m.status === "scheduled"
        ? `Scheduled · ${m.durationMin ?? 30} min`
        : [
            `${m.turnCount} line${m.turnCount === 1 ? "" : "s"}`,
            minutes !== null ? `${minutes} min` : null,
            m.status === "summarized" ? "summary ready" : null,
          ]
            .filter(Boolean)
            .join(" · ");
  return (
    <li>
      <button type="button" className="home-meeting" onClick={onOpen}>
        <span className="home-meeting-when">
          <span className="home-meeting-time">
            {when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
          <span className="home-meeting-date">
            {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
        </span>
        <span className="home-meeting-rule" aria-hidden />
        <span className="home-meeting-body">
          <span className="home-meeting-title">
            {meetingName(m)} · {m.boardName || "Board"}
          </span>
          <span className="home-meeting-meta">{meta}</span>
        </span>
      </button>
    </li>
  );
}

/** One change someone else made on a board you follow. */
function ActivityRow({
  item: a,
  now,
  onOpen,
}: {
  item: ActivityItem;
  now: number;
  onOpen: () => void;
}) {
  const who = a.onBehalfOf ? `${a.actor} for ${a.onBehalfOf}` : a.actor;
  return (
    <li>
      <button type="button" className="home-activity-row" onClick={onOpen}>
        <Avatar name={a.actor} size={24} />
        <span className="home-board-text">
          <span className="home-activity-what">
            <strong>{who}</strong> {a.label || `made ${a.ops} change${a.ops === 1 ? "" : "s"}`}
          </span>
          <span className="home-board-meta">
            {a.starred ? "★ " : ""}
            {a.boardName} · {timeAgo(a.at, now)}
          </span>
        </span>
      </button>
    </li>
  );
}

function ProjectRow({ project: p, onOpen }: { project: OrgProject; onOpen: () => void }) {
  const s = p.stats;
  const signals = s
    ? [
        s.blocked > 0 ? `${s.blocked} blocked` : null,
        s.openQuestions > 0
          ? `${s.openQuestions} open question${s.openQuestions === 1 ? "" : "s"}`
          : null,
        s.openActions > 0 ? `${s.openActions} open action${s.openActions === 1 ? "" : "s"}` : null,
      ].filter(Boolean)
    : [];
  return (
    <li>
      <button type="button" className="home-board" onClick={onOpen}>
        <span className="home-board-text">
          <span className="home-board-name">{p.name}</span>
          <span className="home-board-meta">
            {[
              p.status === "active" ? null : p.status,
              ...signals,
              signals.length === 0
                ? `${p.boards.length} board${p.boards.length === 1 ? "" : "s"}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <Ico.Arrow className="home-board-arrow" aria-hidden />
      </button>
    </li>
  );
}

function Notice({
  notice,
  now,
  onReveal,
  onGoTo,
}: {
  notice: PulseNotice;
  now: number;
  onReveal: (boardKey: string, nodeId: string) => void;
  onGoTo: (boardKey: string, view: View) => void;
}) {
  const board = <ProvenanceChip icon={<Ico.Layers aria-hidden />} label={notice.boardName} />;
  switch (notice.kind) {
    case "blocked-chain": {
      const target = notice.chain[notice.chain.length - 1]!;
      const root = notice.chain[0]!;
      return (
        <div className="home-notice">
          <p className="home-notice-text">
            <b>{target.label}</b> can’t move: it waits on{" "}
            {notice.chain.length > 2
              ? `${notice.chain.length - 2} step${notice.chain.length - 2 === 1 ? "" : "s"} behind `
              : ""}
            <b>{root.label}</b>, which is blocked.
          </p>
          <div className="home-notice-chips">
            {notice.chain.map((n, i) => (
              <span key={n.id} className="home-chain-step">
                {i > 0 && (
                  <span className="home-chain-arrow" aria-hidden>
                    →
                  </span>
                )}
                <ProvenanceChip
                  icon={<StatementGlyph kind="action" size={10} />}
                  label={n.label}
                  title="Show on the board"
                  onClick={() => onReveal(notice.boardId, n.id)}
                />
              </span>
            ))}
          </div>
          <div className="home-notice-actions">
            {board}
            <Button variant="bloom" size="sm" onClick={() => onGoTo(notice.boardId, "execution")}>
              Open execution
            </Button>
          </div>
        </div>
      );
    }
    case "overdue":
      return (
        <div className="home-notice">
          <p className="home-notice-text">
            <b>{notice.label}</b> {dueLabel(notice.dueDate, now)}
            {notice.assignee ? ` and is still with ${notice.assignee}` : " and has no owner"}
            {notice.others > 0
              ? ` — ${notice.others} more action${notice.others === 1 ? " is" : "s are"} late too.`
              : "."}
          </p>
          <div className="home-notice-actions">
            {board}
            <Button
              variant="bloom"
              size="sm"
              onClick={() => onReveal(notice.boardId, notice.nodeId)}
            >
              Show on board
            </Button>
          </div>
        </div>
      );
    case "open-on-decided-topic":
      return (
        <div className="home-notice">
          <p className="home-notice-text">
            “{notice.question}” is still open under <i>{notice.topic}</i>, where{" "}
            <b>{notice.decision}</b> is already decided. Worth answering, or recording what it
            changes.
          </p>
          <div className="home-notice-chips">
            <ProvenanceChip
              icon={<StatementGlyph kind="question" size={10} />}
              label={notice.question}
              title="Show the question on the board"
              onClick={() => onReveal(notice.boardId, notice.questionId)}
            />
            <ProvenanceChip
              icon={<StatementGlyph kind="decision" size={10} />}
              label={notice.decision}
              title="Show the decision on the board"
              onClick={() => onReveal(notice.boardId, notice.decisionId)}
            />
          </div>
          <div className="home-notice-actions">
            {board}
            <Button
              variant="bloom"
              size="sm"
              onClick={() => onGoTo(notice.boardId, "intelligence")}
            >
              Review statements
            </Button>
          </div>
        </div>
      );
    case "duplicate-topic":
      return (
        <div className="home-notice">
          <p className="home-notice-text">
            <b>{notice.dup}</b> and <b>{notice.existing}</b> look like the same topic, split across{" "}
            {notice.statements} statements. Merging keeps its decisions and questions together.
          </p>
          <div className="home-notice-actions">
            {board}
            <Button
              variant="bloom"
              size="sm"
              onClick={() => onGoTo(notice.boardId, "intelligence")}
            >
              Review merge
            </Button>
          </div>
        </div>
      );
  }
}

function FirstRun({
  onDescribe,
  onMeeting,
  onTemplate,
}: {
  onDescribe: () => void;
  onMeeting: () => void;
  onTemplate: () => void;
}) {
  const starts = [
    {
      id: "describe",
      icon: <Ico.Sparkle aria-hidden />,
      title: "Describe an idea",
      body: "Type or speak what you’re thinking. Lucent builds an editable board — and keeps the decisions, questions and actions in it.",
      cta: "Open the canvas",
      onClick: onDescribe,
    },
    {
      id: "meeting",
      icon: <Ico.Present aria-hidden />,
      title: "Start a meeting",
      body: "Lucent listens and drafts what it heard as statements. You approve what lands on the board, with the words it came from.",
      cta: "Open meeting",
      onClick: onMeeting,
    },
    {
      id: "template",
      icon: <Ico.Book aria-hidden />,
      title: "Start from a template",
      body: "Flowcharts, journeys, mind maps and more — begin from a real structure and reshape it by talking.",
      cta: "Browse templates",
      onClick: onTemplate,
    },
  ];
  return (
    <section className="home-first" aria-labelledby="home-first-title">
      <SectionLabel>
        <span id="home-first-title">Three ways to begin</span>
      </SectionLabel>
      <div className="home-first-grid">
        {starts.map((s) => (
          <button key={s.id} type="button" className="home-start" onClick={s.onClick}>
            <span className="home-start-icon">{s.icon}</span>
            <span className="home-start-title">{s.title}</span>
            <span className="home-start-body">{s.body}</span>
            <span className="home-start-cta">
              {s.cta} <Ico.Arrow aria-hidden />
            </span>
          </button>
        ))}
      </div>
      <p className="home-first-note">
        Once a board holds a question, a decision or an action, this page shows what needs you
        across all of them.
      </p>
    </section>
  );
}
