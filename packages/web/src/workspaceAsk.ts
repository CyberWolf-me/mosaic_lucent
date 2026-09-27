import type { StatementKind, StatementStatus, Workspace } from "@lucent/core";
import { apiFetch } from "./http.js";

/**
 * Ask everywhere (docs/26 A4, ADR 0048): search and ask a scope — a board,
 * a meeting, a project, the workspace, a time range — and keep each
 * conversation as the person's own thread on the server.
 */

/** How well an answer is supported, computed from its surviving citations. */
export interface Confidence {
  level: "none" | "low" | "medium" | "high";
  sources: number;
  kinds: number;
  superseded: string[];
  reason: string;
}

export interface Scope {
  project?: string;
  board?: string;
  meeting?: string;
  since?: string;
  until?: string;
}

/** A citation from a scoped answer: it names the board it lives on. */
export interface ScopedCitation {
  kind: "node" | "meeting" | "revision";
  id: string;
  label: string;
  boardId?: string;
  boardName?: string;
  detail?: string;
  why?: string;
  turnRange?: [number, number];
}

export interface ScopedAnswer {
  answer: string;
  citations: ScopedCitation[];
  confidence: Confidence;
  scope?: { label: string; boards: number; meetings: number; excluded?: string[] };
  warnings?: Array<{ reason: string }>;
}

interface Where {
  boardId: string;
  boardName: string;
  matched: string[];
  score: number;
}
export type WorkspaceHit = Where &
  (
    | {
        kind: "node";
        id: string;
        label: string;
        nodeType: string;
        statement?: { kind: StatementKind; status: StatementStatus; topic?: string };
      }
    | {
        kind: "turn";
        meetingId: string;
        meetingTitle: string | null;
        turnIndex: number;
        speaker: string;
        at: number;
        snippet: string;
      }
    | {
        kind: "comment";
        commentId: string;
        targetId: string;
        by: string;
        createdAt: number;
        snippet: string;
      }
    | { kind: "meeting"; meetingId: string; title: string; startedAt: number }
    | { kind: "board" }
  );

const orgPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

function scopeParams(scope: Scope): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(scope)) if (v) params.set(k, v);
  return params;
}

export async function searchWorkspace(
  orgId: string,
  query: string,
  scope: Scope = {},
): Promise<WorkspaceHit[] | null> {
  const params = scopeParams(scope);
  params.set("q", query.slice(0, 200));
  try {
    const res = await apiFetch(`${orgPath(orgId)}/search?${params}`);
    if (!res.ok) return null;
    return ((await res.json()) as { results: WorkspaceHit[] }).results;
  } catch {
    return null;
  }
}

type History = Array<{ role: "user" | "ai"; text: string }>;

async function answerFrom(res: Response): Promise<ScopedAnswer | { error: string }> {
  const body = (await res.json().catch(() => null)) as (ScopedAnswer & { error?: string }) | null;
  if (!res.ok || !body) return { error: body?.error ?? `Couldn't answer (${res.status}).` };
  return body;
}

export async function askWorkspace(
  orgId: string,
  question: string,
  scope: Scope = {},
  history: History = [],
): Promise<ScopedAnswer | { error: string }> {
  try {
    const res = await apiFetch(`${orgPath(orgId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ question, scope, history: history.slice(-8) }),
    });
    return await answerFrom(res);
  } catch {
    return { error: "Couldn't reach Lucent. Try again." };
  }
}

/** Ask about a board that lives only in this browser (its workspace goes along). */
export async function askLocalBoard(
  question: string,
  workspace: Workspace,
  name: string,
  history: History = [],
): Promise<ScopedAnswer | { error: string }> {
  try {
    const res = await apiFetch("/api/ask/local", {
      method: "POST",
      body: JSON.stringify({ question, workspace, name, history: history.slice(-8) }),
    });
    return await answerFrom(res);
  } catch {
    return { error: "Couldn't reach Lucent. Try again." };
  }
}

/* ------------------------------- threads -------------------------------- */

export interface ThreadMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  reply: string | null;
  citations: unknown[] | null;
  surface: "chat" | "ask" | "voice";
  at: number;
}

export type NewThreadMessage = Omit<ThreadMessage, "id" | "reply" | "citations"> & {
  reply?: string | null;
  citations?: unknown[] | null;
};

/** board:<id> · meeting:<boardId>:<meetingId> · project:<orgId>:<id> · workspace:<orgId> */
export const threadScope = {
  board: (boardId: string) => `board:${boardId}`,
  meeting: (boardId: string, meetingId: string) => `meeting:${boardId}:${meetingId}`,
  project: (orgId: string, projectId: string) => `project:${orgId}:${projectId}`,
  workspace: (orgId: string) => `workspace:${orgId}`,
};

export async function loadThread(scope: string): Promise<ThreadMessage[] | null> {
  try {
    const res = await apiFetch(`/api/threads?scope=${encodeURIComponent(scope)}`);
    if (!res.ok) return null;
    return ((await res.json()) as { messages: ThreadMessage[] }).messages;
  } catch {
    return null;
  }
}

/** Append to a thread; false when it didn't land (the conversation still stands locally). */
export async function appendThread(scope: string, messages: NewThreadMessage[]): Promise<boolean> {
  if (messages.length === 0) return true;
  try {
    for (let i = 0; i < messages.length; i += 10) {
      const res = await apiFetch("/api/threads", {
        method: "POST",
        body: JSON.stringify({ scope, messages: messages.slice(i, i + 10) }),
      });
      if (!res.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearThread(scope: string): Promise<void> {
  try {
    await apiFetch(`/api/threads?scope=${encodeURIComponent(scope)}`, { method: "DELETE" });
  } catch {
    /* the local chat is cleared either way */
  }
}

/** One line for an answer's footer. */
export function confidenceLine(c: Confidence): string {
  switch (c.level) {
    case "none":
      return "No evidence — nothing in scope supports this answer.";
    case "low":
      return c.superseded.length > 0 ? `Weak support — ${c.reason}` : "Supported by one source.";
    case "medium":
      return `Supported by ${c.sources} sources.`;
    case "high":
      return `Well supported — ${c.reason}`;
  }
}
