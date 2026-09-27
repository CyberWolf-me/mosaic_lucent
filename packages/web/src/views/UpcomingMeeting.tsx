import { useEffect, useMemo, useState } from "react";
import { NOTE_TEMPLATES } from "@lucent/ai";
import type { Workspace } from "@lucent/core";
import { Button, EmptyState } from "../ui/kit.js";
import { Dialog } from "../ui/primitives.js";
import { Ico } from "../ui/icons.js";
import {
  calendarFileUrl,
  cancelMeeting,
  fetchMeetingPeople,
  meetingTimeRange,
  startsIn,
  type MeetingPeople,
  type MeetingTranscript,
} from "../meetings.js";
import { contextBrief, type ContextItem } from "../meetingContext.js";
import { ScheduleMeetingDialog } from "./ScheduleMeeting.js";

/**
 * S3 — a scheduled meeting's page (docs/28): when, who, the agenda its
 * template sets, and the context brief — what the board still has open and
 * what last time ended with — so the meeting starts where the last one left
 * off. Join opens the call's lobby (joining early is fine, §9.6). The host can
 * change or cancel it; a cancelled meeting says who called it off, and when.
 */
export function UpcomingMeeting({
  meeting,
  boardName,
  workspace,
  pastMeetings,
  onJoin,
  onChanged,
  onOpenMeeting,
  onRevealNode,
  notify,
}: {
  meeting: MeetingTranscript;
  boardName: string;
  workspace: Workspace;
  /** The board's other meetings, for "last time". */
  pastMeetings: MeetingTranscript[];
  onJoin: () => void;
  onChanged: (meeting: MeetingTranscript) => void;
  onOpenMeeting: (meetingId: string) => void;
  onRevealNode: (nodeId: string) => void;
  notify: (text: string) => void;
}) {
  const schedule = meeting.schedule;
  const [people, setPeople] = useState<MeetingPeople | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    void fetchMeetingPeople(meeting.boardId, meeting.id).then((p) => alive && setPeople(p));
    return () => {
      alive = false;
    };
  }, [meeting.boardId, meeting.id, meeting.schedule]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const brief = useMemo(
    () =>
      contextBrief(
        workspace,
        pastMeetings.filter((m) => m.id !== meeting.id),
      ),
    [workspace, pastMeetings, meeting.id],
  );

  if (!schedule) return null;
  const cancelled = meeting.cancelledAt !== undefined;
  const template = NOTE_TEMPLATES[schedule.template ?? "general"];
  const link = `${window.location.origin}/?board=${encodeURIComponent(meeting.boardId)}&view=meeting&meeting=${encodeURIComponent(meeting.id)}`;

  const copyLink = () => {
    void navigator.clipboard
      ?.writeText(link)
      .then(() => notify("Link copied"))
      .catch(() => notify("Couldn't copy the link"));
  };

  const doCancel = async () => {
    const result = await cancelMeeting(meeting.boardId, meeting.id);
    setConfirmCancel(false);
    if (!result.ok) {
      notify(result.error);
      return;
    }
    notify(
      schedule.invitees.length > 0
        ? `Cancelled — ${schedule.invitees.length} ${schedule.invitees.length === 1 ? "person was" : "people were"} told`
        : "Cancelled",
    );
    onChanged(result.meeting);
  };

  const section = (label: string, items: ContextItem[], empty?: string) =>
    items.length > 0 || empty ? (
      <section className="upc-section" aria-label={label}>
        <h4 className="upc-h">{label}</h4>
        {items.length === 0 ? (
          <p className="upc-muted">{empty}</p>
        ) : (
          <ul className="upc-list">
            {items.map((i) => (
              <li key={i.nodeId}>
                <button type="button" className="upc-item" onClick={() => onRevealNode(i.nodeId)}>
                  {i.label}
                </button>
                {(i.assignee || i.dueDate) && (
                  <span className="upc-muted">
                    {[i.assignee, i.dueDate ? `due ${i.dueDate}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    ) : null;

  return (
    <div className="upc">
      <header className="upc-head">
        <p className="upc-eyebrow mono-caps">
          {cancelled ? "Cancelled" : `Scheduled meeting · ${boardName || "Board"}`}
        </p>
        <h2 className="upc-title">{meeting.title ?? "Meeting"}</h2>
        <p className="upc-when">
          <Ico.History width={14} height={14} aria-hidden />
          <span>{meetingTimeRange(schedule.scheduledFor, schedule.durationMin)}</span>
          {!cancelled && <span className="upc-soon">{startsIn(schedule.scheduledFor, now)}</span>}
        </p>
        {cancelled ? (
          <p className="upc-cancelled" role="status">
            Cancelled
            {people?.cancelledBy ? ` by ${people.cancelledBy.name}` : ""}
            {meeting.cancelledAt
              ? ` on ${new Date(meeting.cancelledAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                })}`
              : ""}
            .
          </p>
        ) : (
          <div className="upc-actions">
            <Button variant="primary" onClick={onJoin}>
              <Ico.Video /> Join
            </Button>
            <Button onClick={copyLink}>
              <Ico.Link /> Copy link
            </Button>
            <a className="btn-atelier ghost md" href={calendarFileUrl(meeting.boardId, meeting.id)}>
              <Ico.Plus /> Add to calendar
            </a>
            {people?.youHost && (
              <>
                <Button variant="quiet" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="quiet" onClick={() => setConfirmCancel(true)}>
                  Cancel meeting
                </Button>
              </>
            )}
          </div>
        )}
      </header>

      <div className="upc-grid">
        <div className="upc-col">
          <section className="upc-section" aria-label="People">
            <h4 className="upc-h">People</h4>
            {people === null ? (
              <p className="upc-muted">Loading…</p>
            ) : (
              <ul className="upc-people">
                {people.host && (
                  <li>
                    {people.host.name} <span className="upc-muted">host</span>
                  </li>
                )}
                {people.invitees.map((p) => (
                  <li key={p.id}>{p.name}</li>
                ))}
                {people.invitees.length === 0 && (
                  <li className="upc-muted">No one else invited — anyone on the board can join.</li>
                )}
              </ul>
            )}
          </section>
          <section className="upc-section" aria-label="Agenda">
            <h4 className="upc-h">Agenda · {template.name}</h4>
            <ol className="upc-agenda">
              {template.sections.map((s) => (
                <li key={s.title}>
                  <strong>{s.title}</strong>
                  <span className="upc-muted">{s.guide}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="upc-col">
          <h3 className="upc-brief-title">Context brief</h3>
          {brief.total === 0 && !brief.lastTime ? (
            <EmptyState
              compact
              title="No earlier meetings on these boards"
              body="Open actions, questions and decisions from this board show here before the next meeting."
            />
          ) : (
            <>
              {brief.lastTime && (
                <section className="upc-section" aria-label="Last time">
                  <h4 className="upc-h">
                    Last time
                    <button
                      type="button"
                      className="upc-link"
                      onClick={() => onOpenMeeting(brief.lastTime!.meetingId)}
                    >
                      {brief.lastTime.title ??
                        new Date(brief.lastTime.at).toLocaleDateString(undefined, {
                          day: "numeric",
                          month: "short",
                        })}
                    </button>
                  </h4>
                  <ul className="upc-list">
                    {brief.lastTime.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </section>
              )}
              {section("Open actions", brief.actions)}
              {section("Unresolved questions", brief.questions)}
              {section("Risks", brief.risks)}
              {section("Decided", brief.decisions)}
            </>
          )}
        </div>
      </div>

      {editing && (
        <ScheduleMeetingDialog
          editing={meeting}
          onClose={() => setEditing(false)}
          onDone={({ meeting: changed }) => {
            setEditing(false);
            notify("Meeting updated — everyone invited was told");
            onChanged(changed);
          }}
        />
      )}
      {confirmCancel && (
        <Dialog onClose={() => setConfirmCancel(false)} title="Cancel this meeting?">
          <p className="confirm-body">
            {schedule.invitees.length > 0
              ? "Everyone invited gets a cancellation, and it comes off their calendar."
              : "It comes off the meetings list."}
          </p>
          <div className="confirm-actions">
            <Button variant="quiet" onClick={() => setConfirmCancel(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void doCancel()}>
              Cancel meeting
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
