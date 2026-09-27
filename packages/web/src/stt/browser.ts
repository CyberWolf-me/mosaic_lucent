import type { SttProvider, VoiceHandlers, VoiceSession } from "./types.js";
import { eventConsumerFromCallbacks, type VoiceEventHandlers } from "./events.js";
import { isTtsSpeaking } from "../tts.js";

/**
 * Web Speech API provider. Streams live interim words, but is Chrome/Edge-only
 * and needs a network + secure context. Primes mic permission via getUserMedia
 * first (the recognizer alone often doesn't prompt in embedded webviews) and
 * reports specific, actionable errors instead of failing silently.
 */

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}
interface SpeechResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}
interface SpeechErrorEvent {
  error?: string;
}

/**
 * Segment mode (M2): fire `onFinal` once per UTTERANCE while the session runs,
 * not one joined blob at stop. The recognition event marks each result
 * `isFinal` when the utterance ends; meeting capture needs those as separate
 * turns ("Sarah: I'll handle marketing" arriving minutes apart as two turns,
 * not one concatenated blob). The event's `resultIndex` tells us where the
 * new results begin so nothing is double-counted across restarts.
 */
interface SegmentedResult {
  0: { transcript: string };
  isFinal: boolean;
  length: number;
}
interface SegmentedResultList {
  length: number;
  [index: number]: SegmentedResult;
}
interface SegmentedEvent {
  resultIndex: number;
  results: SegmentedResultList;
}
type RecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): RecognitionCtor | null {
  // Guard for non-DOM contexts (tests, SSR): isSupported() must answer "no"
  // rather than throwing a ReferenceError on `window`.
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Errors Chrome raises in the ordinary life of a long capture: a pause with no
 * speech, its own restart, a moment without network. The recognizer ends and
 * the provider starts it again; none of these is the person's problem, and
 * reporting them ended every voice session the first time someone paused
 * (found in use: "it only gets about four words, then resets").
 */
export function isTransientSpeechError(code: string | undefined): boolean {
  return code === "no-speech" || code === "aborted" || code === "network";
}

/** A restart storm — the recognizer ending again and again — is a real failure. */
export const MAX_RESTARTS_IN_WINDOW = 6;
export const RESTART_WINDOW_MS = 5000;

function describeError(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow the mic for this site, then try again.";
    case "audio-capture":
      return "No microphone was found. Check that a mic is connected and enabled.";
    case "no-speech":
      return "Didn't catch any speech — try again and speak after the tone.";
    case "network":
      return "Browser voice recognition needs a network connection and isn't reachable right now.";
    case "aborted":
      return "";
    default:
      return "Voice recognition isn't available in this browser. Try the on-device Whisper provider in Settings, or type.";
  }
}

