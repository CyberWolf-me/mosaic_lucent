import { useCallback, useEffect, useRef, useState } from "react";
import {
  NOTE_TEMPLATES,
  NOTE_TEMPLATE_IDS,
  type EnhancedNote,
  type NoteItem,
  type NoteLine,
  type NoteTemplateId,
} from "@lucent/ai";
import type { MeetingTurn } from "../meetings.js";
import { enhanceNotes, getNotes, noteToMarkdown, restamp, saveNotes } from "../meetingNotes.js";

/**
 * Meeting notes, Granola's way (docs/27 N1). During the meeting: a private
 * notepad — type terse lines; each is stamped with the transcript turn it
 * came after. Afterwards (automatically when the meeting ends, or on
 * demand): the enhanced note — your lines exactly as typed, in full ink; what
 * Lucent added in muted ink, each line citing the turns it came from (hover
 * for the words, click to jump there). Edit any added line and it becomes
 * yours. Private to you; copy it out as Markdown to share.
 */

type Offline = "policy" | "no-model" | "model-failed";

const OFFLINE_NOTE: Record<Offline, string> = {
  policy: "Enhanced on this device — this board's policy keeps meeting content from AI providers.",
  "no-model": "Enhanced without a model — no AI provider is configured here.",
  "model-failed":
    "The AI provider didn't answer, so this was enhanced without it. Try again later for a fuller note.",
};

