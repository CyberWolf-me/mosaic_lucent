import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Board-scoped voice-agent grants.
 *
 * The voice agent (packages/voice-agent) writes to a board on behalf of the
 * person who started it. It used to receive that person's bearer session
 * token through LiveKit dispatch metadata — a full-power credential crossing
 * a third-party service — and, for cookie-session users (who have no bearer
 * token), fell back to a static service token from its own environment, so
 * every agent edit ran as one shared account.
 *
 * A grant is the narrow replacement: it names one user and one board, lives
 * two hours, and is accepted only by the two routes the agent calls (board
 * read, board ops) for that board. The user's CURRENT role is still checked
 * on every use, so revoking their access revokes the agent's.
 *
 * It must never be mistakable for a session token. Session tokens are
 * `<body>.<sig>` HMAC'd with the app secret and accepted by `verifyToken`,
 * which checks only `userId` and `exp`. A grant is `ag1.<body>.<sig>` signed
 * with a key DERIVED from the secret, so `verifyToken` rejects it (wrong
 * shape, wrong key) and `verifyAgentGrant` rejects a session token.
 */

export interface AgentGrant {
  userId: string;
  boardId: string;
  /** Epoch seconds. */
  exp: number;
}

const PREFIX = "ag1";
const DEFAULT_TTL_SECONDS = 2 * 60 * 60;

function grantKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("lucent:agent-grant:v1").digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function issueAgentGrant(
  input: { userId: string; boardId: string; ttlSeconds?: number },
  secret: string,
  now: number = Date.now(),
): string {
  const payload: AgentGrant = {
    userId: input.userId,
    boardId: input.boardId,
    exp: Math.floor(now / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", grantKey(secret)).update(`${PREFIX}.${body}`).digest());
  return `${PREFIX}.${body}.${sig}`;
}

export function verifyAgentGrant(
  token: string,
  secret: string,
  now: number = Date.now(),
): AgentGrant | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, sig] = parts as [string, string, string];
  const expected = b64url(
    createHmac("sha256", grantKey(secret)).update(`${PREFIX}.${body}`).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: AgentGrant;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8")) as AgentGrant;
  } catch {
    return null;
  }
  if (
    typeof payload.userId !== "string" ||
    typeof payload.boardId !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp * 1000 < now) return null;
  return payload;
}

/** `Authorization: Agent <grant>` → the grant string, else null. */
export function agentGrantFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Agent\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * The rooms a LiveKit token may be minted for, and what each requires.
 * `board-<id>` is the board's call (viewer+); `voice_<id>` is the voice
 * agent's room, which edits the board (editor+); anything else — including
 * the legacy shared "lucent-voice" default — becomes the caller's own
 * private room. A name outside these forms is refused rather than minted.
 */
export type RoomAccess =
  | { kind: "board"; room: string; boardId: string; minRole: "viewer" | "editor" }
  | { kind: "private"; room: string }
  | { kind: "refused" };

export function resolveRoomAccess(
  requested: { room?: string; boardId?: string },
  userId: string,
): RoomAccess {
  const room = requested.room?.trim() ?? "";
  const boardId = requested.boardId?.trim() ?? "";
  const privateRoom = { kind: "private" as const, room: `user-${userId}` };
  if (!room) {
    if (boardId) return { kind: "board", room: `board-${boardId}`, boardId, minRole: "viewer" };
    return privateRoom;
  }
  if (room === "lucent-voice" || room === `user-${userId}`) return privateRoom;
  const board = /^board-(.{1,120})$/.exec(room);
  if (board) return { kind: "board", room, boardId: board[1]!, minRole: "viewer" };
  const voice = /^voice_(.{1,120})$/.exec(room);
  if (voice) return { kind: "board", room, boardId: voice[1]!, minRole: "editor" };
  return { kind: "refused" };
}
