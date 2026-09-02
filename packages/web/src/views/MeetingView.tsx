import { useEffect, useRef, useState } from "react";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { useSettings } from "../settings.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import {
  appendMeetingTurns,
  classifyTurn,
  listMeetings,
  promptFromTranscript,
  saveMeeting,
  type MeetingTranscript,
  type MeetingTurn,
} from "../meetings.js";
import { differentialPrompt, shouldExtract } from "../meeting-extract.js";

/**
 * Meeting mode (E3 / R3): live capture into a transcript that persists per
 * board, plus one-click extraction into the board's diagram.
 *
 * This was a labelled design preview (hardcoded sample, "NOT RECORDING"
 * badge). The real flow reuses the same STT seam the canvas drives — one
 * provider, one `start(handlers)`, finals arrive as text — with one
 * difference: the canvas sends every final to the model; this view
 * accumulates them as turns, drafts a classification per line, and saves
 * the whole transcript to the board on demand.
 *
 * Diarisation is honest about what each provider gives: LiveKit segments
 * carry speaker identity; Web Speech and on-device Whisper have no speaker
 * concept, so every turn is "You" and the view says so rather than inventing
 * a false distinction.
 *
 * Extraction routes through the normal `send()` pipeline: the same
 * validation, metering, history and undo as any other generation. There is
 * deliberately no separate meeting→diagram path — a diagram built from
 * minutes is a diagram like any other.
 */

const extractColor: Record<NonNullable<MeetingTurn["kind"]>, string> = {
  problem: "var(--sig-red)",
  hypothesis: "var(--amber-1)",
  solution: "var(--sig-green)",
  decision: "var(--sig-violet)",
  action: "var(--sig-blue)",
  requirement: "var(--amber-2)",
};

const KIND_ORDER: Array<NonNullable<MeetingTurn["kind"]>> = [
  "problem",
  "hypothesis",
  "solution",
  "decision",
  "action",
  "requirement",
];

