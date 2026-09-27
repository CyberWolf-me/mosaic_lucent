import type { StatementKind, StatementStatus } from "@lucent/core";
import { apiFetch } from "./http.js";

/**
 * The Review center's reads and statement decisions (docs/26 J5, ADR 0047).
 * Everything that waits on a person, across the boards this person can read:
 * statements the AI suggested, proposals, external actions, inbound changes.
 * Proposals, actions and inbound changes keep their own decide routes
 * (boards.ts); statements are decided here.
 */

export interface ReviewStatement {
  kind: StatementKind;
  id: string;
  label: string;
  status: StatementStatus;
  boardId: string;
  boardName: string;
  assignee?: string;
  dueDate?: string;
  provenance?: { meetingId: string; turnRange?: [number, number] };
  meeting?: { id: string; title: string | null; startedAt: number };
}

export interface ReviewProposal {
  id: string;
  boardId: string;
  boardName: string;
  request: string;
  explanation: string | null;
  operations: number;
  meetingId: string | null;
  quote: string | null;
  createdAt: number;
}

export interface ReviewAction {
  id: string;
  boardId: string;
  boardName: string;
  provider: string;
  origin: "user" | "ai";
  items: Array<{ nodeId: string; action: "create" | "update"; title: string }>;
  createdAt: number;
}

export interface ReviewInbound {
  id: string;
  boardId: string;
  boardName: string;
  provider: string;
  nodeId: string;
  label: string;
  /** Which field changed there (servers before docs/26 A5 send only status). */
  field?: "status" | "assignee" | "dueDate";
  externalValue: string;
  mappedValue: string | null;
  detectedAt: number;
}

export interface ReviewQueue {
  boards: Record<string, { name: string; canDecide: boolean }>;
  statements: ReviewStatement[];
  proposals: ReviewProposal[];
  actions: ReviewAction[];
  inbound: ReviewInbound[];
  counts: { statements: number; proposals: number; actions: number; inbound: number };
}

export async function loadReviewQueue(orgId: string): Promise<ReviewQueue | null> {
  try {
    const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/review`);
    if (!res.ok) return null;
    return (await res.json()) as ReviewQueue;
  } catch {
    return null;
  }
}

export type StatementDecision =
  | { action: "approve" | "reject"; nodeIds: string[] }
  | { action: "edit"; nodeIds: [string]; label: string }
  | { action: "assign"; nodeIds: [string]; assignee?: string; dueDate?: string };

/** Decide statements on one board. Resolves an error message, or null on success. */
export async function decideStatements(
  boardId: string,
  decision: StatementDecision,
): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/review`, {
      method: "POST",
      body: JSON.stringify(decision),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return body?.error ?? "Couldn't save that decision.";
  } catch {
    return "Couldn't reach Lucent. Try again.";
  }
}

/** One AI run, as the run lists show it (docs/26 J6). */
export interface AiRunView {
  id: string;
  boardId: string | null;
  boardName?: string | null;
  initiatedBy: string | null;
  initiatedByName: string | null;
  surface: string;
  provider: string;
  model: string | null;
  contextScope: string;
  opCount: number;
  proposalId: string | null;
  opSeqs: number[];
  approvedBy: string | null;
  approvedByName: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export async function loadOrgRuns(orgId: string): Promise<AiRunView[] | null> {
  try {
    const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/ai-runs?limit=200`);
    if (!res.ok) return null;
    return ((await res.json()) as { runs: AiRunView[] }).runs;
  } catch {
    return null;
  }
}
