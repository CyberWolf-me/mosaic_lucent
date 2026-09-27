import { randomBytes } from "node:crypto";

/**
 * Conversation threads (docs/26 J7, ADR 0048): one person's conversation on
 * one scope — a board, a meeting, a project, the workspace — kept on the
 * server, so canvas chat, Ask and the meeting's spoken questions share
 * context: "what about PostgreSQL?" after a spoken answer continues the same
 * thread when typed. Private to its author, like meeting notes.
 */

export const THREAD_SCOPES = ["board", "meeting", "project", "workspace"] as const;
export type ThreadScopeType = (typeof THREAD_SCOPES)[number];

/**
 * A scope, as the wire names it:
 *   board:<boardId> · meeting:<boardId>:<meetingId> · project:<orgId>:<projectId> · workspace:<orgId>
 */
export interface ThreadScope {
  type: ThreadScopeType;
  /** The canonical key, e.g. "meeting:brd_1:mtg_2". */
  key: string;
  boardId?: string;
  meetingId?: string;
  orgId?: string;
  projectId?: string;
}

export type ThreadRole = "user" | "ai";
export type ThreadSurface = "chat" | "ask" | "voice";

export interface ThreadMessage {
  id: string;
  role: ThreadRole;
  text: string;
  /** What Lucent said aloud, when it differs from the text. */
  reply: string | null;
  /** The answer's citations, as the client rendered them. */
  citations: unknown[] | null;
  surface: ThreadSurface;
  at: number;
}

export type NewThreadMessage = Omit<ThreadMessage, "id">;

export interface ThreadStore {
  /** The latest messages, oldest first. */
  messages(userId: string, scopeKey: string, limit?: number): Promise<ThreadMessage[]>;
  append(
    userId: string,
    orgId: string,
    scopeKey: string,
    messages: readonly NewThreadMessage[],
  ): Promise<ThreadMessage[]>;
  /** Start over: the thread's messages go. */
  clear(userId: string, scopeKey: string): Promise<void>;
}

/** A thread keeps its latest messages; older ones fall away. */
export const THREAD_KEEP = 200;
export const THREAD_READ_DEFAULT = 60;
export const MAX_THREAD_TEXT = 8000;
export const MAX_APPEND = 10;

export function newThreadId(): string {
  return "thr_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}
export function newThreadMessageId(): string {
  return "tmsg_" + Date.now().toString(36) + randomBytes(4).toString("hex");
}

const ID = /^[A-Za-z0-9_-]{1,120}$/;

export function parseThreadScope(raw: unknown): ThreadScope | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  const [type, ...parts] = raw.split(":");
  if (!parts.every((p) => ID.test(p))) return null;
  switch (type) {
    case "board":
      return parts.length === 1 ? { type, key: raw, boardId: parts[0]! } : null;
    case "meeting":
      return parts.length === 2
        ? { type, key: raw, boardId: parts[0]!, meetingId: parts[1]! }
        : null;
    case "project":
      return parts.length === 2 ? { type, key: raw, orgId: parts[0]!, projectId: parts[1]! } : null;
    case "workspace":
      return parts.length === 1 ? { type, key: raw, orgId: parts[0]! } : null;
    default:
      return null;
  }
}

/** Validate an append body's messages; `null` when any is malformed. */
export function parseNewMessages(raw: unknown, now: number): NewThreadMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_APPEND) return null;
  const out: NewThreadMessage[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) return null;
    const v = m as Record<string, unknown>;
    if (v.role !== "user" && v.role !== "ai") return null;
    if (typeof v.text !== "string" || !v.text.trim()) return null;
    const surface = v.surface === "ask" || v.surface === "voice" ? v.surface : "chat";
    const citations = Array.isArray(v.citations) ? v.citations.slice(0, 20) : null;
    out.push({
      role: v.role,
      text: v.text.slice(0, MAX_THREAD_TEXT),
      reply:
        typeof v.reply === "string" && v.reply.trim() ? v.reply.slice(0, MAX_THREAD_TEXT) : null,
      citations: citations && JSON.stringify(citations).length <= 20_000 ? citations : null,
      surface,
      at: typeof v.at === "number" && Number.isFinite(v.at) ? Math.min(v.at, now) : now,
    });
  }
  return out;
}

export class InMemoryThreadStore implements ThreadStore {
  private readonly threads = new Map<string, ThreadMessage[]>();

  private key(userId: string, scopeKey: string): string {
    return `${userId}\u0000${scopeKey}`;
  }

  async messages(userId: string, scopeKey: string, limit = THREAD_READ_DEFAULT) {
    return (this.threads.get(this.key(userId, scopeKey)) ?? [])
      .slice(-limit)
      .map((m) => ({ ...m }));
  }

  async append(
    userId: string,
    _orgId: string,
    scopeKey: string,
    messages: readonly NewThreadMessage[],
  ) {
    const k = this.key(userId, scopeKey);
    const added = messages.map((m) => ({ ...m, id: newThreadMessageId() }));
    this.threads.set(k, [...(this.threads.get(k) ?? []), ...added].slice(-THREAD_KEEP));
    return added;
  }

  async clear(userId: string, scopeKey: string) {
    this.threads.delete(this.key(userId, scopeKey));
  }
}
