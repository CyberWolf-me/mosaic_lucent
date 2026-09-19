import { apiFetch } from "../http.js";

export type VoiceAgentState =
  | "idle"
  | "connecting"
  | "listening"
  | "agent_speaking"
  | "error"
  | "disconnected";

export interface VoiceAgentTranscript {
  text: string;
  final: boolean;
  isAgent: boolean;
  timestamp: number;
}

export interface StartVoiceAgentOptions {
  boardId: string;
  onStateChange: (state: VoiceAgentState) => void;
  onTranscript?: (transcript: VoiceAgentTranscript) => void;
  onError?: (error: string) => void;
}

export interface VoiceAgentController {
  disconnect: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  isMuted: () => boolean;
}

/** Structural types for livekit-client */
interface LiveKitTrack {
  kind: string;
  attach: (element?: HTMLMediaElement) => HTMLMediaElement;
  detach: () => HTMLMediaElement[];
}

interface LiveKitParticipant {
  identity: string;
  name?: string;
}

interface LiveKitRoom {
  on(event: string, cb: (...args: any[]) => void): void;
  connect(url: string, token: string): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant: {
    identity: string;
    setMicrophoneEnabled(on: boolean): Promise<unknown>;
    isMicrophoneEnabled: boolean;
  };
}

export async function startVoiceAgentSession(
  options: StartVoiceAgentOptions,
): Promise<VoiceAgentController> {
  const { boardId, onStateChange, onTranscript, onError } = options;
  const roomName = `voice_${boardId}`;
  let stopped = false;
  let muted = false;
  const attachedAudioElements: HTMLMediaElement[] = [];

  onStateChange("connecting");

  try {
    // 1. Summon the Voice Agent worker to the room via dispatch
    const dispatchRes = await apiFetch("/api/livekit/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId, room: roomName }),
    });

    if (!dispatchRes.ok) {
      const errData = (await dispatchRes.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      // If dispatch fails with 503 (e.g. LiveKit not configured), warn cleanly
      if (dispatchRes.status === 503) {
        throw new Error(errData.error || "LiveKit is not configured on this server.");
      }
      // Non-fatal if worker is already listening/auto-dispatched, but report detail if error
      console.warn("Agent dispatch response:", dispatchRes.status, errData);
    }

    if (stopped) throw new Error("Voice session was stopped");

    // 2. Fetch connection token for the room
    const tokenRes = await apiFetch("/api/livekit/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId, room: roomName }),
    });

    if (!tokenRes.ok) {
      const errData = (await tokenRes.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(errData.error || `Failed to mint token (${tokenRes.status})`);
    }

    const { token, url } = (await tokenRes.json()) as {
      token: string;
      url: string;
    };

    if (stopped) throw new Error("Voice session was stopped");

    // 3. Dynamically import livekit-client
    const livekit = (await import(/* @vite-ignore */ "livekit-client")) as {
      Room: new (opts?: unknown) => LiveKitRoom;
      RoomEvent: Record<string, string>;
      Track: { Kind: { Audio: string; Video: string } };
    };

    const room = new livekit.Room({
      adaptiveStream: true,
      audioCaptureDefaults: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // 4. Listen for incoming remote tracks from the agent
    room.on(
      livekit.RoomEvent.TrackSubscribed || "trackSubscribed",
      (track: LiveKitTrack, _pub: unknown, participant: LiveKitParticipant) => {
        if (track.kind === "audio") {
          const el = track.attach();
          el.autoplay = true;
          el.setAttribute("data-livekit-agent", participant.identity || "agent");
          document.body.appendChild(el);
          attachedAudioElements.push(el);
          onStateChange("agent_speaking");
        }
      },
    );

    room.on(
      livekit.RoomEvent.TrackUnsubscribed || "trackUnsubscribed",
      (track: LiveKitTrack) => {
        track.detach();
      },
    );

    // 5. Active speaker detection for agent speaking state
    room.on(
      livekit.RoomEvent.ActiveSpeakersChanged || "activeSpeakersChanged",
      (speakers: LiveKitParticipant[]) => {
        const isAgent = speakers.some(
          (s) => s.identity !== room.localParticipant?.identity,
        );
        if (isAgent) {
          onStateChange("agent_speaking");
        } else {
          onStateChange("listening");
        }
      },
    );

    // 6. Real-time transcription events
    room.on(
      livekit.RoomEvent.TranscriptionReceived || "transcriptionReceived",
      (segments: Array<{ text: string; final: boolean; participant?: any }>) => {
        for (const seg of segments) {
          const participantId =
            typeof seg.participant === "string"
              ? seg.participant
              : seg.participant?.identity || "";
          const isAgent = participantId !== room.localParticipant?.identity;
          onTranscript?.({
            text: seg.text,
            final: seg.final,
            isAgent,
            timestamp: Date.now(),
          });
        }
      },
    );

    room.on(livekit.RoomEvent.Disconnected || "disconnected", () => {
      onStateChange("disconnected");
    });

    // 7. Connect to LiveKit room and publish local microphone
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);

    onStateChange("listening");

    return {
      disconnect() {
        if (stopped) return;
        stopped = true;
        for (const el of attachedAudioElements) {
          el.remove();
        }
        void room.disconnect();
        onStateChange("disconnected");
      },
      async setMuted(nextMuted: boolean) {
        muted = nextMuted;
        await room.localParticipant.setMicrophoneEnabled(!nextMuted);
      },
      isMuted() {
        return muted;
      },
    };
  } catch (err) {
    onStateChange("error");
    const msg = (err as Error).message;
    onError?.(msg);
    throw err;
  }
}
