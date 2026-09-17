import { apiFetch } from "../http.js";
import type { SttProvider, VoiceHandlers, VoiceSession } from "./types.js";

/**
 * Server-hosted diarizing STT (docs/25 V1 — the fourth slot).
 *
 * The mic stays here, but transcription happens server-side: this provider
 * opens a session (`POST /api/stt/sessions`), streams MediaRecorder slices
 * as audio chunks, and surfaces the finals the server returns — each already
 * carrying the sidecar's speaker label, which rides `onFinal`'s meta so
 * meeting capture attributes turns to speakers on a shared mic.
 *
 * What this provider deliberately does NOT do:
 *
 * - No interim words. Chunk cadence (2s) is the deep loop's cadence, not the
 *   fast loop's: live captions stay the browser provider's job. Finals
 *   display immediately, exactly like every other provider.
 * - No client-held secrets. The session is authed by the caller's own
 *   session (cookie/bearer via `apiFetch`); the STT key never leaves the
 *   server, the same rule as every other provider key.
 * - No silent void. An unconfigured server answers 503, a forbidding org
 *   403, an exhausted allowance 402 — each becomes the `onError` message,
 *   never an empty transcript the user mistakes for silence.
 */

interface SessionResponse {
  sessionId?: string;
  error?: string;
}

interface AudioResponse {
  finals?: Array<{ text?: unknown; speaker?: unknown }>;
  error?: string;
}

interface CloseResponse extends AudioResponse {
  audioSeconds?: number;
  minutes?: number;
}

const CHUNK_MS = 2000;

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" && data.error !== "" ? data.error : fallback;
}

export const hostedSttProvider: SttProvider = {
  id: "hosted",

  isSupported() {
    // Mic only — no client configuration exists (the server decides
    // liveness at session creation and says 503 when unconfigured).
    return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  },

  unavailableReason() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "This browser can't access the microphone.";
    }
    return null;
  },

  start(handlers: VoiceHandlers): VoiceSession | null {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      handlers.onError?.("This browser can't access the microphone.");
      return null;
    }

    let stopped = false;
    let sessionId: string | null = null;
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    // Serialize chunk uploads: a 2s cadence never overlaps, and an ordering
    // guarantee the server does not need is still one less thing to reason
    // about when finals arrive out of order.
    let chain: Promise<void> = Promise.resolve();

    handlers.onStatus?.("connecting");

    const fail = (message: string): null => {
      if (!stopped) handlers.onError?.(message);
      return null;
    };

    const emitFinals = (finals: AudioResponse["finals"]): void => {
      if (stopped || !finals) return;
      for (const f of finals) {
        if (typeof f.text !== "string" || f.text.trim() === "") continue;
        handlers.onFinal(
          f.text,
          typeof f.speaker === "string" && f.speaker !== "" ? { speaker: f.speaker } : undefined,
        );
      }
    };

    const postChunk = (bytes: Blob): void => {
      if (stopped || sessionId === null || bytes.size === 0) return;
      const id = sessionId;
      chain = chain.then(async () => {
        if (stopped) return;
        let res: Response;
        try {
          res = await apiFetch(`/api/stt/sessions/${encodeURIComponent(id)}/audio`, {
            method: "POST",
            body: bytes,
          });
        } catch {
          return;
        }
        if (!res.ok || stopped) return;
        const data = (await res.json().catch(() => null)) as AudioResponse | null;
        emitFinals(data?.finals);
      });
    };

    const closeSession = (): void => {
      if (sessionId === null) return;
      const id = sessionId;
      sessionId = null;
      chain = chain.then(async () => {
        let res: Response;
        try {
          res = await apiFetch(`/api/stt/sessions/${encodeURIComponent(id)}/close`, {
            method: "POST",
          });
        } catch {
          return;
        }
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as CloseResponse | null;
        emitFinals(data?.finals);
      });
    };

    void (async () => {
      let created: Response;
      try {
        created = await apiFetch("/api/stt/sessions", { method: "POST" });
      } catch {
        if (!stopped) handlers.onError?.("Couldn't reach the transcription service.");
        return;
      }
      if (stopped) return;
      if (!created.ok) {
        if (created.status === 503) {
          fail(
            "Hosted transcription isn't configured on this server — nothing would be transcribed. Use on-device Whisper or LiveKit instead.",
          );
        } else {
          fail(await readError(created, `Hosted transcription failed (${created.status}).`));
        }
        return;
      }
      const data = (await created.json().catch(() => null)) as SessionResponse | null;
      if (!data?.sessionId) {
        fail("Hosted transcription answered without a session.");
        return;
      }
      sessionId = data.sessionId;
      if (stopped) {
        closeSession();
        return;
      }
      let mic: MediaStream;
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        closeSession();
        fail("Microphone access was denied.");
        return;
      }
      if (stopped) {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        return;
      }
      stream = mic;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        fail("This browser can't record audio for upload.");
        return;
      }
      recorder.ondataavailable = (event: BlobEvent) => postChunk(event.data);
      recorder.onerror = () => {
        if (!stopped) handlers.onError?.("Audio upload failed; transcription stopped.");
        void session?.stop();
      };
      try {
        recorder.start(CHUNK_MS);
      } catch {
        for (const track of mic.getTracks()) track.stop();
        closeSession();
        fail("This browser can't record audio for upload.");
        return;
      }
      handlers.onStatus?.("listening");
      handlers.onStart?.();
    })();

    const session: VoiceSession = {
      stop() {
        if (stopped) return;
        stopped = true;
        handlers.onStatus?.("idle");
        try {
          recorder?.stop();
        } catch {
          // Already stopped — closing the session is what matters.
        }
        recorder = null;
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
        }
        // The close flushes boundary finals through the same chain, so
        // nothing recorded is lost to the stop itself.
        closeSession();
      },
    };
    return session;
  },
};
