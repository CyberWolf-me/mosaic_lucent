import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Ico } from "../ui/icons.js";
import {
  Avatar,
  Button,
  EmptyState,
  FilterChips,
  KindBadge,
  Page,
  PageHeader,
  ProvenanceChip,
} from "../ui/kit.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { KIND_LABEL } from "../statementUi.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { useSettings } from "../settings.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import { askLucent, type AskCitation } from "../boards.js";
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
import { differentialPrompt, meetingExtractRequest } from "../meeting-extract.js";
import { createCaptureDurability, type CaptureDurability } from "../meetingCapture.js";
import { NativeRoom } from "../meeting-room/NativeRoom.js";
import {
  applyExtractOutcome,
  createMeetingEngine,
  extractStatusMessage,
  sliceBatch,
} from "../meeting-engine.js";
import { isLiveProvenance, objectsByTurn, pointsAtLive } from "../meetingTimeline.js";
import { MeetingNotes } from "./MeetingNotes.js";
import { ProposalPanel } from "./ProposalPanel.js";
import { VoiceStateHud, type VoiceHudSnapshot } from "../meeting-room/VoiceStateHud.js";
import {
  TOPIC_BREAK_LINE,
  citationTurns,
  formatElapsed,
  meetingBrief,
  speakersOf,
  type BriefItem,
  type BriefSection,
} from "../meetingBrief.js";

/**
 * Meeting mode (E3 / R3): live capture into a transcript that persists per
 * board, plus one-click extraction into the board's diagram.
 *
 * The view is a document and its source, side by side. The document column
 * is the meeting BRIEF — the decisions, actions, open questions and risks the
 * meeting put on the board, each one a click from the turns that produced it
 * (meetingBrief.ts decides; this file lays it out). The right column is the
 * transcript those citations land on.
 *
 * The real flow reuses the same STT seam the canvas drives — one provider,
 * one `start(handlers)`, finals arrive as text — with one difference: the
 * canvas sends every final to the model; this view accumulates them as
 * turns, drafts a classification per line, and checkpoints the transcript to
 * the board as it is captured.
 *
 * Diarisation is honest about what each provider gives: LiveKit segments
 * carry speaker identity; Web Speech and on-device Whisper have no speaker
 * concept, so every turn is "You" and the view says so rather than inventing
 * a false distinction. Meetings have no title in the data model, so the
 * title is the moment the meeting started — never an invented subject.
 *
 * Extraction routes through the normal `send()` pipeline: the same
 * validation, metering, history and undo as any other generation. There is
 * deliberately no separate meeting→diagram path — a diagram built from
 * minutes is a diagram like any other.
 */

/** The draft turn classification, tinted with the nearest statement kind. */
const TURN_TINT: Record<NonNullable<MeetingTurn["kind"]>, string> = {
  problem: "var(--kind-risk)",
  hypothesis: "var(--kind-question)",
  solution: "var(--kind-proposal)",
  decision: "var(--kind-decision)",
  action: "var(--kind-action)",
  requirement: "var(--kind-requirement)",
};

const KIND_ORDER: Array<NonNullable<MeetingTurn["kind"]>> = [
  "problem",
  "hypothesis",
  "solution",
  "decision",
  "action",
  "requirement",
];

type TurnFilter = "all" | NonNullable<MeetingTurn["kind"]>;

/** A spoken or typed answer; typed asks keep the resolved citations. */
type AnswerCard = VoiceAnswer & { links?: AskCitation[] };

/**
 * Splice topic-break markers into a turn slice for extraction prompts (UX-5).
 * Breaks are indices into the displayed transcript; each becomes a plain
 * separator line the model reads as a topic boundary. The transcript itself
 * is untouched — breaks are render-local state.
 */
function withTopicBreaks(list: MeetingTurn[], breaks: number[]): MeetingTurn[] {
  if (breaks.length === 0) return list;
  const marks = new Set(breaks);
  const out: MeetingTurn[] = [];
  for (let i = 0; i <= list.length; i++) {
    if (marks.has(i)) out.push({ speaker: "You", at: Date.now(), text: TOPIC_BREAK_LINE });
    if (i < list.length) out.push(list[i]!);
  }
  return out;
}

function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 1 ? "under a minute" : `${minutes} min`;
}

