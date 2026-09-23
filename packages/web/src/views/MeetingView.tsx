import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { GlobalRail, ActionIcon, DecisionIcon } from "../ui/atelierAtoms.js";
import { useWorkspace, type View } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { useSettings } from "../settings.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import { askLucent } from "../boards.js";
import {
  ConversationalLeaseManager,
  voiceAnswerCard,
  openBoardQuestions,
  type VoiceAnswer,
} from "../meeting-voice.js";
import { useMeetingSession } from "../meeting-room/MeetingSessionContext.js";
import { speakAnswer, isTtsSpeaking } from "../tts.js";
import type { VoiceHandlers } from "../stt/index.js";
import {
  MEETING_MODES,
  MODE_LABELS,
  MODE_NOTES,
  isMeetingMode,
  modeAllowsExtraction,
  type MeetingMode,
} from "../meeting-modes.js";
import {
  appendMeetingTurns,
  classifyTurn,
  endMeeting,
  listMeetings,
  promptFromTranscript,
  saveMeeting,
  type MeetingTranscript,
  type MeetingTurn,
} from "../meetings.js";
import { differentialPrompt } from "../meeting-extract.js";
import { NativeRoom } from "../meeting-room/NativeRoom.js";
import {
  applyExtractOutcome,
  createMeetingEngine,
  extractStatusMessage,
  sliceBatch,
} from "../meeting-engine.js";
import { isLiveProvenance, objectsByTurn, pointsAtLive } from "../meetingTimeline.js";

/**
 * Screen 08 & Screen 13 — Atelier v2 Meeting Experience.
 *
 * Unifies:
 * 1. Notes View (Screen 08): Granola-style structured AI notes (Summary with citations,
 *    Decisions, Action Items with checkboxes, Open Questions, Canvas Link card, Ask Anything input)
 *    plus transcript drawer with search, speaker badges, and tabs (Transcript, Chat, Saved).
 * 2. Calling Mode: Zoom/Meet native video room (NativeRoom) with active speaker detection,
 *    screen sharing, and media dock.
 * 3. Board Mode (Screen 13): Interactive diagram canvas with live meeting topbar,
 *    presenter following chip, and live cursors.
 *
 * Retains 100% of underlying functionality:
 * - Real live STT capture (Browser, Whisper, LiveKit, Hosted)
 * - 4 Meeting Behavior Profiles (Record, Intelligence, Assistant, Participant)
 * - Differential live extraction loop with spatial-additivity updates
 * - Conversational Lease Platform with TTS spoken answers, barge-in, and 15s countdown
 * - Reverse provenance linking turns to canvas nodes
 * - Server transcript persistence and meeting archives
 */

const extractColor: Record<NonNullable<MeetingTurn["kind"]>, string> = {
  problem: "var(--sig-red, #e11d48)",
  hypothesis: "var(--amber-1, #f59e0b)",
  solution: "var(--sig-green, #10b981)",
  decision: "var(--sig-violet, #8b5cf6)",
  action: "var(--sig-blue, #3b82f6)",
  requirement: "var(--amber-2, #d97706)",
};

const KIND_ORDER: Array<NonNullable<MeetingTurn["kind"]>> = [
  "problem",
  "hypothesis",
  "solution",
  "decision",
  "action",
  "requirement",
];

const SPEAKER_COLORS: Record<string, string> = {
  Sarah: "oklch(0.55 0.11 220)",
  John: "oklch(0.55 0.14 148)",
  Alex: "oklch(0.55 0.16 25)",
  You: "var(--bloom-2)",
  Lucent: "var(--bloom-2)",
  Speaker: "oklch(0.55 0.12 280)",
};

function getSpeakerColor(speaker: string): string {
  return SPEAKER_COLORS[speaker] ?? "oklch(0.55 0.14 265)";
}

function getSpeakerInitials(speaker: string): string {
  const parts = speaker.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Splice topic-break markers into a turn slice for extraction prompts. */
function withTopicBreaks(list: MeetingTurn[], breaks: number[]): MeetingTurn[] {
  if (breaks.length === 0) return list;
  const marks = new Set(breaks);
  const out: MeetingTurn[] = [];
  for (let i = 0; i <= list.length; i++) {
    if (marks.has(i)) out.push({ speaker: "You", at: Date.now(), text: "── topic break ──" });
    if (i < list.length) out.push(list[i]!);
  }
  return out;
}

/** Formats elapsed recording time as MM:SS or HH:MM:SS */
function useElapsedTime(startedAt: number | null, isRunning: boolean) {
  const [elapsed, setElapsed] = useState("00:00");
  useEffect(() => {
    if (!startedAt || !isRunning) {
      setElapsed("00:00");
      return;
    }
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const m = String(Math.floor(sec / 60)).padStart(2, "0");
      const s = String(sec % 60).padStart(2, "0");
      setElapsed(`${m}:${s}`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt, isRunning]);
  return elapsed;
}

// -----------------------------------------------------------------------------
// Sub-components for Granola-style notes
// -----------------------------------------------------------------------------

function CitationPill({ n, onClick }: { n: string | number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 16,
        height: 16,
        padding: "0 5px",
        borderRadius: 999,
        background: "oklch(from var(--bloom-1) l c h / 0.15)",
        border: "1px solid var(--bloom-wash-2)",
        color: "var(--bloom-2)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 700,
        marginLeft: 4,
        verticalAlign: 1,
        cursor: "pointer",
        transition: "all 0.1s var(--e-out)",
      }}
      title={`Jump to turn ${n}`}
    >
      {n}
    </button>
  );
}

function MetaChip({
  icon,
  label,
  bloom,
}: {
  icon: React.ReactNode;
  label: string;
  bloom?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px 4px 8px",
        borderRadius: 999,
        background: bloom
          ? "oklch(from var(--bloom-1) l c h / 0.08)"
          : "oklch(from var(--paper-2) l c h / 0.7)",
        border: `1px solid ${bloom ? "var(--bloom-wash-2)" : "oklch(from var(--paper-4) l c h / 0.4)"}`,
        fontSize: 12,
        color: bloom ? "var(--bloom-2)" : "var(--ink-1)",
        fontWeight: 500,
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}

function CalendarSm() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function PeopleSm() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3 20c1-3 3.5-5 6-5s5 2 6 5M14 20c1-2.5 2-3.5 3-4" />
    </svg>
  );
}

function FolderSm() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
    </svg>
  );
}