export function MeetingNotes({
  boardId,
  meetingId,
  turns,
  live,
  title,
  onJumpToTurn,
}: {
  boardId: string | null;
  meetingId: string | null;
  turns: MeetingTurn[];
  live: boolean;
  title: string;
  onJumpToTurn: (turn: number) => void;
}) {
  const [lines, setLines] = useState<NoteLine[]>([]);
  const [template, setTemplate] = useState<NoteTemplateId>("general");
  const [enhanced, setEnhanced] = useState<EnhancedNote | null>(null);
  const [view, setView] = useState<"notes" | "enhanced">("notes");
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState<Offline | null>(null);
  const [editing, setEditing] = useState<{ s: number; i: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // True while a meeting's stored notes are on their way (the pad reads busy).
  const [loading, setLoading] = useState(false);
  // Typed while those notes were on their way. The answer used to replace
  // the pad, so lines typed before it landed vanished from the screen (an
  // empty stored copy wiped them) and the note written at the meeting's end
  // had nothing to work from. Now they are kept, after anything stored.
  const typedSinceLoad = useRef(false);
  const editCancelled = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const saveFlight = useRef<Promise<unknown> | null>(null);
  const pending = useRef<Parameters<typeof saveNotes>[2]>({});
  const canSync = Boolean(boardId && meetingId);

  // Which meeting these notes belong to, across MeetingView's lifecycle. A
  // capture's id goes X → null → X when it stops (the live id clears before
  // the stored record opens), and a capture that started before its server
  // transcript existed runs with no id at first. Notes typed in either gap
  // are the same meeting's notes, so they're carried, not wiped:
  //   - to null FROM LIVE: keep everything (the capture is ending);
  //   - to null otherwise: a fresh, unsaved notepad;
  //   - back to the same id: keep (nothing to reload);
  //   - to a new id from an unsaved notepad with lines: adopt them there;
  //   - to any other id: load that meeting's notes.
  const lastId = useRef<string | null>(null);
  const prevLive = useRef(live);
  const justEnded = useRef(false);
  const [autoEnhance, setAutoEnhance] = useState(0);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  useEffect(() => {
    const wasLive = prevLive.current;
    prevLive.current = live;
    if (live) justEnded.current = false;
    else if (wasLive) justEnded.current = true;
    const ended = justEnded.current && !live;

    if (!boardId || !meetingId) {
      setLoading(false);
      if (!wasLive) {
        lastId.current = null;
        setLines([]);
        setEnhanced(null);
        setOffline(null);
        setView("notes");
      }
      return;
    }
    if (meetingId === lastId.current) {
      if (ended) {
        justEnded.current = false;
        setAutoEnhance((n) => n + 1);
      }
      return;
    }
    const carried = lastId.current === null ? linesRef.current.filter((l) => l.text.trim()) : [];
    setEnhanced(null);
    setOffline(null);
    setView("notes");
    if (carried.length === 0) setLines([]);
    let alive = true;
    typedSinceLoad.current = false;
    setLoading(true);
    void getNotes(boardId, meetingId).then(async (n) => {
      if (!alive) return;
      // Marked only once its notes are here: a rerun of this effect before the
      // answer (React runs it twice in development; a dependency can change
      // mid-fetch) dropped the first answer and then skipped loading, so a
      // reopened meeting showed an empty notepad.
      lastId.current = meetingId;
      setLoading(false);
      const stored = (n?.lines ?? []).filter((l) => l.text.trim());
      // Lines on the pad that aren't stored: carried from before the meeting
      // had an id, or typed while its notes loaded. They are this person's
      // notes on this meeting — kept after what was stored, then saved.
      const local =
        carried.length > 0 || typedSinceLoad.current
          ? linesRef.current.filter((l) => l.text.trim())
          : [];
      const extra = local.filter((l) => !stored.some((s) => s.text === l.text));
      if (n) {
        setTemplate(n.template);
        setEnhanced(n.enhanced);
      }
      if (extra.length > 0) {
        const merged = [...stored, ...extra];
        setLines(merged);
        await saveNotes(boardId, meetingId, { lines: merged, template: n?.template ?? template });
      } else if (n) {
        setLines(n.lines);
        if (n.enhanced && n.lines.length === 0) setView("enhanced");
      }
      if (ended && alive) {
        justEnded.current = false;
        setAutoEnhance((x) => x + 1);
      }
    });
    return () => {
      alive = false;
    };
    // template is read, not tracked: switching it must not reload the notes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, meetingId, live]);

  const persist = useCallback(
    (patch: Parameters<typeof saveNotes>[2]) => {
      if (!boardId || !meetingId) return;
      // Coalesce: a template change inside the debounce must not drop the
      // lines typed just before it.
      pending.current = { ...pending.current, ...patch };
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      setSaving("saving");
      saveTimer.current = window.setTimeout(() => {
        saveTimer.current = null;
        const body = pending.current;
        pending.current = {};
        saveFlight.current = saveNotes(boardId, meetingId, body).then((r) => {
          setSaving(r ? "saved" : "error");
          return r;
        });
      }, 700);
    },
    [boardId, meetingId],
  );

  const onType = (text: string) => {
    typedSinceLoad.current = true;
    const next = restamp(lines, text, turns.length);
    setLines(next);
    persist({ lines: next });
  };

  const enhance = useCallback(async () => {
    if (!boardId || !meetingId || busy) return;
    setBusy(true);
    setError(null);
    // The server enhances what it has stored, so store exactly what's on
    // screen first — including lines typed while the meeting was ending,
    // when there was no id to save them under.
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pending.current = {};
    if (saveFlight.current) await saveFlight.current;
    await saveNotes(boardId, meetingId, { lines, template });
    const r = await enhanceNotes(boardId, meetingId, template);
    setBusy(false);
    if ("error" in r) {
      setError(r.error);
      return;
    }
    setEnhanced(r.enhanced);
    setOffline(r.offline ?? null);
    setView("enhanced");
  }, [boardId, meetingId, busy, lines, template]);

  // Granola's moment: when the meeting ends, the note writes itself — once
  // the stored record is open (its last turns flushed), and only when there
  // are notes to enhance and no note yet.
  useEffect(() => {
    if (autoEnhance === 0) return;
    if (lines.some((l) => l.text.trim()) && !enhanced) void enhance();
    // Fires on the end signal only; the rest is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEnhance]);

  const editItem = (s: number, i: number, text: string) => {
    if (!enhanced) return;
    const next: EnhancedNote = {
      ...enhanced,
      sections: enhanced.sections.map((sec, si) =>
        si !== s
          ? sec
          : {
              ...sec,
              items: sec.items
                .map((it, ii): NoteItem | null => {
                  if (ii !== i) return it;
                  const t = text.trim();
                  if (!t) return null;
                  // Your edit makes the line yours: full ink, no citation.
                  return t === it.text ? it : { text: t, source: "user" };
                })
                .filter((it): it is NoteItem => it !== null),
            },
      ),
    };
    setEnhanced(next);
    setEditing(null);
    persist({ enhanced: next });
  };

  const copy = async () => {
    if (!enhanced) return;
    try {
      await navigator.clipboard.writeText(noteToMarkdown(enhanced, title));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard access was blocked.");
    }
  };

  const quote = (it: NoteItem) =>
    it.turns
      ? turns
          .slice(it.turns[0], it.turns[1] + 1)
          .map((t) => `${t.speaker}: ${t.text}`)
          .join("\n")
      : "";

  return (
    <div className="mn">
      <div className="mn-bar">
        <div className="mn-toggle" role="tablist" aria-label="Notes view">
          <button
            role="tab"
            aria-selected={view === "notes"}
            className={view === "notes" ? "on" : ""}
            onClick={() => setView("notes")}
          >
            My notes
          </button>
          <button
            role="tab"
            aria-selected={view === "enhanced"}
            className={view === "enhanced" ? "on" : ""}
            onClick={() => setView("enhanced")}
            disabled={!enhanced}
            title={enhanced ? "The enhanced note" : "Enhance your notes to see it"}
          >
            Enhanced
          </button>
        </div>
        <select
          className="mn-template"
          aria-label="Meeting type"
          value={template}
          onChange={(e) => {
            const t = e.target.value as NoteTemplateId;
            setTemplate(t);
            persist({ template: t });
          }}
        >
          {NOTE_TEMPLATE_IDS.map((id) => (
            <option key={id} value={id}>
              {NOTE_TEMPLATES[id].name}
            </option>
          ))}
        </select>
      </div>

      {view === "notes" ? (
        <>
          <textarea
            className="mn-pad"
            aria-label="Your notes"
            placeholder={
              live
                ? "Jot what matters — terse is fine. Lucent writes the full note when the meeting ends."
                : "Your notes on this meeting. Enhance them into a full note, with every added line tied to what was said."
            }
            value={lines.map((l) => l.text).join("\n")}
            aria-busy={loading}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            spellCheck
          />
          <div className="mn-foot">
            <span className="mn-state" aria-live="polite">
              {!canSync
                ? "Private to you · not saved yet — notes save once the meeting is on the board"
                : saving === "saving"
                  ? "Saving…"
                  : saving === "error"
                    ? "Couldn't save — your text is still here"
                    : "Private to you"}
            </span>
            <button
              className="mn-go"
              onClick={() => void enhance()}
              disabled={!canSync || busy || turns.length === 0}
            >
              {busy ? "Writing the note…" : enhanced ? "Re-enhance" : "Enhance notes"}
            </button>
          </div>
        </>
      ) : enhanced ? (
        <div className="mn-note">
          {offline && <p className="mn-offline">{OFFLINE_NOTE[offline]}</p>}
          {enhanced.by === "fallback" && !offline && (
            <p className="mn-offline">Enhanced without a model.</p>
          )}
          {enhanced.sections.map((sec, s) => (
            <section key={sec.title} className="mn-sec">
              <h4>{sec.title}</h4>
              <ul>
                {sec.items.map((it, i) =>
                  editing?.s === s && editing.i === i ? (
                    <li key={i} className={`mn-item ${it.source}`}>
                      <textarea
                        className="mn-edit"
                        autoFocus
                        defaultValue={it.text}
                        rows={Math.max(1, Math.ceil(it.text.length / 44))}
                        aria-label="Edit this line"
                        onBlur={(e) => {
                          if (editCancelled.current) editCancelled.current = false;
                          else editItem(s, i, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }
                          if (e.key === "Escape") {
                            // Some browsers blur a focused node as it unmounts;
                            // Escape must not save on the way out.
                            editCancelled.current = true;
                            setEditing(null);
                          }
                        }}
                      />
                    </li>
                  ) : (
                    <li key={i} className={`mn-item ${it.source}`}>
                      <span
                        className="mn-text"
                        onDoubleClick={() => setEditing({ s, i })}
                        title="Double-click to edit"
                      >
                        {it.text}
                      </span>
                      {it.source === "ai" && it.turns && (
                        <button
                          className="mn-cite"
                          title={quote(it)}
                          aria-label={`Source: turn ${it.turns[0] + 1}. ${quote(it)}`}
                          onClick={() => onJumpToTurn(it.turns![0])}
                        >
                          {it.turns[0] + 1}
                          {it.turns[1] > it.turns[0] ? `–${it.turns[1] + 1}` : ""}
                        </button>
                      )}
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
          <div className="mn-foot">
            <span className="mn-state">
              Your lines in ink, Lucent&rsquo;s in grey — each tied to what was said. Double-click
              to edit.
            </span>
            <button className="mn-go ghost" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy as Markdown"}
            </button>
          </div>
        </div>
      ) : null}
      {error && <p className="mn-error">{error}</p>}
    </div>
  );
}
