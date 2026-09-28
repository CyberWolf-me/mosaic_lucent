/**
 * The board call's own vocabulary (docs/28 A3.2): host metadata, the data
 * messages people send each other (chat, reactions), why a call ended, what a
 * failed join says, and the marker that offers a rejoin after a reload.
 *
 * Pure, so the rules are tested without a room, a camera or a browser. The
 * session (MeetingSessionContext) feeds LiveKit's events through these; the
 * room UI renders what they return.
 *
 * The host list is the server's (`server/src/calls.ts`), stored as the LiveKit
 * room's metadata, which clients can read and never write. A data message's
 * sender is the LiveKit participant that sent it — never a name inside the
 * payload — so nobody can post chat as someone else.
 */

/** The call's state, as the server writes it into the room's metadata. */
export interface CallMeta {
  hosts: string[];
  removed: string[];
  startedBy: string;
  startedAt: number;
  /** No one new gets in (the host's lock). */
  locked: boolean;
  /** Only hosts may present. */
  hostsOnlyShare: boolean;
  /** Guests asking to join (docs/28 S5, A6), oldest first; a host answers. */
  waiting: Array<{ userId: string; name: string; at: number }>;
  /** Guests come in without asking (the host turned the waiting room off). */
  openToGuests: boolean;
  /** The server's write counter: an update older than the one held is stale. */
  rev: number;
}

/** Participant attributes the server sets (mirrors `CALL_ATTRIBUTES` on the server). */
export const CALL_ATTRIBUTES = {
  hand: "lucent.hand",
  capture: "lucent.capture",
  optOut: "lucent.optout",
  captions: "lucent.cc",
} as const;

/** This person reads live captions. */
export function captionsFrom(attributes: Record<string, string> | undefined): boolean {
  return attributes?.[CALL_ATTRIBUTES.captions] === "1";
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function readCallMeta(raw: string | undefined | null): CallMeta | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value?.v !== 1) return null;
    return {
      hosts: strings(value.hosts),
      removed: strings(value.removed),
      startedBy: typeof value.startedBy === "string" ? value.startedBy : "",
      startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
      locked: value.locked === true,
      hostsOnlyShare: value.hostsOnlyShare === true,
      waiting: Array.isArray(value.waiting)
        ? value.waiting.flatMap((w: Record<string, unknown>) =>
            typeof w?.userId === "string" && typeof w.name === "string" && typeof w.at === "number"
              ? [{ userId: w.userId, name: w.name, at: w.at }]
              : [],
          )
        : [],
      openToGuests: value.openToGuests === true,
      rev: typeof value.rev === "number" ? value.rev : 0,
    };
  } catch {
    return null;
  }
}

/** When the hand went up (epoch ms), or null when it's down. */
export function handFrom(attributes: Record<string, string> | undefined): number | null {
  const raw = attributes?.[CALL_ATTRIBUTES.hand];
  const at = raw ? Number(raw) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * When this person's device started transcribing the meeting (epoch ms), or
 * null. An older server wrote "on"; it reads as the earliest possible start.
 */
export function captureSince(attributes: Record<string, string> | undefined): number | null {
  const raw = attributes?.[CALL_ATTRIBUTES.capture];
  if (!raw) return null;
  if (raw === "on") return 1;
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : null;
}

export function captureFrom(attributes: Record<string, string> | undefined): boolean {
  return captureSince(attributes) !== null;
}

/** This person asked not to be transcribed (docs/28 §4.3 `muted`). */
export function optedOutFrom(attributes: Record<string, string> | undefined): boolean {
  return attributes?.[CALL_ATTRIBUTES.optOut] === "1";
}

/**
 * Whose transcript the call feeds (docs/28 A3.5): the person who started
 * transcribing first. One call, one transcript — everyone else's device sends
 * its lines there, so turn numbers, citations and extraction stay one record.
 */
export function transcriberOf(
  people: ReadonlyArray<{ identity: string; captureAt: number | null }>,
): string | null {
  let best: { identity: string; captureAt: number } | null = null;
  for (const p of people) {
    if (p.captureAt === null) continue;
    if (
      !best ||
      p.captureAt < best.captureAt ||
      (p.captureAt === best.captureAt && p.identity < best.identity)
    ) {
      best = { identity: p.identity, captureAt: p.captureAt };
    }
  }
  return best?.identity ?? null;
}

// --- Data messages -------------------------------------------------------

export const CHAT_TOPIC = "lucent.chat";
export const REACTION_TOPIC = "lucent.reaction";
/** docs/28 §9.5: the recording device switched Lucent's mode mid-meeting. */
export const MODE_TOPIC = "lucent.mode";
const MODES = ["record", "intelligence", "assistant", "participant"] as const;

export function encodeModeChange(mode: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, mode }));
}

