import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "../http.js";
import { roomPeers, type RoomPeer } from "./roomPeers.js";
import type { ConversationalLease } from "../meeting-voice.js";

export interface MediaTile {
  key: string;
  identity: string;
  name: string;
  kind: "audio" | "video";
  screen: boolean;
  track: LiveKitTrack;
}

export interface LiveKitTrack {
  kind: string;
  source: string;
  attach(): HTMLElement;
  detach(): void;
  isMuted?: boolean;
  stop?(): void;
  mediaStreamTrack?: MediaStreamTrack;
}

export interface LiveKitPublication {
  track?: LiveKitTrack;
  isMuted: boolean;
  source: string;
  kind: string;
}

export interface LiveKitParticipant {
  identity: string;
  name?: string;
  isLocal?: boolean;
  audioTrackPublications: Map<string, LiveKitPublication>;
  videoTrackPublications: Map<string, LiveKitPublication>;
}

export interface LiveKitRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  on(event: string, cb: (...args: never[]) => void): void;
  off(event: string, cb: (...args: never[]) => void): void;
  localParticipant: LiveKitParticipant & {
    setMicrophoneEnabled(on: boolean): Promise<unknown>;
    setCameraEnabled(on: boolean): Promise<unknown>;
    setScreenShareEnabled(on: boolean): Promise<unknown>;
  };
  remoteParticipants: Map<string, LiveKitParticipant>;
}

export type RoomStatus = "idle" | "joining" | "live" | "error";

interface MeetingSessionValue {
  status: RoomStatus;
  error: string | null;
  activeBoardId: string | null;
  peers: Map<string, RoomPeer>;
  tiles: MediaTile[];
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  activeLease: ConversationalLease | null;
  setActiveLease: React.Dispatch<React.SetStateAction<ConversationalLease | null>>;
  setMicOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamOn: React.Dispatch<React.SetStateAction<boolean>>;
  join: (targetBoardId: string | null) => Promise<void>;
  leave: (keepError?: boolean) => void;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  toggleScreen: () => Promise<void>;
}

