import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import { Button, EmptyState, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import { loadOrgs } from "../orgs.js";
import { hasSession } from "../session.js";
import { listWorkspaceMeetings, meetingName, type MeetingSummary } from "../meetings.js";

/**
 * Meetings — the workspace list (docs/28 S1, ADR 0045). Every meeting on the
 * boards this person can read, across boards: live ones first, then the
 * past, newest first. A row opens the meeting on its own board. Upcoming and
 * needs-review sections arrive with scheduling (A3.4) and the end-of-meeting
 * pass (A3.3); until then they are absent, not empty (docs/28 rule 7).
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "failed" }
  | { kind: "ready"; meetings: MeetingSummary[] };

export function MeetingsView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { boardId, projectName, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    if (!hasSession()) {
      setState({ kind: "signed-out" });
      return;
    }
    const { current } = await loadOrgs();
    if (!current) {
      setState({ kind: "signed-out" });
      return;
    }
    const meetings = await listWorkspaceMeetings(current.id);
    setState(meetings === null ? { kind: "failed" } : { kind: "ready", meetings });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { live, past } = useMemo(() => {
    const rows = state.kind === "ready" ? state.meetings : [];
    return {
      live: rows.filter((m) => m.status === "live"),
      past: rows.filter((m) => m.status !== "live"),
    };
  }, [state]);

  const open = async (m: MeetingSummary): Promise<void> => {
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

  const startHere = (
    <Button variant="primary" onClick={() => setView("meeting")}>
      <Ico.Mic /> {boardId ? `Meet on ${projectName || "this board"}` : "Start a meeting"}
    </Button>
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
    </Page>
  );
}

function MeetingRow({ meeting: m, onOpen }: { meeting: MeetingSummary; onOpen: () => void }) {
  const minutes =
    m.endedAt === null ? null : Math.max(1, Math.round((m.endedAt - m.startedAt) / 60_000));
  const detail = [
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