/** The mode a switch announced, or null for anything else. */
export function decodeModeChange(payload: Uint8Array): (typeof MODES)[number] | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    const mode = value?.v === 1 ? value.mode : null;
    return (MODES as readonly unknown[]).includes(mode) ? (mode as (typeof MODES)[number]) : null;
  } catch {
    return null;
  }
}
export const MAX_CHAT_CHARS = 1000;
/** The reactions on offer — Meet's set, short enough to learn. */
export const REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"] as const;
export type Reaction = (typeof REACTIONS)[number];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A chat message as it travels; null for an empty or over-long one. */
export function encodeChat(text: string, id: string, at: number): Uint8Array | null {
  const body = text.trim();
  if (!body || body.length > MAX_CHAT_CHARS) return null;
  return encoder.encode(JSON.stringify({ v: 1, id, text: body, at }));
}

export function decodeChat(payload: Uint8Array): { id: string; text: string; at: number } | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
    if (value?.v !== 1 || typeof value.text !== "string" || typeof value.id !== "string") {
      return null;
    }
    const text = value.text.trim().slice(0, MAX_CHAT_CHARS);
    if (!text) return null;
    return { id: value.id.slice(0, 64), text, at: typeof value.at === "number" ? value.at : 0 };
  } catch {
    return null;
  }
}

export function encodeReaction(emoji: Reaction): Uint8Array {
  return encoder.encode(JSON.stringify({ v: 1, emoji }));
}

/** Only the offered reactions decode, so a message can't paint arbitrary text over a tile. */
export function decodeReaction(payload: Uint8Array): Reaction | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as { v?: unknown; emoji?: unknown };
    return value?.v === 1 && (REACTIONS as readonly unknown[]).includes(value.emoji)
      ? (value.emoji as Reaction)
      : null;
  } catch {
    return null;
  }
}

/**
 * One finished line of someone's speech, sent by their own device to the
 * device that keeps the transcript (docs/28 A3.5). Who said it is the LiveKit
 * participant that sent it — the payload carries only the words.
 */
export const LINE_TOPIC = "lucent.line";
export const MAX_LINE_CHARS = 2000;

/**
 * `id` is the sender's own name for the line: the keeper acknowledges it
 * (LINE_ACK_TOPIC) and the sender resends until it does, so a data channel
 * that hiccups mid-meeting doesn't cost anyone their words; a resend the
 * keeper already filed is recognised by its id and dropped.
 */
export function encodeLine(text: string, at: number, id = ""): Uint8Array | null {
  const body = text.trim();
  if (!body || body.length > MAX_LINE_CHARS) return null;
  return encoder.encode(JSON.stringify({ v: 1, text: body, at, id }));
}

export function decodeLine(payload: Uint8Array): { text: string; at: number; id: string } | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
    if (value?.v !== 1 || typeof value.text !== "string") return null;
    const text = value.text.trim().slice(0, MAX_LINE_CHARS);
    return text
      ? {
          text,
          at: typeof value.at === "number" ? value.at : 0,
          id: typeof value.id === "string" ? value.id.slice(0, 64) : "",
        }
      : null;
  } catch {
    return null;
  }
}

