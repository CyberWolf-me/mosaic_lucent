import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { useSettings } from "../settings.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import { askLucent } from "../boards.js";
import {
  shouldAnswerVoice,
  voiceAnswerCard,
  openBoardQuestions,
  type VoiceAnswer,
} from "../meeting-voice.js";
import { speakAnswer } from "../tts.js";
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
import { differentialPrompt } from "../meeting-extract.js";
import {
  applyExtractOutcome,
  createMeetingEngine,
  extractStatusMessage,
  sliceBatch,
} from "../meeting-engine.js";
import { isLiveProvenance, objectsByTurn, pointsAtLive } from "../meetingTimeline.js";

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
    if (marks.has(i)) out.push({ speaker: "You", at: Date.now(), text: "── topic break ──" });
    if (i < list.length) out.push(list[i]!);
  }
  return out;
}

export function MeetingView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, send, boardId, projectName, workspace, onCitation } = useWorkspace();
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
  // M6.1: spoken answers (text). Session-local, never stored — answers are
  // reads, not minutes. One in flight at a time; a question arriving while
  // busy waits for the next trigger rather than overlapping speech.
  const [voiceAnswers, setVoiceAnswers] = useState<VoiceAnswer[]>([]);
  const answerInFlight = useRef(false);
  // M6.2: server/local speech for answers. Session-local mute; the playback
  // ref lets stopRecording (and the next answer) cancel audio in flight —
  // the turn-taking basis V8 builds on.
  const [voiceMuted, setVoiceMuted] = useState(false);
  const playbackRef = useRef<{ stop(): void } | null>(null);
  // Fresh-closure trap: answers fire long after startRecording built the
  // callback, so the mute flag is mirrored into a ref read at answer time.
  const voiceMutedRef = useRef(false);
  voiceMutedRef.current = voiceMuted;
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
  // P1-MT-001: capture durability independent of extraction. Turns appended to
  // the server transcript the moment they are captured (not only when an
  // extraction checkpoint rides along), and stopRecording flushes what a
  // still-in-flight append hadn't reached BEFORE the end route makes the
  // transcript immutable. `persistedCount` counts the local turns the server
  // definitely holds; an append in flight (or that failed) leaves the gap that
  // the flush closes.
  const persistedCountRef = useRef(0);
  const appendInFlightRef = useRef<Promise<MeetingTranscript | null> | null>(null);
  const checkpointTurns = async (): Promise<void> => {
    const board = boardId;
    const meetingId = liveMeetingId;
    if (!board || !meetingId) return;
    // Serialize appends: a checkpoint behind an in-flight one would double-send
    // the same span when both read the same persistedCount.
    const previous = appendInFlightRef.current;
    if (previous) await previous.catch(() => {});
    if (persistedCountRef.current >= turnsRef.current.length) return;
    const batch = turnsRef.current.slice(persistedCountRef.current);
    const from = persistedCountRef.current;
    appendInFlightRef.current = appendMeetingTurns(board, meetingId, batch)
      .then((stored) => {
        if (stored) {
          // The server holds the full list; trust its length over our slice
          // arithmetic so a dedup/normalization on the server still converges.
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
  // The live transcript id lives in state (renders) and in a ref (the capture
  // callbacks below read it without re-arming the STT provider).
  const liveMeetingIdRef = useRef<string | null>(null);
  // Topic breaks (UX-5): separator indices into the displayed transcript.
  // Render-local — the saved transcript is never rewritten — and spliced
  // into extraction prompts as "── topic break ──" lines.
  const [topicBreaks, setTopicBreaks] = useState<number[]>([]);

  // Phase D: the behavior profile. Sanitized at the use site (stored
  // settings predate the field and may hold anything); the capture loop
  // reads only the effective behavior, the UI shows the selected mode.
  const selectedMode = isMeetingMode(settings.meetingMode) ? settings.meetingMode : "intelligence";
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
  // and flash it — the reverse-provenance interaction: evidence → the exact
  // words that produced it. Index-based, like turnRange itself; consumed on
  // read so a reload doesn't re-flash.
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
    // M6.1: the text voice loop. Addressed turns in the assistant profiles
    // ask the board through the read-only pipeline and render the answer
    // below the transcript. One at a time; anything else is surfaced, never
    // silently dropped into overlap.
    const maybeAnswerVoice = (text: string): Promise<void> => {
      if (!shouldAnswerVoice(selectedMode, text)) return Promise.resolve();
      if (!boardId) {
        notify("Share the board first — voice answers read a shared board.");
        return Promise.resolve();
      }
      if (answerInFlight.current) {
        notify("Lucent is answering — one spoken question at a time.");
        return Promise.resolve();
      }
      answerInFlight.current = true;
      return (async () => {
        try {
          const question = text.trim();
          const result = await askLucent(boardId, question);
          const card = voiceAnswerCard(question, result);
          setVoiceAnswers((prev) => [...prev, card]);
          // M6.2: read the answer aloud unless muted. Errors stay text —
          // speaking a paywall would be theater, and speaking nothing is.
          if (!voiceMutedRef.current && !card.error && card.answer !== "") {
            playbackRef.current?.stop();
            const spoken = await speakAnswer(card.answer);
            playbackRef.current = spoken.playback;
            if (spoken.reason) notify(`Voice: ${spoken.reason}`);
          }
        } finally {
          answerInFlight.current = false;
        }
      })();
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
        if (!t) return;
        engineRef.current.noteFinal(Date.now());
        appendTurn({
          // Display precedence (events.ts ladder), not an identity claim:
          // a diarized label shows opaquely, a stream identity shows as
          // minted, and "You"/"Speaker" is the honest fallback rather than
          // a fake guess.
          speaker:
            meta?.speaker ??
            (provider.id === "livekit" || provider.id === "hosted" ? "Speaker" : "You"),
          at: Date.now(),
          text: t,
          kind: classifyTurn(t),
        });
        // Queue the turn for the live extraction loop — the trigger effect
        // decides when the batch is worth a model call. Record mode never
        // queues: a Record meeting that burns a generation is a clause-4
        // defect, so the refusal lives here, one call above the send.
        if (extracts) setExtractQueued((q) => q + 1);
        // P1-MT-001: checkpoint the CAPTURED turn immediately — durability of
        // what was said must not depend on the extraction loop deciding a
        // batch is worth a model call, or on an extraction succeeding at all.
        void checkpointTurns();
        // M6.1: an addressed turn in an assistant profile gets a text answer
        // through the read-only Ask pipeline (never a board write). The mode
        // is captured at recording start, like the STT provider: switching
        // profiles mid-capture takes effect on the next capture.
        void maybeAnswerVoice(t);
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
      setStartedAt(Date.now());
      // A fresh capture starts a fresh transcript; the saved list keeps the
      // prior meetings.
      turnsRef.current = [];
      setTurns([]);
      setVoiceAnswers([]);
      persistedCountRef.current = 0;
      setExtractQueued(0);
      setLastExtractStatus(null);
      // Fresh capture resets the engine clock — including a stuck in-flight
      // flag, which the old refs carried across restarts and wedged the
      // loop with. Reset-on-start recovers by construction.
      engineRef.current.reset();
      setRecording(true);
      // Open the server-side transcript NOW with an empty turn list: every
      // captured final checkpoints into it the moment it lands, so everything
      // said during the meeting is durable even before it ends. No board / no
      // store → capture still works locally; checkpoints are just skipped.
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
    // M6.2: a stopped meeting stops talking — cancel audio in flight so no
    // answer outlives the capture it answered.
    playbackRef.current?.stop();
    playbackRef.current = null;
    setRecording(false);
    // End the running transcript (Stage C3 + P1-MT-001): flush every captured
    // turn the checkpoint pipeline hasn't confirmed BEFORE the end route makes
    // the record immutable — the end used to race the last in-flight append,
    // and an ended transcript refuses appends, so the meeting's final words
    // could vanish. Idempotent, so a retry is a read.
    const ending = liveMeetingIdRef.current;
    const captured = turnsRef.current;
    const unflushed = captured.length - persistedCountRef.current;
    if (ending && boardId) {
      void (async () => {
        await checkpointTurns().catch(() => {});
        const ended = await endMeeting(boardId, ending);
        if (ended) {
          // The saved list updates in place: the record it already holds
          // gained its boundary.
          setSaved((prev) => prev.map((m) => (m.id === ended.id ? ended : m)));
        }
        persistedCountRef.current = 0;
        liveMeetingIdRef.current = null;
      })();
    } else if (captured.length > 0 && boardId) {
      // Fallback save when capture ran without the server transcript (local
      // board, or the open call failed): persist what was said in one piece.
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
      // The flush above runs async; if it fails (offline, server down) the
      // turns are still on screen and Save meeting can retry. Say so rather
      // than claiming an all-clear the transcript may not have.
      notify(`Flushing ${unflushed} captured turn${unflushed === 1 ? "" : "s"} to the transcript…`);
    }
    setLiveMeetingId(null);
    setLiveMeetingTurnCount(0);
  };

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
  useEffect(() => {
    if (!recording) return;
    if (engineRef.current.shouldFire(pendingTurns.length)) {
      void runExtraction();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, recording]);

  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => {
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
    // send() lands on the canvas with the prompt, through the standard
    // generate path — the user watches the diagram appear like any other.
    void send(prompt);
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
  // Reverse provenance (Stage C3): which board objects each turn of the  // SELECTED meeting produced. Computed from the workspace this browser
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

  // Per-object correction (UX-5): provenance is append-only on the board — no
  // core op clears it — so "unlink" is honest navigation: the node opens on
  // the canvas for review, with a toast saying so, instead of pretending to
  // delete the link.
  const onUnlink = (id: string): void => {
    notify("Provenance is read-only — opened the node on the canvas to review.");
    onCitation({ kind: "node", id });
  };

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
              {(selectedMode === "assistant" || selectedMode === "participant") && (
                <button
                  className="btn"
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
              {displayTurns.length > 0 && (
                <button
                  className="btn"
                  onClick={markTopicBreak}
                  title="Insert a topic separator — re-extractions treat it as a new topic"
                >
                  Mark topic break
                </button>
              )}
            </div>
          </div>

          {!livekitConfigured && !recording && (
            <p className="mono small" style={{ color: "var(--ink-3)", margin: "8px 0 0" }}>
              Local STT labels every line "You". Configure LiveKit in Settings for per-speaker
              identity, or Hosted for server-side diarisation.
            </p>
          )}

          {/* Phase D: behavior profile. Capture + checkpoint always run; the
              profile decides whether the extraction loop may spend. Assistant
              and Participant degrade to Intelligence, disclosed, until M6. */}
          {!recording && (
            <div style={{ marginTop: 8 }}>
              <div className="segmented" role="radiogroup" aria-label="Meeting mode">
                {MEETING_MODES.map((mode) => (
                  <button
                    key={mode}
                    className={selectedMode === mode ? "active" : ""}
                    aria-pressed={selectedMode === mode}
                    title={MODE_NOTES[mode]}
                    onClick={() => setSettings({ meetingMode: mode })}
                  >
                    {MODE_LABELS[mode]}
                    {(mode === "assistant" || mode === "participant") && " · soon"}
                  </button>
                ))}
              </div>
              <p className="mono small" style={{ color: "var(--ink-3)", margin: "4px 0 0" }}>
                {MODE_NOTES[selectedMode]}
              </p>
            </div>
          )}

          <div className="meeting-turns">
            {displayTurns.length === 0 && (
              <p className="muted" style={{ fontSize: 13, padding: "24px 4px" }}>
                Start recording to capture the meeting. Lines classify themselves as they land
                (problem / hypothesis / solution / decision / action / requirement) and save to this
                board.
              </p>
            )}
            {displayTurns.map((t, i) => {
              // Reverse provenance (Stage C3): the objects this turn produced,
              // rendered under the words that created them — the Stage C
              // document's "Used to create N objects · View on board".
              // Live capture (UX-5) chips the same from the provisional
              // live-session stamps via pointsAtLive.
              const produced = reverseByTurn?.get(i) ?? liveByTurn?.get(i);
              const provisional = !shown && (liveByTurn?.has(i) ?? false);
              return (
                <Fragment key={i}>
                  {topicBreaks.includes(i) && (
                    <button
                      className="mono small"
                      title="Remove topic break"
                      onClick={() => setTopicBreaks((prev) => prev.filter((b) => b !== i))}
                      style={{
                        alignSelf: "stretch",
                        textAlign: "center",
                        margin: "6px 0",
                        fontSize: 10,
                        letterSpacing: "0.08em",
                        color: "var(--ink-3)",
                        background: "transparent",
                        border: "none",
                        borderTop: "1px dashed var(--stroke-2)",
                        padding: "6px 0 0",
                        cursor: "pointer",
                      }}
                    >
                      ── topic break ──
                    </button>
                  )}
                  <div data-turn={i}>
                    <div className={`meeting-turn${i === turnFlash ? " highlight" : ""}`}>
                      <span className="mono small meeting-turn-speaker">{t.speaker}</span>
                      <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-1)" }}>
                        {t.text}
                      </span>
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
                    <div
                      style={{
                        display: "flex",
                        gap: 12,
                        flexWrap: "wrap",
                        alignItems: "baseline",
                        margin: "0 0 6px 10px",
                      }}
                    >
                      <button
                        className="mono"
                        title="Re-extract the board from this turn onward"
                        onClick={() => onReextractFrom(i)}
                        style={{
                          fontSize: 10,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: "var(--ink-3)",
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                        }}
                      >
                        Re-extract from here
                      </button>
                      {produced && produced.length > 0 && (
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            letterSpacing: "0.05em",
                            textTransform: "uppercase",
                            color: "var(--amber-2)",
                          }}
                          title={`View on board: ${produced.join(", ")}`}
                        >
                          ✦ {produced.length} object{produced.length === 1 ? "" : "s"} on the board
                          {provisional ? " · provisional" : ""}
                        </span>
                      )}
                      {produced?.map((id) => (
                        <span
                          key={id}
                          style={{ display: "inline-flex", gap: 8, alignItems: "baseline" }}
                        >
                          <button
                            className="mono turn-objects-link"
                            title={`View on board: ${id}`}
                            onClick={() => onCitation({ kind: "node", id })}
                            style={{
                              fontSize: 10,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              color: "var(--amber-2)",
                              background: "transparent",
                              border: "none",
                              padding: 0,
                              cursor: "pointer",
                            }}
                          >
                            view
                          </button>
                          <button
                            className="mono"
                            title="Unlink this object from the turn (provenance is read-only — opens the node on the canvas)"
                            onClick={() => onUnlink(id)}
                            style={{
                              fontSize: 10,
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                              color: "var(--ink-3)",
                              background: "transparent",
                              border: "none",
                              padding: 0,
                              cursor: "pointer",
                            }}
                          >
                            Unlink from turn
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                </Fragment>
              );
            })}
            {/* A break marked past the last turn has no turn row to hang on. */}
            {topicBreaks.includes(displayTurns.length) && displayTurns.length > 0 && (
              <button
                className="mono small"
                title="Remove topic break"
                onClick={() =>
                  setTopicBreaks((prev) => prev.filter((b) => b !== displayTurns.length))
                }
                style={{
                  alignSelf: "stretch",
                  textAlign: "center",
                  margin: "6px 0",
                  fontSize: 10,
                  letterSpacing: "0.08em",
                  color: "var(--ink-3)",
                  background: "transparent",
                  border: "none",
                  borderTop: "1px dashed var(--stroke-2)",
                  padding: "6px 0 0",
                  cursor: "pointer",
                }}
              >
                ── topic break ──
              </button>
            )}
            {/* M6.1: spoken answers, session-local. Text only for now —
                voice audio arrives with M6.2; citations render as labels,
                with jumps following the C1 plumbing later. */}
            {!shown &&
              voiceAnswers.map((a) => (
                <div key={a.id} className="meeting-turn meeting-answer">
                  <span className="mono small meeting-turn-speaker">✦ Lucent</span>
                  <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-1)" }}>
                    {a.error ? `Couldn't answer: ${a.error}` : a.answer}
                  </span>
                  {a.citations.length > 0 && (
                    <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                      {a.citations.join(" · ")}
                    </span>
                  )}
                </div>
              ))}
            {/* V9: open questions, participant mode only. Derived live from
                the                 board each render — no store, no speech, dismissed by
                leaving the profile. */}
            {!shown && openQuestions.total > 0 && (
              <div className="meeting-turn meeting-questions">
                <span className="mono small meeting-turn-speaker">? Open</span>
                <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink-1)" }}>
                  {openQuestions.items.map((q) => q.label).join(" · ")}
                  {openQuestions.total > openQuestions.items.length &&
                    ` (+${openQuestions.total - openQuestions.items.length} more)`}
                </span>
              </div>
            )}
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