export const browserSttProvider: SttProvider = {
  id: "browser",
  isSupported: () => getCtor() !== null,
  start(handlers: VoiceHandlers): VoiceSession | null {
    // The only implementation is the event stream; callbacks are derived in
    // one place so the two surfaces can never disagree. The guard is
    // unreachable (every provider implements events) and exists so `this`
    // stays honest without a non-null assertion.
    const withEvents = this.startWithEvents;
    if (!withEvents) return null;
    return withEvents.call(this, eventConsumerFromCallbacks(handlers));
  },
  startWithEvents(handlers: VoiceEventHandlers): VoiceSession | null {
    const Ctor = getCtor();
    if (!Ctor) {
      handlers.onError?.(
        "Voice input isn't supported in this browser — try Chrome/Edge or switch to Whisper in Settings.",
      );
      return null;
    }

    let recognition: SpeechRecognitionLike | null = null;
    let stopped = false;
    // Segment mode bookkeeping: every utterance final fires onFinal at once.
    // `emittedThrough` tracks the last result index already emitted so a
    // recognizer restart replaying the list can't double-fire a turn.
    let emittedThrough = -1;
    // Words heard but not yet final. Chrome can end a recognition session in
    // the middle of a phrase (its own restart, a network blip) without ever
    // finalizing it; those words used to vanish, and the text reset.
    let pendingInterim = "";
    let networkErrors = 0;
    const restarts: number[] = [];

    const flushPending = () => {
      const text = pendingInterim.trim();
      pendingInterim = "";
      if (!text || stopped || isTtsSpeaking()) return;
      handlers.onEvent({ type: "final", text, at: Date.now(), source: "browser" });
    };

    const begin = () => {
      if (stopped) return;
      try {
        recognition = new Ctor();
      } catch {
        return;
      }
      emittedThrough = -1;
      recognition.lang = "en-US";
      recognition.interimResults = true;
      recognition.continuous = true;
      recognition.onresult = (baseEvent) => {
        if (stopped || isTtsSpeaking()) return;
        // Segment mode: the event carries an index where new results start.
        const event = baseEvent as unknown as SegmentedEvent;
        networkErrors = 0;
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result?.[0]?.transcript ?? "";
          if (result?.isFinal === true) {
            // A finalized utterance: emit immediately (once, even if the
            // recognizer restarts and replays the list).
            if (i > emittedThrough && transcript.trim() && !stopped && !isTtsSpeaking()) {
              emittedThrough = i;
              handlers.onEvent({
                type: "final",
                text: transcript.trim(),
                at: Date.now(),
                source: "browser",
              });
            }
          } else {
            interim += transcript;
          }
        }
        pendingInterim = interim;
        if (interim && !stopped && !isTtsSpeaking())
          handlers.onEvent({ type: "interim", text: interim, at: Date.now(), source: "browser" });
      };
      recognition.onerror = (event) => {
        if (stopped) return;
        const code = event?.error;
        // Ordinary in a long capture: the recognizer ends and restarts itself.
        if (isTransientSpeechError(code)) {
          if (code === "network" && ++networkErrors >= 3) {
            handlers.onError?.(describeError(code));
          }
          return;
        }
        // Anything else (blocked mic, no mic, unsupported) won't fix itself on
        // a restart: stop here and say what to do.
        stopped = true;
        const msg = describeError(code);
        if (msg) handlers.onError?.(msg);
      };
      recognition.onend = () => {
        if (stopped) return;
        flushPending();
        const now = Date.now();
        restarts.push(now);
        while (restarts.length > 0 && now - restarts[0]! > RESTART_WINDOW_MS) restarts.shift();
        if (restarts.length > MAX_RESTARTS_IN_WINDOW) {
          stopped = true;
          handlers.onError?.(
            "Voice recognition keeps stopping in this browser. Check the microphone, or switch to another speech provider in Settings.",
          );
          return;
        }
        // Chrome stops recognition after any short silence. Continuously recreate
        // and restart capture unless stopped or TTS is actively playing.
        if (!stopped) {
          if (isTtsSpeaking()) {
            const poll = setInterval(() => {
              if (stopped) {
                clearInterval(poll);
                return;
              }
              if (!isTtsSpeaking()) {
                clearInterval(poll);
                try {
                  begin();
                  handlers.onStatus?.("listening");
                } catch {
                  /* restart raced with stop() */
                }
              }
            }, 200);
            return;
          }
          try {
            begin();
            handlers.onStatus?.("listening");
          } catch {
            /* restart raced with stop() — nothing to do */
          }
        }
      };
      try {
        recognition.start();
        // No VAD here: capture-begin is the honest speech_started, refined
        // when a voice-activity layer lands (events.ts).
        handlers.onEvent({ type: "speech_started", at: Date.now() });
        handlers.onStart?.();
        handlers.onStatus?.("listening");
      } catch (err) {
        handlers.onError?.(`Couldn't start voice input: ${(err as Error).message || "unknown"}.`);
      }
    };

    const media = navigator.mediaDevices?.getUserMedia?.({ audio: true });
    if (media !== undefined) {
      media
        .then((stream) => {
          stream.getTracks().forEach((t) => t.stop());
          begin();
        })
        .catch(() =>
          handlers.onError?.(
            "Microphone access was denied. Allow the mic for this site, then try again.",
          ),
        );
    } else {
      begin();
    }

    return {
      stop: () => {
        // What was heard but not finalized when the person stopped is theirs.
        flushPending();
        stopped = true;
        handlers.onEvent({ type: "speech_stopped", at: Date.now() });
        try {
          recognition?.stop();
        } catch {
          /* ignore */
        }
        recognition = null;
      },
    };
  },
};
