import type { LiveKitConfig } from "./livekit.js";

/**
 * The board's video call as a meeting room (docs/28 A3.2): who hosts it, who
 * the host removed, and the host's powers — mute, remove, end for everyone.
 *
 * LiveKit owns the room; the server owns the decisions. The call's own state
 * lives in the LiveKit room's metadata (JSON, below), which only a holder of
 * the API secret can write and every participant can read — so a host badge
 * or a removal can't be forged by a client, and there is no table to keep in
 * step with a room LiveKit may close on its own. When the last person leaves,
 * LiveKit closes the room after `DEPARTURE_TIMEOUT_S` (docs/28 §9.1: two
 * minutes), and the next call starts clean — a removal lasts for the meeting
 * it was made in, as in Zoom and Meet.
 *
 * Participants never get `roomAdmin` or `canUpdateOwnMetadata`: a raised hand
 * and the "transcribing" mark are participant attributes the server sets on
 * the caller's own behalf (`setAttributes`), because the grant that would let
 * a client set them would also let it rename itself.
 */

/** Seconds LiveKit keeps a room after its last participant leaves (§9.1). */
export const DEPARTURE_TIMEOUT_S = 120;
/** Seconds an explicitly created room waits for its first participant. */
export const EMPTY_TIMEOUT_S = 300;

/** The call's state, stored as the LiveKit room's metadata. */
export interface CallMeta {
  v: 1;
  /** User ids with host powers: the person who started the call, and whoever a host made co-host. */
  hosts: string[];
  /** User ids the host removed from this call; the token route refuses them. */
  removed: string[];
  startedBy: string;
  startedAt: number;
}

export type CallTrackSource =
  | "microphone"
  | "camera"
  | "screen_share"
  | "screen_share_audio"
  | "unknown";

export interface CallTrack {
  sid: string;
  source: CallTrackSource;
  muted: boolean;
}

export interface CallParticipant {
  identity: string;
  name: string;
  joinedAt: number;
  tracks: CallTrack[];
  attributes: Record<string, string>;
}

export interface CallRoom {
  meta: CallMeta | null;
  participants: CallParticipant[];
}

/**
 * The room operations the call routes need. The LiveKit implementation is
 * below; tests use `InMemoryCallControl`.
 */
export interface CallControl {
  /**
   * Create the room with `initial` as its metadata, or return the existing
   * room's metadata unchanged. LiveKit returns an existing room as it is, so
   * of two people starting the same call at once exactly one becomes host.
   */
  open(room: string, initial: CallMeta): Promise<CallMeta | null>;
  /** The room and who is in it; null when no call is running. */
  read(room: string): Promise<CallRoom | null>;
  setMeta(room: string, meta: CallMeta): Promise<void>;
  /** Set attributes on one participant; an empty string removes one. */
  setAttributes(room: string, identity: string, attributes: Record<string, string>): Promise<void>;
  mute(room: string, identity: string, trackSid: string): Promise<void>;
  /** Disconnect one participant and void the tokens they already hold. */
  remove(room: string, identity: string): Promise<void>;
  /** End the call for everyone. */
  end(room: string): Promise<void>;
}

/** The LiveKit room a board's call runs in. */
export function callRoomName(boardId: string): string {
  return `board-${boardId}`;
}

export function newCallMeta(userId: string, now: number): CallMeta {
  return { v: 1, hosts: [userId], removed: [], startedBy: userId, startedAt: now };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Read room metadata; null for a room with none (or with someone else's). */
export function parseCallMeta(raw: string | null | undefined): CallMeta | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.v !== 1) return null;
    return {
      v: 1,
      hosts: stringList(value.hosts),
      removed: stringList(value.removed),
      startedBy: typeof value.startedBy === "string" ? value.startedBy : "",
      startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
    };
  } catch {
    return null;
  }
}

export type CallAdmission =
  | { kind: "removed" }
  | { kind: "admitted"; host: boolean; meta: CallMeta; changed: boolean };

/**
 * Decide one person's entry to a running call. A removed person stays out
 * for this call. A host is a host. Otherwise, when none of the hosts is in the
 * room — the host left, or the room predates host metadata — the person
 * joining becomes a host too, so a call is never left without anyone who can
 * end it (Zoom hands the host on the same way).
 */
export function admitToCall(
  meta: CallMeta | null,
  present: readonly string[],
  userId: string,
  now: number,
): CallAdmission {
  const current = meta ?? { ...newCallMeta(userId, now), hosts: [] };
  if (current.removed.includes(userId)) return { kind: "removed" };
  if (current.hosts.includes(userId)) {
    return { kind: "admitted", host: true, meta: current, changed: meta === null };
  }
  const hostHere = current.hosts.some((h) => present.includes(h));
  if (hostHere) return { kind: "admitted", host: false, meta: current, changed: false };
  return {
    kind: "admitted",
    host: true,
    meta: { ...current, hosts: [...current.hosts, userId] },
    changed: true,
  };
}

export function isCallHost(meta: CallMeta | null, userId: string): boolean {
  return meta?.hosts.includes(userId) ?? false;
}

/** Record a removal; the host list loses the person too. */
export function withRemoved(meta: CallMeta, userId: string): CallMeta {
  return {
    ...meta,
    hosts: meta.hosts.filter((h) => h !== userId),
    removed: meta.removed.includes(userId) ? meta.removed : [...meta.removed, userId],
  };
}

export function withHost(meta: CallMeta, userId: string): CallMeta {
  return meta.hosts.includes(userId) ? meta : { ...meta, hosts: [...meta.hosts, userId] };
}

