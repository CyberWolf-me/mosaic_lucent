import type { LiveKitConfig, SttProvider, VoiceHandlers, VoiceSession } from "./types.js";

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

async function fetchToken(room: string): Promise<{ token: string; url: string }> {
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room }),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `Token endpoint failed (${res.status}).`);
  }
  // The endpoint may override the room URL (useful for regional routing).
  return { token: data.token, url: data.url ?? config.url };
}

function isConfigured(): boolean {
  return config.url.trim().length > 0 && config.tokenUrl.trim().length > 0;
}

export const livekitSttProvider: SttProvider = {
  id: "livekit",

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
    if (!config.url.trim()) return "Add your LiveKit server URL in Settings → AI & voice.";
    if (!config.tokenUrl.trim()) {
      return "Add a LiveKit token endpoint in Settings → AI & voice. The browser must never hold a LiveKit API secret.";
    }
    return null;
  },

  configure(next: LiveKitConfig) {
    configureLiveKit(next);
  },

  start(handlers: VoiceHandlers): VoiceSession | null {
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
        const { token, url } = await fetchToken(config.room || "lucent-voice");
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
        // TranscriptionReceived event; segments carry `final` so interim words
        // can stream while the final text accumulates — and the speaking
        // participant's identity, which rides along to onFinal so meeting
        // capture can attribute turns to people.
        room.on(
          livekit.RoomEvent.TranscriptionReceived ?? "transcriptionReceived",
          (segments: TranscriptionSegment[]) => {
            for (const seg of segments) {
              const speaker =
                typeof seg.participant === "string"
                  ? seg.participant
                  : seg.participant?.name || seg.participant?.identity || undefined;
              if (seg.final) {
                chunks.push(seg.text);
                lastSpeaker = speaker ?? lastSpeaker;
              } else {
                handlers.onInterim?.(seg.text);
              }
            }
            if (chunks.length > 0) handlers.onInterim?.(chunks.join(" "));
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
        if (text) handlers.onFinal(text, lastSpeaker ? { speaker: lastSpeaker } : undefined);
        else handlers.onError?.("");
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
 * A transcription segment as LiveKit actually delivers it. The SDK's own type
 * carries more; this file deliberately types only what it reads — and `final`
 * segments DO carry the speaking participant's identity, which is exactly
 * what meeting capture needs to attribute a turn to a person. The previous
 * structural type dropped those fields on the floor.
 */
interface TranscriptionSegment {
  text: string;
  final: boolean;
  /** The participant who spoke — the room identity the token minted. */
  participant?: { identity?: string; name?: string } | string | null;
}
