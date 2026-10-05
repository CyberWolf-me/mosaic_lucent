import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import { Button, EmptyState, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import { loadOrgs } from "../orgs.js";
import { hasSession } from "../session.js";
import {
  getLocalMeetings,
  listInvitedMeetings,
  listWorkspaceMeetings,
  meetingName,
  type MeetingSummary,
  type MeetingTranscript,
} from "../meetings.js";
import { listBoards } from "../boards.js";
import { ScheduleMeetingDialog } from "./ScheduleMeeting.js";

/**
 * Meetings — the workspace list (docs/28 S1, ADR 0045). Every meeting on the
 * boards this person can read, across boards: live ones first, then what's
 * coming up (soonest first), then the past, newest first. A row opens the
 * meeting on its own board — an upcoming one on its page (S3). Schedule opens
 * the sheet (S2) with a board picker. Needs-review arrives with the review
 * center (A2); until then it is absent, not empty (docs/28 rule 7).
 */

/** A scheduled meeting stays under Upcoming until an hour past its planned end. */
function isUpcomingRow(m: MeetingSummary, now: number): boolean {
  if (m.status !== "scheduled" || !m.scheduledFor) return false;
  return m.scheduledFor + (m.durationMin ?? 30) * 60_000 + 60 * 60_000 >= now;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "failed" }
  | { kind: "ready"; meetings: MeetingSummary[] };

export function MeetingsView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { boardId, projectId, projectName, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [scheduling, setScheduling] = useState<Array<{ id: string; name: string }> | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const localA = boardId ? getLocalMeetings(boardId) : [];
    const localB = projectId && projectId !== boardId ? getLocalMeetings(projectId) : [];
    const seenLocal = new Set<string>();
    const local: MeetingTranscript[] = [];
    for (const m of [...localA, ...localB]) {
      if (!seenLocal.has(m.id)) {
        seenLocal.add(m.id);
        local.push(m);
      }
    }
    const localSummaries: MeetingSummary[] = local.map((m) => ({
      id: m.id,
      boardId: m.boardId || boardId || projectId,
      boardName: projectName || "Current board",
      title: m.title ?? null,
      status: m.endedAt ? "ended" : "live",
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      turnCount: m.turns.length,
      mode: m.mode ?? null,
      createdBy: m.createdBy ?? "You",
    }));

    if (!hasSession()) {
      if (localSummaries.length > 0) {
        setState({ kind: "ready", meetings: localSummaries });
      } else {
        setState({ kind: "signed-out" });
      }
      return;
    }
    const { current } = await loadOrgs();
    if (!current) {
      if (localSummaries.length > 0) {
        setState({ kind: "ready", meetings: localSummaries });
      } else {
        setState({ kind: "signed-out" });
      }
      return;
    }
    setOrgId(current.id);
    const [meetings, invited] = await Promise.all([
      listWorkspaceMeetings(current.id),
      listInvitedMeetings(),
    ]);
    if (meetings === null) {
      if (localSummaries.length > 0) {
        setState({ kind: "ready", meetings: localSummaries });
      } else {
        setState({ kind: "failed" });
      }
      return;
    }
    // Meetings you're invited to on boards outside this workspace join the list.
    const known = new Set(meetings.map((m) => m.id));
    const extraLocal = localSummaries.filter((m) => !known.has(m.id));
    setState({
      kind: "ready",
      meetings: [...meetings, ...invited.filter((m) => !known.has(m.id)), ...extraLocal],
    });
  }, [boardId, projectId, projectName]);

  useEffect(() => {
    void load();
  }, [load]);

  const { live, upcoming, past } = useMemo(() => {
    const rows = state.kind === "ready" ? state.meetings : [];
    const now = Date.now();
    return {
      live: rows.filter((m) => m.status === "live"),
      upcoming: rows
        .filter((m) => isUpcomingRow(m, now))
        .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0)),
      past: rows.filter((m) => m.status !== "live" && !isUpcomingRow(m, now)),
    };
  }, [state]);

  const openSchedule = async (): Promise<void> => {
    if (!orgId) return;
    const boards = await listBoards(orgId);
    if (boards.length === 0) {
      notify("Share a board first — meetings are scheduled on a shared board.");
      return;
    }
    // The board you're on first.
    const ordered = [...boards].sort((a, b) =>
      a.id === boardId ? -1 : b.id === boardId ? 1 : b.updatedAt - a.updatedAt,
    );
    setScheduling(ordered.map((b) => ({ id: b.id, name: b.name })));
  };

  const open = async (m: MeetingSummary): Promise<void> => {
    if (m.boardId !== boardId && !m.id.startsWith("mtg_loc_") && !(await openBoard(m.boardId))) {
      notify("Couldn't open that meeting's board — you may no longer have access.");
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("meeting", m.id);
    if (m.boardId) params.set("board", m.boardId);
    window.history.replaceState(null, "", `?${params.toString()}`);
    setView("meeting");
  };

  const startHere = (
    <>
      <Button onClick={() => void openSchedule()}>
        <Ico.Plus /> Schedule
      </Button>
      <Button variant="primary" onClick={() => setView("meeting")}>
        <Ico.Mic /> {boardId ? `Meet on ${projectName || "this board"}` : "Start a meeting"}
      </Button>
    </>
  );

  return (
    <Page
      crumbs={[{ label: "Meetings", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="narrow"
    >
      <PageHeader
        eyebrow="Meetings"
        title={
          state.kind === "ready" && state.meetings.length > 0 ? (
            live.length > 0 ? (
              <>
                {live.length} <em>live now</em>
              </>
            ) : upcoming.length > 0 ? (
              <>
                {upcoming.length} <em>coming up</em>
              </>
            ) : (
              <>
                {past.length} {past.length === 1 ? "meeting" : "meetings"}
              </>
            )
          ) : (
            "Meetings"
          )
        }
        lede="Every meeting on the boards you can see in this workspace — open one to read its transcript, brief and notes."
        actions={state.kind === "ready" && state.meetings.length > 0 ? startHere : undefined}
      />

      {(boardId || projectId) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            marginBottom: 20,
            borderRadius: 12,
            border: "1px solid var(--stroke-2)",
            background: "var(--canvas-2)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)", display: "flex", alignItems: "center", gap: 6 }}>
              <Ico.Flow width={14} height={14} /> Active Board: {projectName || "Current board"}
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2 }}>
              View and capture meeting transcripts, decisions, and briefs for this board.
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={() => setView("meeting")}>
            <Ico.Present /> Open Board Meeting
          </Button>
        </div>
      )}

      {state.kind === "loading" && (
        <div className="boards-notif-skeleton" role="status" aria-label="Loading meetings">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} />
          ))}
        </div>
      )}

      {state.kind === "signed-out" && (
        <EmptyState
          compact
          title="Sign in to see your workspace's meetings"
          body="Meetings are kept on shared boards, so the list needs a signed-in session. A board that lives only in this browser keeps its captures in the tab."
        />
      )}

      {state.kind === "failed" && (
        <div role="alert">
          <EmptyState
            compact
            title="Couldn't load meetings"
            body="The Lucent server didn't answer, or answered with an error. Try again in a moment."
            action={
              <Button size="sm" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      {state.kind === "ready" && state.meetings.length === 0 && (
        <EmptyState
          glyph={<Ico.Present width={22} height={22} />}
          title="No meetings yet"
          body="Record a meeting on a board and it is kept here, with its transcript, brief and notes."
          action={startHere}
        />
      )}

      {live.length > 0 && (
        <section className="boards-notif-group" aria-label="Live now">
          <SectionLabel count={live.length}>Live now</SectionLabel>
          <ul className="boards-notif-list">
            {live.map((m) => (
              <MeetingRow key={m.id} meeting={m} onOpen={() => void open(m)} />
            ))}
          </ul>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="boards-notif-group" aria-label="Upcoming">
          <SectionLabel count={upcoming.length}>Upcoming</SectionLabel>
          <ul className="boards-notif-list">
            {upcoming.map((m) => (
              <MeetingRow key={m.id} meeting={m} onOpen={() => void open(m)} />
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section className="boards-notif-group" aria-label="Past">
          <SectionLabel count={past.length}>Past</SectionLabel>
          <ul className="boards-notif-list">
            {past.map((m) => (
              <MeetingRow key={m.id} meeting={m} onOpen={() => void open(m)} />
            ))}
          </ul>
        </section>
      )}

      {scheduling && (
        <ScheduleMeetingDialog
          boards={scheduling}
          onClose={() => setScheduling(null)}
          onDone={({ meeting, invited }) => {
            setScheduling(null);
            notify(
              invited > 0
                ? `Invites sent to ${invited} ${invited === 1 ? "person" : "people"}`
                : "Meeting scheduled",
            );
            void load();
            void open({ id: meeting.id, boardId: meeting.boardId } as MeetingSummary);
          }}
        />
      )}
    </Page>
  );
}

export function MeetingRow({
  meeting: m,
  onOpen,
}: {
  meeting: MeetingSummary;
  onOpen: () => void;
}) {
  const minutes =
    m.endedAt === null ? null : Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  const planned = m.scheduledFor !== null && m.scheduledFor !== undefined;
  const invited = m.inviteeCount ?? 0;
  const detail =
    m.status === "scheduled"
      ? [
          `${m.durationMin ?? 30} min`,
          invited > 0 ? `${invited} invited` : null,
          (m.scheduledFor ?? 0) < Date.now() ? "not started" : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : m.status === "cancelled"
        ? "Cancelled"
        : planned && m.turnCount === 0
          ? "Didn't take place"
          : [
              `${m.turnCount} ${m.turnCount === 1 ? "line" : "lines"}`,
              m.status === "live" ? "recording now" : minutes !== null ? `${minutes} min` : null,
              m.status === "summarized" ? "summary ready" : null,
            ]
              .filter(Boolean)
              .join(" · ");
  return (
    <li>
      <button type="button" className="boards-notif-row read" onClick={onOpen}>
        <span className="boards-notif-ico" aria-hidden="true">
          <Ico.Present />
        </span>
        <span className="boards-notif-main">
          <span className="boards-notif-meta">
            <span className="mono-caps">{m.boardName || "Board"}</span>
            {m.status === "live" && <span className="boards-notif-new">Live</span>}
            {m.status === "scheduled" && <span className="boards-notif-new">Scheduled</span>}
          </span>
          <span className="boards-notif-title">{meetingName(m)}</span>
          <span className="boards-notif-body">{detail}</span>
        </span>
        <time className="boards-notif-age mono" dateTime={new Date(m.startedAt).toISOString()}>
          {new Date(m.startedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      </button>
    </li>
  );
}