function fmtDue(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Case-insensitive match marking for transcript search. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(q, from);
  while (at !== -1) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={at} className="meet-mark">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** The brief's section heading, in the kind's own words. */
function sectionHeading(section: BriefSection): string {
  if (section.kind === "action") return "Action items";
  if (section.kind === "question") {
    return section.items.every((i) => i.status === "open") ? "Open questions" : "Questions";
  }
  return KIND_LABEL[section.kind].many;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * What a board viewer may do in a meeting (docs/28 §6 and F19), said once
 * wherever a control is withheld: speaking in the call is not editing the
 * board, so a viewer joins and takes notes; recording, saving and
 * extracting are board writes.
 */
const VIEWER_CAPTURE_REASON =
  "You can view this board: you can join the call, read the transcript and take private notes, but only editors record, save or extract meetings.";

export function MeetingView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const {
    view,
    setView,
    send,
    boardId,
    projectName,
    workspace,
    onCitation,
    startSharing,
    proposal,
    readOnly,
  } = useWorkspace();
  // docs/28 F16: the server keeps ONE pending proposal per board, and a new one
  // supersedes it. A batch sent while a proposal awaits review would silently
  // replace it — the last batch's candidates, or the user's own canvas
  // request. So the live loop holds: turns stay queued and go out together
  // once the proposal is decided, against the board as the decision left it.
  // A ref, because the trigger's timer is armed per capture.
  const proposalPendingRef = useRef(false);
  proposalPendingRef.current = proposal !== null;
  const { notify } = useToast();
  const [settings, setSettings] = useSettings();
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [turns, setTurns] = useState<MeetingTurn[]>([]);
  // Mirror of `turns` for the STT callbacks and the checkpoint helper: both
  // are armed once and must read the live list, not the list of the render
  // that created them.
  const turnsRef = useRef<MeetingTurn[]>([]);
  const appendTurn = (t: MeetingTurn): void => {
    turnsRef.current = [...turnsRef.current, t];
    setTurns(turnsRef.current);
  };
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<MeetingTranscript[]>([]);
  const [selectedMeeting, setSelectedMeeting] = useState<MeetingTranscript | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  // ---- Live extraction state (M2, engine-driven) --------------------------
  // Turn indices not yet sent to the model live in state (they render);
  // clock state lives in the meeting engine (meeting-engine.ts) — one
  // boundary for when a generation may fire, unit-tested without a DOM.
  const [extractQueued, setExtractQueued] = useState(0);
  const engineRef = useRef(createMeetingEngine());
  const [lastExtractStatus, setLastExtractStatus] = useState<string | null>(null);
  // M6.1: spoken answers (text) and typed asks. Session-local, never stored —
  // answers are reads, not minutes. One in flight at a time; a question
  // arriving while busy waits for the next trigger rather than overlapping.
  const [voiceAnswers, setVoiceAnswers] = useState<AnswerCard[]>([]);
  const answerInFlight = useRef(false);
  const [askDraft, setAskDraft] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  // M6.2: server/local speech for answers. Session-local mute; the playback
  // ref lets stopRecording (and the next answer) cancel audio in flight —
  // the turn-taking basis V8 builds on.
  const [voiceMuted, setVoiceMuted] = useState(false);
  const playbackRef = useRef<{ stop(): void } | null>(null);
  // Fresh-closure trap: answers fire long after startRecording built the
  // callback, so the mute flag is mirrored into a ref read at answer time.
  const voiceMutedRef = useRef(false);
  voiceMutedRef.current = voiceMuted;
  // The server-side transcript for the RUNNING meeting: opened with the first
  // captured turns, appended-to as each final lands, ended on stop.
  const [liveMeetingId, setLiveMeetingId] = useState<string | null>(null);
  // The live transcript id lives in state (renders) and in a ref (the capture
  // callbacks below read it without re-arming the STT provider).
  const liveMeetingIdRef = useRef<string | null>(null);
  // P1-MT-001 / docs/28 F13: capture durability independent of extraction.
  // One per capture, built at Start; it reads refs, never this render's state,
  // because the STT callbacks that feed it are armed once. The board is read
  // through a ref for the same reason.
  const captureRef = useRef<CaptureDurability | null>(null);
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  // A stopped capture whose flush or end failed (offline): Save meeting
  // resumes ITS transcript rather than writing the meeting a second time.
  const unsavedCaptureRef = useRef<{
    capture: CaptureDurability;
    turns: MeetingTurn[];
  } | null>(null);
  // Topic breaks (UX-5): separator indices into the displayed transcript.
  // Render-local — the saved transcript is never rewritten — and spliced
  // into extraction prompts as "── topic break ──" lines.
  const [topicBreaks, setTopicBreaks] = useState<number[]>([]);
  // The transcript column: open/closed, and which list it shows. The video
  // room's dock still names the old "extract" panel; that button now scrolls
  // the brief into view instead (see onRoomPanel).
  const [panelOpen, setPanelOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<"transcript" | "notes" | "saved">("transcript");
  // Debug voice-state HUD (docs/26 §7): opt-in via ?voicehud=1. `sttStatus` and
  // `lastSpeaker` feed it; `hudTick` refreshes the live reads (isTtsSpeaking,
  // lease FSM) a few times a second while it is shown.
  const voiceHud = useMemo(
    () =>
      typeof window !== "undefined" && new URLSearchParams(window.location.search).has("voicehud"),
    [],
  );
  const [sttStatus, setSttStatus] = useState("idle");
  const [lastSpeaker, setLastSpeaker] = useState<string | undefined>(undefined);
  const [, setHudTick] = useState(0);
  useEffect(() => {
    if (!voiceHud) return;
    const t = setInterval(() => setHudTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [voiceHud]);
  // Debug-only voice-loop driver (docs/26 §7 headed verification). Behind
  // ?voicehud=1 it exposes the REAL conversational-lease manager on window so a
  // headed Playwright run can step cases A–E (invocation, follow-up, barge-in,
  // expiry, cross-talk) and watch the HUD transition — no mic, no AI call, and
  // never present in the ordinary product surface.
  useEffect(() => {
    if (!voiceHud || typeof window === "undefined") return;
    const mgr = leaseManagerRef.current;
    const bump = () => setHudTick((n) => n + 1);
    const hook = {
      setRecording: (on: boolean) => setRecording(on),
      evaluate: (speaker: string, text: string, now?: number) => {
        setLastSpeaker(speaker);
        setTurns((t) => [...t, { speaker, at: now ?? Date.now(), text }]);
        const res = mgr.evaluateTurn({ speaker, text }, now);
        bump();
        return res;
      },
      bargeIn: (speaker: string, text: string, now?: number) => {
        const res = mgr.onBargeIn(speaker, text, now);
        bump();
        return res;
      },
      aiStart: () => {
        mgr.onAiStartResponding();
        bump();
      },
      aiDone: (answer: string, now?: number) => {
        mgr.onTtsDone(answer, now);
        bump();
      },
      dismiss: () => {
        mgr.dismissLease();
        bump();
      },
      state: () => mgr.getState(),
    };
    (window as unknown as { __lucentVoiceDebug?: typeof hook }).__lucentVoiceDebug = hook;
    return () => {
      delete (window as unknown as { __lucentVoiceDebug?: typeof hook }).__lucentVoiceDebug;
    };
  }, [voiceHud]);
  const [callOpen, setCallOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [turnFilter, setTurnFilter] = useState<TurnFilter>("all");
  const turnsListRef = useRef<HTMLDivElement | null>(null);

  // M6.1–M6.3: Conversational Lease Platform
  const {
    activeLease,
    setActiveLease,
    peers,
    status: roomStatus,
    setCapture: publishCapture,
  } = useMeetingSession();
  const leaseManagerRef = useRef<ConversationalLeaseManager>(
    new ConversationalLeaseManager({ leaseDurationMs: 15_000, maxFollowUpTurns: 3 }),
  );
  const [leaseRemainingSec, setLeaseRemainingSec] = useState(0);

  // Sync peer names to lease manager so teammate cross-talk is correctly recognized
  useEffect(() => {
    const names = [...peers.values()].map((p) => p.name).filter(Boolean);
    leaseManagerRef.current.setTeammates(names);
  }, [peers]);

  // Sync leaseManager changes to MeetingSessionContext and local state
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

  // 1-second countdown ticker when lease is active
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

  // Global Esc key listener to dismiss conversational lease
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        leaseManagerRef.current.dismissLease();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The REC pill's clock: real elapsed time since capture started.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [recording]);

  // Phase D: the behavior profile. Sanitized at the use site (stored
  // settings predate the field and may hold anything); the capture loop
  // reads only the effective behavior, the UI shows the selected mode.
  const selectedMode = isMeetingMode(settings.meetingMode) ? settings.meetingMode : "assistant";
  const extracts = modeAllowsExtraction(selectedMode);

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

  // The turn jump (Stage C1): an Ask citation set ?turn=<start> (alongside
  // ?meeting=). Once the transcript is on screen, scroll the turn into view
  // and keep it marked — the reverse-provenance interaction: evidence → the
  // exact words that produced it. Index-based, like turnRange itself;
  // consumed on read so a reload doesn't re-jump. Brief citations reuse the
  // same state; `seq` re-fires the scroll when the same turn is asked twice.
  const [turnFocus, setTurnFocus] = useState<{ turn: number; seq: number } | null>(null);
  const focusSeqRef = useRef(0);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const turn = params.get("turn");
    if (turn === null) return;
    params.delete("turn");
    window.history.replaceState(null, "", `?${params.toString()}`);
    const idx = Number(turn);
    if (Number.isInteger(idx) && idx >= 0) {
      focusSeqRef.current += 1;
      setTurnFocus({ turn: idx, seq: focusSeqRef.current });
    }
  }, []);

  // When the meeting view unmounts, stop only the VIEW-LOCAL work — on-device
  // speech capture and TTS playback — so their microphone stream is released
  // and no answer keeps playing. The room session itself lives in
  // MeetingSessionContext and deliberately OUTLIVES the view: navigating away
  // keeps the call up so the huddle dock can appear, and the call ends only on
  // an explicit Leave (which calls `leave()` directly). Tearing the call down
  // here is what stopped the dock from ever showing (F5).
  //
  // A running capture keeps this view mounted (docs/28 F14, App's Router), so
  // an unmount mid-capture means the app itself is going (sign-out, a new
  // workspace): finish the capture — flush and end — rather than leave the
  // transcript open for the idle sweep.
  useEffect(
    () => () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
      playbackRef.current?.stop();
      playbackRef.current = null;
      const capture = captureRef.current;
      if (capture) {
        captureRef.current = null;
        void capture.finish(turnsRef.current);
      }
      publishCapture(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const startRecording = (): void => {
    // docs/28 F19: a viewer's capture could never be saved (the server
    // refuses it), so it never starts; the controls say why up front.
    if (readOnly) {
      notify(VIEWER_CAPTURE_REASON);
      return;
    }
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
    // M6.1–M6.3: execute voice query with TTS done synchronization to conversational lease
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
      leaseManagerRef.current.onAiStartResponding();
      try {
        const q = question.trim();
        const result = await askLucent(targetBoardId, q);
        const card = voiceAnswerCard(q, result);
        setVoiceAnswers((prev) => [
          ...prev,
          { ...card, ...("error" in result ? {} : { links: result.citations }) },
        ]);

        // M6.2: read the answer aloud unless muted. Errors stay text.
        if (!voiceMutedRef.current && !card.error && card.answer !== "") {
          playbackRef.current?.stop();
          const spoken = await speakAnswer(card.answer);
          playbackRef.current = spoken.playback;
          if (spoken.reason) notify(`Voice: ${spoken.reason}`);

          // When TTS playback finishes, notify lease manager so the 15s window begins!
          if (spoken.playback) {
            void spoken.playback.done
              .then(() => {
                leaseManagerRef.current.onTtsDone(card.answer);
              })
              .catch(() => {
                leaseManagerRef.current.onTtsDone(card.answer);
              });
          } else {
            leaseManagerRef.current.onTtsDone(card.answer);
          }
        } else {
          // If muted or errored, start lease window immediately
          leaseManagerRef.current.onTtsDone(card.answer);
        }
      } finally {
        answerInFlight.current = false;
      }
    };

    // One callbacks object feeding both surfaces: providers that speak
    // events go through it (final → onFinal below), so the stream and the
    // legacy path append byte-identical turns.
    const voiceCallbacks: VoiceHandlers = {
      onStart: () => setRecording(true),
      onInterim: () => {
        // Interim text is display-only here; the durable record is finals.
      },
      onFinal: (text, meta) => {
        const t = text.trim();
        if (!t || isTtsSpeaking()) return;
        engineRef.current.noteFinal(Date.now());
        const speaker =
          meta?.speaker ??
          (provider.id === "livekit" || provider.id === "hosted" ? "Speaker" : "You");
        setLastSpeaker(speaker);

        appendTurn({
          speaker,
          at: Date.now(),
          text: t,
          kind: classifyTurn(t),
        });

        // Queue the turn for the live extraction loop
        if (extracts) setExtractQueued((q) => q + 1);

        // Persist the captured turn immediately
        void captureRef.current?.persist(turnsRef.current);

        // Conversational Lease Engine in Assistant / Participant modes
        if (selectedMode === "assistant" || selectedMode === "participant") {
          // 1. Barge-in check if AI is currently playing speech
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

          // 2. Evaluate turn against stateful conversational lease
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
        setSttStatus(s);
        if (s === "transcribing") notify("Transcribing on device…");
        if (s === "connecting") notify("Connecting…");
      },
      onError: (msg) => {
        setRecording(false);
        if (msg) notify(msg);
      },
    };
    // The event stream is the primitive; callbacks are derived. Interim
    // events never reach onFinal (the bridge is structurally silent on
    // them), which is what keeps live captions out of durable turns.
    // V8 (chunk cadence): a new capture silences in-flight answers — human
    // speech outranks Lucent. Per-utterance barge-in needs VAD onset
    // events the chunk transport cannot produce; until the V8 transport
    // lands, capture-start yield is the honest form of interruption.
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
      const capturedFrom = Date.now();
      setStartedAt(capturedFrom);
      // A fresh capture starts a fresh transcript; the saved list keeps the
      // prior meetings. The document follows the capture. The server
      // transcript opens with the first turn that lands (meetingCapture.ts):
      // no board → capture still works locally and nothing is sent.
      turnsRef.current = [];
      setTurns([]);
      setSelectedMeeting(null);
      setVoiceAnswers([]);
      unsavedCaptureRef.current = null;
      liveMeetingIdRef.current = null;
      setLiveMeetingId(null);
      const capture = createCaptureDurability({
        startedAt: capturedFrom,
        mode: selectedMode,
        board: () => boardIdRef.current,
        store: { open: saveMeeting, append: appendMeetingTurns, end: endMeeting },
        onOpened: (stored) => {
          // A capture started since owns the live id now.
          if (captureRef.current !== capture) return;
          liveMeetingIdRef.current = stored.id;
          setLiveMeetingId(stored.id);
        },
      });
      captureRef.current = capture;
      setExtractQueued(0);
      setLastExtractStatus(null);
      // Fresh capture resets the engine clock — including a stuck in-flight
      // flag, which the old refs carried across restarts and wedged the
      // loop with. Reset-on-start recovers by construction.
      engineRef.current.reset();
      setRecording(true);
    }
  };

  /**
   * After a capture is durably stored, the document switches to the stored
   * record: its real id is what the board's provenance names, and it can no
   * longer be "saved" a second time. Skipped when a new capture has started
   * in the meantime (the async end must not yank the view off it).
   */
  const openStoredCapture = (stored: MeetingTranscript, captured: MeetingTurn[]): void => {
    setSaved((prev) =>
      prev.some((m) => m.id === stored.id)
        ? prev.map((m) => (m.id === stored.id ? stored : m))
        : [stored, ...prev],
    );
    if (voiceRef.current === null && turnsRef.current === captured) {
      setSelectedMeeting(stored);
      turnsRef.current = [];
      setTurns([]);
      setStartedAt(null);
    }
  };

  const stopRecording = (): void => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    // M6.2: a stopped meeting stops talking — cancel audio in flight so no
    // answer outlives the capture it answered.
    playbackRef.current?.stop();
    playbackRef.current = null;
    setRecording(false);
    // End the running transcript (Stage C3 + P1-MT-001): flush every captured
    // turn the server doesn't hold yet BEFORE the end route makes the record
    // immutable — an ended transcript refuses appends, so ending first would
    // drop the meeting's final words. The flush also opens the transcript if
    // nothing reached it during the meeting (offline the whole time).
    const capture = captureRef.current;
    captureRef.current = null;
    const captured = turnsRef.current;
    const unflushed = captured.length - (capture?.persisted ?? 0);
    const board = capture?.boardId ?? boardId;
    if (capture && captured.length > 0) {
      void (async () => {
        const ended = await capture.finish(captured);
        // A capture started while this end was in flight owns the live id now.
        if (captureRef.current === null) liveMeetingIdRef.current = null;
        if (ended) {
          // The ended record joins the saved list (it was never added at
          // start, so the old in-place update left it missing until reload).
          openStoredCapture(ended, captured);
        } else if (capture.boardId ?? boardIdRef.current) {
          // Offline or refused: the lines stay on screen, and Save meeting
          // retries into this same transcript.
          unsavedCaptureRef.current = { capture, turns: captured };
          notify("Couldn't save the meeting — use Save meeting to retry.");
        }
      })();
    }
    if (unflushed > 0 && board) {
      // The flush above runs async; if it fails (offline, server down) the
      // turns are still on screen and Save meeting can retry. Say so rather
      // than claiming an all-clear the transcript may not have.
      notify(`Flushing ${unflushed} captured turn${unflushed === 1 ? "" : "s"} to the transcript…`);
    }
    setLiveMeetingId(null);
  };

  // docs/28 F14: publish the running capture. While it exists the app keeps
  // this view mounted when the user goes elsewhere, and the dock shows it with
  // a Stop that runs this view's own stopRecording (through a ref, so the dock
  // never holds a stale one). Re-published as lines land or listening flips.
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  useEffect(() => {
    const capture = captureRef.current;
    publishCapture(
      capture
        ? {
            boardId: capture.boardId ?? boardId,
            startedAt: startedAt ?? Date.now(),
            lines: turns.length,
            listening: recording,
            stop: () => stopRecordingRef.current(),
          }
        : null,
    );
  }, [recording, turns.length, startedAt, boardId, publishCapture]);

  // ---- The live extraction loop (M2), driven by the meeting engine -----
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
  // flight ends and the queue still holds unextracted turns. Clock state
  // lives in the engine (meeting-engine.ts), not in refs here — the view
  // owns React state, the engine owns timing.
  const { batch: pendingTurns, batchStart } = sliceBatch(turns, extractQueued);
  const runExtraction = async (): Promise<void> => {
    // Defense in depth behind the trigger gate: extraction without the
    // profile's permission is a spend bug, never a feature.
    if (!extracts) return;
    if (pendingTurns.length === 0 || engineRef.current.state.inFlight) return;
    engineRef.current.markFired();
    const batch = pendingTurns;
    const prompt = differentialPrompt(batch);
    setExtractQueued((q) => Math.max(0, q - batch.length));
    try {
      // send() runs the full pipeline and now reports its terminal state
      // (P1-MT-002): applied / proposed / answered / rejected / failed /
      // busy / refused / cancelled. The heartbeat below names what actually
      // happened instead of asserting "Extracted" for every outcome — and a
      // busy/failed batch is RE-QUEUED so its turns reach the board on the
      // next trigger rather than vanishing behind a success message.
      // The provenance attachment stamps whatever this extract creates with
      // the meeting id, the turns' own words, AND the stable index range
      // + per-turn kinds — the range survives transcript normalization and
      // is what a future board→transcript→object link keys on.
      // Locked AI philosophy: extraction always lands as a proposal to review
      // (meetingExtractRequest), never auto-applied, regardless of the
      // approval threshold that governs explicit canvas commands.
      const result = await send(
        prompt,
        undefined,
        meetingExtractRequest({
          meetingId: liveMeetingIdRef.current ?? "live-session",
          quoted: batch,
          turnRange: [batchStart, batchStart + batch.length - 1],
          kinds: batch.map((t) => t.kind),
        }),
      );
      const n = batch.length;
      setExtractQueued((q) => applyExtractOutcome(q, n, result.outcome));
      setLastExtractStatus(
        extractStatusMessage(result.outcome, n, {
          ...(result.outcome === "proposed" ? { ops: result.ops } : {}),
          ...(result.outcome === "failed" ? { error: result.error } : {}),
        }),
      );
    } catch (err) {
      // send() itself catches and reports into chat; this arm guards a
      // failure in OUR plumbing around it. Re-queue, same as a failed send.
      setExtractQueued((q) => q + batch.length);
      setLastExtractStatus(`Extraction failed: ${(err as Error).message} — will retry`);
    } finally {
      engineRef.current.markDone();
    }
  };

  // Trigger check: on every new final and on a timer (the silence + overdue
  // arms need time to fire even when no more speech arrives). The engine
  // owns the timing decision; the view only asks.
  // Held while a proposal awaits review (F16); deciding it re-runs the check.
  useEffect(() => {
    if (!recording || proposalPendingRef.current) return;
    if (engineRef.current.shouldFire(pendingTurns.length)) {
      void runExtraction();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, recording, proposal]);

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
      if (proposalPendingRef.current) return;
      if (engineRef.current.shouldFire(pendingTurns.length)) {
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
    // A capture Stop couldn't finish may already be partly on the server:
    // finish THAT transcript, so a retry never writes the meeting twice.
    const pending = unsavedCaptureRef.current;
    const stored =
      pending && pending.turns === turnsRef.current
        ? await pending.capture.finish(pending.turns)
        : await saveMeeting(boardId, {
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
    unsavedCaptureRef.current = null;
    setSaved((prev) => [stored, ...prev]);
    turnsRef.current = [];
    setTurns([]);
    setStartedAt(null);
    setSelectedMeeting(stored);
    notify("Meeting saved to this board.");
  };

  const onExtract = (meeting: MeetingTranscript): void => {
    const spliced = withTopicBreaks(meeting.turns, topicBreaks);
    const prompt = promptFromTranscript({ ...meeting, turns: spliced });
    setView("canvas");
    // send() lands on the canvas with the prompt, through the standard
    // generate path — the user watches the diagram appear like any other.
    // Stamped with the meeting's provenance (whole-transcript range), the
    // same shape "Re-extract from here" sends: without it the statements this
    // creates could not be traced back to the meeting, and its brief would
    // stay empty after a successful extraction. Always a proposal (F15).
    void send(
      prompt,
      undefined,
      meetingExtractRequest({
        meetingId: meeting.id,
        quoted: meeting.turns.length > 0 ? spliced : [],
        turnRange: [0, meeting.turns.length - 1],
        kinds: meeting.turns.map((t) => t.kind),
      }),
    );
  };

  const shown = selectedMeeting;
  const displayTurns = shown ? shown.turns : turns;
  // V9 (M6.4), first proactive surface: the board's open questions, shown
  // only in Participant mode and only while capturing live. Text panel,
  // never speech — nothing here speaks unprompted (docs/25 §V9).
  const openQuestions = useMemo(
    () =>
      selectedMode === "participant" && !shown
        ? openBoardQuestions(workspace)
        : { items: [], total: 0 },
    [selectedMode, shown, workspace],
  );
  // Topic breaks index into the displayed transcript — switching transcripts
  // would misalign them, so they reset with the view.
  const shownId = shown?.id ?? null;
  useEffect(() => {
    setTopicBreaks([]);
  }, [shownId]);
  // Reverse provenance (Stage C3): which board objects each turn of the
  // SELECTED meeting produced. Computed from the workspace this browser
  // already holds — C2 put provenance in the state, so no server call is
  // needed. Live capture shows none: its turns are still flowing and the
  // affordance belongs to the closed record.
  const reverseByTurn = useMemo(
    () => (shown ? objectsByTurn(workspace, shown.id, shown.turns.length) : null),
    [workspace, shown],
  );

  // Live provenance keys (UX-5): the running capture stamps the open server
  // id once it exists, and "live-session" before that — both are live. The
  // guard keeps the set to genuinely live stamps.
  const liveKeys = useMemo(() => {
    const keys = new Set<string>(["live-session"]);
    if (liveMeetingId && !isLiveProvenance(liveMeetingId)) keys.add(liveMeetingId);
    return keys;
  }, [liveMeetingId]);

  // Live provisional chips (UX-5): while capturing, the objects the running
  // loop just stamped chip each turn provisionally via pointsAtLive — the
  // saved-view exclusion in pointsAt would list nothing here.
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

  // The brief (meetingBrief.ts): the statements this meeting put on the board.
  // A live capture without a server transcript is the "live-session"
  // placeholder — the brief checks those stamps against the live turns.
  const briefId = shown ? shown.id : (liveMeetingId ?? "live-session");
  const brief = useMemo(
    () => meetingBrief(workspace, { id: briefId, turns: displayTurns }),
    [workspace, briefId, displayTurns],
  );
  // Per past meeting, how many statements it produced — for the meetings list.
  const savedStatementCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of saved) counts.set(m.id, meetingBrief(workspace, { id: m.id }).total);
    return counts;
  }, [workspace, saved]);

  const speakers = useMemo(() => speakersOf(displayTurns), [displayTurns]);
  const turnBase = shown?.startedAt ?? startedAt ?? displayTurns[0]?.at ?? null;

  const markTopicBreak = (): void => {
    const at = displayTurns.length;
    if (topicBreaks.includes(at)) {
      notify("A topic break is already marked here.");
      return;
    }
    setTopicBreaks([...topicBreaks, at].sort((a, b) => a - b));
    notify("Topic break marked.");
  };

  // Per-turn correction (UX-5): re-extract the transcript FROM this turn, so
  // a misheard or corrected passage rebuilds without re-sending everything
  // before it. Same pipeline as the live loop — differential prompt plus the
  // same provenance shape — over the slice, with topic breaks spliced in. A
  // saved meeting hands off to the canvas like onExtract; a live capture
  // sends in the background so recording survives.
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
    void send(
      prompt,
      undefined,
      meetingExtractRequest({
        meetingId,
        quoted: slice,
        turnRange: [startIndex, displayTurns.length - 1],
        kinds: slice.map((t) => t.kind),
      }),
    );
    notify(
      shown
        ? "Re-extracting from that turn — the result waits on the canvas for your review."
        : "Re-extracting from that turn — the result waits for your review.",
    );
  };

  // Per-object correction (UX-5): provenance is append-only on the board — no
  // core op clears it — so "unlink" is honest navigation: the node opens on
  // the canvas for review, with a toast saying so, instead of pretending to
  // delete the link.
  const onUnlink = (id: string): void => {
    notify("Provenance is read-only — opened the node on the canvas to review.");
    onCitation({ kind: "node", id });
  };

  // ---- Citations: brief → transcript turn -------------------------------
  const jumpToTurn = (turn: number): void => {
    setQuery("");
    setTurnFilter("all");
    setPanelOpen(true);
    setActivePanel("transcript");
    focusSeqRef.current += 1;
    setTurnFocus({ turn, seq: focusSeqRef.current });
  };
  // Scroll the focused turn to the middle of the transcript list. Manual
  // rather than scrollIntoView: the list sits in a sticky column inside the
  // page scroller, and scrollIntoView would drag the whole page along.
  useEffect(() => {
    if (!turnFocus || !panelOpen || activePanel !== "transcript") return;
    const list = turnsListRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-turn="${turnFocus.turn}"]`);
    if (!list || !el) return;
    list.scrollTo({
      top: Math.max(0, el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [turnFocus, shownId, displayTurns.length, panelOpen, activePanel]);

  const openMeeting = (m: MeetingTranscript | null): void => {
    setSelectedMeeting(m);
    setTurnFocus(null);
    setQuery("");
    setTurnFilter("all");
  };

  // Ask citations: a node opens on the canvas; a turn of a meeting this board
  // holds opens here; a revision opens History.
  const followAskCitation = (c: AskCitation): void => {
    if (c.kind !== "meeting") {
      onCitation(c);
      return;
    }
    const here = shown ? shown.id : liveMeetingId;
    if (c.id === here) {
      if (c.turnRange) jumpToTurn(c.turnRange[0]);
      return;
    }
    const match = saved.find((m) => m.id === c.id);
    if (!match) {
      notify("That meeting isn't in this board's list.");
      return;
    }
    openMeeting(match);
    if (c.turnRange) jumpToTurn(c.turnRange[0]);
  };

  // The typed Ask bar: askLucent over the board, answered with citations.
  // Text in, text out — never spoken, and outside the voice lease.
  const onAsk = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    const q = askDraft.trim();
    if (!q || askBusy) return;
    if (answerInFlight.current) {
      notify("Lucent is answering — one question at a time.");
      return;
    }
    let target = boardId;
    if (!target) target = await startSharing();
    if (!target) {
      notify("Asking Lucent needs a saved board — please sign in or share the board.");
      return;
    }
    answerInFlight.current = true;
    setAskBusy(true);
    try {
      const result = await askLucent(target, q);
      const card = voiceAnswerCard(q, result);
      setVoiceAnswers((prev) => [
        ...prev,
        { ...card, ...("error" in result ? {} : { links: result.citations }) },
      ]);
      setAskDraft("");
    } finally {
      answerInFlight.current = false;
      setAskBusy(false);
    }
  };

  // The video room's dock buttons: minutes/saved toggle this column; its
  // "extracted statements" button now means the brief.
  const onRoomPanel = (p: "transcript" | "extract" | "saved" | "notes"): void => {
    if (p === "extract") {
      document
        .getElementById("meet-brief")
        ?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      return;
    }
    if (panelOpen && activePanel === p) {
      setPanelOpen(false);
    } else {
      setPanelOpen(true);
      setActivePanel(p);
    }
  };

  // ---- Derived presentation ---------------------------------------------
  const phase: "live" | "saved" | "unsaved" | "none" =
    recording && !shown ? "live" : shown ? "saved" : turns.length > 0 ? "unsaved" : "none";
  const meetingStart = shown?.startedAt ?? startedAt ?? displayTurns[0]?.at ?? null;
  const title =
    meetingStart !== null
      ? `Meeting · ${fmtDay(meetingStart)}, ${fmtClock(meetingStart)}`
      : "Meeting";
  const shownMode = shown?.mode && isMeetingMode(shown.mode) ? shown.mode : null;

  const filteredTurns = useMemo(() => {
    const q = query.trim().toLowerCase();
    return displayTurns
      .map((t, i) => ({ t, i }))
      .filter(
        ({ t }) =>
          (turnFilter === "all" || t.kind === turnFilter) &&
          (!q || t.text.toLowerCase().includes(q) || t.speaker.toLowerCase().includes(q)),
      );
  }, [displayTurns, query, turnFilter]);
  const filtering = query.trim() !== "" || turnFilter !== "all";
  const kindCounts = useMemo(() => {
    const counts = new Map<NonNullable<MeetingTurn["kind"]>, number>();
    for (const t of displayTurns) if (t.kind) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
    return counts;
  }, [displayTurns]);

  const recPill = recording ? (
    shown ? (
      <button
        type="button"
        className="meet-rec"
        onClick={() => openMeeting(null)}
        title="Recording continues — return to the live capture"
      >
        <span className="meet-rec-dot" aria-hidden />
        REC · {formatElapsed(now - (startedAt ?? now))}
      </button>
    ) : (
      <span className="meet-rec">
        <span className="meet-rec-dot" aria-hidden />
        REC · {formatElapsed(now - (startedAt ?? now))}
      </span>
    )
  ) : shown ? (
    <span className="meet-ended">
      {shown.endedAt ? `Ended · ${fmtClock(shown.endedAt)}` : "No end recorded"}
    </span>
  ) : null;

  const statusLine = recording
    ? !extracts
      ? "Recording the transcript only — Record mode extracts nothing."
      : proposal !== null && extractQueued > 0
        ? `Waiting for your review — ${plural(extractQueued, "turn")} queued behind the proposed changes.`
        : (lastExtractStatus ??
          (extractQueued > 0 ? `${plural(extractQueued, "turn")} pending` : "Listening…"))
    : null;

  const renderCitations = (item: BriefItem): ReactNode => {
    if (!item.turnRange) return null;
    const cite = citationTurns(item.turnRange);
    const turnTitle = (n: number): string => {
      const t = displayTurns[n];
      return t ? `Turn ${n + 1} · ${t.speaker}: ${t.text}` : `Turn ${n + 1}`;
    };
    return (
      <span className="meet-cites" title={item.quote ? `“${item.quote}”` : undefined}>
        {cite.kind === "turns" ? (
          cite.turns.map((n) => (
            <button
              key={n}
              type="button"
              className="meet-cite"
              title={turnTitle(n)}
              aria-label={`Show turn ${n + 1} in the transcript`}
              onClick={() => jumpToTurn(n)}
            >
              {n + 1}
            </button>
          ))
        ) : (
          <button
            type="button"
            className="meet-cite span"
            title={turnTitle(cite.from)}
            aria-label={`Show turns ${cite.from + 1} to ${cite.to + 1} in the transcript`}
            onClick={() => jumpToTurn(cite.from)}
          >
            {cite.from + 1}–{cite.to + 1}
          </button>
        )}
      </span>
    );
  };

  const today = todayIso();
  const renderItem = (item: BriefItem): ReactNode => {
    const overdue =
      item.kind === "action" &&
      item.status === "open" &&
      item.dueDate !== undefined &&
      item.dueDate < today;
    const hasMeta =
      item.kind === "action" || item.dueDate !== undefined || (item.supersedes?.length ?? 0) > 0;
    return (
      <li key={item.nodeId} className={`meet-item ${item.status}`}>
        <div className="meet-item-line">
          <KindBadge kind={item.kind} status={item.status} showKind={false} />
          <span className="meet-item-text">
            <span
              className={`meet-item-label ${item.kind === "decision" && item.status === "resolved" ? "decided" : ""}`}
            >
              {item.label}
            </span>
            {renderCitations(item)}
          </span>
          <button
            type="button"
            className="meet-link meet-item-show"
            onClick={() => onCitation({ kind: "node", id: item.nodeId })}
            aria-label={`Show “${item.label}” on the board`}
          >
            Show on board
            <Ico.Arrow />
          </button>
        </div>
        {hasMeta && (
          <div className="meet-item-meta">
            {item.assignee && (
              <span className="meet-owner">
                <Avatar name={item.assignee} size={18} />
                {item.assignee}
              </span>
            )}
            {item.kind === "action" && !item.assignee && (
              <span className="meet-owner unowned">No owner yet</span>
            )}
            {item.dueDate && (
              <span className={`mono meet-due ${overdue ? "overdue" : ""}`}>
                {overdue ? "Overdue · " : "Due "}
                {fmtDue(item.dueDate)}
              </span>
            )}
            {item.supersedes?.map((id) => (
              <ProvenanceChip
                key={id}
                icon={<span aria-hidden>↺</span>}
                label={`Replaces · ${workspace.nodes[id]?.label ?? id}`}
                title="Show the statement this one replaces on the board"
                onClick={() => onCitation({ kind: "node", id })}
              />
            ))}
          </div>
        )}
      </li>
    );
  };

  const briefSummary = brief.sections
    .map((s) => plural(s.items.length, KIND_LABEL[s.kind].one.toLowerCase()))
    .join(" · ");

  const renderBrief = (): ReactNode => {
    if (phase === "none") return null;
    let empty: ReactNode = null;
    if (brief.total === 0) {
      if (phase === "live") {
        empty = extracts ? (
          <EmptyState
            compact
            glyph={<span className="meet-listen" aria-hidden />}
            title="Listening"
            body="Decisions, actions and questions appear here as Lucent hears them — each one linked to the turns that produced it."
          />
        ) : (
          <EmptyState
            compact
            title="Record mode keeps the transcript only"
            body="Nothing is extracted while this capture runs. Choose Intelligence before your next recording to build the brief live, or extract this transcript once it is saved."
          />
        );
      } else if (phase === "saved" && shown) {
        empty = (
          <EmptyState
            compact
            title="Nothing on this board cites this meeting yet"
            body="Extract it and Lucent adds the decisions, actions, questions and risks it finds to the board — each one linked back to the turns that produced it."
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => onExtract(shown)}
                disabled={!boardId || shown.turns.length === 0 || readOnly}
                title={readOnly ? VIEWER_CAPTURE_REASON : undefined}
              >
                Extract to board <Ico.Arrow />
              </Button>
            }
          />
        );
      } else {
        empty = (
          <EmptyState
            compact
            title="This transcript isn't saved yet"
            body={
              boardId
                ? "Save it to the board, then extract it — the brief lists what the meeting decided, assigned and left open."
                : "Meetings save against a board in your workspace. Share this board, then save the transcript to extract a brief from it."
            }
          />
        );
      }
    }
    return (
      <section className="meet-brief" id="meet-brief" aria-labelledby="meet-brief-title">
        <div className="meet-brief-head">
          <h2 className="meet-h2" id="meet-brief-title">
            Brief
          </h2>
          {brief.total > 0 && (
            <span className="mono-caps meet-brief-sum">
              {briefSummary}
              {brief.provisional ? " · provisional" : ""}
            </span>
          )}
        </div>
        {empty}
        {brief.sections.map((section) => (
          <div key={section.kind} className="meet-brief-section">
            <h3 className="meet-h3">
              <StatementGlyph kind={section.kind} size={13} />
              {sectionHeading(section)}
              <span className="section-count">{section.items.length}</span>
            </h3>
            <ul className="meet-items">{section.items.map(renderItem)}</ul>
          </div>
        ))}
      </section>
    );
  };

  const meetingsList = (compact: boolean): ReactNode =>
    saved.map((m) => {
      const statements = savedStatementCounts.get(m.id) ?? 0;
      const viewing = selectedMeeting?.id === m.id;
      return (
        <button
          key={m.id}
          type="button"
          className={`meet-past ${viewing ? "on" : ""} ${compact ? "compact" : ""}`}
          aria-pressed={viewing}
          onClick={() => openMeeting(viewing ? null : m)}
        >
          <span className="meet-past-title">
            {fmtDay(m.startedAt)}, {fmtClock(m.startedAt)}
          </span>
          <span className="mono meet-past-meta">
            {plural(m.turns.length, "turn")}
            {m.endedAt ? ` · ${fmtDuration(m.endedAt - m.startedAt)}` : " · no end recorded"}
            {statements > 0 ? ` · ${plural(statements, "statement")}` : ""}
            {viewing ? " · viewing" : ""}
          </span>
        </button>
      );
    });

  const modeControl = (
    <div className="meet-mode">
      {!recording ? (
        <div className="meet-seg" role="radiogroup" aria-label="Meeting mode">
          {MEETING_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={selectedMode === mode ? "on" : ""}
              aria-pressed={selectedMode === mode}
              title={MODE_NOTES[mode]}
              onClick={() => setSettings({ meetingMode: mode })}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      ) : (
        <span className="meet-chip">{MODE_LABELS[selectedMode]} mode</span>
      )}
    </div>
  );

  const voiceHints = (
    <>
      {readOnly && <p className="meet-note">{VIEWER_CAPTURE_REASON}</p>}
      {!voiceSupported && (
        <p className="meet-note">
          This browser offers no speech-to-text Lucent can use, so recording is unavailable.{" "}
          <button type="button" className="meet-link" onClick={() => onOpenSettings("ai")}>
            See voice providers
          </button>
        </p>
      )}
      {voiceSupported && !livekitConfigured && !recording && (
        <p className="meet-note">
          Local speech-to-text labels every line “You”. Configure LiveKit for per-speaker identity.{" "}
          <button type="button" className="meet-link" onClick={() => onOpenSettings("ai")}>
            Open voice settings
          </button>
        </p>
      )}
    </>
  );

  // The call drawer stays open while a call is joining or live; an idle or
  // failed room can be put away.
  const roomActive = roomStatus === "live" || roomStatus === "joining";
  const showCall = callOpen || roomActive;

  return (
    <Page
      crumbs={[
        { label: "Boards", view: "dashboard" },
        { label: projectName || "Untitled board", view: "canvas" },
        { label: "Meeting", current: true },
      ]}
      meta={recPill}
      onOpenSettings={onOpenSettings}
      width="wide"
    >
      {/* docs/28 F16: the pending proposal is reviewed here too, not only on
          the canvas. Only while this view is on screen: the panel binds
          Esc / Ctrl+Enter globally, and a hidden kept-alive copy (F14) must
          not apply a proposal the user can't see. */}
      {view === "meeting" && <ProposalPanel />}
      {voiceHud && (
        <VoiceStateHud
          snapshot={
            {
              recording,
              sttStatus,
              ttsSpeaking: isTtsSpeaking(),
              conversation: leaseManagerRef.current.getState(),
              leaseRemainingSec,
              leaseSpeaker: activeLease?.speakerName ?? activeLease?.speakerId,
              lastSpeaker,
              turnCount: turns.length,
            } satisfies VoiceHudSnapshot
          }
        />
      )}
      <div className={`meet-layout ${panelOpen ? "" : "panel-closed"}`}>
        <div className="meet-doc">
          {phase !== "none" && (
            <div className="meet-meta">
              {shown?.endedAt && (
                <span className="meet-chip">{fmtDuration(shown.endedAt - shown.startedAt)}</span>
              )}
              {speakers.length > 0 && (
                <span className="meet-chip meet-people" title={speakers.join(", ")}>
                  <span className="meet-avatars">
                    {speakers.slice(0, 4).map((name) => (
                      <Avatar key={name} name={name} size={20} />
                    ))}
                  </span>
                  {speakers.length === 1 ? speakers[0] : plural(speakers.length, "speaker")}
                </span>
              )}
              <span className="meet-chip">{plural(displayTurns.length, "turn")}</span>
              {shown
                ? shownMode && <span className="meet-chip">{MODE_LABELS[shownMode]} mode</span>
                : null}
            </div>
          )}

          <PageHeader
            eyebrow={
              phase === "live"
                ? `Live meeting · ${projectName}`
                : phase === "saved"
                  ? `Saved meeting · ${projectName}`
                  : `Meeting · ${projectName}`
            }
            title={title}
            lede={
              phase === "live"
                ? extracts
                  ? `Recording — what the room decides lands on ${projectName} as it is said.`
                  : "Recording the transcript only."
                : phase === "saved" && shown
                  ? shown.endedAt
                    ? `Ended at ${fmtClock(shown.endedAt)} after ${fmtDuration(shown.endedAt - shown.startedAt)}.`
                    : "This capture never recorded an end — the transcript holds what was flushed."
                  : phase === "unsaved"
                    ? "Captured in this tab and not saved to the board yet."
                    : `Record a conversation and Lucent types what it hears onto ${projectName} — decisions, actions, questions and risks, each linked to the words that produced it.`
            }
          />

          {phase !== "none" && (
            <div className="meet-controls">
              <div className="meet-actions">
                {!recording ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={startRecording}
                    disabled={!voiceSupported || readOnly}
                    title={readOnly ? VIEWER_CAPTURE_REASON : undefined}
                  >
                    <Ico.Mic /> New recording
                  </Button>
                ) : (
                  <Button variant="danger" size="sm" onClick={stopRecording}>
                    <span className="meet-stop" aria-hidden /> Stop
                  </Button>
                )}
                {recording && shown && (
                  <Button variant="ghost" size="sm" onClick={() => openMeeting(null)}>
                    Back to live capture
                  </Button>
                )}
                {!shown && !recording && turns.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void onSave()}
                    disabled={saving || readOnly}
                    title={readOnly ? VIEWER_CAPTURE_REASON : undefined}
                  >
                    {saving ? "Saving…" : "Save meeting"}
                  </Button>
                )}
                {shown && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onExtract(shown)}
                    disabled={!boardId || readOnly}
                    title={readOnly ? VIEWER_CAPTURE_REASON : undefined}
                  >
                    Extract to board <Ico.Arrow />
                  </Button>
                )}
                {displayTurns.length > 0 && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={markTopicBreak}
                    title="Insert a topic separator — re-extractions treat it as a new topic"
                  >
                    Topic break
                  </Button>
                )}
                {(selectedMode === "assistant" || selectedMode === "participant") && (
                  <Button
                    variant="quiet"
                    size="sm"
                    title={
                      voiceMuted ? "Unmute Lucent's spoken answers" : "Mute Lucent's spoken answers"
                    }
                    aria-pressed={!voiceMuted}
                    onClick={() => {
                      if (!voiceMuted) {
                        playbackRef.current?.stop();
                        playbackRef.current = null;
                      }
                      setVoiceMuted((m) => !m);
                    }}
                  >
                    {voiceMuted ? "Unmute voice" : "Mute voice"}
                  </Button>
                )}
                <Button
                  variant="quiet"
                  size="sm"
                  aria-pressed={showCall}
                  disabled={roomActive}
                  onClick={() => setCallOpen((o) => !o)}
                  title={
                    roomActive
                      ? "The video call is running — leave it from the call controls"
                      : "Video call with the people on this board"
                  }
                >
                  <Ico.Video /> {roomStatus === "live" ? "In call" : "Video call"}
                </Button>
                {!panelOpen && (
                  <Button variant="quiet" size="sm" onClick={() => setPanelOpen(true)}>
                    Show transcript
                  </Button>
                )}
              </div>
              {modeControl}
            </div>
          )}

          {phase !== "none" && (
            <>
              {!recording && <p className="meet-note">{MODE_NOTES[selectedMode]}</p>}
              {statusLine && (
                <p className="meet-live" role="status">
                  <span className="meet-rec-dot" aria-hidden />
                  {statusLine}
                </p>
              )}
              {voiceHints}
            </>
          )}

          {/* Conversational Lease Follow-Up Indicator */}
          {activeLease && leaseRemainingSec > 0 && (
            <div className="meet-lease" role="status">
              <span className="meet-lease-dot" aria-hidden />
              <span className="meet-lease-text">
                {activeLease.state === "waiting_for_user_response"
                  ? `Awaiting clarification from ${activeLease.speakerName || activeLease.speakerId}`
                  : `Continuing conversation with ${activeLease.speakerName || activeLease.speakerId}`}{" "}
                <span className="mono">({leaseRemainingSec}s)</span>
              </span>
              <button
                type="button"
                className="meet-kbd"
                onClick={() => leaseManagerRef.current.dismissLease()}
                title="Dismiss conversational lease (Esc)"
              >
                Esc
              </button>
            </div>
          )}

          {showCall && (
            <div className="meet-call">
              <NativeRoom
                boardId={boardId}
                isRecording={recording}
                onToggleRecording={
                  readOnly
                    ? undefined
                    : () => {
                        if (recording) stopRecording();
                        else startRecording();
                      }
                }
                panelOpen={panelOpen}
                onTogglePanel={onRoomPanel}
                activePanel={activePanel}
                onToggleNotes={() => onRoomPanel("notes")}
                notesOpen={panelOpen && activePanel === "notes"}
                turnsCount={displayTurns.length}
              />
            </div>
          )}

          {phase === "none" && (
            <>
              <EmptyState
                glyph={
                  <span className="meet-empty-glyph">
                    <Ico.Mic />
                  </span>
                }
                title="No meeting captured on this board yet"
                body={
                  <>
                    Start recording and the transcript fills in on the right. In Intelligence mode
                    Lucent turns what it hears into typed statements on the board — each one cites
                    the turns it came from, so anyone can check who said it and in which words.
                    {!boardId &&
                      " This board lives only in this browser: share it to keep transcripts with the board."}
                  </>
                }
                action={
                  <>
                    <Button
                      variant="primary"
                      onClick={startRecording}
                      disabled={!voiceSupported || readOnly}
                      title={readOnly ? VIEWER_CAPTURE_REASON : undefined}
                    >
                      <Ico.Mic /> Start recording
                    </Button>
                    <Button
                      variant="ghost"
                      aria-pressed={showCall}
                      disabled={roomActive}
                      onClick={() => setCallOpen((o) => !o)}
                    >
                      <Ico.Video /> Video call
                    </Button>
                  </>
                }
              />
              <div className="meet-empty-mode">
                <span className="mono-caps">Capture mode</span>
                {modeControl}
                <p className="meet-note">{MODE_NOTES[selectedMode]}</p>
                {voiceHints}
              </div>
              {saved.length > 0 && (
                <section className="meet-past-list" aria-label="Past meetings on this board">
                  <h2 className="meet-h2">Past meetings</h2>
                  {meetingsList(false)}
                </section>
              )}
            </>
          )}

          {renderBrief()}

          {!shown && openQuestions.total > 0 && (
            <section className="meet-open" aria-label="Open questions on this board">
              <h3 className="meet-h3">
                <StatementGlyph kind="question" size={13} />
                Still open on this board
                <span className="section-count">{openQuestions.total}</span>
              </h3>
              <ul className="meet-open-list">
                {openQuestions.items.map((q) => (
                  <li key={q.id}>
                    <button
                      type="button"
                      className="meet-link"
                      onClick={() => onCitation({ kind: "node", id: q.id })}
                    >
                      {q.label}
                    </button>
                  </li>
                ))}
              </ul>
              {openQuestions.total > openQuestions.items.length && (
                <p className="meet-note">
                  +{openQuestions.total - openQuestions.items.length} more in Intelligence
                </p>
              )}
            </section>
          )}

          {voiceAnswers.length > 0 && (
            <section className="meet-answers" aria-label="Answers from Lucent">
              <h2 className="meet-h2">Asked Lucent</h2>
              {voiceAnswers.map((a) => (
                <div key={a.id} className="meet-answer">
                  <div className="meet-answer-q">{a.question}</div>
                  <div className={`meet-answer-a ${a.error ? "error" : ""}`}>
                    <span className="meet-answer-mark" aria-hidden>
                      ✦
                    </span>
                    {a.error ? `Couldn't answer: ${a.error}` : a.answer}
                  </div>
                  {a.links && a.links.length > 0 ? (
                    <div className="meet-answer-cites">
                      {a.links.map((c) => (
                        <ProvenanceChip
                          key={`${c.kind}:${c.id}:${c.turnRange?.join("-") ?? ""}`}
                          label={c.label}
                          title={c.why ?? c.detail}
                          onClick={() => followAskCitation(c)}
                        />
                      ))}
                    </div>
                  ) : (
                    a.citations.length > 0 && (
                      <div className="meet-answer-cites">
                        {a.citations.map((label, idx) => (
                          <ProvenanceChip key={`${label}-${idx}`} label={label} />
                        ))}
                      </div>
                    )
                  )}
                </div>
              ))}
            </section>
          )}

          <form className="meet-ask" onSubmit={(e) => void onAsk(e)}>
            <span className="meet-ask-mark" aria-hidden>
              <Ico.Sparkle />
            </span>
            <input
              value={askDraft}
              onChange={(e) => setAskDraft(e.target.value)}
              placeholder={
                boardId
                  ? "Ask Lucent about this board…"
                  : "Ask Lucent about this board — saves it to your workspace first"
              }
              aria-label="Ask Lucent about this board"
              disabled={askBusy}
            />
            <button
              type="submit"
              className="meet-ask-send"
              disabled={askBusy || askDraft.trim() === ""}
              aria-label="Ask"
            >
              {askBusy ? <span className="meet-ask-busy" aria-hidden /> : <Ico.Arrow />}
            </button>
          </form>
        </div>

        {panelOpen && (
          <aside className="meet-panel" aria-label="Meeting transcript">
            <div className="meet-panel-head">
              <div className="meet-tabs" role="tablist" aria-label="Transcript panel">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePanel === "transcript"}
                  className={activePanel === "transcript" ? "on" : ""}
                  onClick={() => setActivePanel("transcript")}
                >
                  Transcript
                  <span className="meet-tab-count">{displayTurns.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePanel === "notes"}
                  className={activePanel === "notes" ? "on" : ""}
                  onClick={() => setActivePanel("notes")}
                >
                  Notes
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activePanel === "saved"}
                  className={activePanel === "saved" ? "on" : ""}
                  onClick={() => setActivePanel("saved")}
                >
                  Meetings
                  <span className="meet-tab-count">{saved.length}</span>
                </button>
              </div>
              <button
                type="button"
                className="meet-icon-btn"
                onClick={() => setPanelOpen(false)}
                title="Collapse transcript"
                aria-label="Collapse transcript"
              >
                <Ico.X />
              </button>
            </div>

            {activePanel === "transcript" && (
              <>
                <div className="meet-search">
                  <Ico.Search />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search transcript…"
                    aria-label="Search transcript"
                  />
                  {query && (
                    <button
                      type="button"
                      className="meet-icon-btn"
                      onClick={() => setQuery("")}
                      aria-label="Clear search"
                    >
                      <Ico.X />
                    </button>
                  )}
                </div>
                {kindCounts.size > 0 && (
                  <div className="meet-kind-filter">
                    <FilterChips<TurnFilter>
                      label="Filter lines by classification"
                      value={turnFilter}
                      onChange={setTurnFilter}
                      items={[
                        { id: "all", label: "All", count: displayTurns.length },
                        ...KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => ({
                          id: k,
                          label: k[0]!.toUpperCase() + k.slice(1),
                          count: kindCounts.get(k),
                        })),
                      ]}
                    />
                  </div>
                )}

                <div className="meet-turns" ref={turnsListRef}>
                  {displayTurns.length === 0 && (
                    <EmptyState
                      compact
                      title={recording ? "Listening for the first line" : "No transcript yet"}
                      body={
                        recording
                          ? "Each line lands here as it is transcribed, with who said it and when."
                          : "Start recording to capture the meeting. Lines classify themselves as they land (problem / hypothesis / solution / decision / action / requirement) and save to this board."
                      }
                    />
                  )}
                  {displayTurns.length > 0 && filtering && filteredTurns.length === 0 && (
                    <p className="meet-note meet-none">No lines match.</p>
                  )}
                  {filteredTurns.map(({ t, i }) => {
                    const produced = reverseByTurn?.get(i) ?? liveByTurn?.get(i);
                    const provisional = !shown && (liveByTurn?.has(i) ?? false);
                    const focused = turnFocus?.turn === i;
                    return (
                      <Fragment key={focused ? `${i}:${turnFocus.seq}` : i}>
                        {!filtering && topicBreaks.includes(i) && (
                          <button
                            type="button"
                            className="meet-break"
                            title="Remove topic break"
                            onClick={() => setTopicBreaks((prev) => prev.filter((b) => b !== i))}
                          >
                            <span>Topic break</span>
                          </button>
                        )}
                        <div
                          data-turn={i}
                          className={`meet-turn ${focused ? "focused" : ""}`}
                          aria-current={focused ? "true" : undefined}
                        >
                          <Avatar name={t.speaker} size={24} />
                          <div className="meet-turn-body">
                            <div className="meet-turn-head">
                              <span className="meet-turn-speaker">{t.speaker}</span>
                              <span className="mono meet-turn-time">
                                {turnBase !== null
                                  ? formatElapsed(t.at - turnBase)
                                  : fmtClock(t.at)}
                              </span>
                              <span className="mono meet-turn-num">#{i + 1}</span>
                              {t.kind && (
                                <span
                                  className="meet-turn-kind"
                                  style={{ ["--tint" as string]: TURN_TINT[t.kind] }}
                                >
                                  {t.kind}
                                </span>
                              )}
                            </div>
                            <p className="meet-turn-text">{highlight(t.text, query)}</p>
                            <div className="meet-turn-foot">
                              {produced && produced.length > 0 && (
                                <span
                                  className="mono meet-produced"
                                  title={`On the board: ${produced
                                    .map((id) => workspace.nodes[id]?.label ?? id)
                                    .join(", ")}`}
                                >
                                  ✦ {produced.length} on board{provisional ? " · provisional" : ""}
                                </span>
                              )}
                              {produced?.map((id) => (
                                <span key={id} className="meet-obj">
                                  <button
                                    type="button"
                                    className="meet-obj-view"
                                    title={`View on board: ${workspace.nodes[id]?.label ?? id}`}
                                    onClick={() => onCitation({ kind: "node", id })}
                                  >
                                    {workspace.nodes[id]?.label ?? id}
                                  </button>
                                  <button
                                    type="button"
                                    className="meet-obj-unlink"
                                    title="Unlink this object from the turn"
                                    onClick={() => onUnlink(id)}
                                  >
                                    unlink
                                  </button>
                                </span>
                              ))}
                              {!readOnly && (
                                <button
                                  type="button"
                                  className="meet-reextract"
                                  title="Re-extract the board from this turn onward"
                                  onClick={() => onReextractFrom(i)}
                                >
                                  Re-extract from here
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                  {!filtering &&
                    topicBreaks.includes(displayTurns.length) &&
                    displayTurns.length > 0 && (
                      <button
                        type="button"
                        className="meet-break"
                        title="Remove topic break"
                        onClick={() =>
                          setTopicBreaks((prev) => prev.filter((b) => b !== displayTurns.length))
                        }
                      >
                        <span>Topic break</span>
                      </button>
                    )}
                </div>
              </>
            )}

            {activePanel === "notes" && (
              <MeetingNotes
                boardId={boardId}
                meetingId={shown ? shown.id : liveMeetingId}
                turns={displayTurns}
                live={phase === "live"}
                title={title}
                onJumpToTurn={jumpToTurn}
              />
            )}

            {activePanel === "saved" && (
              <div className="meet-saved">
                {recording && (
                  <button
                    type="button"
                    className={`meet-past compact ${shown ? "" : "on"}`}
                    aria-pressed={!shown}
                    onClick={() => openMeeting(null)}
                  >
                    <span className="meet-past-title">
                      <span className="meet-rec-dot" aria-hidden /> Live capture
                    </span>
                    <span className="mono meet-past-meta">
                      {plural(turns.length, "turn")} · {formatElapsed(now - (startedAt ?? now))}
                    </span>
                  </button>
                )}
                {saved.length === 0 ? (
                  <EmptyState
                    compact
                    title="No saved meetings yet"
                    body={
                      boardId
                        ? "Record a meeting and it is kept here, with its transcript and brief."
                        : "Meetings save against a board in your workspace — share this board to keep them."
                    }
                  />
                ) : (
                  meetingsList(true)
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </Page>
  );
}
