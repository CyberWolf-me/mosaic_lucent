import type { LiveKitConfig, SttProvider, VoiceHandlers, VoiceSession } from "./types.js";
import { eventConsumerFromCallbacks, type VoiceEventHandlers } from "./events.js";
import { apiFetch } from "../http.js";

/**
 * LiveKit-backed speech-to-text.
 *
 * LiveKit itself does not transcribe: a room carries the audio, and a
 * server-side agent publishes transcription back into the room as text. This
 * provider therefore does two things and nothing more:
 *
 *  1. asks *your* server for a short-lived access token (the LiveKit API secret
 *     must never reach the browser, exactly as with the model API key), and
 *  2. joins the room, publishes the mic, and surfaces transcription events the
 *     agent sends back.
 *
 * The `livekit-client` SDK is imported dynamically so a workspace that never
 * enables LiveKit pays no bundle cost, and so a missing dependency degrades to a
 * clear message instead of a build error.
 */

let config: LiveKitConfig = { url: "", tokenUrl: "", room: "" };

export function configureLiveKit(next: LiveKitConfig): void {
  config = next;
}

/** Minimal shape of the token endpoint's response. */
interface TokenResponse {
  token?: string;
  url?: string;
  error?: string;
}

/** True for a path on this origin, or an absolute URL that names it. */
export function isSameOrigin(url: string): boolean {
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (typeof window === "undefined") return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * docs/28 F23: Lucent's own token route (the default, `/api/livekit/token`)
 * needs the session and the CSRF header — a bare fetch got 403 "csrf
 * rejected" for every cookie session. A third-party token server gets
 * neither: Lucent's CSRF token and cookies never leave this origin.
 */
export async function fetchLiveKitToken(room: string): Promise<{ token: string; url: string }> {
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room }),
  };
  const res = isSameOrigin(config.tokenUrl)
    ? await apiFetch(config.tokenUrl, init)
    : await fetch(config.tokenUrl, { ...init, credentials: "omit" });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `Token endpoint failed (${res.status}).`);
  }
  // The endpoint may override the room URL (useful for regional routing).
  return { token: data.token, url: data.url ?? config.url };
}

function isConfigured(): boolean {
  // The token endpoint is the only thing that must be reachable: it mints the
  // access token AND returns the room URL (the server owns `LUCENT_LIVEKIT_URL`),
  // so the browser needs no URL of its own. A deployment with no LiveKit
  // configured answers the token call with 503, surfaced honestly at connect
  // time rather than by asking the user to paste infrastructure here.
  return config.tokenUrl.trim().length > 0;
}