/** The keeper's receipt for a line, sent back to its speaker. */
export const LINE_ACK_TOPIC = "lucent.line-ack";

export function encodeLineAck(id: string): Uint8Array {
  return encoder.encode(JSON.stringify({ v: 1, id }));
}

export function decodeLineAck(payload: Uint8Array): string | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as { v?: unknown; id?: unknown };
    return value?.v === 1 && typeof value.id === "string" && value.id ? value.id : null;
  } catch {
    return null;
  }
}

/** How often, and how many times, an unacknowledged line is sent again. */
export const LINE_RESEND_MS = 2500;
export const LINE_MAX_SENDS = 6;

/**
 * The keeper's memory of lines it filed, per speaker: true the first time an
 * id is seen, false for a resend. Bounded, oldest forgotten first.
 */
export function createLineDedup(max = 500): (sender: string, id: string) => boolean {
  const seen = new Map<string, string[]>();
  return (sender, id) => {
    if (!id) return true;
    const ids = seen.get(sender) ?? [];
    if (ids.includes(id)) return false;
    ids.push(id);
    if (ids.length > max) ids.shift();
    seen.set(sender, ids);
    return true;
  };
}

/**
 * A per-sender flood gate for incoming lines: people finish a sentence every
 * few seconds, so more than `max` lines in `windowMs` from one device is a
 * broken or hostile client, and the extra lines are dropped.
 */
export function createLineGate(max = 8, windowMs = 5000): (sender: string, now: number) => boolean {
  const seen = new Map<string, number[]>();
  return (sender, now) => {
    const recent = (seen.get(sender) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      seen.set(sender, recent);
      return false;
    }
    recent.push(now);
    seen.set(sender, recent);
    return true;
  };
}

/**
 * Live captions (docs/28 S5): each speaker's own device sends what it hears
 * of them — the words so far, then the finished line — to the people who
 * turned captions on. Never stored: a caption is gone a few seconds after it
 * stops changing. The speaker is the sending participant, as with lines.
 */
export const CAPTION_TOPIC = "lucent.caption";
/** A caption shows the end of a long utterance; this is how much. */
export const MAX_CAPTION_CHARS = 240;
/** How long a caption stays once it stops changing. */
export const CAPTION_TTL_MS = 6000;

export function encodeCaption(text: string, final: boolean): Uint8Array | null {
  const body = text.trim();
  if (!body) return null;
  return encoder.encode(JSON.stringify({ v: 1, text: body.slice(-MAX_CAPTION_CHARS), final }));
}

export function decodeCaption(payload: Uint8Array): { text: string; final: boolean } | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
    if (value?.v !== 1 || typeof value.text !== "string") return null;
    const text = value.text.trim().slice(-MAX_CAPTION_CHARS);
    return text ? { text, final: value.final === true } : null;
  } catch {
    return null;
  }
}

export interface Caption {
  identity: string;
  name: string;
  text: string;
  at: number;
}

/**
 * The captions on screen after one more arrives: one line per speaker (the
 * newest words replace theirs), the three most recent speakers, nothing
 * older than CAPTION_TTL_MS.
 */
export function withCaption(list: readonly Caption[], next: Caption): Caption[] {
  return [...list.filter((c) => c.identity !== next.identity), next]
    .filter((c) => next.at - c.at < CAPTION_TTL_MS)
    .slice(-3);
}

export interface ChatMessage {
  id: string;
  /** The sender's participant identity ("local" for you). */
  from: string;
  name: string;
  text: string;
  at: number;
}

/** Messages kept per call: enough for any real meeting, bounded for a runaway one. */
export const MAX_CHAT_MESSAGES = 500;

/** Add a message, once (a resend arrives with the same id), in time order. */
export function appendChat(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === message.id && m.from === message.from)) return [...list];
  return [...list, message].slice(-MAX_CHAT_MESSAGES);
}

// --- Why a call ended ----------------------------------------------------

