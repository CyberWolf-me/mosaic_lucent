/**
 * Text-to-speech seam (docs/25 V7, M6.2).
 *
 * Two engines, one contract: the browser's free local speech synthesis is
 * the default (no key, no network, no metering — nothing to bill), and a
 * server-proxied sidecar (OpenAI-style `/v1/audio/speech`) serves voices
 * the browser cannot do. The key never reaches the browser — the hosted
 * engine POSTs text to `/api/tts/speak`, exactly like the hosted STT slot
 * POSTs audio to `/api/stt/sessions`.
 *
 * `speakAnswer` is the only entry the meeting view needs: hosted first,
 * browser on 503 (unconfigured server), text-only when neither can run.
 * The fallback is honest, not silent — every refusal carries its reason,
 * and a caller that cannot speak says so once rather than swallowing
 * answers.
 */

export type TtsProviderId = "browser" | "hosted";

export interface TtsPlayback {
  stop(): void;
  done: Promise<void>;
}

export interface TtsProvider {
  readonly id: TtsProviderId;
  isSupported(): boolean;
  unavailableReason(): string | null;
  speak(text: string): Promise<TtsPlayback>;
}

function essentials(text: string): string | null {
  const clean = text.trim().slice(0, 2000);
  return clean === "" ? null : clean;
}

/**
 * A generous safety cap (ms) for how long one utterance may hold the
 * "TTS speaking" flag. Chrome's `SpeechSynthesisUtterance.onend` is notoriously
 * unreliable — it frequently never fires — which would leave `_activeTtsCount`
 * stuck above zero, `isTtsSpeaking()` permanently true, and STT gated forever:
 * the mic goes deaf after Lucent's first answer and the transcript appears to
 * "reset" after a few words. The watchdog force-releases the flag well AFTER
 * any real speech would have finished (deliberately an over-estimate, so it
 * only fires when the real end event was missed — never mid-speech, which would
 * reopen the mic into Lucent's own voice).
 */
function ttsWatchdogMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(180_000, Math.max(5000, words * 500 + 5000));
}

let _activeTtsCount = 0;

/**
 * Returns true if TTS audio is actively playing through the computer speakers.
 * STT input must be suppressed while this is true to prevent acoustic echo loops.
 */
export function isTtsSpeaking(): boolean {
  return _activeTtsCount > 0;
}

function notifyTtsStart(): void {
  _activeTtsCount++;
}

function notifyTtsEnd(): void {
  _activeTtsCount = Math.max(0, _activeTtsCount - 1);
}

export const browserTtsProvider: TtsProvider = {
  id: "browser",

  isSupported() {
    return (
      typeof window !== "undefined" &&
      typeof window.speechSynthesis !== "undefined" &&
      typeof window.SpeechSynthesisUtterance !== "undefined"
    );
  },

  unavailableReason() {
    return this.isSupported() ? null : "This browser has no built-in speech synthesis.";
  },

  async speak(text: string): Promise<TtsPlayback> {
    const clean = essentials(text);
    if (!clean) throw new Error("nothing to speak");
    if (!this.isSupported()) throw new Error(this.unavailableReason() ?? "unsupported");
    const synth = window.speechSynthesis;
    const utterance = new window.SpeechSynthesisUtterance(clean);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    notifyTtsStart();
    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      notifyTtsEnd();
      resolveDone();
    };
    utterance.onend = () => cleanup();
    utterance.onerror = () => cleanup();
    synth.cancel();
    synth.speak(utterance);
    // Chrome often never fires onend; release the STT gate anyway (see ttsWatchdogMs).
    watchdog = setTimeout(cleanup, ttsWatchdogMs(clean));
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        synth.cancel();
        cleanup();
      },
      done,
    };
  },
};

interface SpeakResponse {
  error?: string;
}

export const hostedTtsProvider: TtsProvider = {
  id: "hosted",

  isSupported() {
    return typeof window !== "undefined" && typeof window.Audio !== "undefined";
  },

  unavailableReason() {
    return this.isSupported() ? null : "This browser cannot play audio.";
  },

  async speak(text: string): Promise<TtsPlayback> {
    const clean = essentials(text);
    if (!clean) throw new Error("nothing to speak");
    if (!this.isSupported()) throw new Error(this.unavailableReason() ?? "unsupported");
    const { apiFetch } = await import("./http.js");
    const res = await apiFetch("/api/tts/speak", {
      method: "POST",
      body: JSON.stringify({ input: clean }),
    });
    if (res.status === 503) throw new Error("unconfigured");
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as SpeakResponse | null;
      throw new Error(data?.error ?? `server voice failed (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new window.Audio(url);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    notifyTtsStart();
    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (watchdog !== undefined) clearTimeout(watchdog);
      notifyTtsEnd();
      URL.revokeObjectURL(url);
      resolveDone();
    };
    audio.onended = () => cleanup();
    audio.onerror = () => cleanup();
    // Backstop for a stalled/GC'd audio element that never fires 'ended'.
    watchdog = setTimeout(cleanup, ttsWatchdogMs(text));
    let stopped = false;
    try {
      await audio.play();
    } catch {
      cleanup();
      throw new Error("Audio playback was blocked — interact with the page, then try again.");
    }
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        audio.pause();
        cleanup();
      },
      done,
    };
  },
};

export interface SpeakOutcome {
  /** Which engine spoke, or null when the answer stayed text. */
  provider: TtsProviderId | null;
  /** The live playback, for cancel-on-interruption (V8 owns the policy). */
  playback: TtsPlayback | null;
  /** Human reason speech did not happen; null when it did. */
  reason: string | null;
}

/**
 * Speak an answer: hosted sidecar first, browser synthesis on 503, text
 * silence otherwise. Never throws — not-speaking is a reason, not an
 * exception, and the meeting view renders the reason once.
 */
export async function speakAnswer(text: string): Promise<SpeakOutcome> {
  if (essentials(text) === null) {
    return { provider: null, playback: null, reason: "nothing to speak" };
  }
  if (hostedTtsProvider.isSupported()) {
    try {
      const playback = await hostedTtsProvider.speak(text);
      return { provider: "hosted", playback, reason: null };
    } catch (err) {
      const message = (err as Error).message;
      // "unconfigured" is the expected fallback trigger, not a failure:
      // the deployment simply has no server voice.
      if (message !== "unconfigured") {
        return { provider: null, playback: null, reason: message };
      }
    }
  }
  if (browserTtsProvider.isSupported()) {
    try {
      const playback = await browserTtsProvider.speak(text);
      return { provider: "browser", playback, reason: null };
    } catch (err) {
      return { provider: null, playback: null, reason: (err as Error).message };
    }
  }
  return {
    provider: null,
    playback: null,
    reason: browserTtsProvider.unavailableReason() ?? "speech is unavailable",
  };
}