export const livekitSttProvider: SttProvider = {
  id: "livekit",
  finalsAtStop: true,

  isSupported() {
    // Needs a mic and a configured room; the SDK check happens at start(),
    // because a dynamic import can't be probed synchronously.
    return (
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      isConfigured()
    );
  },

  unavailableReason() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "This browser can't access the microphone.";
    }
    if (!config.tokenUrl.trim()) {
      return "Add a LiveKit token endpoint in Settings → AI & voice. The browser must never hold a LiveKit API secret.";
    }
    // No check on config.url: the token endpoint returns the room URL, so an
    // empty URL here is the normal zero-config case, not a misconfiguration.
    return null;
  },

  configure(next: LiveKitConfig) {
    configureLiveKit(next);
  },

  start(handlers: VoiceHandlers): VoiceSession | null {
    const withEvents = this.startWithEvents;
    if (!withEvents) return null;
    return withEvents.call(this, eventConsumerFromCallbacks(handlers));
  },

  startWithEvents(handlers: VoiceEventHandlers): VoiceSession | null {
    const reason = this.unavailableReason?.();
    if (reason) {
      handlers.onError?.(reason);
      return null;
    }

    let stopped = false;
    // Resolved once connected; stop() before then just sets the flag.
    let disconnect: (() => void) | null = null;
    const chunks: string[] = [];
    // The most recent final segment's speaker — attribution for the joined
    // final this session emits on stop.
    let lastSpeaker: string | undefined;

    handlers.onStatus?.("connecting");

    void (async () => {
      try {
        const { token, url } = await fetchLiveKitToken(config.room || "lucent-voice");
        if (stopped) return;

        // Dynamic import: optional dependency.
        const livekit = (await import(/* @vite-ignore */ "livekit-client")) as {
          Room: new (opts?: unknown) => LiveKitRoom;
          RoomEvent: Record<string, string>;
        };
        if (stopped) return;

        const room = new livekit.Room({ adaptiveStream: true });
        disconnect = () => void room.disconnect();

        // Transcription arrives from the server agent. LiveKit exposes it as a
        // TranscriptionReceived event: segments carry `final` so interim words
        // can stream while the final text accumulates, and the event's SECOND
        // argument is the participant whose track was transcribed, which
        // becomes the event's participantId (per-stream identity IS the
        // person here — advisory §2, no diarization needed and none
        // attempted). It used to be read off the segment, which has no such
        // field, so no turn was ever attributed.
        //
        // Cadence preserved exactly: finals accumulate and emit ONCE at stop
        // as one joined turn. Per-utterance finals while running would change
        // how often the extraction loop bills a generation — a billing and
        // behavior decision, not a contract-migration side effect.
        room.on(
          livekit.RoomEvent.TranscriptionReceived ?? "transcriptionReceived",
          (segments: TranscriptionSegment[], participant?: TranscribedParticipant) => {
            const speaker = participant?.name || participant?.identity || undefined;
            for (const seg of segments) {
              if (seg.final) {
                chunks.push(seg.text);
                lastSpeaker = speaker ?? lastSpeaker;
              } else {
                handlers.onEvent({
                  type: "interim",
                  text: seg.text,
                  at: Date.now(),
                  participantId: speaker,
                  source: "livekit",
                });
              }
            }
            if (chunks.length > 0)
              handlers.onEvent({
                type: "interim",
                text: chunks.join(" "),
                at: Date.now(),
                participantId: lastSpeaker,
                source: "livekit",
              });
          },
        );

        room.on(livekit.RoomEvent.Disconnected ?? "disconnected", () => {
          if (!stopped) handlers.onError?.("LiveKit room disconnected.");
        });

        await room.connect(url, token);
        if (stopped) {
          void room.disconnect();
          return;
        }
        await room.localParticipant.setMicrophoneEnabled(true);
        handlers.onStatus?.("listening");
        handlers.onEvent({ type: "speech_started", at: Date.now() });
        handlers.onStart?.();
      } catch (err) {
        if (stopped) return;
        const message = (err as Error).message;
        handlers.onError?.(
          /Failed to fetch dynamically imported module|Cannot find module/i.test(message)
            ? "LiveKit isn't installed. Run: npm i livekit-client -w @lucent/web"
            : `LiveKit voice failed: ${message}`,
        );
      }
    })();

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        handlers.onStatus?.("idle");
        disconnect?.();
        const text = chunks.join(" ").trim();
        if (text)
          handlers.onEvent({
            type: "final",
            text,
            at: Date.now(),
            participantId: lastSpeaker,
            source: "livekit",
          });
        else handlers.onError?.("");
        // Boundary flush first, stopped last — same order as every
        // provider, so consumers never lose the last turn to the stop.
        handlers.onEvent({ type: "speech_stopped", at: Date.now(), participantId: lastSpeaker });
      },
    };
  },
};

/** Structural types for the parts of livekit-client this file touches. */
interface LiveKitRoom {
  on(event: string, cb: (...args: never[]) => void): void;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant: { setMicrophoneEnabled(on: boolean): Promise<unknown> };
}

/**
 * A transcription segment as LiveKit delivers it. The SDK's own type carries
 * more (id, language, timings); this file types only what it reads. Who spoke
 * is NOT on the segment — it is the event's second argument.
 */
interface TranscriptionSegment {
  text: string;
  final: boolean;
}

/** The participant whose track a transcription belongs to — the room identity the token minted. */
interface TranscribedParticipant {
  identity?: string;
  name?: string;
}
