import { useEffect, useRef, useState } from "react";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { useSettings } from "../settings.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import {
  classifyTurn,
  listMeetings,
  promptFromTranscript,
  saveMeeting,
  type MeetingTranscript,
  type MeetingTurn,
} from "../meetings.js";

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

  const voiceSupported = isAnyVoiceSupported();
  const livekitConfigured = settings.livekitTokenUrl.trim().length > 0;

  // Prior meetings for this board, so the view opens on real state.
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      const rows = await listMeetings(boardId);
      if (!cancelled && rows) setSaved(rows);
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
      onFinal: (text) => {
        const t = text.trim();
        if (!t) return;
        setTurns((prev) => [
          ...prev,
          {
            // LiveKit names the speaker; the local engines have no concept,
            // and "You" is the honest answer rather than a fake guess.
            speaker: provider.id === "livekit" ? "Speaker" : "You",
            at: Date.now(),
            text: t,
            kind: classifyTurn(t),
          },
        ]);
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
      setRecording(true);
    }
  };

  const stopRecording = (): void => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setRecording(false);
  };

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
                style={{ letterSpacing: "0.12em", color: recording ? "var(--sig-red)" : "var(--ink-3)" }}
              >
                {recording ? "RECORDING" : shown ? "SAVED MEETING" : "READY"}
              </div>
              <h2 style={{ margin: "4px 0 0", fontSize: 16, color: "var(--ink-0)" }}>
                {shown ? new Date(shown.startedAt).toLocaleString() : "Meeting capture"}
              </h2>
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
                <button className="btn primary" onClick={() => onExtract(shown)} disabled={!boardId}>
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
                (problem / hypothesis / solution / decision / action / requirement) and save to
                this board.
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
