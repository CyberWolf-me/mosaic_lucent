import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { describeMediaError, enableLocalMedia } from "./mediaErrors.js";
import { apiFetch } from "../http.js";
import { roomPeers, type RoomPeer } from "./roomPeers.js";
import type { ConversationalLease } from "../meeting-voice.js";
import {
  appendChat,
  CAPTION_TOPIC,
  CAPTION_TTL_MS,
  decodeCaption,
  encodeCaption,
  withCaption,
  type Caption,
  CHAT_TOPIC,
  createLineDedup,
  createLineGate,
  decodeLineAck,
  encodeLineAck,
  LINE_ACK_TOPIC,
  LINE_MAX_SENDS,
  LINE_RESEND_MS,
  decodeChat,
  decodeLine,
  decodeReaction,
  describeDisconnect,
  describeJoinFailure,
  encodeChat,
  encodeLine,
  encodeReaction,
  handFrom,
  LINE_TOPIC,
  readCallMeta,
  REACTION_TOPIC,
  MODE_TOPIC,
  encodeModeChange,
  decodeModeChange,
  captureSince,
  rejoinMarker,
  rejoinOffer,
  REJOIN_KEY,
  transcriberOf,
  type CallEnd,
  type CallMeta,
  type ChatMessage,
  type Reaction,
} from "./callProtocol.js";
import { MODE_LABELS } from "../meeting-modes.js";
import {
  loadDeviceChoice,
  saveDeviceChoice,
  type DeviceChoice,
  type DeviceKind,
} from "./devices.js";
import { useSettings } from "../settings.js";
import { resolveSttProvider, type SttProviderId, type VoiceSession } from "../stt/index.js";

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
  /** Without an element, detaches from every element — the dock's and the room's alike. */
  detach(element?: HTMLElement): void;
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
  attributes?: Record<string, string>;
  audioTrackPublications: Map<string, LiveKitPublication>;
  videoTrackPublications: Map<string, LiveKitPublication>;
}

export interface LiveKitRoom {
  connect(url: string, token: string): Promise<void>;
  disconnect(stopTracks?: boolean): Promise<void>;
  on(event: string, cb: (...args: never[]) => void): void;
  off(event: string, cb: (...args: never[]) => void): void;
  metadata?: string;
  canPlaybackAudio?: boolean;
  startAudio(): Promise<void>;
  switchActiveDevice(kind: MediaDeviceKind, deviceId: string): Promise<boolean>;
  localParticipant: LiveKitParticipant & {
    setMicrophoneEnabled(on: boolean, options?: { deviceId?: string }): Promise<unknown>;
    setCameraEnabled(on: boolean, options?: { deviceId?: string }): Promise<unknown>;
    setScreenShareEnabled(on: boolean): Promise<unknown>;
    publishData(
      data: Uint8Array,
      options?: { reliable?: boolean; topic?: string; destinationIdentities?: string[] },
    ): Promise<void>;
  };
  remoteParticipants: Map<string, LiveKitParticipant>;
}

/**
 * The call's connection (docs/28 §4.2): `idle` and `error` show the lobby
 * (with the join failure in `error`), `ended` shows why the call ended
 * (`ended`) with Rejoin; `live` and `reconnecting` are in the call.
 */
export type RoomStatus = "idle" | "joining" | "live" | "reconnecting" | "error" | "ended";

/** In the call, including while the connection recovers. */
export function inCall(status: RoomStatus): boolean {
  return status === "live" || status === "reconnecting";
}

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

/** A reaction floating over someone's tile for a few seconds. */
export interface LiveReaction {
  id: number;
  identity: string;
  name: string;
  emoji: Reaction;
}

export type HostAction =
  | { kind: "mute"; identity: string }
  | { kind: "mute-everyone" }
  | { kind: "remove"; identity: string }
  | { kind: "make-host"; identity: string }
  | { kind: "lower-hand"; identity: string }
  | { kind: "end" };