export type CallEnd =
  | { kind: "left" }
  | { kind: "ended" | "removed" | "replaced" | "lost"; text: string };

/**
 * What the person sees when the room disconnects, from LiveKit's reason name
 * (`DisconnectReason[reason]`). Leaving yourself is not an event worth a
 * screen; everything else explains itself (docs/28 §4.2, S5).
 */
export function describeDisconnect(reason: string | undefined): CallEnd {
  switch (reason) {
    case "CLIENT_INITIATED":
      return { kind: "left" };
    case "ROOM_DELETED":
      return { kind: "ended", text: "The host ended the meeting for everyone." };
    case "ROOM_CLOSED":
      return { kind: "ended", text: "The meeting ended." };
    case "PARTICIPANT_REMOVED":
      return { kind: "removed", text: "The host removed you from this meeting." };
    case "DUPLICATE_IDENTITY":
      return {
        kind: "replaced",
        text: "You joined this call from another tab or device, so it ended here.",
      };
    default:
      return { kind: "lost", text: "Lost the connection to the call." };
  }
}

/**
 * A failed join in words (S4). `status` is null when the request itself
 * failed (offline, DNS); `body` is the server's JSON error.
 */
export function describeJoinFailure(
  status: number | null,
  body: { error?: string; removed?: boolean; locked?: boolean; denied?: boolean } = {},
): string {
  if (status === null) return "Couldn't connect. Check your connection, then try again.";
  if (status === 503) {
    return "Video calls aren't set up on this server. You can still transcribe on this device.";
  }
  if (status === 403 && body.denied) return "The host didn't let you into this call.";
  if (status === 403 && body.removed) return "The host removed you from this call.";
  if (status === 403 && body.locked) {
    return "The host locked this call, so no one new can join. Ask them to unlock it.";
  }
  if (status === 401) return "Sign in to join the call.";
  if (status === 403 || status === 404) return "You don't have access to this meeting's call.";
  return `Couldn't connect to the call (error ${status}). Try again.`;
}

// --- Rejoin after a reload (S6) ------------------------------------------

export const REJOIN_KEY = "lucent.call";
/** A reload later than this is a new visit, not an interrupted call. */
export const REJOIN_TTL_MS = 2 * 60 * 60 * 1000;

export function rejoinMarker(boardId: string, now: number): string {
  return JSON.stringify({ boardId, at: now });
}

/** The call this tab was in when the page reloaded, if it's recent. */
export function rejoinOffer(raw: string | null, now: number): { boardId: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { boardId?: unknown; at?: unknown };
    if (typeof value.boardId !== "string" || typeof value.at !== "number") return null;
    if (now - value.at > REJOIN_TTL_MS || value.at > now + 60_000) return null;
    return { boardId: value.boardId };
  } catch {
    return null;
  }
}

// --- The roster and the stage ---------------------------------------------

export interface RosterEntry {
  identity: string;
  name: string;
  isLocal: boolean;
  host: boolean;
  handAt: number | null;
}

/**
 * The People panel's order: raised hands first, in the order they went up
 * (who's next to speak); then you; then hosts; then everyone by name.
 */
export function sortRoster<T extends RosterEntry>(entries: readonly T[]): T[] {
  const rank = (e: T) => (e.handAt !== null ? 0 : e.isLocal ? 1 : e.host ? 2 : 3);
  return [...entries].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.handAt !== null && b.handAt !== null) return a.handAt - b.handAt;
    return a.name.localeCompare(b.name);
  });
}

/** Columns for N equal tiles, the way Meet's auto grid steps. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return 5;
}

/** The lobby's "who's here" line. */
export function peopleSentence(names: readonly string[]): string {
  if (names.length === 0) return "No one else is here yet.";
  if (names.length === 1) return `${names[0]} is in this call.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in this call.`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} other${others === 1 ? "" : "s"} are in this call.`;
}

/** Elapsed call time: "4:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Initials for an avatar tile. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
