/**
 * Speech-to-text provider abstraction. Voice is a swappable STT layer, mirroring
 * how @lucent/ai keeps the LLM behind a provider interface (docs/06 calls for a
 * realtime STT provider). Three implementations ship:
 *
 *  - "browser"  — the built-in Web Speech API. Streams live interim words, but is
 *                 Chrome/Edge-only and cloud-backed (audio leaves the device).
 *  - "whisper"  — on-device Whisper via transformers.js. Free, private, works in
 *                 any browser; records then transcribes on stop (no live words).
 *  - "livekit"  — realtime STT through a LiveKit room, for shared/meeting audio.
 *                 Needs a room URL and a server endpoint that mints tokens; the
 *                 browser never holds a LiveKit secret.
 *  - "hosted"   — server-hosted diarizing STT (docs/25 V1). The mic stays
 *                 here; chunks ride authed POSTs to /api/stt/sessions and
 *                 finals come back with speaker labels for shared-mic audio.
 *                 503s honestly when the server has no STT configured.
 *
 * All satisfy the same VoiceSession contract so CanvasView never depends on
 * which one is active.
 */

export type SttProviderId = "browser" | "whisper" | "livekit" | "hosted";

export interface VoiceSession {
  stop(): void;
}

/** What a provider can tell the consumer about ONE finalized utterance. */
export interface FinalMeta {
  /**
   * Who spoke, when the provider knows. LiveKit segments carry the room
   * participant's identity (the token mints it from the signed-in user);
   * local engines have no speaker concept and omit the field rather than
   * guessing. Meeting capture uses this to attribute turns — "Sarah: I'll
   * handle marketing" becomes a task owned by Sarah, not an anonymous card.
   */
  speaker?: string;
}

export interface VoiceHandlers {
  /** Fires once the session is actively capturing audio (after mic permission). */
  onStart?: () => void;
  /** Live partial transcript (browser provider only; whisper has no interim). */
  onInterim?: (text: string) => void;
  /**
   * Final transcript when the user stops — or, for segment-mode providers,
   * once per utterance while the session runs. The optional meta carries
   * what the provider knows about the utterance; callers that don't care
   * can keep taking just the text.
   */
  onFinal: (text: string, meta?: FinalMeta) => void;
  /** Human-actionable error message; empty string means "silent / user-initiated". */
  onError?: (message: string) => void;
  /** Coarse status for UI (e.g. "transcribing" while Whisper runs). */
  onStatus?: (status: VoiceStatus) => void;
}

export type VoiceStatus = "idle" | "listening" | "transcribing" | "connecting";

/** Connection details a hosted provider needs; empty strings mean unconfigured. */
export interface LiveKitConfig {
  url: string;
  tokenUrl: string;
  room: string;
}

export interface SttProvider {
  readonly id: SttProviderId;
  /** True if this provider can run in the current browser. */
  isSupported(): boolean;
  /** Begin a capture session. Returns null only if unsupported. */
  start(handlers: VoiceHandlers): VoiceSession | null;
  /**
   * Human-readable reason this provider can't be used right now (missing
   * configuration, unsupported browser). Null when it is ready.
   */
  unavailableReason?(): string | null;
  /** Supply runtime configuration before `start` (hosted providers only). */
  configure?(config: LiveKitConfig): void;
}