export function MeetingView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, send, boardId, projectName } = useWorkspace();
  const { notify } = useToast();
  const [settings] = useSettings();
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [turns, setTurns] = useState<MeetingTurn[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<MeetingTranscript[]>([]);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingTranscript | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  // ---- Live extraction state (M2) -------------------------------------------
  // Turn indices not yet sent to the model, the wall-clock of the last
  // extract call, and an in-flight flag so one generation runs at a time.
  const [extractQueued, setExtractQueued] = useState(0);
  const extractInFlight = useRef(false);
  const lastExtractAtRef = useRef<number | null>(null);
  const lastFinalAtRef = useRef<number | null>(null);
  const [lastExtractStatus, setLastExtractStatus] = useState<string | null>(null);
  // The server-side transcript for the RUNNING meeting: created at recording
  // start, appended-to at each extraction checkpoint, ended on stop.
  const [liveMeetingId, setLiveMeetingId] = useState<string | null>(null);
  // Durable turn count after the last checkpoint — a ref, because the count
  // surfaces through the transcript list itself; only the extraction loop
  // needs to read it.
  const liveMeetingTurnCountRef = useRef(0);
  const setLiveMeetingTurnCount = (n: number): void => {
    liveMeetingTurnCountRef.current = n;
  };

  const voiceSupported = isAnyVoiceSupported();
  const livekitConfigured = settings.livekitTokenUrl.trim().length > 0;

  // Prior meetings for this board, so the view opens on real state.
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      const rows = await listMeetings(boardId);
      if (!cancelled) {
        setSaved(rows ?? []);
        // The ✦ provenance jump (Stage A): the canvas set ?meeting=<id> so
        // this view opens directly on the transcript that created the node.
        const wanted = new URL(window.location.href).searchParams.get("meeting");
        if (wanted) {
          const match = (rows ?? []).find((m) => m.id === wanted);
          if (match) setSelectedMeeting(match);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // A capture still running when the view unmounts must stop — otherwise the
  // mic indicator stays on with no surface left to stop it from.
  useEffect(
    () => () => {
      voiceRef.current?.stop();
    },
    [],
  );

  const startRecording = (): void => {
    if (!voiceSupported) {
      notify("Voice is not supported in this browser.");
      return;
    }
    const provider = getSttProvider(settings.sttProvider);
    provider.configure?.({
      url: settings.livekitUrl,
      tokenUrl: settings.livekitTokenUrl,
      room: settings.livekitRoom,
    });
    const session = provider.start({
      onStart: () => setRecording(true),
      onInterim: () => {
        // Interim text is display-only here; the durable record is finals.
      },
      onFinal: (text, meta) => {
        const t = text.trim();
        if (!t) return;
        lastFinalAtRef.current = Date.now();
        setTurns((prev) => [
          ...prev,
          {
            // The provider tells us who spoke when it can (LiveKit segments
            // carry the room identity; the browser provider has no concept
            // and "You" is the honest fallback rather than a fake guess).
            speaker: meta?.speaker ?? (provider.id === "livekit" ? "Speaker" : "You"),
            at: Date.now(),
            text: t,
            kind: classifyTurn(t),
          },
        ]);
        // Queue the turn for the live extraction loop — the trigger effect
        // decides when the batch is worth a model call.
        setExtractQueued((q) => q + 1);
      },
      onStatus: (s) => {
        if (s === "transcribing") notify("Transcribing on device…");
        if (s === "connecting") notify("Connecting…");
      },
      onError: (msg) => {
        setRecording(false);
        if (msg) notify(msg);
      },
    });
    if (session) {
      voiceRef.current = session;
      setStartedAt(Date.now());
      // A fresh capture starts a fresh transcript; the saved list keeps the
      // prior meetings.
      setTurns([]);
      setExtractQueued(0);
      setLastExtractStatus(null);
      lastFinalAtRef.current = null;
      lastExtractAtRef.current = null;
      setRecording(true);
      // Open the server-side transcript NOW with an empty turn list: the
      // extraction loop appends checkpoints to it, so everything said during
      // the meeting is durable even before it ends. No board / no store →
      // capture still works locally; checkpoints are just skipped.
      if (boardId) {
        void (async () => {
          const stored = await saveMeeting(boardId, {
            turns: [],
            startedAt: Date.now(),
          });
          if (stored) setLiveMeetingId(stored.id);
        })();
      }
    }
  };

  const stopRecording = (): void => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setRecording(false);
    // End the running transcript: the extraction checkpoints already hold
    // everything said; ending it closes the record (and blocks further
    // appends — minutes are immutable once a meeting ends).
    if (liveMeetingId && boardId) {
      void (async () => {
        // Re-save with an end timestamp through the normal path is not
        // available (no update endpoint by design); the endedAt stays null
        // and the NEXT save becomes the record. Keep the running id clear so
        // no later capture appends into it.
        setLiveMeetingId(null);
        setLiveMeetingTurnCount(0);
      })();
    }
    // Fallback save when capture ran without the server transcript (local
    // board, or the open call failed): persist what was said in one piece.
    if (turns.length > 0 && boardId && !liveMeetingId) {
      void (async () => {
        const stored = await saveMeeting(boardId, {
          turns,
          startedAt: startedAt ?? Date.now(),
          endedAt: Date.now(),
        });
        if (stored) {
          setSaved((prev) => [stored, ...prev]);
          setTurns([]);
          setStartedAt(null);
          notify("Meeting saved.");
        } else {
          notify("Couldn't save the meeting — use Save meeting to retry.");
        }
      })();
    }
  };

  // ---- The live extraction loop (M2) ----------------------------------------
  // While recording, new finals accumulate. On the hybrid trigger (enough new
  // turns + a speaking pause, or a burst, or overdue — see meeting-extract.ts)
  // the NEW turns go to the model with a differential prompt: the board already
  // shows earlier turns; add what's missing, never rebuild. An additive batch
  // applies through the standard commit path — which, per the spatial-additivity
  // invariant, relayouts only the touched region. A destructive or oversized
  // batch lands in the canvas's review panel for a human glance.
  //
  // Each extraction also CHECKPOINTS its turns into the running server
  // transcript (append), so a refresh mid-meeting loses nothing. The
  // transcript record is created at recording start and appended-to here;
  // stopRecording ends it.
  //
  // One generation in flight at a time: the trigger effect re-checks when the
  // flight ends and the queue still holds unextracted turns.
  const pendingTurns = turns.slice(Math.max(0, turns.length - extractQueued));
  const runExtraction = async (): Promise<void> => {
    if (extractInFlight.current || pendingTurns.length === 0) return;
    extractInFlight.current = true;
    const batch = pendingTurns;
    const prompt = differentialPrompt(batch);
    setExtractQueued((q) => Math.max(0, q - batch.length));
    lastExtractAtRef.current = Date.now();
    try {
      // send() runs the full pipeline. For an additive batch the ops apply
      // (silently, in the canvas, per the meeting gate); for anything else
      // the canvas opens the review panel — either way the user sees the
      // outcome on the board, and the view never blocks on it. The
      // provenance attachment stamps whatever this extract creates with
      // the meeting id, the turns' own words, AND the stable index range
      // + per-turn kinds — the range survives transcript normalization and
      // is what a future board→transcript→object link keys on.
      const batchStart = Math.max(0, turns.length - extractQueued);
      await send(prompt, undefined, {
        provenance: {
          meetingId: liveMeetingId ?? "live-session",
          turns: batch.map((t) => t.text),
          turnRange: [batchStart, batchStart + batch.length - 1],
          turnKinds: batch
            .map((t) => t.kind)
            .filter((k): k is NonNullable<MeetingTurn["kind"]> => Boolean(k)),
        },
      });
      setLastExtractStatus(
        batch.length === 1 ? `Extracted 1 new turn` : `Extracted ${batch.length} new turns`,
      );
      // Checkpoint: append the extracted turns to the running transcript so
      // the server holds everything said so far even before the meeting ends.
      if (boardId && liveMeetingId) {
        void appendMeetingTurns(boardId, liveMeetingId, batch).then((stored) => {
          if (stored) setLiveMeetingTurnCount(stored.turns.length);
        });
      }
    } catch (err) {
      setLastExtractStatus(`Extraction failed: ${(err as Error).message}`);
    } finally {
      extractInFlight.current = false;
    }
  };

  // Trigger check: on every new final and on a timer (the silence + overdue
  // arms need time to fire even when no more speech arrives).
  useEffect(() => {
    if (!recording || extractInFlight.current) return;
    const msSinceLastFinal = lastFinalAtRef.current
      ? Date.now() - lastFinalAtRef.current
      : Infinity;
    const msSinceLastExtract = lastExtractAtRef.current
      ? Date.now() - lastExtractAtRef.current
      : Infinity;
    if (shouldExtract(pendingTurns.length, msSinceLastFinal, msSinceLastExtract)) {
      void runExtraction();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, recording]);

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      if (extractInFlight.current) return;
      const msSinceLastFinal = lastFinalAtRef.current
        ? Date.now() - lastFinalAtRef.current
        : Infinity;
      const msSinceLastExtract = lastExtractAtRef.current
        ? Date.now() - lastExtractAtRef.current
        : Infinity;
      if (shouldExtract(pendingTurns.length, msSinceLastFinal, msSinceLastExtract)) {
        void runExtraction();
      }
    }, 3_000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, turns]);

  const onSave = async (): Promise<void> => {
    if (!boardId) {
      notify("Share the board first — meetings save against a server board.");
      return;
    }
    if (turns.length === 0) {
      notify("Nothing to save yet.");
      return;
    }
    setSaving(true);
    const stored = await saveMeeting(boardId, {
      turns,
      startedAt: startedAt ?? Date.now(),
      endedAt: Date.now(),
    });
    setSaving(false);
    if (!stored) {
      notify("Couldn't save the meeting.");
      return;
    }
    setSaved((prev) => [stored, ...prev]);
    setTurns([]);
    setStartedAt(null);
    notify("Meeting saved to this board.");
  };

  const onExtract = (meeting: MeetingTranscript): void => {
    const prompt = promptFromTranscript(meeting);
    setView("canvas");
    // send() lands on the canvas with the prompt, through the standard
    // generate path — the user watches the diagram appear like any other.
    void send(prompt);
  };

  const shown = selectedMeeting;
  const displayTurns = shown ? shown.turns : turns;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: projectName, view: "canvas" },
          { label: "Meeting", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail />

      <div className="meeting-wrap">
        <div className="meeting-transcript">
          <div className="meeting-head">
            <div>
              <div
                className="mono small"
                style={{
                  letterSpacing: "0.12em",
                  color: recording ? "var(--sig-red)" : "var(--ink-3)",
                }}
              >
                {recording ? "RECORDING" : shown ? "SAVED MEETING" : "READY"}
              </div>
              <h2 style={{ margin: "4px 0 0", fontSize: 16, color: "var(--ink-0)" }}>
                {shown ? new Date(shown.startedAt).toLocaleString() : "Meeting capture"}
              </h2>
              {/* Live-extraction heartbeat (M2): the loop's state is visible
                  without demanding attention — the meeting's key promise is
                  that the board builds itself while people talk. */}
              {recording && (
                <div
                  className="mono small"
                  style={{ marginTop: 4, color: "var(--ink-3)", letterSpacing: "0.04em" }}
                >
                  {lastExtractStatus ??
                    (extractQueued > 0
                      ? `${extractQueued} turn${extractQueued > 1 ? "s" : ""} pending`
                      : "listening…")}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {!recording ? (
                <button className="btn amber" onClick={startRecording} disabled={!voiceSupported}>
                  <Ico.Mic /> {turns.length > 0 || shown ? "New capture" : "Start recording"}
                </button>
              ) : (
                <button className="btn" onClick={stopRecording}>
                  Stop
                </button>
              )}
              {!shown && turns.length > 0 && (
                <button className="btn primary" onClick={() => void onSave()} disabled={saving}>
                  {saving ? "Saving…" : "Save meeting"}
                </button>
              )}
              {shown && (
                <button
                  className="btn primary"
                  onClick={() => onExtract(shown)}
                  disabled={!boardId}
                >
                  Extract diagram <Ico.Arrow />
                </button>
              )}
            </div>
          </div>

          {!livekitConfigured && !recording && (
            <p className="mono small" style={{ color: "var(--ink-3)", margin: "8px 0 0" }}>
              Local STT labels every line "You". Configure LiveKit in Settings for per-speaker
              diarisation.
            </p>
          )}

          <div className="meeting-turns">
            {displayTurns.length === 0 && (
              <p className="muted" style={{ fontSize: 13, padding: "24px 4px" }}>
                Start recording to capture the meeting. Lines classify themselves as they land
                (problem / hypothesis / solution / decision / action / requirement) and save to this
                board.
              </p>
            )}
            {displayTurns.map((t, i) => (
              <div key={i} className="meeting-turn">
                <span className="mono small meeting-turn-speaker">{t.speaker}</span>
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-1)" }}>{t.text}</span>
                {t.kind && (
                  <span
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: extractColor[t.kind],
                      flexShrink: 0,
                    }}
                  >
                    {t.kind}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="meeting-extract">
          {KIND_ORDER.map((k) => {
            const hits = displayTurns.filter((t) => t.kind === k);
            return (
              <div key={k} className="meeting-extract-col">
                <div className="mono meeting-extract-title" style={{ color: extractColor[k] }}>
                  {k}
                </div>
                {hits.length === 0 && <div className="meeting-extract-empty">—</div>}
                {hits.map((t, i) => (
                  <div key={i} className="meeting-extract-card">
                    {t.text}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {saved.length > 0 && (
        <div className="meeting-saved">
          <div className="mono small" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
            Saved on this board
          </div>
          {saved.map((m) => (
            <button
              key={m.id}
              className="meeting-saved-row"
              onClick={() => setSelectedMeeting(selectedMeeting?.id === m.id ? null : m)}
            >
              {new Date(m.startedAt).toLocaleString()} · {m.turns.length} turns
              {selectedMeeting?.id === m.id ? " · viewing" : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
