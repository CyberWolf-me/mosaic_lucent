import { useId, useMemo, useState } from "react";
import {
  IMPORT_MAX_TURNS,
  parseTranscript,
  transcriptTurns,
  type ParsedTranscript,
} from "@lucent/core";
import { Dialog, Field } from "../ui/primitives.js";
import { Button } from "../ui/kit.js";
import { importTranscript, type MeetingTranscript } from "../meetings.js";

/**
 * Import a transcript (docs/28 S12): a file another tool exported — Zoom's
 * or Teams' .vtt, an .srt, Meet's or Otter's text — becomes an ended meeting
 * on this board, with its summary to follow, like one Lucent recorded.
 * Nothing is sent until the preview shows what the file holds: who spoke,
 * how many lines, and the first of them. Speakers are named as the file
 * names them.
 */

const SOURCE_LABEL: Record<NonNullable<ParsedTranscript["source"]>, string> = {
  zoom: "Zoom",
  teams: "Microsoft Teams",
  meet: "Google Meet",
  otter: "Otter",
};

function localInput(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function ImportTranscriptDialog({
  boardId,
  onClose,
  onDone,
}: {
  boardId: string;
  onClose: () => void;
  onDone: (meeting: MeetingTranscript, note: string) => void;
}) {
  const uid = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const start = localInput(Date.now() - 60 * 60_000);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(
    () => (content.trim() ? parseTranscript(content, fileName ?? undefined) : null),
    [content, fileName],
  );
  const ready = parsed && !("error" in parsed) ? parsed : null;

  const readFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    setTitle(
      (t) =>
        t ||
        file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[_-]+/g, " ")
          .trim(),
    );
    setContent(await file.text());
  };

  const submit = async () => {
    if (!ready) return;
    const startedAt = new Date(`${date}T${time}`).getTime();
    if (!Number.isFinite(startedAt)) {
      setError("Choose when the meeting happened.");
      return;
    }
    const { turns, dropped } = transcriptTurns(ready, startedAt);
    const endedAt = Math.max(turns[turns.length - 1]!.at, startedAt + (ready.durationMs ?? 0));
    setBusy(true);
    setError(null);
    const result = await importTranscript(boardId, { turns, startedAt, endedAt, title });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const from = ready.source ? `from ${SOURCE_LABEL[ready.source]} ` : "";
    onDone(
      result.meeting,
      dropped > 0
        ? `Imported ${from}— the first ${IMPORT_MAX_TURNS} lines; ${dropped} more didn't fit`
        : `Imported ${from}— speakers as the file names them`,
    );
  };

  return (
    <Dialog onClose={onClose} title="Import a transcript" className="sched-dialog import-dialog">
      <form
        className="sched-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <p className="import-help">
          A transcript another tool exported — Zoom or Teams (.vtt), subtitles (.srt), or Google
          Meet and Otter text. It becomes a meeting on this board, and Lucent writes its summary.
        </p>
        <label className="import-drop" htmlFor={`${uid}-file`}>
          <input
            id={`${uid}-file`}
            type="file"
            accept=".vtt,.srt,.txt,.md,text/vtt,text/plain"
            aria-label="Transcript file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <span>{fileName ? `${fileName} · choose another` : "Choose a file…"}</span>
        </label>
        <details className="import-paste">
          <summary>Or paste it</summary>
          <textarea
            aria-label="Transcript text"
            rows={6}
            value={fileName ? "" : content}
            onChange={(e) => {
              setFileName(null);
              setContent(e.target.value);
            }}
            placeholder={"Ada: Let's go annual.\nBo: Agreed — I'll update the page."}
          />
        </details>

        {parsed && "error" in parsed && (
          <p className="sched-error" role="alert">
            {parsed.error}
          </p>
        )}
        {ready && (
          <section className="import-preview" aria-label="What the file holds">
            <p className="import-summary">
              {ready.source
                ? `Looks like ${/^[AEIOU]/.test(SOURCE_LABEL[ready.source]) ? "an" : "a"} ${SOURCE_LABEL[ready.source]} transcript · `
                : ""}
              {ready.turns.length} {ready.turns.length === 1 ? "line" : "lines"} ·{" "}
              {ready.speakers.length} {ready.speakers.length === 1 ? "speaker" : "speakers"}
              {ready.durationMs
                ? ` · ${Math.max(1, Math.round(ready.durationMs / 60_000))} min`
                : ""}
            </p>
            <ul className="import-speakers" aria-label="Speakers">
              {ready.speakers.slice(0, 8).map((s) => (
                <li key={s}>{s}</li>
              ))}
              {ready.speakers.length > 8 && <li>+{ready.speakers.length - 8}</li>}
            </ul>
            <ol className="import-lines">
              {ready.turns.slice(0, 4).map((t, i) => (
                <li key={i}>
                  <strong>{t.speaker}</strong>{" "}
                  {t.text.length > 140 ? `${t.text.slice(0, 140)}…` : t.text}
                </li>
              ))}
            </ol>
            {ready.turns.length > IMPORT_MAX_TURNS && (
              <p className="import-warn">
                A meeting holds {IMPORT_MAX_TURNS} lines; the last{" "}
                {ready.turns.length - IMPORT_MAX_TURNS} won&apos;t be imported.
              </p>
            )}
            {ready.speakers.length === 1 && ready.speakers[0] === "Speaker" && (
              <p className="import-warn">
                This file doesn&apos;t name its speakers, so every line reads as Speaker.
              </p>
            )}
          </section>
        )}

        <Field label="Title" value={title} onChange={setTitle} placeholder="Pricing review" />
        <div className="sched-row">
          <Field label="Date" type="date" value={date} onChange={setDate} />
          <Field label="Started at" type="time" value={time} onChange={setTime} />
        </div>

        {error && (
          <p className="sched-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !ready}>
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
