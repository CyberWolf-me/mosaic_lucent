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
    utterance.onend = () => resolveDone();
    utterance.onerror = () => resolveDone();
    synth.cancel();
    synth.speak(utterance);
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        // Cancel only our utterance's aftermath: a full cancel() would cut
        // a queued utterance from elsewhere, but this seam owns the channel
        // while a meeting answer plays — documented, single-speaker rule.
        synth.cancel();
        resolveDone();
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
    // Playback is a plain <audio> element; support is near-universal.
    // Whether the SERVER has a voice configured is answered at speak time
    // (503), not probed here — probing would spend nothing but still lie
    // about liveness between the probe and the speak.
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
    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolveDone();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolveDone();
    };
    let stopped = false;
    try {
      await audio.play();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Audio playback was blocked — interact with the page, then try again.");
    }
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        audio.pause();
        URL.revokeObjectURL(url);
        resolveDone();
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
