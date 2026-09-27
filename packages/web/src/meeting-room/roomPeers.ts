import { captureSince, handFrom, optedOutFrom } from "./callProtocol.js";

/**
 * Native room peer state (docs/22 native-meeting direction).
 *
 * A tiny pure reducer over LiveKit room events: who is here, who has
 * mic/camera on, who is speaking. The React component translates SDK
 * callbacks into these actions; tests drive the reducer directly, so
 * peer-list logic never needs a browser, a room, or a camera.
 *
 * Deliberately media-only: transcript turns, extraction, and answers
 * live in MeetingView/MeetingEngine. The room knows people and tracks,
 * nothing else — LiveKit is transport, not the meeting brain.
 */

export interface RoomPeer {
  identity: string;
  name: string;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  speaking: boolean;
  /** When their hand went up (docs/28 S5); null when it's down. */
  handAt: number | null;
  /** Their device is transcribing the meeting (rule 4: capture is never invisible). */
  capture: boolean;
  /** When that transcription started; the earliest one is the call's transcript. */
  captureAt: number | null;
  /** They asked not to be transcribed (docs/28 §4.3). */
  optedOut: boolean;
  /** LiveKit's view of their link; "poor" and "lost" show on the tile. */
  quality: "excellent" | "good" | "poor" | "lost" | "unknown";
}

export type RoomPeerAction =
  | { type: "peer-joined"; identity: string; name: string }
  | { type: "peer-left"; identity: string }
  | { type: "reset" }
  | { type: "track"; identity: string; kind: "audio" | "video" | "screen"; on: boolean }
  | { type: "speakers"; identities: string[] }
  | { type: "attributes"; identity: string; attributes: Record<string, string> | undefined }
  | { type: "hand"; identity: string; handAt: number | null }
  | { type: "quality"; identity: string; quality: RoomPeer["quality"] };

const blank = (identity: string, name: string): RoomPeer => ({
  identity,
  name,
  micOn: false,
  camOn: false,
  screenOn: false,
  speaking: false,
  handAt: null,
  capture: false,
  captureAt: null,
  optedOut: false,
  quality: "unknown",
});

/**
 * The synthetic identity the local participant is stored under (the session
 * publishes it as "local", and its media tiles use the same id). Speaker events
 * carry the participant's REAL identity, so the session maps the local one to
 * this before dispatching — see MeetingSessionContext.
 */
export const LOCAL_IDENTITY = "local";

/**
 * Peers to render as remote tiles: everyone except the local participant. The
 * local person has their own dedicated tile, so including them here drew them
 * twice (F6).
 */
export function remotePeers(peers: ReadonlyMap<string, RoomPeer>): RoomPeer[] {
  return [...peers.values()].filter((p) => p.identity !== LOCAL_IDENTITY);
}

/** Whether the local participant is currently speaking (for their own tile's ring). */
export function localSpeaking(peers: ReadonlyMap<string, RoomPeer>): boolean {
  return peers.get(LOCAL_IDENTITY)?.speaking ?? false;
}

export function roomPeers(
  peers: ReadonlyMap<string, RoomPeer>,
  action: RoomPeerAction,
): Map<string, RoomPeer> {
  const next = new Map(peers);
  switch (action.type) {
    case "peer-joined": {
      const existing = next.get(action.identity);
      next.set(
        action.identity,
        existing
          ? { ...existing, name: action.name || existing.name }
          : blank(action.identity, action.name),
      );
      return next;
    }
    case "peer-left": {
      next.delete(action.identity);
      return next;
    }
    case "reset":
      return new Map();
    case "track": {
      const existing = next.get(action.identity) ?? blank(action.identity, action.identity);
      const field =
        action.kind === "audio" ? "micOn" : action.kind === "video" ? "camOn" : "screenOn";
      next.set(action.identity, { ...existing, [field]: action.on });
      return next;
    }
    case "attributes": {
      const existing = next.get(action.identity) ?? blank(action.identity, action.identity);
      const captureAt = captureSince(action.attributes);
      next.set(action.identity, {
        ...existing,
        handAt: handFrom(action.attributes),
        capture: captureAt !== null,
        captureAt,
        optedOut: optedOutFrom(action.attributes),
      });
      return next;
    }
    case "hand": {
      const existing = next.get(action.identity);
      if (existing) next.set(action.identity, { ...existing, handAt: action.handAt });
      return next;
    }
    case "quality": {
      const existing = next.get(action.identity);
      if (existing && existing.quality !== action.quality) {
        next.set(action.identity, { ...existing, quality: action.quality });
      }
      return next;
    }
    case "speakers": {
      const live = new Set(action.identities);
      for (const [id, peer] of next) {
        const speaking = live.has(id);
        if (peer.speaking !== speaking) next.set(id, { ...peer, speaking });
      }
      return next;
    }
  }
}