function NoteH2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontFamily: "var(--font-serif)",
        fontSize: 20,
        fontWeight: 500,
        letterSpacing: "-0.015em",
        color: "var(--ink-0)",
        marginTop: 28,
        marginBottom: 10,
      }}
    >
      {children}
    </h2>
  );
}

function NoteBullet({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        paddingLeft: 18,
        marginBottom: 8,
        fontSize: 14,
        color: "var(--ink-1)",
        lineHeight: 1.6,
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 4,
          top: 8,
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: "var(--bloom-2)",
        }}
      />
      {children}
    </div>
  );
}

function ActionItemRow({
  owner,
  color,
  children,
  checked = false,
  onToggle,
}: {
  owner: string;
  color: string;
  children: React.ReactNode;
  checked?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "8px 0",
        fontSize: 14,
        color: checked ? "var(--ink-3)" : "var(--ink-1)",
        lineHeight: 1.55,
        textDecoration: checked ? "line-through" : "none",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Mark action item ${checked ? "uncompleted" : "completed"}`}
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          border: `1.5px solid ${checked ? "var(--bloom-2)" : "var(--ink-3)"}`,
          background: checked ? "var(--bloom-2)" : "transparent",
          color: "white",
          display: "grid",
          placeItems: "center",
          marginTop: 3,
          flexShrink: 0,
          cursor: "pointer",
          padding: 0,
          fontSize: 10,
        }}
      >
        {checked && "✓"}
      </button>
      <div style={{ flex: 1 }}>
        {children}{" "}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            marginLeft: 6,
            padding: "1px 8px 1px 3px",
            background: `oklch(from ${color} l c h / 0.14)`,
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 500,
            color: color,
            verticalAlign: 1,
          }}
        >
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              background: color,
              color: "white",
              fontFamily: "var(--font-mono)",
              fontSize: 8,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
            }}
          >
            {owner[0]}
          </span>
          {owner}
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export function MeetingView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, send, boardId, projectName, workspace, onCitation, startSharing } =
    useWorkspace();
  const { notify } = useToast();
  const [settings, setSettings] = useSettings();

  // Surface mode: notes (Screen 08) | room (Calling mode) | board (Screen 13)
  const [surface, setSurface] = useState<"notes" | "room" | "board">("notes");

  // Transcript drawer tab: transcript | chat | saved
  const [activeTab, setActiveTab] = useState<"transcript" | "chat" | "saved">("transcript");
  const [transcriptSearch, setTranscriptSearch] = useState("");

  // Recording & speech state
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [turns, setTurns] = useState<MeetingTurn[]>([]);
  const turnsRef = useRef<MeetingTurn[]>([]);
  const appendTurn = (t: MeetingTurn): void => {
    turnsRef.current = [...turnsRef.current, t];
    setTurns(turnsRef.current);
  };

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<MeetingTranscript[]>([]);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingTranscript | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);

  // Live extraction state
  const [extractQueued, setExtractQueued] = useState(0);
  const engineRef = useRef(createMeetingEngine());
  const [lastExtractStatus, setLastExtractStatus] = useState<string | null>(null);

  // Voice answers & TTS speech
  const [voiceAnswers, setVoiceAnswers] = useState<VoiceAnswer[]>([]);
  const answerInFlight = useRef(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const playbackRef = useRef<{ stop(): void } | null>(null);
  const voiceMutedRef = useRef(false);
  voiceMutedRef.current = voiceMuted;

  // Ask Anything input state
  const [askQuery, setAskQuery] = useState("");
  const [askBusy, setAskBusy] = useState(false);

  // Action item completion toggles
  const [completedActions, setCompletedActions] = useState<Record<string, boolean>>({});

  // Server transcript checkpointing
  const [liveMeetingId, setLiveMeetingId] = useState<string | null>(null);
  const liveMeetingTurnCountRef = useRef(0);
  const setLiveMeetingTurnCount = (n: number): void => {
    liveMeetingTurnCountRef.current = n;
  };
  const persistedCountRef = useRef(0);
  const appendInFlightRef = useRef<Promise<MeetingTranscript | null> | null>(null);

  const checkpointTurns = async (): Promise<void> => {
    const board = boardId;
    const meetingId = liveMeetingId;
    if (!board || !meetingId) return;
    const previous = appendInFlightRef.current;
    if (previous) await previous.catch(() => {});
    if (persistedCountRef.current >= turnsRef.current.length) return;
    const batch = turnsRef.current.slice(persistedCountRef.current);
    const from = persistedCountRef.current;
    appendInFlightRef.current = appendMeetingTurns(board, meetingId, batch)
      .then((stored) => {
        if (stored) {
          persistedCountRef.current = Math.max(from + batch.length, stored.turns.length);
          liveMeetingTurnCountRef.current = stored.turns.length;
        }
        return stored;
      })
      .finally(() => {
        appendInFlightRef.current = null;
      });
    await appendInFlightRef.current;
  };

  const liveMeetingIdRef = useRef<string | null>(null);
  const [topicBreaks, setTopicBreaks] = useState<number[]>([]);

  // Conversational Lease Platform
  const { activeLease, setActiveLease, peers, leave } = useMeetingSession();
  const leaseManagerRef = useRef<ConversationalLeaseManager>(
    new ConversationalLeaseManager({ leaseDurationMs: 15_000, maxFollowUpTurns: 3 }),
  );
  const [leaseRemainingSec, setLeaseRemainingSec] = useState(0);

  // Sync peer names to lease manager
  useEffect(() => {
    const names = [...peers.values()].map((p) => p.name).filter(Boolean);
    leaseManagerRef.current.setTeammates(names);
  }, [peers]);

  // Sync leaseManager changes
  useEffect(() => {
    const manager = leaseManagerRef.current;
    return manager.subscribe(() => {
      const l = manager.getLease();
      setActiveLease(l);
      if (l) {
        setLeaseRemainingSec(Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 1000)));
      } else {
        setLeaseRemainingSec(0);
      }
    });
  }, [setActiveLease]);

  // 1-second countdown ticker
  useEffect(() => {
    if (!activeLease) return;
    const interval = setInterval(() => {
      const diff = Math.max(0, Math.ceil((activeLease.expiresAt - Date.now()) / 1000));
      setLeaseRemainingSec(diff);
      if (diff <= 0) {
        leaseManagerRef.current.dismissLease();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [activeLease]);

  // Global Esc key listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        leaseManagerRef.current.dismissLease();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Meeting behavior profile
  const selectedMode: MeetingMode = isMeetingMode(settings.meetingMode)
    ? settings.meetingMode
    : "intelligence";
  const extracts = modeAllowsExtraction(selectedMode);
  const voiceSupported = isAnyVoiceSupported();
  const livekitConfigured = settings.livekitTokenUrl.trim().length > 0;
  const elapsedTimer = useElapsedTime(startedAt, recording);

  // Prior meetings for this board
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void (async () => {
      const rows = await listMeetings(boardId);
      if (!cancelled) {
        setSaved(rows ?? []);
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

  // Turn jump & flash
  const [turnFlash, setTurnFlash] = useState<number | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const turn = params.get("turn");
    if (turn === null) return;
    params.delete("turn");
    window.history.replaceState(null, "", `?${params.toString()}`);
    const idx = Number(turn);
    if (Number.isInteger(idx) && idx >= 0) setTurnFlash(idx);
  }, []);

  useEffect(() => {
    if (turnFlash === null) return;
    const el = document.querySelector(`[data-turn="${turnFlash}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setTurnFlash(null), 1600);
    return () => clearTimeout(t);
  }, [turnFlash, selectedMeeting]);

  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // Cleanup on unmount
  useEffect(
    () => () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
      playbackRef.current?.stop();
      playbackRef.current = null;
      leaveRef.current?.();
    },
    [],
  );

  // Execute voice query
  const executeVoiceQuery = async (speaker: string, question: string): Promise<void> => {
    let targetBoardId = boardId;
    if (!targetBoardId) {
      targetBoardId = await startSharing();
    }
    if (!targetBoardId) {
      notify("Voice answers require a saved board — please sign in or share the board.");
      return;
    }
    if (answerInFlight.current) {
      notify("Lucent is answering — one spoken question at a time.");
      return;
    }
    answerInFlight.current = true;
    setAskBusy(true);
    leaseManagerRef.current.onAiStartResponding();
    try {
      const q = question.trim();
      const result = await askLucent(targetBoardId, q);
      const card = voiceAnswerCard(q, result);
      setVoiceAnswers((prev) => [...prev, card]);

      if (!voiceMutedRef.current && !card.error && card.answer !== "") {
        playbackRef.current?.stop();
        const spoken = await speakAnswer(card.answer);
        playbackRef.current = spoken.playback;
        if (spoken.reason) notify(`Voice: ${spoken.reason}`);

        if (spoken.playback) {
          void spoken.playback.done
            .then(() => leaseManagerRef.current.onTtsDone(card.answer))
            .catch(() => leaseManagerRef.current.onTtsDone(card.answer));
        } else {
          leaseManagerRef.current.onTtsDone(card.answer);
        }
      } else {
        leaseManagerRef.current.onTtsDone(card.answer);
      }
    } finally {
      answerInFlight.current = false;
      setAskBusy(false);
    }
  };

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

    const voiceCallbacks: VoiceHandlers = {
      onStart: () => setRecording(true),
      onInterim: () => {},
      onFinal: (text, meta) => {
        const t = text.trim();
        if (!t || isTtsSpeaking()) return;
        engineRef.current.noteFinal(Date.now());
        const speaker =
          meta?.speaker ??
          (provider.id === "livekit" || provider.id === "hosted" ? "Speaker" : "You");

        appendTurn({
          speaker,
          at: Date.now(),
          text: t,
          kind: classifyTurn(t),
        });

        if (extracts) setExtractQueued((q) => q + 1);
        void checkpointTurns();

        // Conversational lease in Assistant / Participant modes
        if (selectedMode === "assistant" || selectedMode === "participant") {
          if (playbackRef.current) {
            const barge = leaseManagerRef.current.onBargeIn(speaker, t);
            if (barge.interrupted) {
              playbackRef.current.stop();
              playbackRef.current = null;
              if (barge.newQuery) {
                void executeVoiceQuery(speaker, barge.newQuery);
                return;
              }
            }
          }

          const evaluation = leaseManagerRef.current.evaluateTurn({ speaker, text: t });
          if (
            evaluation.action === "direct_mutation" ||
            evaluation.action === "followup_mutation"
          ) {
            notify("Applying voice instruction to canvas…");
            void send(evaluation.instruction);
          } else if (
            evaluation.action === "direct_invoke" ||
            evaluation.action === "followup_query"
          ) {
            void executeVoiceQuery(evaluation.speakerId, evaluation.query);
          } else if (evaluation.action === "dismiss") {
            playbackRef.current?.stop();
            playbackRef.current = null;
          }
        }
      },
      onStatus: (s) => {
        if (s === "transcribing") notify("Transcribing on device…");
        if (s === "connecting") notify("Connecting…");
      },
      onError: (msg) => {
        setRecording(false);
        if (msg) notify(msg);
      },
    };

    const session = provider.startWithEvents
      ? provider.startWithEvents({
          onEvent: (event) => {
            if (event.type === "speech_started") {
              playbackRef.current?.stop();
              playbackRef.current = null;
              return;
            }
            if (event.type !== "final") return;
            const speaker = event.speakerId ?? event.participantId;
            voiceCallbacks.onFinal(event.text, speaker === undefined ? undefined : { speaker });
          },
          onStart: voiceCallbacks.onStart,
          onError: voiceCallbacks.onError,
          onStatus: voiceCallbacks.onStatus,
        })
      : provider.start(voiceCallbacks);

    if (session) {
      voiceRef.current = session;
      setStartedAt(Date.now());
      turnsRef.current = [];
      setTurns([]);
      setVoiceAnswers([]);
      persistedCountRef.current = 0;
      setExtractQueued(0);
      setLastExtractStatus(null);
      engineRef.current.reset();
      setRecording(true);

      if (boardId) {
        void (async () => {
          const stored = await saveMeeting(boardId, {
            turns: [],
            startedAt: Date.now(),
            mode: selectedMode,
          });
          if (stored) {
            liveMeetingIdRef.current = stored.id;
            setLiveMeetingId(stored.id);
          }
        })();
      }
    }
  };

  const stopRecording = (): void => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    playbackRef.current?.stop();
    playbackRef.current = null;
    setRecording(false);

    const ending = liveMeetingIdRef.current;
    const captured = turnsRef.current;
    const unflushed = captured.length - persistedCountRef.current;
    if (ending && boardId) {
      void (async () => {
        await checkpointTurns().catch(() => {});
        const ended = await endMeeting(boardId, ending);
        if (ended) {
          setSaved((prev) => prev.map((m) => (m.id === ended.id ? ended : m)));
        }
        persistedCountRef.current = 0;
        liveMeetingIdRef.current = null;
      })();
    } else if (captured.length > 0 && boardId) {
      void (async () => {
        const stored = await saveMeeting(boardId, {
          turns: captured,
          startedAt: startedAt ?? Date.now(),
          endedAt: Date.now(),
          mode: selectedMode,
        });
        if (stored) {
          setSaved((prev) => [stored, ...prev]);
          notify("Meeting saved.");
        } else {
          notify("Couldn't save the meeting — use Save meeting to retry.");
        }
      })();
    }
    if (unflushed > 0) {
      notify(`Flushing ${unflushed} captured turn${unflushed === 1 ? "" : "s"} to the transcript…`);
    }
    setLiveMeetingId(null);
    setLiveMeetingTurnCount(0);
  };

  // Differential live extraction loop
  const { batch: pendingTurns, batchStart } = sliceBatch(turns, extractQueued);
  const runExtraction = async (): Promise<void> => {
    if (!extracts) return;
    if (pendingTurns.length === 0 || engineRef.current.state.inFlight) return;
    engineRef.current.markFired();
    const batch = pendingTurns;
    const prompt = differentialPrompt(batch);
    setExtractQueued((q) => Math.max(0, q - batch.length));
    try {
      const result = await send(prompt, undefined, {
        provenance: {
          meetingId: liveMeetingIdRef.current ?? "live-session",
          turns: batch.map((t) => t.text),
          turnRange: [batchStart, batchStart + batch.length - 1],
          turnKinds: batch
            .map((t) => t.kind)
            .filter((k): k is NonNullable<MeetingTurn["kind"]> => Boolean(k)),
        },
      });
      const n = batch.length;
      setExtractQueued((q) => applyExtractOutcome(q, n, result.outcome));
      setLastExtractStatus(
        extractStatusMessage(result.outcome, n, {
          ...(result.outcome === "proposed" ? { ops: result.ops } : {}),
          ...(result.outcome === "failed" ? { error: result.error } : {}),
        }),
      );
    } catch (err) {
      setExtractQueued((q) => q + batch.length);
      setLastExtractStatus(`Extraction failed: ${(err as Error).message} — will retry`);
    } finally {
      engineRef.current.markDone();
    }
  };

  useEffect(() => {
    if (!recording) return;
    if (engineRef.current.shouldFire(pendingTurns.length)) {
      void runExtraction();
    }
  }, [turns, recording]);

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      if (engineRef.current.shouldFire(pendingTurns.length)) {
        void runExtraction();
      }
    }, 3_000);
    return () => clearInterval(tick);
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
      mode: selectedMode,
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
    const prompt = promptFromTranscript({
      ...meeting,
      turns: withTopicBreaks(meeting.turns, topicBreaks),
    });
    setView("canvas");
    void send(prompt);
  };

  const shown = selectedMeeting;
  const displayTurns = shown ? shown.turns : turns;

  const openQuestions = useMemo(
    () =>
      selectedMode === "participant" && !shown
        ? openBoardQuestions(workspace)
        : { items: [], total: 0 },
    [selectedMode, shown, workspace],
  );

  const shownId = shown?.id ?? null;
  useEffect(() => {
    setTopicBreaks([]);
  }, [shownId]);

  const reverseByTurn = useMemo(
    () => (shown ? objectsByTurn(workspace, shown.id, shown.turns.length) : null),
    [workspace, shown],
  );

  const liveKeys = useMemo(() => {
    const keys = new Set<string>(["live-session"]);
    if (liveMeetingId && !isLiveProvenance(liveMeetingId)) keys.add(liveMeetingId);
    return keys;
  }, [liveMeetingId]);

  const liveByTurn = useMemo(() => {
    if (shown) return null;
    const byTurn = new Map<number, string[]>();
    for (const node of Object.values(workspace.nodes)) {
      const records = [node.provenance, node.statement?.provenance];
      for (const record of records) {
        if (!record) continue;
        let matched = false;
        for (const key of liveKeys) {
          if (pointsAtLive(record, key)) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;
        if (!record.turnRange) continue;
        for (
          let i = Math.max(0, record.turnRange[0]);
          i <= record.turnRange[1] && i < turns.length;
          i++
        ) {
          const bucket = byTurn.get(i) ?? [];
          if (!bucket.includes(node.id)) bucket.push(node.id);
          byTurn.set(i, bucket);
        }
      }
    }
    return byTurn;
  }, [workspace, shown, liveKeys, turns.length]);

  const markTopicBreak = (): void => {
    const at = displayTurns.length;
    if (topicBreaks.includes(at)) {
      notify("A topic break is already marked here.");
      return;
    }
    setTopicBreaks([...topicBreaks, at].sort((a, b) => a - b));
    notify("Topic break marked.");
  };

  const onReextractFrom = (startIndex: number): void => {
    if (startIndex < 0 || startIndex >= displayTurns.length) return;
    const slice = withTopicBreaks(
      displayTurns.slice(startIndex),
      topicBreaks.filter((b) => b >= startIndex).map((b) => b - startIndex),
    );
    if (slice.length === 0) return;
    const meetingId = shown ? shown.id : (liveMeetingId ?? "live-session");
    const prompt = differentialPrompt(slice);
    if (shown) setView("canvas");
    void send(prompt, undefined, {
      provenance: {
        meetingId,
        turns: slice.map((t) => t.text),
        turnRange: [startIndex, displayTurns.length - 1],
        turnKinds: slice
          .map((t) => t.kind)
          .filter((k): k is NonNullable<MeetingTurn["kind"]> => Boolean(k)),
      },
    });
    notify(shown ? "Re-extracting from that turn on the canvas." : "Re-extracting from that turn.");
  };

  const onUnlink = (id: string): void => {
    notify("Provenance is read-only — opened the node on the canvas to review.");
    onCitation({ kind: "node", id });
  };

  // Structured notes derived lists
  const decisionTurns = displayTurns.filter((t) => t.kind === "decision");
  const actionTurns = displayTurns.filter((t) => t.kind === "action");

  const filteredTurns = useMemo(() => {
    if (!transcriptSearch.trim()) return displayTurns;
    const q = transcriptSearch.toLowerCase();
    return displayTurns.filter((t) => t.text.toLowerCase().includes(q) || t.speaker.toLowerCase().includes(q));
  }, [displayTurns, transcriptSearch]);

  const handleAskSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!askQuery.trim() || askBusy) return;
    const q = askQuery.trim();
    setAskQuery("");
    setActiveTab("chat");
    void executeVoiceQuery("You", q);
  };

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--paper-1)" }}>
      <div className="paper-bg" />
      <div className="paper-grain" />

      {/* Global Navigation Rail */}
      <GlobalRail active="meeting" onOpenSettings={onOpenSettings} />

      {/* Screen 08 Minimal Top Bar */}
      <header
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 20px 0 76px",
          zIndex: 30,
          background: "oklch(from var(--paper-1) l c h / 0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        }}
      >
        <button
          type="button"
          className="brand"
          onClick={() => setView("home")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-serif)",
            fontSize: 14,
            fontWeight: 500,
            whiteSpace: "nowrap",
            background: "none",
            border: 0,
            cursor: "pointer",
          }}
        >
          <div className="brand-mark" style={{ width: 20, height: 20 }} />
          Lucent
        </button>

        <span style={{ color: "var(--ink-3)" }}>·</span>
        <button
          type="button"
          className="crumb"
          onClick={() => setView("workspace")}
          style={{ whiteSpace: "nowrap", background: "none", border: 0, cursor: "pointer", fontSize: 13, color: "var(--ink-2)" }}
        >
          {projectName || "Personal"}
        </button>
        <span className="crumb-sep" style={{ color: "var(--ink-3)", fontSize: 12 }}>/</span>
        <span
          className="crumb current"
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 220,
            fontSize: 13,
            fontWeight: 500,
            color: "var(--ink-0)",
          }}
        >
          {shown ? `Meeting · ${new Date(shown.startedAt).toLocaleDateString()}` : "Live Meeting"}
        </span>

        {/* Surface Switcher: Notes | Video Call */}
        <div
          style={{
            display: "inline-flex",
            padding: 3,
            background: "oklch(from var(--paper-2) l c h / 0.8)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            borderRadius: 999,
            marginLeft: 12,
            gap: 2,
          }}
          role="tablist"
          aria-label="Meeting View Mode"
        >
          <button
            type="button"
            onClick={() => setSurface("notes")}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: surface === "notes" ? 600 : 450,
              color: surface === "notes" ? "var(--ink-0)" : "var(--ink-2)",
              background: surface === "notes" ? "var(--paper-0)" : "transparent",
              border: 0,
              cursor: "pointer",
              boxShadow: surface === "notes" ? "var(--shadow-1)" : "none",
            }}
          >
            Notes
          </button>
          <button
            type="button"
            onClick={() => setSurface("room")}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: surface === "room" ? 600 : 450,
              color: surface === "room" ? "var(--ink-0)" : "var(--ink-2)",
              background: surface === "room" ? "var(--paper-0)" : "transparent",
              border: 0,
              cursor: "pointer",
              boxShadow: surface === "room" ? "var(--shadow-1)" : "none",
            }}
          >
            Video Call
          </button>
          <button
            type="button"
            onClick={() => setView("canvas")}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 450,
              color: "var(--ink-2)",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            title="Open interactive canvas board"
          >
            Board <Ico.Arrow style={{ transform: "rotate(-45deg)", width: 10, height: 10 }} />
          </button>
        </div>

        <div style={{ flex: 1 }} />

        {/* Meeting Profile Mode Selector */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "2px 6px",
            background: "oklch(from var(--paper-2) l c h / 0.7)",
            borderRadius: 8,
            border: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
            gap: 4,
          }}
          title={MODE_NOTES[selectedMode]}
        >
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Mode
          </span>
          {MEETING_MODES.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSettings({ meetingMode: m })}
              style={{
                padding: "2px 8px",
                borderRadius: 5,
                fontSize: 11,
                border: 0,
                background: selectedMode === m ? "var(--paper-0)" : "transparent",
                color: selectedMode === m ? "var(--bloom-2)" : "var(--ink-2)",
                fontWeight: selectedMode === m ? 600 : 400,
                boxShadow: selectedMode === m ? "var(--shadow-1)" : "none",
                cursor: "pointer",
              }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {/* REC / LIVE status pill */}
        {recording ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px 5px 8px",
              background: "oklch(from var(--madder, #e11d48) l c h / 0.1)",
              border: "1px solid oklch(from var(--madder, #e11d48) l c h / 0.3)",
              borderRadius: 999,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--madder, #e11d48)",
              letterSpacing: "0.03em",
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "var(--madder, #e11d48)",
                animation: "pulse-bloom 1.4s ease-in-out infinite",
              }}
            />
            REC · {elapsedTimer}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              background: "oklch(from var(--paper-2) l c h / 0.6)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
              borderRadius: 999,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--ink-2)",
            }}
          >
            READY
          </div>
        )}

        {/* Attendee Avatar Stack */}
        <div style={{ display: "flex", marginLeft: 4 }}>
          {["A", "S", "J"].map((x, i) => (
            <div
              key={i}
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                background: ["oklch(0.55 0.16 25)", "oklch(0.55 0.11 220)", "oklch(0.55 0.14 148)"][i],
                border: "2px solid var(--paper-0)",
                marginLeft: i === 0 ? 0 : -8,
                display: "grid",
                placeItems: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 700,
                color: "white",
                zIndex: 3 - i,
              }}
            >
              {x}
            </div>
          ))}
        </div>

        {/* Action Controls */}
        <button
          type="button"
          className="icon-btn"
          onClick={() => void startSharing()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: 8,
            fontSize: 12,
            border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
            background: "var(--paper-0)",
            cursor: "pointer",
          }}
          title="Share meeting"
        >
          <Ico.Share /> Share
        </button>

        {!recording ? (
          <button
            type="button"
            className="icon-btn primary"
            onClick={startRecording}
            disabled={!voiceSupported}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 8,
              fontSize: 12,
              background: "var(--bloom-2)",
              color: "white",
              border: 0,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            <Ico.Mic /> {turns.length > 0 || shown ? "New capture" : "Record"}
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn"
            onClick={stopRecording}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 8,
              fontSize: 12,
              background: "oklch(from var(--madder, #e11d48) l c h / 0.12)",
              color: "var(--madder, #e11d48)",
              border: "1px solid oklch(from var(--madder, #e11d48) l c h / 0.3)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            <Ico.X /> End
          </button>
        )}
      </header>

      {/* =====================================================================
          MAIN VIEW BODY: Switches on surface state
         ===================================================================== */}
      <div
        style={{
          position: "absolute",
          top: 52,
          bottom: 0,
          left: 84,
          right: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* SURFACE 1: Screen 08 Granola-style Structured Notes */}
        {surface === "notes" && (
          <>
            {/* Notes Column (Left) */}
            <div style={{ flex: 1, overflowY: "auto", position: "relative" }}>
              <div style={{ maxWidth: 740, margin: "0 auto", padding: "44px 56px 140px" }}>
                {/* Conversational Lease Live Indicator Banner */}
                {activeLease && leaseRemainingSec > 0 && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 14px",
                      margin: "0 0 20px",
                      borderRadius: 10,
                      background: "oklch(from var(--bloom-1) l c h / 0.12)",
                      border: "1px solid var(--bloom-wash-2)",
                      color: "var(--bloom-2)",
                      fontSize: 12.5,
                      fontWeight: 500,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--bloom-2)",
                          boxShadow: "0 0 8px var(--bloom-glow)",
                        }}
                      />
                      <span>
                        {activeLease.state === "waiting_for_user_response"
                          ? `Awaiting clarification from ${activeLease.speakerName || activeLease.speakerId}`
                          : `Conversational lease active with ${activeLease.speakerName || activeLease.speakerId}`}{" "}
                        ({leaseRemainingSec}s)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => leaseManagerRef.current.dismissLease()}
                      title="Dismiss conversational lease (Esc)"
                      style={{
                        background: "oklch(from var(--paper-0) l c h / 0.8)",
                        border: "1px solid var(--bloom-wash-2)",
                        borderRadius: 4,
                        color: "var(--ink-1)",
                        cursor: "pointer",
                        fontSize: 11,
                        padding: "2px 8px",
                      }}
                    >
                      Esc
                    </button>
                  </div>
                )}

                {/* Meta chips */}
                <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
                  <MetaChip icon={<CalendarSm />} label={`Today · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`} />
                  <MetaChip icon={<PeopleSm />} label={`${peers.size + 1} people`} />
                  <MetaChip icon={<FolderSm />} label={projectName || "Product / Q4"} />
                  <MetaChip icon={<Ico.Sparkle />} label="Auto template · Product review" bloom />
                </div>

                {/* Title & Italic Subtitle */}
                <h1
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 38,
                    fontWeight: 400,
                    letterSpacing: "-0.025em",
                    color: "var(--ink-0)",
                    lineHeight: 1.15,
                    marginBottom: 8,
                  }}
                >
                  {shown ? "Archived Meeting Notes" : "Checkout design review"}
                </h1>
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontStyle: "italic",
                    fontSize: 16,
                    color: "var(--ink-2)",
                    lineHeight: 1.5,
                    marginBottom: 32,
                  }}
                >
                  Team walkthrough of the checkout redesign — cart review, payments, guest flow.
                </div>

                {/* Note Content Blocks */}
                <div>
                  <NoteH2>Summary</NoteH2>
                  <p style={{ color: "var(--ink-1)", fontSize: 14.5, lineHeight: 1.65, marginBottom: 4 }}>
                    The team aligned on a four-step checkout — <b>Cart → Address → Payment → Confirmation</b> — with guest checkout as the default path
                    <CitationPill n="3" onClick={() => setTurnFlash(2)} />. Payment must support Apple Pay and Klarna in addition to cards
                    <CitationPill n="2" onClick={() => setTurnFlash(1)} />, and errors should be retried silently before surfacing
                    <CitationPill n="5" onClick={() => setTurnFlash(4)} />.
                  </p>

                  <NoteH2>Decisions</NoteH2>
                  {decisionTurns.length > 0 ? (
                    decisionTurns.map((dt, i) => (
                      <NoteBullet key={i}>
                        <span style={{ fontWeight: 600 }}>{dt.text}</span>
                        <CitationPill n={i + 1} onClick={() => setTurnFlash(displayTurns.indexOf(dt))} />
                      </NoteBullet>
                    ))
                  ) : (
                    <>
                      <NoteBullet>
                        <span style={{ fontWeight: 600 }}>4-step checkout flow.</span> Cart review first — people forget what&apos;s in their cart{" "}
                        <CitationPill n="1" onClick={() => setTurnFlash(0)} />
                      </NoteBullet>
                      <NoteBullet>
                        <span style={{ fontWeight: 600 }}>Guest checkout is the default.</span> No forced signup, biggest funnel drop{" "}
                        <CitationPill n="3" onClick={() => setTurnFlash(2)} />
                      </NoteBullet>
                      <NoteBullet>
                        <span style={{ fontWeight: 600 }}>Payment methods.</span> Cards, Apple Pay, Klarna — Klarna alone lifted conversion +8% at Northbeam{" "}
                        <CitationPill n="2" onClick={() => setTurnFlash(1)} />
                      </NoteBullet>
                      <NoteBullet>
                        <span style={{ fontWeight: 600 }}>Silent retry policy.</span> Two retries on Stripe intermittency before surfacing an error{" "}
                        <CitationPill n="5" onClick={() => setTurnFlash(4)} />
                      </NoteBullet>
                    </>
                  )}

                  <NoteH2>Action items</NoteH2>
                  {actionTurns.length > 0 ? (
                    actionTurns.map((at, i) => (
                      <ActionItemRow
                        key={i}
                        owner={at.speaker}
                        color={getSpeakerColor(at.speaker)}
                        checked={completedActions[`act_${i}`]}
                        onToggle={() =>
                          setCompletedActions((prev) => ({ ...prev, [`act_${i}`]: !prev[`act_${i}`] }))
                        }
                      >
                        {at.text}
                      </ActionItemRow>
                    ))
                  ) : (
                    <>
                      <ActionItemRow
                        owner="Alex"
                        color="oklch(0.55 0.16 25)"
                        checked={completedActions["demo_1"]}
                        onToggle={() =>
                          setCompletedActions((p) => ({ ...p, demo_1: !p.demo_1 }))
                        }
                      >
                        Draft the wireframes for cart review + address (screens 1–2) by <b>Fri</b>
                      </ActionItemRow>
                      <ActionItemRow
                        owner="John"
                        color="oklch(0.55 0.14 148)"
                        checked={completedActions["demo_2"]}
                        onToggle={() =>
                          setCompletedActions((p) => ({ ...p, demo_2: !p.demo_2 }))
                        }
                      >
                        Integrate Klarna sandbox and confirm 3DS callback in staging by <b>Mon</b>
                      </ActionItemRow>
                      <ActionItemRow
                        owner="Sarah"
                        color="oklch(0.55 0.11 220)"
                        checked={completedActions["demo_3"]}
                        onToggle={() =>
                          setCompletedActions((p) => ({ ...p, demo_3: !p.demo_3 }))
                        }
                      >
                        Add gift wrapping micro-flow spec to the cart review PRD{" "}
                        <CitationPill n="4" onClick={() => setTurnFlash(3)} />
                      </ActionItemRow>
                    </>
                  )}

                  <NoteH2>Open questions</NoteH2>
                  {openQuestions.total > 0 ? (
                    openQuestions.items.map((q, i) => (
                      <NoteBullet key={i}>{q.label}</NoteBullet>
                    ))
                  ) : (
                    <>
                      <NoteBullet>
                        Should the confirmation email include tracking immediately, or wait for fulfillment?{" "}
                        <CitationPill n="6" onClick={() => setTurnFlash(5)} />
                      </NoteBullet>
                      <NoteBullet>What&apos;s the deadline for the Klarna rollout — before Black Friday?</NoteBullet>
                    </>
                  )}

                  <NoteH2>Related canvas</NoteH2>
                  <div
                    onClick={() => setView("canvas")}
                    style={{
                      marginTop: 10,
                      padding: 14,
                      borderRadius: 12,
                      background: "oklch(from var(--paper-0) l c h / 0.7)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      cursor: "pointer",
                      transition: "all 0.12s var(--e-out)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--ink-3)";
                      e.currentTarget.style.transform = "translateY(-1px)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.5)";
                      e.currentTarget.style.transform = "translateY(0)";
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: "var(--bloom-wash)",
                        border: "1px solid var(--bloom-wash-2)",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--bloom-2)",
                      }}
                    >
                      <Ico.Layers />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)" }}>
                        User journey · Checkout v3
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>
                        lucent · 4 steps · updated by AI · 12s ago
                      </div>
                    </div>
                    <Ico.Arrow style={{ color: "var(--ink-3)" }} />
                  </div>
                </div>
              </div>

              {/* Ask Anything bottom bar */}
              <form
                onSubmit={handleAskSubmit}
                style={{
                  position: "sticky",
                  bottom: 24,
                  maxWidth: 680,
                  margin: "0 auto",
                  padding: "0 20px",
                  zIndex: 10,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 14px",
                    borderRadius: 16,
                    background: "var(--paper-0)",
                    border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                    boxShadow: "var(--shadow-2)",
                  }}
                >
                  <Ico.Search style={{ color: "var(--ink-3)" }} />
                  <input
                    type="text"
                    value={askQuery}
                    onChange={(e) => setAskQuery(e.target.value)}
                    placeholder="Ask about this meeting — or ask Lucent to draft…"
                    style={{
                      flex: 1,
                      border: 0,
                      outline: 0,
                      background: "transparent",
                      fontSize: 13,
                      color: "var(--ink-0)",
                    }}
                  />
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--ink-3)",
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                    }}
                  >
                    <span>
                      SCOPE · <span style={{ color: "var(--ink-1)" }}>this note</span>
                    </span>
                    <span>·</span>
                    <span>
                      AUTO · <span style={{ color: "var(--ink-1)" }}>context aware</span>
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={!askQuery.trim() || askBusy}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: "var(--bloom-2)",
                      color: "white",
                      border: 0,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                      opacity: askQuery.trim() ? 1 : 0.4,
                    }}
                  >
                    {askBusy ? "…" : "Ask"}
                  </button>
                </div>
              </form>
            </div>

            {/* Transcript Drawer Column (Right) */}
            <div
              style={{
                width: 420,
                borderLeft: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                background: "oklch(from var(--paper-0) l c h / 0.6)",
                display: "flex",
                flexDirection: "column",
              }}
            >
              {/* Tabs */}
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  padding: "12px 12px 0",
                  borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
                }}
              >
                {[
                  { id: "transcript", label: "Transcript", count: displayTurns.length },
                  { id: "chat", label: "Chat", count: voiceAnswers.length },
                  { id: "saved", label: "Saved", count: saved.length },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id as "transcript" | "chat" | "saved")}
                    style={{
                      padding: "8px 12px 10px",
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: activeTab === t.id ? "var(--ink-0)" : "var(--ink-2)",
                      borderBottom: `2px solid ${activeTab === t.id ? "var(--ink-0)" : "transparent"}`,
                      marginBottom: -1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "transparent",
                      borderTop: 0,
                      borderLeft: 0,
                      borderRight: 0,
                      cursor: "pointer",
                    }}
                  >
                    {t.label}
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        padding: "1px 5px",
                        borderRadius: 4,
                        background: "oklch(from var(--paper-3) l c h / 0.7)",
                      }}
                    >
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tab 1: Transcript */}
              {activeTab === "transcript" && (
                <div style={{ flex: 1, overflowY: "auto", padding: "12px 10px 20px" }}>
                  {/* Search Bar */}
                  <div
                    style={{
                      margin: "4px 4px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 12px",
                      background: "oklch(from var(--paper-2) l c h / 0.7)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      borderRadius: 8,
                    }}
                  >
                    <Ico.Search style={{ color: "var(--ink-3)" }} />
                    <input
                      placeholder="Search transcript…"
                      value={transcriptSearch}
                      onChange={(e) => setTranscriptSearch(e.target.value)}
                      style={{
                        flex: 1,
                        fontSize: 12.5,
                        background: "transparent",
                        border: 0,
                        outline: 0,
                        color: "var(--ink-0)",
                      }}
                    />
                    <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      ⌘F
                    </span>
                  </div>

                  {/* Empty State */}
                  {displayTurns.length === 0 && (
                    <div style={{ padding: "28px 16px", textAlign: "center" }}>
                      <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                        Start recording to capture the meeting in real-time. Turns classify automatically and stream into this transcript.
                      </p>
                    </div>
                  )}

                  {/* Turns list */}
                  {filteredTurns.map((t, i) => {
                    const originalIdx = displayTurns.indexOf(t);
                    const produced = reverseByTurn?.get(originalIdx) ?? liveByTurn?.get(originalIdx);
                    const provisional = !shown && (liveByTurn?.has(originalIdx) ?? false);
                    const speakerColor = getSpeakerColor(t.speaker);
                    const initials = getSpeakerInitials(t.speaker);

                    return (
                      <Fragment key={i}>
                        {topicBreaks.includes(originalIdx) && (
                          <div
                            style={{
                              textAlign: "center",
                              margin: "8px 0",
                              fontSize: 10,
                              fontFamily: "var(--font-mono)",
                              color: "var(--ink-3)",
                              borderTop: "1px dashed oklch(from var(--paper-4) l c h / 0.6)",
                              paddingTop: 6,
                            }}
                          >
                            ── topic break ──
                          </div>
                        )}

                        <div
                          data-turn={originalIdx}
                          style={{
                            display: "flex",
                            gap: 10,
                            padding: "8px 10px",
                            borderRadius: 8,
                            background: originalIdx === turnFlash ? "oklch(from var(--bloom-1) l c h / 0.12)" : "transparent",
                            transition: "background 0.3s ease",
                            marginBottom: 4,
                          }}
                        >
                          <div
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: "50%",
                              background: speakerColor,
                              color: "white",
                              display: "grid",
                              placeItems: "center",
                              fontFamily: "var(--font-mono)",
                              fontSize: 9,
                              fontWeight: 700,
                              flexShrink: 0,
                              marginTop: 2,
                            }}
                          >
                            {initials}
                          </div>

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-0)" }}>
                                {t.speaker}
                              </span>
                              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                                {new Date(t.at).toLocaleTimeString(undefined, { minute: "2-digit", second: "2-digit" })}
                              </span>
                              {t.kind && (
                                <span
                                  className="mono"
                                  style={{
                                    fontSize: 9,
                                    textTransform: "uppercase",
                                    color: extractColor[t.kind],
                                    letterSpacing: "0.06em",
                                    marginLeft: "auto",
                                  }}
                                >
                                  {t.kind}
                                </span>
                              )}
                            </div>

                            <div style={{ fontSize: 13, color: "var(--ink-1)", lineHeight: 1.5 }}>
                              {t.text}
                            </div>

                            {/* Turn links and provenance */}
                            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
                              <button
                                type="button"
                                className="mono"
                                onClick={() => onReextractFrom(originalIdx)}
                                style={{
                                  fontSize: 9.5,
                                  color: "var(--ink-3)",
                                  background: "none",
                                  border: 0,
                                  padding: 0,
                                  cursor: "pointer",
                                  textTransform: "uppercase",
                                }}
                              >
                                Re-extract
                              </button>

                              {produced && produced.length > 0 && (
                                <span
                                  className="mono"
                                  style={{ fontSize: 9.5, color: "var(--bloom-2)", textTransform: "uppercase" }}
                                >
                                  ✦ {produced.length} on board{provisional ? " · provisional" : ""}
                                </span>
                              )}

                              {produced?.map((nid) => (
                                <button
                                  key={nid}
                                  type="button"
                                  className="mono"
                                  onClick={() => onCitation({ kind: "node", id: nid })}
                                  style={{
                                    fontSize: 9.5,
                                    color: "var(--bloom-2)",
                                    background: "none",
                                    border: 0,
                                    padding: 0,
                                    cursor: "pointer",
                                    textTransform: "uppercase",
                                    textDecoration: "underline",
                                  }}
                                >
                                  view
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}

                  {/* Live typing pulse indicator */}
                  {recording && (
                    <div style={{ display: "flex", gap: 8, padding: "10px 14px", alignItems: "center" }}>
                      <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        {lastExtractStatus ?? "Lucent listening…"}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Chat & Lucent Answers */}
              {activeTab === "chat" && (
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px" }}>
                  <div className="mono-caps" style={{ marginBottom: 8 }}>
                    Spoken & Asked Q&amp;A
                  </div>
                  {voiceAnswers.length === 0 && (
                    <p style={{ fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>
                      No questions asked yet. Use the Ask Anything bar below or speak out loud when in Assistant mode.
                    </p>
                  )}
                  {voiceAnswers.map((a) => (
                    <div
                      key={a.id}
                      style={{
                        padding: "12px 14px",
                        borderRadius: 12,
                        background: "oklch(from var(--bloom-1) l c h / 0.05)",
                        border: "1px solid var(--bloom-wash-2)",
                        marginBottom: 12,
                      }}
                    >
                      <div className="mono-caps" style={{ marginBottom: 6, color: "var(--bloom-2)" }}>
                        ✦ Lucent
                      </div>
                      <div style={{ fontSize: 13.5, color: "var(--ink-0)", lineHeight: 1.55 }}>
                        {a.error ? `Couldn't answer: ${a.error}` : a.answer}
                      </div>
                      {a.citations.length > 0 && (
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 6 }}>
                          Citations: {a.citations.join(" · ")}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Tab 3: Saved Meetings Archive */}
              {activeTab === "saved" && (
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 14px" }}>
                  <div className="mono-caps" style={{ marginBottom: 10 }}>
                    Saved meetings on this board ({saved.length})
                  </div>
                  {saved.length === 0 && (
                    <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
                      No saved meetings yet. Record and save a meeting to review archives here.
                    </p>
                  )}
                  {saved.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelectedMeeting(selectedMeeting?.id === m.id ? null : m)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "10px 12px",
                        borderRadius: 8,
                        background: selectedMeeting?.id === m.id ? "var(--paper-1)" : "var(--paper-0)",
                        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                        marginBottom: 8,
                        cursor: "pointer",
                        width: "100%",
                        textAlign: "left",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-0)" }}>
                          {new Date(m.startedAt).toLocaleString()}
                        </div>
                        <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                          {m.turns.length} turns · {m.mode ?? "intelligence"}
                        </div>
                      </div>
                      <span className="mono" style={{ fontSize: 11, color: "var(--bloom-2)" }}>
                        {selectedMeeting?.id === m.id ? "viewing" : "open →"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* SURFACE 2: Calling / Native Video Room Mode */}
        {surface === "room" && (
          <div style={{ flex: 1, display: "flex", height: "100%", padding: 16 }}>
            <NativeRoom
              boardId={boardId}
              isRecording={recording}
              onToggleRecording={() => {
                if (recording) stopRecording();
                else startRecording();
              }}
              turnsCount={displayTurns.length}
            />
          </div>
        )}
      </div>
    </div>
  );
}
