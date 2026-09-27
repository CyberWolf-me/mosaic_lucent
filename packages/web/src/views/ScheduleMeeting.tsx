import { useEffect, useId, useMemo, useState } from "react";
import { NOTE_TEMPLATES, type NoteTemplateId } from "@lucent/ai";
import { Dialog, Field } from "../ui/primitives.js";
import { Button } from "../ui/kit.js";
import {
  listInvitable,
  rescheduleMeeting,
  scheduleMeeting,
  type Invitable,
  type MeetingTranscript,
} from "../meetings.js";
import { MEETING_MODES, MODE_LABELS } from "../meeting-modes.js";

/**
 * S2 — Schedule (docs/28): a title, when and for how long, who, which board,
 * the notes template and Lucent's mode. Invites go out from the server — a
 * notification and, by each person's preference, a mail with the calendar
 * invite. Opened from the Meetings list (with a board picker) or from a
 * board's meeting page (that board); with `editing`, it changes a meeting
 * that hasn't started.
 */

const DURATIONS = [15, 30, 45, 60, 90, 120];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** The next half hour, at least ten minutes away. */
function nextSlot(now: number): Date {
  const d = new Date(now + 10 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

export interface ScheduledResult {
  meeting: MeetingTranscript;
  invited: number;
  boardId: string;
}

export function ScheduleMeetingDialog({
  boardId: fixedBoard,
  boards,
  editing,
  onClose,
  onDone,
}: {
  /** The board, when the sheet was opened on one. */
  boardId?: string | null;
  /** The boards to choose from, when it wasn't. */
  boards?: Array<{ id: string; name: string }>;
  /** A meeting that hasn't started, to change. */
  editing?: MeetingTranscript;
  onClose: () => void;
  onDone: (result: ScheduledResult) => void;
}) {
  const start = editing?.schedule ? new Date(editing.schedule.scheduledFor) : nextSlot(Date.now());
  const [title, setTitle] = useState(editing?.title ?? "");
  const [date, setDate] = useState(localDate(start));
  const [time, setTime] = useState(localTime(start));
  const [duration, setDuration] = useState(editing?.schedule?.durationMin ?? 30);
  const [boardId, setBoardId] = useState<string>(
    editing?.boardId ?? fixedBoard ?? boards?.[0]?.id ?? "",
  );
  const [template, setTemplate] = useState<NoteTemplateId>(
    editing?.schedule?.template ?? "general",
  );
  const [mode, setMode] = useState<string>(editing?.mode ?? "assistant");
  const [invitees, setInvitees] = useState<Set<string>>(
    () => new Set(editing?.schedule?.invitees ?? []),
  );
  const [people, setPeople] = useState<Invitable[] | null | "loading">("loading");
  const [filter, setFilter] = useState("");
  const [errors, setErrors] = useState<{ title?: string; when?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const ids = {
    selLength: `${uid}-length`,
    selBoard: `${uid}-board`,
    selNotestemplate: `${uid}-template`,
    selLucent: `${uid}-mode`,
  };

  useEffect(() => {
    if (!boardId) {
      setPeople([]);
      return;
    }
    let alive = true;
    setPeople("loading");
    void listInvitable(boardId).then((list) => alive && setPeople(list));
    return () => {
      alive = false;
    };
  }, [boardId]);

  const shownPeople = useMemo(() => {
    if (!Array.isArray(people)) return [];
    const q = filter.trim().toLowerCase();
    return q
      ? people.filter((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
      : people;
  }, [people, filter]);

  const submit = async () => {
    const when = new Date(`${date}T${time}`).getTime();
    const next: typeof errors = {};
    if (!title.trim()) next.title = "Add a title.";
    if (!Number.isFinite(when)) next.when = "Pick a date and time.";
    else if (when < Date.now() - 60_000) next.when = "Pick a time in the future.";
    if (!boardId) next.form = "Pick a board.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setBusy(true);
    const plan = {
      title: title.trim(),
      scheduledFor: when,
      durationMin: duration,
      invitees: [...invitees],
      template,
      mode,
    };
    const result = editing
      ? await rescheduleMeeting(editing.boardId, editing.id, plan)
      : await scheduleMeeting(boardId, plan);
    setBusy(false);
    if (!result.ok) {
      setErrors({ form: result.error });
      return;
    }
    onDone({ meeting: result.meeting, invited: result.invited, boardId });
  };

  return (
    <Dialog
      onClose={onClose}
      title={editing ? "Change the meeting" : "Schedule a meeting"}
      className="sched-dialog"
    >
      <form
        className="sched-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <Field
          label="Title"
          value={title}
          onChange={(v) => {
            setTitle(v);
            if (v.trim()) setErrors(({ title: _cleared, ...rest }) => rest);
          }}
          placeholder="Launch sync"
        />
        {errors.title && (
          <p className="sched-error" role="alert">
            {errors.title}
          </p>
        )}

        <div className="sched-row">
          <Field
            label="Date"
            type="date"
            value={date}
            onChange={(v) => {
              setDate(v);
              setErrors(({ when: _cleared, ...rest }) => rest);
            }}
          />
          <Field
            label="Time"
            type="time"
            value={time}
            onChange={(v) => {
              setTime(v);
              setErrors(({ when: _cleared, ...rest }) => rest);
            }}
          />
          <div className="field auth-field">
            <label className="field-label" htmlFor={ids.selLength}>
              Length
            </label>
            <select
              id={ids.selLength}
              className="field-input auth-input"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d < 60 ? `${d} min` : `${d / 60} h${d % 60 ? ` ${d % 60} min` : ""}`}
                </option>
              ))}
            </select>
          </div>
        </div>
        {errors.when && (
          <p className="sched-error" role="alert">
            {errors.when}
          </p>
        )}

        {boards && !editing && (
          <div className="field auth-field">
            <label className="field-label" htmlFor={ids.selBoard}>
              Board
            </label>
            <select
              id={ids.selBoard}
              className="field-input auth-input"
              value={boardId}
              onChange={(e) => {
                setBoardId(e.target.value);
                setInvitees(new Set());
              }}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name || "Untitled board"}
                </option>
              ))}
            </select>
          </div>
        )}

        <fieldset className="sched-people">
          <legend className="field-label">
            Invite{invitees.size > 0 ? ` · ${invitees.size}` : ""}
          </legend>
          {people === "loading" ? (
            <p className="sched-note">Loading who can join…</p>
          ) : people === null ? (
            <p className="sched-note">You can schedule only on boards you can edit.</p>
          ) : people.length === 0 ? (
            <p className="sched-note">
              Nobody else can open this board yet. Share it, and they can be invited.
            </p>
          ) : (
            <>
              {people.length > 8 && (
                <input
                  className="field-input auth-input"
                  placeholder="Find people"
                  aria-label="Find people"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
              <ul className="sched-list">
                {shownPeople.map((p) => (
                  <li key={p.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={invitees.has(p.id)}
                        onChange={(e) =>
                          setInvitees((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          })
                        }
                      />
                      <span className="sched-name">{p.name}</span>
                      <span className="sched-email">{p.email}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </fieldset>

        <div className="sched-row">
          <div className="field auth-field">
            <label className="field-label" htmlFor={ids.selNotestemplate}>
              Notes template
            </label>
            <select
              id={ids.selNotestemplate}
              className="field-input auth-input"
              value={template}
              onChange={(e) => setTemplate(e.target.value as NoteTemplateId)}
            >
              {Object.values(NOTE_TEMPLATES).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field auth-field">
            <label className="field-label" htmlFor={ids.selLucent}>
              Lucent
            </label>
            <select
              id={ids.selLucent}
              className="field-input auth-input"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              {MEETING_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>

        {errors.form && (
          <p className="sched-error" role="alert">
            {errors.form}
          </p>
        )}
        <div className="confirm-actions">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Schedule"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