const MeetingSessionContext = createContext<MeetingSessionValue | null>(null);

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Map<string, RoomPeer>>(new Map());
  const [tiles, setTiles] = useState<MediaTile[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [activeLease, setActiveLease] = useState<ConversationalLease | null>(null);

  const roomRef = useRef<LiveKitRoom | null>(null);
  const deadRef = useRef(false);

  const act = useCallback(
    (action: Parameters<typeof roomPeers>[1]) => setPeers((prev) => roomPeers(prev, action)),
    [],
  );

  const leave = useCallback((keepError = false) => {
    deadRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      try {
        const lp = room.localParticipant;
        for (const pub of lp.audioTrackPublications.values()) {
          pub.track?.stop?.();
          pub.track?.mediaStreamTrack?.stop();
        }
        for (const pub of lp.videoTrackPublications.values()) {
          pub.track?.stop?.();
          pub.track?.mediaStreamTrack?.stop();
        }
        void lp.setMicrophoneEnabled(false).catch(() => {});
        void lp.setCameraEnabled(false).catch(() => {});
        void lp.setScreenShareEnabled(false).catch(() => {});
      } catch {}
      void room.disconnect(true).catch(() => {});
    }
    setTiles([]);
    setPeers(new Map());
    setScreenOn(false);
    setActiveLease(null);
    setActiveBoardId(null);
    setStatus(keepError ? "error" : "idle");
    if (!keepError) setError(null);
  }, []);

  const publishLocal = useCallback(
    (room: LiveKitRoom, identity: string, name: string) => {
      const lp = room.localParticipant;
      act({ type: "peer-joined", identity, name });
      for (const pub of lp.audioTrackPublications.values()) {
        if (pub.track) {
          const track = pub.track;
          setTiles((prev) => [
            ...prev.filter((t) => !(t.identity === identity && t.kind === "audio")),
            { key: `${identity}-audio`, identity, name, kind: "audio", screen: false, track },
          ]);
        }
      }
      for (const pub of lp.videoTrackPublications.values()) {
        if (pub.track) {
          const track = pub.track;
          const screen = pub.source === "screen_share";
          const key = `${identity}-${screen ? "screen" : "video"}`;
          setTiles((prev) => [
            ...prev.filter((t) => t.key !== key),
            { key, identity, name, kind: "video", screen, track },
          ]);
        }
      }
    },
    [act],
  );

  const join = useCallback(
    async (targetBoardId: string | null) => {
      setError(null);
      setStatus("joining");
      setActiveBoardId(targetBoardId);
      deadRef.current = false;
      try {
        const roomName = targetBoardId ? `board-${targetBoardId}` : "lucent-voice";
        const resp = await apiFetch("/api/livekit/token", {
          method: "POST",
          body: JSON.stringify({ boardId: targetBoardId, room: roomName }),
        });
        if (!resp.ok) {
          if (resp.status === 503) {
            throw new Error("LiveKit is not configured on this Lucent server.");
          }
          const text = await resp.text();
          throw new Error(`Token request failed (${resp.status}): ${text}`);
        }
        const data = (await resp.json()) as { token: string; url: string };

        // Dynamic import of LiveKit client SDK
        const sdk = (await import("livekit-client")) as unknown as {
          Room: new () => LiveKitRoom;
          RoomEvent: Record<string, string>;
        };
        const room = new sdk.Room();
        roomRef.current = room;

        room.on(sdk.RoomEvent.ParticipantConnected ?? "participantConnected", ((
          p: LiveKitParticipant,
        ) => {
          act({ type: "peer-joined", identity: p.identity, name: p.name ?? p.identity });
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.ParticipantDisconnected ?? "participantDisconnected", ((
          p: LiveKitParticipant,
        ) => {
          act({ type: "peer-left", identity: p.identity });
          setTiles((prev) => prev.filter((t) => t.identity !== p.identity));
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.TrackSubscribed ?? "trackSubscribed", ((
          track: LiveKitTrack,
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const identity = p.identity;
          const name = p.name ?? p.identity;
          const kind = track.kind === "video" ? "video" : "audio";
          const screen = pub.source === "screen_share";
          const key = `${identity}-${screen ? "screen" : kind}`;
          act({ type: "track", identity, kind, on: true });
          setTiles((prev) => [
            ...prev.filter((t) => t.key !== key),
            { key, identity, name, kind, screen, track },
          ]);
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.TrackUnsubscribed ?? "trackUnsubscribed", ((
          track: LiveKitTrack,
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const identity = p.identity;
          const kind = track.kind === "video" ? "video" : "audio";
          const screen = pub.source === "screen_share";
          const key = `${identity}-${screen ? "screen" : kind}`;
          act({ type: "track", identity, kind, on: false });
          setTiles((prev) => prev.filter((t) => t.key !== key));
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.TrackMuted ?? "trackMuted", ((
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const identity = p.identity;
          const kind = pub.kind === "video" ? "video" : "audio";
          act({ type: "track", identity, kind, on: false });
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.TrackUnmuted ?? "trackUnmuted", ((
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const identity = p.identity;
          const kind = pub.kind === "video" ? "video" : "audio";
          act({ type: "track", identity, kind, on: true });
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.ActiveSpeakersChanged ?? "activeSpeakersChanged", ((
          speakers: LiveKitParticipant[],
        ) => {
          act({ type: "speakers", identities: speakers.map((s) => s.identity) });
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.Disconnected ?? "disconnected", (() => {
          if (!deadRef.current) leave();
        }) as (...args: never[]) => void);

        await room.connect(data.url, data.token);

        try {
          await room.localParticipant.setMicrophoneEnabled(micOn);
          await room.localParticipant.setCameraEnabled(camOn);
        } catch (err) {
          console.warn("[lucent] mic/cam enable error:", err);
        }

        publishLocal(room, "local", "You");
        setStatus("live");
      } catch (err) {
        setError((err as Error).message);
        leave(true);
      }
    },
    [act, camOn, leave, micOn, publishLocal],
  );

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
      act({ type: "track", identity: "local", kind: "audio", on: next });
    } catch (err) {
      setError(`Microphone error: ${(err as Error).message}`);
    }
  }, [act, micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    try {
      await room.localParticipant.setCameraEnabled(next);
      setCamOn(next);
      act({ type: "track", identity: "local", kind: "video", on: next });
      if (!next) {
        setTiles((prev) => prev.filter((t) => !(t.identity === "local" && !t.screen)));
      } else {
        publishLocal(room, "local", "You");
      }
    } catch (err) {
      setError(`Camera error: ${(err as Error).message}`);
    }
  }, [act, camOn, publishLocal]);

  const toggleScreen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !screenOn;
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenOn(next);
    } catch (err) {
      setError(`Screen share error: ${(err as Error).message}`);
    }
  }, [screenOn]);

  // Clean up on app unmount
  useEffect(() => {
    return () => {
      leave();
    };
  }, [leave]);

  return (
    <MeetingSessionContext.Provider
      value={{
        status,
        error,
        activeBoardId,
        peers,
        tiles,
        micOn,
        camOn,
        screenOn,
        activeLease,
        setActiveLease,
        setMicOn,
        setCamOn,
        join,
        leave,
        toggleMic,
        toggleCam,
        toggleScreen,
      }}
    >
      {children}
    </MeetingSessionContext.Provider>
  );
}

export function useMeetingSession(): MeetingSessionValue {
  const ctx = useContext(MeetingSessionContext);
  if (!ctx) {
    throw new Error("useMeetingSession must be used within a MeetingSessionProvider");
  }
  return ctx;
}
