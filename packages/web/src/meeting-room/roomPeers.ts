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
}

export type RoomPeerAction =
  | { type: "peer-joined"; identity: string; name: string }
  | { type: "peer-left"; identity: string }
  | { type: "reset" }
  | { type: "track"; identity: string; kind: "audio" | "video" | "screen"; on: boolean }
  | { type: "speakers"; identities: string[] };

const blank = (identity: string, name: string): RoomPeer => ({
  identity,
  name,
  micOn: false,
  camOn: false,
  screenOn: false,
  speaking: false,
});

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