/** The participant attributes the server sets for a caller (docs/28 S5). */
export const CALL_ATTRIBUTES = {
  /** Epoch ms the hand went up; absent when it's down. The order is who raised first. */
  hand: "lucent.hand",
  /** "on" while this person's device transcribes the meeting (rule 4). */
  capture: "lucent.capture",
} as const;

// --- LiveKit ---------------------------------------------------------------

const TRACK_SOURCES: Record<number, CallTrackSource> = {
  0: "unknown",
  1: "camera",
  2: "microphone",
  3: "screen_share",
  4: "screen_share_audio",
};
/** ParticipantInfo_State.DISCONNECTED */
const DISCONNECTED = 3;

function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  return e?.status === 404 || e?.code === "not_found" || /not.?found/i.test(e?.message ?? "");
}

/**
 * RoomService over the configured LiveKit project. The SDK is imported on
 * first use, the way the agent dispatch route does, so a deployment without
 * calls never loads it.
 */
export function createLiveKitCallControl(config: LiveKitConfig): CallControl {
  const host = config.url.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
  type Client = import("livekit-server-sdk").RoomServiceClient;
  let client: Promise<Client> | null = null;
  const svc = (): Promise<Client> => {
    client ??= import("livekit-server-sdk").then(
      (sdk) => new sdk.RoomServiceClient(host, config.apiKey, config.apiSecret),
    );
    return client;
  };

  return {
    async open(room, initial) {
      const created = await (
        await svc()
      ).createRoom({
        name: room,
        emptyTimeout: EMPTY_TIMEOUT_S,
        departureTimeout: DEPARTURE_TIMEOUT_S,
        metadata: JSON.stringify(initial),
      });
      return parseCallMeta(created.metadata);
    },
    async read(room) {
      const rs = await svc();
      const [info] = await rs.listRooms([room]);
      if (!info) return null;
      let people: Awaited<ReturnType<Client["listParticipants"]>> = [];
      try {
        people = await rs.listParticipants(room);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      return {
        meta: parseCallMeta(info.metadata),
        participants: people
          .filter((p) => Number(p.state) !== DISCONNECTED)
          .map((p) => ({
            identity: p.identity,
            name: p.name || p.identity,
            joinedAt: Number(p.joinedAtMs) || Number(p.joinedAt) * 1000,
            tracks: p.tracks.map((t) => ({
              sid: t.sid,
              source: TRACK_SOURCES[Number(t.source)] ?? "unknown",
              muted: t.muted,
            })),
            attributes: { ...p.attributes },
          })),
      };
    },
    async setMeta(room, meta) {
      await (await svc()).updateRoomMetadata(room, JSON.stringify(meta));
    },
    async setAttributes(room, identity, attributes) {
      await (await svc()).updateParticipant(room, identity, { attributes });
    },
    async mute(room, identity, trackSid) {
      await (await svc()).mutePublishedTrack(room, identity, trackSid, true);
    },
    async remove(room, identity) {
      // Tokens minted before now stop working for this identity, so a removed
      // client can't reconnect with the token it already holds.
      await (
        await svc()
      ).removeParticipant(room, identity, {
        revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 1),
      });
    },
    async end(room) {
      try {
        await (await svc()).deleteRoom(room);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
  };
}

// --- In memory (tests) -------------------------------------------------------

/**
 * A stand-in LiveKit for tests: rooms, their metadata, and participants a test
 * adds with `join`. It records every host action so a test can assert on it.
 */
export class InMemoryCallControl implements CallControl {
  readonly rooms = new Map<string, CallRoom>();
  readonly log: string[] = [];

  join(room: string, participant: Partial<CallParticipant> & { identity: string }): void {
    const r = this.rooms.get(room);
    if (!r) throw new Error(`no room ${room}`);
    r.participants = [
      ...r.participants.filter((p) => p.identity !== participant.identity),
      {
        name: participant.identity,
        joinedAt: 0,
        tracks: [],
        attributes: {},
        ...participant,
      },
    ];
  }

  async open(room: string, initial: CallMeta): Promise<CallMeta | null> {
    const existing = this.rooms.get(room);
    if (existing) return existing.meta;
    this.rooms.set(room, { meta: initial, participants: [] });
    return initial;
  }

  async read(room: string): Promise<CallRoom | null> {
    const r = this.rooms.get(room);
    return r ? { meta: r.meta, participants: r.participants.map((p) => ({ ...p })) } : null;
  }

  async setMeta(room: string, meta: CallMeta): Promise<void> {
    const r = this.rooms.get(room);
    if (!r) throw Object.assign(new Error("room not found"), { status: 404 });
    r.meta = meta;
  }

  async setAttributes(
    room: string,
    identity: string,
    attributes: Record<string, string>,
  ): Promise<void> {
    const p = this.rooms.get(room)?.participants.find((x) => x.identity === identity);
    if (!p) throw Object.assign(new Error("participant not found"), { status: 404 });
    for (const [k, v] of Object.entries(attributes)) {
      if (v === "") delete p.attributes[k];
      else p.attributes[k] = v;
    }
    this.log.push(`attributes ${identity} ${JSON.stringify(attributes)}`);
  }

  async mute(room: string, identity: string, trackSid: string): Promise<void> {
    const t = this.rooms
      .get(room)
      ?.participants.find((x) => x.identity === identity)
      ?.tracks.find((x) => x.sid === trackSid);
    if (t) t.muted = true;
    this.log.push(`mute ${identity} ${trackSid}`);
  }

  async remove(room: string, identity: string): Promise<void> {
    const r = this.rooms.get(room);
    if (r) r.participants = r.participants.filter((p) => p.identity !== identity);
    this.log.push(`remove ${identity}`);
  }

  async end(room: string): Promise<void> {
    this.rooms.delete(room);
    this.log.push(`end ${room}`);
  }
}
