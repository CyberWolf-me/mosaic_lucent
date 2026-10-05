import { apiFetch } from "../http.js";

export type VoiceAgentState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "agent_speaking"
  | "error"
  | "disconnected";

export interface VoiceAgentTranscript {
  /** LiveKit's segment id: one utterance, whose text grows until it's final. */
  id: string;
  text: string;
  final: boolean;
  isAgent: boolean;
  timestamp: number;
}

/** One line of the call's rolling transcript. */
export interface TranscriptLine {
  id: string;
  isAgent: boolean;
  text: string;
  final: boolean;
}

/** How many lines the bar keeps: the last exchange, not the whole call. */
export const TRANSCRIPT_LINES = 4;

/**
 * Fold one transcription segment into the rolling transcript. A segment is
 * updated in place as its words arrive (LiveKit re-sends the growing text
 * under the same id), and a new one is a new line — the bar used to show only
 * the latest segment, so it read as a few words that kept resetting.
 */
export function withTranscriptSegment(
  lines: readonly TranscriptLine[],
  seg: VoiceAgentTranscript,
  max = TRANSCRIPT_LINES,
): TranscriptLine[] {
  const text = seg.text.trim();
  if (!text) return [...lines];
  const line: TranscriptLine = { id: seg.id, isAgent: seg.isAgent, text, final: seg.final };
  const at = lines.findIndex((l) => l.id === seg.id);
  const next = at >= 0 ? lines.map((l, i) => (i === at ? line : l)) : [...lines, line];
  return next.slice(-max);
}

/** How long to wait for the agent to join before saying it isn't coming. */
export const AGENT_JOIN_TIMEOUT_MS = 15_000;

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
      if (dispatchRes.status === 503) {
        throw new Error(errData.error || "LiveKit is not configured on this server.");
      }
      // Joining a room the agent was never sent to is talking to no one: the
      // call used to open anyway and stay silent.
      throw new Error(
        errData.error
          ? `${errData.error}${errData.detail ? ` (${errData.detail})` : ""}`
          : `The voice agent couldn't be started (error ${dispatchRes.status}).`,
      );
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

    room.on(livekit.RoomEvent.TrackUnsubscribed || "trackUnsubscribed", (track: LiveKitTrack) => {
      track.detach();
    });

    // 5. Active speaker detection for agent speaking state
    room.on(
      livekit.RoomEvent.ActiveSpeakersChanged || "activeSpeakersChanged",
      (speakers: LiveKitParticipant[]) => {
        const isAgent = speakers.some((s) => s.identity !== room.localParticipant?.identity);
        if (isAgent) {
          onStateChange("agent_speaking");
        } else {
          const isLocalSpeaking = speakers.some(
            (s) => s.identity === room.localParticipant?.identity,
          );
          if (isLocalSpeaking) {
            onStateChange("listening");
          }
        }
      },
    );

    // 6. Real-time transcription events
    // Who spoke is the event's SECOND argument — the participant whose track
    // was transcribed — not a field on the segment. Reading it off the
    // segment found nothing, so every line, the person's own words included,
    // was shown as Lucent's.
    room.on(
      livekit.RoomEvent.TranscriptionReceived || "transcriptionReceived",
      (
        segments: Array<{ id?: string; text: string; final: boolean }>,
        speaker?: { identity?: string },
      ) => {
        const participantId = speaker?.identity ?? "";
        const isAgent = participantId !== "" && participantId !== room.localParticipant?.identity;
        for (const seg of segments) {
          onTranscript?.({
            id: seg.id ?? `${participantId}-${Date.now()}`,
            text: seg.text,
            final: seg.final,
            isAgent,
            timestamp: Date.now(),
          });
          if (!isAgent && seg.final && seg.text.trim()) {
            onStateChange("thinking");
          }
        }
      },
    );

    room.on(livekit.RoomEvent.Disconnected || "disconnected", () => {
      if (joinTimer) clearTimeout(joinTimer);
      onStateChange("disconnected");
    });

    // The agent is a separate worker process; if it never joins, say so
    // rather than leave the person talking to an empty room.
    let joinTimer: ReturnType<typeof setTimeout> | null = null;
    const agentArrived = () => {
      if (joinTimer) clearTimeout(joinTimer);
      joinTimer = null;
    };
    room.on(livekit.RoomEvent.ParticipantConnected || "participantConnected", agentArrived);

    // 7. Connect to LiveKit room and publish local microphone
    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);

    onStateChange("listening");
    const present = (room as unknown as { remoteParticipants?: Map<string, unknown> })
      .remoteParticipants;
    if (!present || present.size === 0) {
      joinTimer = setTimeout(() => {
        if (stopped) return;
        stopped = true;
        void room.disconnect();
        onStateChange("error");
        onError?.(
          "The voice agent didn't join. Its worker isn't running on this server (npm run dev -w @lucent/voice-agent), or it has no speech key (DEEPGRAM_API_KEY). Use the mic button to talk with Lucent in the browser instead.",
        );
      }, AGENT_JOIN_TIMEOUT_MS);
    }

    return {
      disconnect() {
        if (joinTimer) clearTimeout(joinTimer);
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
