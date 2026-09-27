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
}

/** Participant attributes the server sets (mirrors `CALL_ATTRIBUTES` on the server). */
export const CALL_ATTRIBUTES = {
  hand: "lucent.hand",
  capture: "lucent.capture",
} as const;

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

export function captureFrom(attributes: Record<string, string> | undefined): boolean {
  return attributes?.[CALL_ATTRIBUTES.capture] === "on";
}

// --- Data messages -------------------------------------------------------

export const CHAT_TOPIC = "lucent.chat";
export const REACTION_TOPIC = "lucent.reaction";
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
  body: { error?: string; removed?: boolean } = {},
): string {
  if (status === null) return "Couldn't connect. Check your connection, then try again.";
  if (status === 503) {
    return "Video calls aren't set up on this server. You can still transcribe on this device.";
  }
  if (status === 403 && body.removed) return "The host removed you from this call.";
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
