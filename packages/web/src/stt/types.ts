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
 *
 * All satisfy the same VoiceSession contract so CanvasView never depends on
 * which one is active.
 */

export type SttProviderId = "browser" | "whisper" | "livekit";

export interface VoiceSession {
  stop(): void;
}

export interface VoiceHandlers {
  /** Fires once the session is actively capturing audio (after mic permission). */
  onStart?: () => void;
  /** Live partial transcript (browser provider only; whisper has no interim). */
  onInterim?: (text: string) => void;
  /** Final transcript when the user stops. */
  onFinal: (text: string) => void;
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