interface MeetingSessionValue {
  status: RoomStatus;
  /** Why the last join failed, in words (S4). */
  error: string | null;
  /** Why the call ended, when it didn't end by leaving (S5). */
  ended: Exclude<CallEnd, { kind: "left" }> | null;
  /**
   * A non-fatal problem in a live call — a blocked mic, a busy camera
   * (docs/28 F18), "The host muted you". The call carries on.
   */
  notice: string | null;
  dismissNotice: () => void;
  /** A passing event ("Alice raised a hand"), cleared after a few seconds. */
  toast: string | null;
  activeBoardId: string | null;
  peers: Map<string, RoomPeer>;
  tiles: MediaTile[];
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  /** The call's host list and start, from the room (server-written). */
  meta: CallMeta | null;
  /** You host this call (docs/28 §6). */
  isHost: boolean;
  /** Your LiveKit identity (your user id) while in a call. */
  selfIdentity: string | null;
  /** Your name as the call shows it to others. */
  selfName: string | null;
  /** The browser blocked call audio until the person clicks (autoplay policy). */
  audioBlocked: boolean;
  startAudio: () => void;
  activeLease: ConversationalLease | null;
  setActiveLease: React.Dispatch<React.SetStateAction<ConversationalLease | null>>;
  setMicOn: React.Dispatch<React.SetStateAction<boolean>>;
  setCamOn: React.Dispatch<React.SetStateAction<boolean>>;
  devices: DeviceChoice;
  /** Choose a device — in the lobby it's remembered; in a call it switches now. */
  chooseDevice: (kind: DeviceKind, deviceId: string) => Promise<void>;
  /** Join the board's call; `options` overrides the lobby's mic and camera choice. */
  join: (targetBoardId: string | null, options?: { mic?: boolean; cam?: boolean }) => Promise<void>;
  cancelJoin: () => void;
  leave: (keepError?: boolean) => void;
  /** Close the "call ended" screen, back to the lobby. */
  dismissEnded: () => void;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  toggleScreen: () => Promise<void>;
  chat: ChatMessage[];
  chatUnread: number;
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  sendChat: (text: string) => Promise<boolean>;
  reactions: LiveReaction[];
  sendReaction: (emoji: Reaction) => void;
  handUp: boolean;
  setHand: (up: boolean) => Promise<void>;
  hostAction: (action: HostAction) => Promise<boolean>;
  /** The call this tab was in when the page reloaded (S6), offered back. */
  rejoin: { boardId: string } | null;
  dismissRejoin: () => void;
  capture: LiveCapture | null;
  setCapture: React.Dispatch<React.SetStateAction<LiveCapture | null>>;
  /**
   * Whose device keeps the call's transcript (docs/28 A3.5): the first person
   * who started transcribing. Null when nobody is.
   */
  transcriber: { identity: string; name: string; isLocal: boolean } | null;
  /** You agree to be transcribed in this call (the default); off is "Stop transcribing me". */
  transcribeMe: boolean;
  setTranscribeMe: (on: boolean) => Promise<void>;
  /** How this device is contributing your words to someone else's transcript. */
  contribution: Contribution;
  /**
   * Hear each line another person's device sends to this device's transcript;
   * returns the unsubscribe. The sender is the LiveKit participant, never the
   * payload.
   */
  subscribeLines: (listener: (line: RemoteLine) => void) => () => void;
  /** You read live captions (the CC button). */
  captionsOn: boolean;
  setCaptionsOn: (on: boolean) => Promise<void>;
  /** The captions on screen now, one line per recent speaker. */
  captions: Caption[];
  /** Someone else in the call reads captions, so your device transcribes you. */
  captionsRequested: boolean;
  /**
   * Send this device's own speech as a caption — for the tab that records,
   * whose recognizer is the recording's (a browser runs one at a time).
   */
  broadcastCaption: (text: string, final: boolean) => void;
  /** The host's call settings: lock the call; let only hosts present; let guests straight in. */
  setCallSettings: (settings: {
    locked?: boolean;
    hostsOnlyShare?: boolean;
    openToGuests?: boolean;
  }) => Promise<boolean>;
  /** You asked to join as a guest, and wait for a host (docs/28 S5, A6). */
  waitingToJoin: boolean;
  /** Tell the call Lucent's mode changed on this (the recording) device (docs/28 §9.5). */
  announceMode: (mode: string) => void;
  /** A host lets a waiting guest in, or keeps them out of this call. */
  answerGuest: (userId: string, allow: boolean) => Promise<boolean>;
}

/** One line of someone else's speech, sent to this device's transcript. */
export interface RemoteLine {
  identity: string;
  name: string;
  text: string;
}

/**
 * Your part in someone else's transcript: `live` while your device
 * transcribes you, `paused` while your mic is off, `off` when you opted out
 * or nobody is transcribing, `unsupported` when this browser can't.
 */
export type Contribution = "off" | "live" | "paused" | "unsupported";

const MeetingSessionContext = createContext<MeetingSessionValue | null>(null);

const LOCAL = "local";
const REACTION_MS = 4000;
const TOAST_MS = 4000;

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* the rejoin offer is a convenience */
  }
}

/** POST to one of the board call's routes; the server's words on failure. */
async function callRoute(
  boardId: string,
  action: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/call/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: json.error ?? `That didn't work (error ${res.status}).` };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again." };
  }
}

