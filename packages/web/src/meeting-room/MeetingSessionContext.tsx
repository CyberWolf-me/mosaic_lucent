import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { describeMediaError, enableLocalMedia } from "./mediaErrors.js";
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

/**
 * A running meeting capture, published by the meeting view (docs/28 F14).
 * While one exists the app keeps the meeting view mounted — hidden when the
 * user works elsewhere — so leaving the view no longer stops the recording,
 * and the dock shows it with a Stop.
 */
export interface LiveCapture {
  boardId: string | null;
  startedAt: number;
  lines: number;
  /** False while transcription is stopped by an error; the capture stays open. */
  listening: boolean;
  /** Stop the capture exactly as the meeting view's Stop does. */
  stop: () => void;
}

interface MeetingSessionValue {
  status: RoomStatus;
  error: string | null;
  /**
   * A non-fatal media problem in a live call — a blocked mic, a busy camera
   * (docs/28 F18). `error` is the fatal kind the lobby shows; this one the
   * room and the dock show, and the call carries on.
   */
  notice: string | null;
  dismissNotice: () => void;
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
  capture: LiveCapture | null;
  setCapture: React.Dispatch<React.SetStateAction<LiveCapture | null>>;
}

const MeetingSessionContext = createContext<MeetingSessionValue | null>(null);

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Map<string, RoomPeer>>(new Map());
  const [tiles, setTiles] = useState<MediaTile[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [activeLease, setActiveLease] = useState<ConversationalLease | null>(null);
  const [capture, setCapture] = useState<LiveCapture | null>(null);

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
      } catch {
        /* best-effort media teardown */
      }
      void room.disconnect(true).catch(() => {});
    }
    setTiles([]);
    setPeers(new Map());
    setScreenOn(false);
    setActiveLease(null);
    setActiveBoardId(null);
    setStatus(keepError ? "error" : "idle");
    if (!keepError) setError(null);
    setNotice(null);
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
          // Speakers arrive by real identity; the local participant is stored
          // under "local" (its publish + tiles use that), so translate it or
          // the local speaking ring never lights (F6).
          const localId = room.localParticipant?.identity;
          act({
            type: "speakers",
            identities: speakers.map((s) =>
              s.isLocal || (localId !== undefined && s.identity === localId) ? "local" : s.identity,
            ),
          });
        }) as (...args: never[]) => void);

        // The browser's own "Stop sharing" ends the track without our button
        // (docs/28 F24): follow it, or the control keeps saying "sharing".
        room.on(sdk.RoomEvent.LocalTrackUnpublished ?? "localTrackUnpublished", ((
          pub: LiveKitPublication,
        ) => {
          if (pub.source !== "screen_share") return;
          setScreenOn(false);
          setTiles((prev) => prev.filter((t) => !(t.identity === "local" && t.screen)));
        }) as (...args: never[]) => void);

        room.on(sdk.RoomEvent.Disconnected ?? "disconnected", (() => {
          if (!deadRef.current) leave();
        }) as (...args: never[]) => void);

        await room.connect(data.url, data.token);

        // Mic and camera independently (docs/28 F18): each control shows what
        // really came on, and the reason for anything that didn't is on screen.
        const media = await enableLocalMedia(room.localParticipant, { mic: micOn, cam: camOn });
        setMicOn(media.mic);
        setCamOn(media.cam);
        setNotice(media.notice);

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
      setNotice(describeMediaError("microphone", err));
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
      setNotice(describeMediaError("camera", err));
    }
  }, [act, camOn, publishLocal]);

  const toggleScreen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !screenOn;
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenOn(next);
      // The local screen tile used to be published only at join and on a
      // camera toggle, so your own share never showed (docs/28 F24).
      if (next) publishLocal(room, "local", "You");
      else setTiles((prev) => prev.filter((t) => !(t.identity === "local" && t.screen)));
    } catch (err) {
      // Cancelling the browser's picker is a choice, not a failure: null.
      setNotice(describeMediaError("screen", err));
    }
  }, [publishLocal, screenOn]);

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
        notice,
        dismissNotice: () => setNotice(null),
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
        capture,
        setCapture,
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
