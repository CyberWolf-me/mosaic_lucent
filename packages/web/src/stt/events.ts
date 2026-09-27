import type { SttProviderId, VoiceHandlers, VoiceStatus } from "./types.js";

/**
 * The speech-event stream (docs/25 follow-through on the voice advisory's
 * "one change immediately").
 *
 * The seam's fundamental primitive is a stream of meeting events, not a bare
 * `onFinal(text, meta)`: live captions, speaker awareness, turn-taking, and
 * eventually the voice loop all read the same stream, while `onFinal` alone
 * locks every consumer into a "2-second transcript upload" shape.
 *
 * The split is deliberate: THESE events describe speech; session lifecycle
 * (`onStart`/`onStatus`/`onError`) stays beside them, not inside them. A
 * provider without VAD emits `speech_started` when capture begins — an
 * honest "listening now", not a voice-onset claim; VAD refines that field
 * later without changing any consumer.
 *
 * Identity follows the advisory's §2 rule, encoded in two fields that are
 * deliberately NOT interchangeable:
 *
 * - `participantId` — known identity from an individual stream (the LiveKit
 *   room identity the token minted). A person, when the stream is
 *   authoritative.
 * - `speakerId` — an opaque diarization label (`spk_01`) from a mixed
 *   stream. A cluster, not a person, until a resolver maps it.
 *
 * Resolution is a ladder, and only the bottom rung lives in display code:
 *
 * ```text
 * trusted stream identity (participantId, authoritative stream)
 *   → mapped label (spk_2 → alice, once something establishes it — nothing does yet)
 *   → raw diarization label (speakerId, displayed opaquely)
 *   → "Speaker" (honest fallback, never a fake name)
 * ```
 *
 * The `??` precedence in display call sites is DISPLAY precedence, not an
 * identity claim: showing `spk_02` next to a turn does not assert who spoke.
 * A real mapping (announced identity, device correlation) arrives as its own
 * seam, not as a reinterpretation of these fields.
 *
 * Timing and provenance ride the events from day one, before the contract
 * hardens: `startMs`/`endMs` where the provider knows them (the hosted
 * sidecar reports them; local engines omit them), `confidence` reserved
 * (accepted and passed through, acted on by nothing yet — a field nobody
 * acts on stays inert, per the freeze's fact/constraint precedent), and
 * `source` naming the engine that heard it.
 *
 * HARD RULE: `interim` is UI/realtime state only. It feeds live captions
 * and nothing else — never turns, never checkpoints, never extraction, and
 * the server contract has no interim shape at all. Anything durable derives
 * from `final`.
 */
export type SpeechEvent =
  | { type: "speech_started"; at: number; participantId?: string }
  | { type: "interim"; text: string; at: number; participantId?: string; source: SttProviderId }
  | {
      type: "final";
      text: string;
      at: number;
      participantId?: string;
      speakerId?: string;
      startMs?: number;
      endMs?: number;
      /** Reserved: passed through where offered, acted on by nothing yet. */
      confidence?: number;
      source: SttProviderId;
    }
  | { type: "speech_stopped"; at: number; participantId?: string };

export interface VoiceEventHandlers {
  onEvent: (event: SpeechEvent) => void;
  onStart?: () => void;
  onError?: (message: string) => void;
  onStatus?: (status: VoiceStatus) => void;
  onDegraded?: (reason: string | null) => void;
}

/**
 * Derive the legacy callbacks from one event stream, in exactly one place.
 * `final` becomes `onFinal` (display precedence: speakerId, then
 * participantId — see the ladder above; this is what shows on screen, not
 * an identity claim); `interim` becomes `onInterim` and NOTHING else, which
 * is what keeps interim out of durable intelligence structurally rather
 * than by convention; lifecycle events are silent here because callback
 * consumers keep using `onStart`/`onStatus`, which providers fire directly.
 * Every provider's `start()` is this bridge over its own `startWithEvents`,
 * so the two surfaces can never disagree about what a provider heard.
 */
export function eventConsumerFromCallbacks(handlers: VoiceHandlers): VoiceEventHandlers {
  return {
    onEvent: (event: SpeechEvent) => {
      if (event.type === "final") {
        const speaker = event.speakerId ?? event.participantId;
        handlers.onFinal(event.text, speaker === undefined ? undefined : { speaker });
      } else if (event.type === "interim") {
        handlers.onInterim?.(event.text);
      }
    },
    ...(handlers.onStart ? { onStart: handlers.onStart } : {}),
    ...(handlers.onError ? { onError: handlers.onError } : {}),
    ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
    ...(handlers.onDegraded ? { onDegraded: handlers.onDegraded } : {}),
  };
}