export function MeetingSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RoomStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<Exclude<CallEnd, { kind: "left" }> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waitingToJoin, setWaitingToJoin] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Map<string, RoomPeer>>(new Map());
  const [tiles, setTiles] = useState<MediaTile[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [meta, setMeta] = useState<CallMeta | null>(null);
  const [selfIdentity, setSelfIdentity] = useState<string | null>(null);
  const [selfName, setSelfName] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [devices, setDevices] = useState<DeviceChoice>(() => loadDeviceChoice());
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatOpen, setChatOpenState] = useState(false);
  const [reactions, setReactions] = useState<LiveReaction[]>([]);
  const [rejoin, setRejoin] = useState<{ boardId: string } | null>(() =>
    rejoinOffer(readSession(REJOIN_KEY), Date.now()),
  );
  const [activeLease, setActiveLease] = useState<ConversationalLease | null>(null);
  const [capture, setCapture] = useState<LiveCapture | null>(null);
  const [transcribeMe, setTranscribeMeState] = useState(true);
  const [contribution, setContribution] = useState<Contribution>("off");
  const [captionsOn, setCaptionsOnState] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);

  const lineListeners = useRef(new Set<(line: RemoteLine) => void>());
  const lineGate = useRef(createLineGate());
  const lineDedup = useRef(createLineDedup());
  /** Lines this device sent that the keeper hasn't acknowledged yet. */
  const pendingLines = useRef(
    new Map<string, { to: string; text: string; at: number; lastSent: number; sends: number }>(),
  );
  const lineToRef = useRef<string | null>(null);
  const roomRef = useRef<LiveKitRoom | null>(null);
  const deadRef = useRef(false);
  /**
   * The page is going away. LiveKit hangs up on `pagehide` itself and calls
   * it "client initiated" — read as Leave, that cleared the rejoin offer a
   * reload is meant to make (S6).
   */
  const unloadingRef = useRef(false);
  /** The browser froze this background tab; LiveKit hangs up then too. */
  const frozenRef = useRef(false);
  const joinSeq = useRef(0);
  const chatOpenRef = useRef(false);
  const captureRef = useRef<LiveCapture | null>(null);
  captureRef.current = capture;
  const boardRef = useRef<string | null>(null);
  const reactionSeq = useRef(0);
  const captureSent = useRef(false);
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;
  const micBusy = useRef(false);
  /** This person just ended the call for everyone: their own end reads "You ended…". */
  const endingRef = useRef(false);

  const act = useCallback(
    (action: Parameters<typeof roomPeers>[1]) => setPeers((prev) => roomPeers(prev, action)),
    [],
  );

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), TOAST_MS);
  }, []);

  /** Tear the room down; `status` is the caller's to set. */
  const teardown = useCallback(() => {
    deadRef.current = true;
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      try {
        const lp = room.localParticipant;
        for (const pub of [
          ...lp.audioTrackPublications.values(),
          ...lp.videoTrackPublications.values(),
        ]) {
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
    setMeta(null);
    setSelfIdentity(null);
    setSelfName(null);
    setAudioBlocked(false);
    setReactions([]);
    setNotice(null);
    captureSent.current = false;
  }, []);

  const leave = useCallback(
    (keepError = false) => {
      joinSeq.current++;
      teardown();
      writeSession(REJOIN_KEY, null);
      setActiveBoardId(null);
      boardRef.current = null;
      setChat([]);
      setChatUnread(0);
      setEnded(null);
      setStatus(keepError ? "error" : "idle");
      if (!keepError) setError(null);
    },
    [teardown],
  );

  const publishLocal = useCallback(
    (room: LiveKitRoom) => {
      const lp = room.localParticipant;
      act({ type: "peer-joined", identity: LOCAL, name: "You" });
      for (const pub of lp.videoTrackPublications.values()) {
        if (!pub.track) continue;
        const track = pub.track;
        const screen = pub.source === "screen_share";
        const key = `${LOCAL}-${screen ? "screen" : "video"}`;
        setTiles((prev) => [
          ...prev.filter((t) => t.key !== key),
          { key, identity: LOCAL, name: "You", kind: "video", screen, track },
        ]);
      }
    },
    [act],
  );

  const join = useCallback(
    async (targetBoardId: string | null, options?: { mic?: boolean; cam?: boolean }) => {
      const seq = ++joinSeq.current;
      const wantMic = options?.mic ?? micOn;
      const wantCam = options?.cam ?? camOn;
      const current = () => seq === joinSeq.current;
      setError(null);
      setEnded(null);
      setNotice(null);
      setStatus("joining");
      setActiveBoardId(targetBoardId);
      boardRef.current = targetBoardId;
      setChat([]);
      setChatUnread(0);
      setRejoin(null);
      // A new participant session starts with no attributes on the server,
      // so "Stop transcribing me" starts off too.
      setTranscribeMeState(true);
      frozenRef.current = false;
      setCaptionsOnState(false);
      setCaptions([]);
      deadRef.current = false;
      endingRef.current = false;
      let data: { token: string; url: string };
      try {
        let resp: Response;
        // docs/28 S5 (A6): a guest waits to be let in — ask again every few
        // seconds until a host answers, or until Cancel.
        for (;;) {
          try {
            resp = await apiFetch("/api/livekit/token", {
              method: "POST",
              body: JSON.stringify(
                targetBoardId
                  ? { boardId: targetBoardId, room: `board-${targetBoardId}` }
                  : { room: "lucent-voice" },
              ),
            });
          } catch {
            setWaitingToJoin(false);
            throw new Error(describeJoinFailure(null));
          }
          if (resp.status !== 202) break;
          if (!current()) return;
          setWaitingToJoin(true);
          await new Promise((r) => setTimeout(r, 3000));
          if (!current()) {
            setWaitingToJoin(false);
            return;
          }
        }
        setWaitingToJoin(false);
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as {
            error?: string;
            removed?: boolean;
            locked?: boolean;
            denied?: boolean;
          };
          throw new Error(describeJoinFailure(resp.status, body));
        }
        data = (await resp.json()) as { token: string; url: string };
        if (!current()) return;

        const sdk = (await import("livekit-client")) as unknown as {
          Room: new (options?: Record<string, unknown>) => LiveKitRoom;
          RoomEvent: Record<string, string>;
          DisconnectReason: Record<number, string>;
        };
        const room = new sdk.Room({
          adaptiveStream: true,
          dynacast: true,
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          ...(devices.audiooutput ? { audioOutput: { deviceId: devices.audiooutput } } : {}),
        });
        roomRef.current = room;
        // Development only: scripts/meeting-call-check.mjs drives LiveKit's own
        // reconnect scenarios through this handle. Production builds drop it.
        if (import.meta.env.DEV)
          (window as unknown as { __lucentCall?: unknown }).__lucentCall = room;
        const E = sdk.RoomEvent;
        const on = (event: string | undefined, fallback: string, cb: (...args: never[]) => void) =>
          room.on(event ?? fallback, cb);
        const idOf = (p: LiveKitParticipant) =>
          p.isLocal || p.identity === room.localParticipant.identity ? LOCAL : p.identity;
        const nameOf = (p: LiveKitParticipant) =>
          idOf(p) === LOCAL ? "You" : p.name || p.identity;
        const seedPeer = (p: LiveKitParticipant) => {
          const identity = idOf(p);
          act({ type: "peer-joined", identity, name: nameOf(p) });
          act({ type: "attributes", identity, attributes: p.attributes });
          for (const pub of p.audioTrackPublications.values()) {
            if (pub.source === "microphone") {
              act({ type: "track", identity, kind: "audio", on: !pub.isMuted });
            }
          }
          for (const pub of p.videoTrackPublications.values()) {
            act({
              type: "track",
              identity,
              kind: pub.source === "screen_share" ? "screen" : "video",
              on: !pub.isMuted,
            });
          }
        };

        on(E.ParticipantConnected, "participantConnected", ((p: LiveKitParticipant) => {
          seedPeer(p);
        }) as (...args: never[]) => void);

        on(E.ParticipantDisconnected, "participantDisconnected", ((p: LiveKitParticipant) => {
          act({ type: "peer-left", identity: p.identity });
          setTiles((prev) => prev.filter((t) => t.identity !== p.identity));
        }) as (...args: never[]) => void);

        on(E.TrackSubscribed, "trackSubscribed", ((
          track: LiveKitTrack,
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const identity = p.identity;
          const kind = track.kind === "video" ? "video" : "audio";
          const screen = pub.source === "screen_share" || pub.source === "screen_share_audio";
          const key = `${identity}-${screen ? `screen-${kind}` : kind}`;
          if (pub.source !== "screen_share_audio") {
            act({
              type: "track",
              identity,
              kind: screen ? "screen" : kind,
              on: !pub.isMuted,
            });
          }
          setTiles((prev) => [
            ...prev.filter((t) => t.key !== key),
            { key, identity, name: p.name || identity, kind, screen, track },
          ]);
        }) as (...args: never[]) => void);

        on(E.TrackUnsubscribed, "trackUnsubscribed", ((
          track: LiveKitTrack,
          pub: LiveKitPublication,
          p: LiveKitParticipant,
        ) => {
          const kind = track.kind === "video" ? "video" : "audio";
          const screen = pub.source === "screen_share" || pub.source === "screen_share_audio";
          const key = `${p.identity}-${screen ? `screen-${kind}` : kind}`;
          if (pub.source !== "screen_share_audio") {
            act({ type: "track", identity: p.identity, kind: screen ? "screen" : kind, on: false });
          }
          setTiles((prev) => prev.filter((t) => t.key !== key));
        }) as (...args: never[]) => void);

        const muteChange = (muted: boolean) =>
          ((pub: LiveKitPublication, p: LiveKitParticipant) => {
            const identity = idOf(p);
            if (pub.source === "screen_share_audio") return;
            const kind =
              pub.source === "screen_share" ? "screen" : pub.kind === "video" ? "video" : "audio";
            act({ type: "track", identity, kind, on: !muted });
            // The host muted this device's mic: the control follows, and says why.
            if (identity === LOCAL && pub.source === "microphone") {
              if (muted && micOnRef.current && !micBusy.current) {
                setNotice("The host muted you. Unmute when you're ready to speak.");
              }
              if (!micBusy.current) setMicOn(!muted);
            }
          }) as (...args: never[]) => void;
        on(E.TrackMuted, "trackMuted", muteChange(true));
        on(E.TrackUnmuted, "trackUnmuted", muteChange(false));

        on(E.ActiveSpeakersChanged, "activeSpeakersChanged", ((speakers: LiveKitParticipant[]) => {
          // Speakers arrive by real identity; the local participant is stored
          // under "local", so translate it or the local ring never lights (F6).
          act({ type: "speakers", identities: speakers.map(idOf) });
        }) as (...args: never[]) => void);

        // The browser's own "Stop sharing" ends the track without our button
        // (docs/28 F24): follow it, or the control keeps saying "sharing".
        on(E.LocalTrackUnpublished, "localTrackUnpublished", ((pub: LiveKitPublication) => {
          if (pub.source !== "screen_share") return;
          setScreenOn(false);
          setTiles((prev) => prev.filter((t) => !(t.identity === LOCAL && t.screen)));
        }) as (...args: never[]) => void);

        on(E.RoomMetadataChanged, "roomMetadataChanged", ((raw: string) => {
          setMeta((prev) => {
            const next = readCallMeta(raw);
            // An older update delivered late must not undo a newer one.
            if (prev && next && next.rev < prev.rev) return prev;
            const self = room.localParticipant.identity;
            if (next && prev && !prev.hosts.includes(self) && next.hosts.includes(self)) {
              showToast("You're now a host of this call.");
            }
            return next;
          });
        }) as (...args: never[]) => void);

        on(E.ParticipantAttributesChanged, "participantAttributesChanged", ((
          _changed: Record<string, string>,
          p: LiveKitParticipant,
        ) => {
          const identity = idOf(p);
          const handAt = handFrom(p.attributes);
          setPeers((prev) => {
            const before = prev.get(identity);
            if (identity !== LOCAL && handAt !== null && before && before.handAt === null) {
              showToast(`${nameOf(p)} raised a hand`);
            }
            return roomPeers(prev, { type: "attributes", identity, attributes: p.attributes });
          });
        }) as (...args: never[]) => void);

        on(E.ConnectionQualityChanged, "connectionQualityChanged", ((
          quality: string,
          p: LiveKitParticipant,
        ) => {
          const q = ["excellent", "good", "poor", "lost"].includes(quality)
            ? (quality as RoomPeer["quality"])
            : "unknown";
          act({ type: "quality", identity: idOf(p), quality: q });
        }) as (...args: never[]) => void);

        on(E.DataReceived, "dataReceived", ((
          payload: Uint8Array,
          p: LiveKitParticipant | undefined,
          _kind: unknown,
          topic: string | undefined,
        ) => {
          // Only people in the room send data; a server-sent packet has no participant.
          if (!p) return;
          if (topic === LINE_TOPIC) {
            // A line of someone's speech for this device's transcript. Dropped
            // unless this tab is recording, and past a sane rate per sender.
            const line = decodeLine(payload);
            if (!line || !captureRef.current || lineListeners.current.size === 0) return;
            if (!lineGate.current(p.identity, Date.now())) return;
            // Filed once, acknowledged every time: a resend means our receipt was lost.
            if (lineDedup.current(p.identity, line.id)) {
              const remote = { identity: p.identity, name: p.name || p.identity, text: line.text };
              for (const listener of lineListeners.current) listener(remote);
            }
            if (line.id) {
              void room.localParticipant
                .publishData(encodeLineAck(line.id), {
                  reliable: true,
                  topic: LINE_ACK_TOPIC,
                  destinationIdentities: [p.identity],
                })
                .catch(() => {});
            }
            return;
          }
          if (topic === LINE_ACK_TOPIC) {
            const id = decodeLineAck(payload);
            if (id) pendingLines.current.delete(id);
            return;
          }
          if (topic === CAPTION_TOPIC) {
            const caption = decodeCaption(payload);
            if (!caption) return;
            setCaptions((prev) =>
              withCaption(prev, {
                identity: p.identity,
                name: p.name || p.identity,
                text: caption.text,
                at: Date.now(),
              }),
            );
            return;
          }
          if (topic === CHAT_TOPIC) {
            const message = decodeChat(payload);
            if (!message) return;
            setChat((prev) =>
              appendChat(prev, {
                id: message.id,
                from: p.identity,
                name: p.name || p.identity,
                text: message.text,
                at: Date.now(),
              }),
            );
            if (!chatOpenRef.current) setChatUnread((n) => n + 1);
          } else if (topic === MODE_TOPIC) {
            // Only the device that records runs Lucent, so only its word counts.
            const mode = decodeModeChange(payload);
            if (!mode || !captureSince(p.attributes)) return;
            showToast(`${p.name || p.identity} switched Lucent to ${MODE_LABELS[mode]} mode`);
          } else if (topic === REACTION_TOPIC) {
            const emoji = decodeReaction(payload);
            if (!emoji) return;
            const id = ++reactionSeq.current;
            setReactions((prev) => [
              ...prev.slice(-20),
              { id, identity: p.identity, name: p.name || p.identity, emoji },
            ]);
            window.setTimeout(
              () => setReactions((prev) => prev.filter((r) => r.id !== id)),
              REACTION_MS,
            );
          }
        }) as (...args: never[]) => void);

        on(E.AudioPlaybackStatusChanged, "audioPlaybackChanged", (() => {
          setAudioBlocked(room.canPlaybackAudio === false);
        }) as (...args: never[]) => void);

        on(E.Reconnecting, "reconnecting", (() => {
          if (!deadRef.current) setStatus("reconnecting");
        }) as (...args: never[]) => void);
        on(E.Reconnected, "reconnected", (() => {
          if (!deadRef.current) setStatus("live");
        }) as (...args: never[]) => void);

        on(E.Disconnected, "disconnected", ((reason?: number | string) => {
          if (deadRef.current || unloadingRef.current) return;
          const name =
            typeof reason === "number" ? sdk.DisconnectReason?.[reason] : (reason ?? undefined);
          // A tab the browser froze in the background was dropped, not left.
          const described = frozenRef.current
            ? {
                kind: "lost" as const,
                text: "The call dropped while this tab was in the background.",
              }
            : describeDisconnect(name);
          const end =
            endingRef.current && described.kind === "ended"
              ? { kind: "ended" as const, text: "You ended the call for everyone." }
              : described;
          const board = boardRef.current;
          teardown();
          if (end.kind === "left") {
            leave();
            return;
          }
          // "End for everyone" ends the meeting, so a capture of it here ends
          // too — and its summary starts (docs/28 §9.1).
          if (end.kind === "ended" && captureRef.current && captureRef.current.boardId === board) {
            captureRef.current.stop();
          }
          // Removed or ended: no rejoin offer after a reload. Lost: offer it.
          writeSession(
            REJOIN_KEY,
            end.kind === "lost" && board ? rejoinMarker(board, Date.now()) : null,
          );
          setEnded(end);
          setStatus("ended");
        }) as (...args: never[]) => void);

        await room.connect(data.url, data.token);
        if (!current()) {
          void room.disconnect(true).catch(() => {});
          return;
        }
        setSelfIdentity(room.localParticipant.identity);
        setSelfName(room.localParticipant.name || null);
        setMeta(readCallMeta(room.metadata));
        setAudioBlocked(room.canPlaybackAudio === false);
        // People already here: ParticipantConnected fires only for later arrivals.
        for (const p of room.remoteParticipants.values()) seedPeer(p);

        // Mic and camera independently (docs/28 F18): each control shows what
        // really came on, and the reason for anything that didn't is on screen.
        micBusy.current = true;
        const media = await enableLocalMedia(
          room.localParticipant,
          { mic: wantMic, cam: wantCam },
          devices,
        );
        micBusy.current = false;
        if (!current()) return;
        setMicOn(media.mic);
        setCamOn(media.cam);
        setNotice(media.notice);
        act({ type: "track", identity: LOCAL, kind: "audio", on: media.mic });
        act({ type: "track", identity: LOCAL, kind: "video", on: media.cam });
        publishLocal(room);
        if (targetBoardId) writeSession(REJOIN_KEY, rejoinMarker(targetBoardId, Date.now()));
        setStatus("live");
      } catch (err) {
        if (!current()) return;
        teardown();
        setError((err as Error).message);
        setStatus("error");
      }
    },
    [act, camOn, devices, leave, micOn, publishLocal, showToast, teardown],
  );

  const cancelJoin = useCallback(() => {
    setWaitingToJoin(false);
    leave();
  }, [leave]);

  const dismissEnded = useCallback(() => {
    setEnded(null);
    setActiveBoardId(null);
    setChat([]);
    setStatus("idle");
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    micBusy.current = true;
    try {
      await room.localParticipant.setMicrophoneEnabled(
        next,
        next && devices.audioinput ? { deviceId: devices.audioinput } : undefined,
      );
      setMicOn(next);
      act({ type: "track", identity: LOCAL, kind: "audio", on: next });
      if (next) setNotice((n) => (n?.startsWith("The host muted you") ? null : n));
    } catch (err) {
      setNotice(describeMediaError("microphone", err));
    } finally {
      // The muted event can trail the call that caused it.
      window.setTimeout(() => (micBusy.current = false), 300);
    }
  }, [act, devices.audioinput, micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    try {
      await room.localParticipant.setCameraEnabled(
        next,
        next && devices.videoinput ? { deviceId: devices.videoinput } : undefined,
      );
      setCamOn(next);
      act({ type: "track", identity: LOCAL, kind: "video", on: next });
      if (!next) {
        setTiles((prev) => prev.filter((t) => !(t.identity === LOCAL && !t.screen)));
      } else {
        publishLocal(room);
      }
    } catch (err) {
      setNotice(describeMediaError("camera", err));
    }
  }, [act, camOn, devices.videoinput, publishLocal]);

  const toggleScreen = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !screenOn;
    try {
      await room.localParticipant.setScreenShareEnabled(next);
      setScreenOn(next);
      act({ type: "track", identity: LOCAL, kind: "screen", on: next });
      // The local screen tile used to be published only at join and on a
      // camera toggle, so your own share never showed (docs/28 F24).
      if (next) publishLocal(room);
      else setTiles((prev) => prev.filter((t) => !(t.identity === LOCAL && t.screen)));
    } catch (err) {
      // Cancelling the browser's picker is a choice, not a failure: null.
      setNotice(describeMediaError("screen", err));
    }
  }, [act, publishLocal, screenOn]);

  const chooseDevice = useCallback(async (kind: DeviceKind, deviceId: string) => {
    setDevices((prev) => {
      const next = { ...prev, [kind]: deviceId };
      saveDeviceChoice(next);
      return next;
    });
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.switchActiveDevice(kind, deviceId);
    } catch (err) {
      setNotice(
        describeMediaError(kind === "videoinput" ? "camera" : "microphone", err) ??
          "Couldn't switch to that device.",
      );
    }
  }, []);

  const startAudio = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    void room
      .startAudio()
      .then(() => setAudioBlocked(room.canPlaybackAudio === false))
      .catch(() => {});
  }, []);

  const setChatOpen = useCallback((open: boolean) => {
    chatOpenRef.current = open;
    setChatOpenState(open);
    if (open) setChatUnread(0);
  }, []);

  const sendChat = useCallback(async (text: string): Promise<boolean> => {
    const room = roomRef.current;
    if (!room) return false;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const at = Date.now();
    const payload = encodeChat(text, id, at);
    if (!payload) return false;
    try {
      await room.localParticipant.publishData(payload, { reliable: true, topic: CHAT_TOPIC });
    } catch {
      setNotice("Your message didn't send. Try again.");
      return false;
    }
    setChat((prev) => appendChat(prev, { id, from: LOCAL, name: "You", text: text.trim(), at }));
    return true;
  }, []);

  const sendReaction = useCallback((emoji: Reaction) => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant
      .publishData(encodeReaction(emoji), { reliable: true, topic: REACTION_TOPIC })
      .catch(() => {});
    const id = ++reactionSeq.current;
    setReactions((prev) => [...prev.slice(-20), { id, identity: LOCAL, name: "You", emoji }]);
    window.setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== id)), REACTION_MS);
  }, []);

  const handUp = (peers.get(LOCAL)?.handAt ?? null) !== null;

  const setHand = useCallback(
    async (up: boolean) => {
      const board = boardRef.current;
      if (!board) return;
      const before = peers.get(LOCAL);
      act({ type: "hand", identity: LOCAL, handAt: up ? Date.now() : null });
      const result = await callRoute(board, "state", { hand: up });
      if (!result.ok) {
        act({ type: "hand", identity: LOCAL, handAt: before?.handAt ?? null });
        setNotice(result.error);
      }
    },
    [act, peers],
  );

  const hostAction = useCallback(async (action: HostAction): Promise<boolean> => {
    const board = boardRef.current;
    if (!board) return false;
    const [route, body]: [string, unknown] =
      action.kind === "mute"
        ? ["mute", { identity: action.identity }]
        : action.kind === "mute-everyone"
          ? ["mute", { everyone: true }]
          : action.kind === "remove"
            ? ["remove", { identity: action.identity }]
            : action.kind === "make-host"
              ? ["hosts", { identity: action.identity }]
              : action.kind === "lower-hand"
                ? ["state", { identity: action.identity, hand: false }]
                : ["end", {}];
    if (action.kind === "end") endingRef.current = true;
    const result = await callRoute(board, route, body);
    if (!result.ok) {
      endingRef.current = false;
      setNotice(result.error);
    }
    return result.ok;
  }, []);

  // Rule 4: while this tab transcribes the call's board, everyone in the call
  // sees it on this person's tile. The server sets the mark (calls.ts).
  useEffect(() => {
    if (status !== "live" || !activeBoardId) return;
    const on = capture !== null && capture.boardId === activeBoardId;
    if (on === captureSent.current) return;
    captureSent.current = on;
    void callRoute(activeBoardId, "state", { capture: on });
  }, [status, activeBoardId, capture]);

  const setTranscribeMe = useCallback(async (on: boolean) => {
    setTranscribeMeState(on);
    const board = boardRef.current;
    if (!board) return;
    // Others see the choice on this person's tile (docs/28 §4.3 `muted`).
    const result = await callRoute(board, "state", { transcribe: on });
    if (!result.ok) setNotice(result.error);
  }, []);

  const subscribeLines = useCallback((listener: (line: RemoteLine) => void) => {
    lineListeners.current.add(listener);
    return () => {
      lineListeners.current.delete(listener);
    };
  }, []);

  /** Put one line on the wire (sendLine keeps track of it until it's acknowledged). */
  const publishLine = useCallback((to: string, text: string, at: number, id: string) => {
    const room = roomRef.current;
    const payload = encodeLine(text, at, id);
    if (!room || !payload) return;
    void room.localParticipant
      .publishData(payload, { reliable: true, topic: LINE_TOPIC, destinationIdentities: [to] })
      .catch(() => {});
  }, []);

  /** One line of your speech, to the device keeping the call's transcript, until it says it has it. */
  const sendLine = useCallback(
    (to: string, text: string) => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const at = Date.now();
      pendingLines.current.set(id, { to, text, at, lastSent: at, sends: 1 });
      publishLine(to, text, at, id);
    },
    [publishLine],
  );

  // Resend what the keeper hasn't acknowledged — to whoever keeps the
  // transcript now — and give up after a few tries.
  useEffect(() => {
    if (!inCall(status)) {
      pendingLines.current.clear();
      return;
    }
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const [id, line] of pendingLines.current) {
        if (now - line.lastSent < LINE_RESEND_MS) continue;
        if (line.sends >= LINE_MAX_SENDS) {
          pendingLines.current.delete(id);
          continue;
        }
        const to = lineToRef.current ?? line.to;
        line.to = to;
        line.lastSent = now;
        line.sends += 1;
        publishLine(to, line.text, line.at, id);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status, publishLine]);

  const transcriber = useMemo(() => {
    const id = transcriberOf([...peers.values()]);
    const peer = id ? peers.get(id) : undefined;
    if (!peer) return null;
    const isLocal = peer.identity === LOCAL;
    return { identity: peer.identity, name: isLocal ? (selfName ?? "You") : peer.name, isLocal };
  }, [peers, selfName]);

  // Your words go to someone else's transcript while they record this call —
  // unless you opted out, or this tab records it itself.
  const recordingHere = capture !== null && capture.boardId === activeBoardId;
  const contributeTo =
    inCall(status) && transcriber && !transcriber.isLocal && transcribeMe && !recordingHere
      ? transcriber.identity
      : null;
  lineToRef.current = contributeTo;

  // Who reads captions besides you: your device sends them what it hears of you.
  const captionReaders = useMemo(
    () =>
      [...peers.values()].filter((p) => p.identity !== LOCAL && p.captions).map((p) => p.identity),
    [peers],
  );
  const captionsRequested = captionReaders.length > 0;
  const captionReadersRef = useRef(captionReaders);
  captionReadersRef.current = captionReaders;
  const captionsOnRef = useRef(captionsOn);
  captionsOnRef.current = captionsOn;
  const selfNameRef = useRef(selfName);
  selfNameRef.current = selfName;

  /** One caption of your speech, to the people reading captions — and to you. */
  const broadcastCaption = useCallback((text: string, final: boolean) => {
    const at = Date.now();
    if (captionsOnRef.current) {
      setCaptions((prev) => withCaption(prev, { identity: LOCAL, name: "You", text, at }));
    }
    const room = roomRef.current;
    const readers = captionReadersRef.current;
    const payload = encodeCaption(text, final);
    if (!room || !payload || readers.length === 0) return;
    // Words still being said go lossy — the next update supersedes them; the
    // finished line goes reliably, so the caption a reader is left with is right.
    void room.localParticipant
      .publishData(payload, {
        reliable: final,
        topic: CAPTION_TOPIC,
        destinationIdentities: readers,
      })
      .catch(() => {});
  }, []);

  const setCaptionsOn = useCallback(async (on: boolean) => {
    setCaptionsOnState(on);
    if (!on) setCaptions([]);
    const board = boardRef.current;
    if (!board) return;
    const result = await callRoute(board, "state", { captions: on });
    if (!result.ok) setNotice(result.error);
  }, []);

  const setCallSettings = useCallback(
    async (settings: { locked?: boolean; hostsOnlyShare?: boolean; openToGuests?: boolean }) => {
      const board = boardRef.current;
      if (!board) return false;
      const result = await callRoute(board, "settings", settings);
      if (!result.ok) setNotice(result.error);
      return result.ok;
    },
    [],
  );

  const announceMode = useCallback((mode: string) => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant
      .publishData(encodeModeChange(mode), { reliable: true, topic: MODE_TOPIC })
      .catch(() => {});
  }, []);

  const answerGuest = useCallback(async (userId: string, allow: boolean) => {
    const board = boardRef.current;
    if (!board) return false;
    const result = await callRoute(board, "admit", { userId, allow });
    if (!result.ok) setNotice(result.error);
    return result.ok;
  }, []);

  // Captions fade a few seconds after they stop changing.
  useEffect(() => {
    if (captions.length === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setCaptions((prev) => {
        const next = prev.filter((c) => now - c.at < CAPTION_TTL_MS);
        return next.length === prev.length ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [captions.length]);

  // Transcribe you on this device while your words are wanted — for someone
  // else's transcript, or for anyone's captions (yours included) — and never
  // after "Stop transcribing me", or while this tab records (its own
  // recognizer covers you then).
  const transcribeLocally =
    inCall(status) &&
    transcribeMe &&
    !recordingHere &&
    (contributeTo !== null || captionsRequested || captionsOn);

  // Clean up on app unmount (the marker stays: a reload offers the call back).
  useEffect(() => () => teardown(), [teardown]);
  useEffect(() => {
    const going = () => {
      unloadingRef.current = true;
    };
    // A page restored from the back-forward cache is back, not going.
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) unloadingRef.current = false;
    };
    const frozen = () => {
      frozenRef.current = true;
    };
    window.addEventListener("pagehide", going);
    window.addEventListener("beforeunload", going);
    window.addEventListener("pageshow", back);
    document.addEventListener("freeze", frozen);
    return () => {
      window.removeEventListener("pagehide", going);
      window.removeEventListener("beforeunload", going);
      window.removeEventListener("pageshow", back);
      document.removeEventListener("freeze", frozen);
    };
  }, []);

  const isHost = selfIdentity !== null && meta !== null && meta.hosts.includes(selfIdentity);

  const value = useMemo<MeetingSessionValue>(
    () => ({
      status,
      error,
      ended,
      notice,
      dismissNotice: () => setNotice(null),
      toast,
      activeBoardId,
      peers,
      tiles,
      micOn,
      camOn,
      screenOn,
      meta,
      isHost,
      selfIdentity,
      selfName,
      audioBlocked,
      startAudio,
      activeLease,
      setActiveLease,
      setMicOn,
      setCamOn,
      devices,
      chooseDevice,
      join,
      cancelJoin,
      leave,
      dismissEnded,
      toggleMic,
      toggleCam,
      toggleScreen,
      chat,
      chatUnread,
      chatOpen,
      setChatOpen,
      sendChat,
      reactions,
      sendReaction,
      handUp,
      setHand,
      hostAction,
      rejoin,
      dismissRejoin: () => {
        writeSession(REJOIN_KEY, null);
        setRejoin(null);
      },
      capture,
      setCapture,
      transcriber,
      transcribeMe,
      setTranscribeMe,
      contribution,
      subscribeLines,
      captionsOn,
      setCaptionsOn,
      captions,
      captionsRequested,
      broadcastCaption,
      setCallSettings,
      waitingToJoin,
      answerGuest,
      announceMode,
    }),
    [
      waitingToJoin,
      answerGuest,
      announceMode,
      captionsOn,
      setCaptionsOn,
      captions,
      captionsRequested,
      broadcastCaption,
      setCallSettings,
      transcriber,
      transcribeMe,
      setTranscribeMe,
      contribution,
      subscribeLines,
      status,
      error,
      ended,
      notice,
      toast,
      activeBoardId,
      peers,
      tiles,
      micOn,
      camOn,
      screenOn,
      meta,
      isHost,
      selfIdentity,
      selfName,
      audioBlocked,
      startAudio,
      activeLease,
      devices,
      chooseDevice,
      join,
      cancelJoin,
      leave,
      dismissEnded,
      toggleMic,
      toggleCam,
      toggleScreen,
      chat,
      chatUnread,
      chatOpen,
      setChatOpen,
      sendChat,
      reactions,
      sendReaction,
      handUp,
      setHand,
      hostAction,
      rejoin,
      capture,
    ],
  );

  return (
    <MeetingSessionContext.Provider value={value}>
      {children}
      <CallAudio tiles={tiles} />
      <CallTranscriber
        active={transcribeLocally}
        lineTo={contributeTo}
        micOn={micOn}
        onLine={sendLine}
        onCaption={broadcastCaption}
        onState={setContribution}
      />
    </MeetingSessionContext.Provider>
  );
}

/**
 * A provider that can feed someone else's live transcript: lines must arrive
 * as they're spoken, so providers that transcribe only at stop (on-device
 * Whisper) and LiveKit's agent room are out.
 */
function liveProvider(preferred: SttProviderId) {
  const order: SttProviderId[] =
    preferred === "browser" || preferred === "hosted"
      ? [preferred, "browser", "hosted"]
      : ["browser", "hosted"];
  for (const id of order) {
    const { provider } = resolveSttProvider(id);
    if (provider.id === id && !provider.finalsAtStop) return provider;
  }
  return null;
}

/**
 * Transcribes you, on your own device, while someone else in the call records
 * it (docs/28 A3.5): each finished line goes to their device, which files it
 * under your name. Nothing runs while your mic is off, and nothing at all
 * after "Stop transcribing me".
 */
function CallTranscriber({
  active,
  lineTo,
  micOn,
  onLine,
  onCaption,
  onState,
}: {
  /** Your words are wanted — for a transcript or for captions. */
  active: boolean;
  /** The device keeping the call's transcript, when someone records. */
  lineTo: string | null;
  micOn: boolean;
  onLine: (to: string, text: string) => void;
  onCaption: (text: string, final: boolean) => void;
  onState: (state: Contribution) => void;
}) {
  const [settings] = useSettings();
  const preferred = settings.sttProvider;
  // Read at each line, so the recognizer keeps running when someone starts
  // or stops recording while captions are on.
  const lineToRef = useRef(lineTo);
  lineToRef.current = lineTo;
  useEffect(() => {
    if (!active) {
      onState("off");
      return;
    }
    if (!micOn) {
      onState("paused");
      return;
    }
    const provider = liveProvider(preferred);
    if (!provider) {
      onState("unsupported");
      return;
    }
    let session: VoiceSession | null = null;
    session = provider.start({
      onInterim: (text) => {
        if (text.trim()) onCaption(text, false);
      },
      onFinal: (text) => {
        const line = text.trim();
        if (!line) return;
        onCaption(line, true);
        if (lineToRef.current) onLine(lineToRef.current, line);
      },
      onError: (message) => {
        if (message) onState("unsupported");
      },
    });
    onState(session ? "live" : "unsupported");
    return () => session?.stop();
  }, [active, micOn, preferred, onLine, onCaption, onState]);
  return null;
}

/**
 * Every remote voice, attached once, wherever the person is in the app. The
 * room and the dock draw video only; audio used to be attached by neither,
 * so a call could be silent.
 */
function CallAudio({ tiles }: { tiles: MediaTile[] }) {
  const audio = tiles.filter((t) => t.kind === "audio" && t.identity !== LOCAL);
  return (
    <div hidden aria-hidden>
      {audio.map((t) => (
        <AudioSink key={t.key} tile={t} />
      ))}
    </div>
  );
}

function AudioSink({ tile }: { tile: MediaTile }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const el = tile.track.attach() as HTMLAudioElement;
    el.autoplay = true;
    host.appendChild(el);
    return () => {
      try {
        tile.track.detach(el);
      } catch {
        /* teardown race */
      }
      el.remove();
    };
  }, [tile]);
  return <div ref={ref} />;
}

export function useMeetingSession(): MeetingSessionValue {
  const ctx = useContext(MeetingSessionContext);
  if (!ctx) {
    throw new Error("useMeetingSession must be used within a MeetingSessionProvider");
  }
  return ctx;
}
