import { randomBytes } from "node:crypto";
import type { Operation } from "@lucent/core";

/**
 * Review-gate proposals, server-side (Stage B3 — the P2 boundary).
 *
 * A proposal is what Lucent wants to change: the operations, the request that
 * prompted them, the meeting provenance, and the decision. Before this store
 * a pending proposal for a shared board lived only in the proposing browser's
 * localStorage — that browser was the sole source of truth for the batch,
 * invisible to every peer, gone if the tab closed. The server is now the
 * record: every member of the board sees the same pending batch, and the
 * decision is transition-guarded where the op log's own idempotency lives.
 *
 * The one-pending-per-board invariant (the localStorage contract, made
 * race-safe): `create` supersedes any pending predecessor in the same
 * operation that inserts the new record, and the partial unique index in
 * Postgres backs it. Deciding an already-decided proposal returns its current
 * state without re-applying — the server-side `decidedRef` the web client
 * guards with locally, now enforced where both browsers can see it.
 */

export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

/** Meeting provenance carried from the extraction: quote + stable refs. */
export interface ProposalProvenance {
  quote?: string;
  turnRange?: [number, number];
  turnKinds?: string[];
}

export interface StoredProposal {
  id: string;
  orgId: string;
  boardId: string;
  meetingId: string | null;
  status: ProposalStatus;
  operations: Operation[];
  request: string;
  explanation: string | null;
  provenance: ProposalProvenance | null;
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  /** The op_log seq the approval committed, once applied. */
  appliedSeq: number | null;
  /** ADR 0047: the AI run that produced it, when known. */
  runId: string | null;
}

export interface NewProposal {
  boardId: string;
  orgId: string;
  meetingId?: string | null;
  operations: Operation[];
  request: string;
  explanation?: string | null;
  provenance?: ProposalProvenance | null;
  createdBy: string;
  createdAt: number;
  runId?: string | null;
}

/** The decision the store records; `appliedSeq` completes an approval. */
export interface ProposalDecision {
  status: "approved" | "rejected";
  decidedBy: string;
  decidedAt: number;
  appliedSeq?: number;
}

export interface ProposalStore {
  /**
   * Insert a proposal, atomically superseding any pending predecessor on the
   * board. Returns the created record; the predecessor's id rides the result
   * so the caller can tell peers which pending panel to close.
   */
  create(input: NewProposal): Promise<{ proposal: StoredProposal; supersededId: string | null }>;
  /** A board's proposals, newest first, bounded. */
  forBoard(boardId: string, limit?: number): Promise<StoredProposal[]>;
  /** The pending proposals on these boards (at most one each), newest first. */
  pendingForBoards(boardIds: readonly string[]): Promise<StoredProposal[]>;
  /** One proposal, scoped to its board so a leaked id is not a read. */
  get(boardId: string, id: string): Promise<StoredProposal | undefined>;
  /**
   * Record a decision, transition-guarded: deciding an already-decided
   * proposal returns its current state untouched (the second browser's
   * double-approve is a read, not a second commit). `appliedSeq` is written
   * only when the caller supplies it (an approval, after the log committed).
   */
  decide(
    boardId: string,
    id: string,
    decision: ProposalDecision,
  ): Promise<StoredProposal | undefined>;
}

/** How many proposals `forBoard` returns when the caller does not say. */
export const PROPOSAL_LIST_LIMIT = 20;

/** Caps enforced at the route before the store sees anything. */
export const MAX_PROPOSAL_OPS = 200;
export const MAX_REQUEST_CHARS = 2000;
export const MAX_EXPLANATION_CHARS = 2000;
export const MAX_QUOTE_CHARS = 500;

export function newProposalId(): string {
  return "prp_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/**
 * Validate the body of a proposal create. Returns the cleaned record or the
 * first problem — the route turns the string into its 400 body. Ops are NOT
 * validated here: the semantically honest place is apply-time, against the
 * live workspace (a proposal whose target is deleted before approval must
 * apply its remainder, not be refused wholesale).
 */
export function validateProposalInput(
  input: unknown,
): { ok: true; value: NewProposal } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "body must be an object" };
  }
  const v = input as Record<string, unknown>;
  if (!Array.isArray(v.operations) || v.operations.length === 0) {
    return { ok: false, error: "operations must be a non-empty array" };
  }
  if (v.operations.length > MAX_PROPOSAL_OPS) {
    return { ok: false, error: `operations exceed the ${MAX_PROPOSAL_OPS}-op cap` };
  }
  // Structural shape only — the validator runs at apply time. Anything that
  // is not an op-shaped object is refused rather than silently skipped.
  for (const op of v.operations) {
    if (typeof op !== "object" || op === null || typeof (op as { op?: unknown }).op !== "string") {
      return { ok: false, error: "each operation must be an op object" };
    }
  }
  if (typeof v.request !== "string" || v.request.trim().length === 0) {
    return { ok: false, error: "request must be a non-empty string" };
  }
  let provenance: ProposalProvenance | null = null;
  if (v.provenance !== undefined && v.provenance !== null) {
    if (typeof v.provenance !== "object" || Array.isArray(v.provenance)) {
      return { ok: false, error: "provenance must be an object" };
    }
    const p = v.provenance as Record<string, unknown>;
    const cleaned: ProposalProvenance = {};
    if (p.quote !== undefined && p.quote !== null) {
      if (typeof p.quote !== "string")
        return { ok: false, error: "provenance.quote must be a string" };
      cleaned.quote = p.quote.slice(0, MAX_QUOTE_CHARS);
    }
    if (p.turnRange !== undefined && p.turnRange !== null) {
      if (
        !Array.isArray(p.turnRange) ||
        p.turnRange.length !== 2 ||
        p.turnRange.some((n) => typeof n !== "number")
      ) {
        return { ok: false, error: "provenance.turnRange must be [start, end]" };
      }
      cleaned.turnRange = p.turnRange as [number, number];
    }
    if (p.turnKinds !== undefined && p.turnKinds !== null) {
      if (!Array.isArray(p.turnKinds) || p.turnKinds.some((k) => typeof k !== "string")) {
        return { ok: false, error: "provenance.turnKinds must be an array of strings" };
      }
      cleaned.turnKinds = p.turnKinds.map((k) => String(k));
    }
    provenance = cleaned;
  }
  const meetingId = typeof v.meetingId === "string" && v.meetingId.length > 0 ? v.meetingId : null;
  // ADR 0047: the run this proposal came from. The route keeps it only when
  // the run is the caller's own on this board.
  const runId =
    typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 64 ? v.runId : null;
  return {
    ok: true,
    value: {
      boardId: "", // filled by the route, which owns the board id from the path
      orgId: "", // filled by the route from the stored board
      meetingId,
      operations: v.operations as Operation[],
      request: v.request.trim().slice(0, MAX_REQUEST_CHARS),
      explanation:
        typeof v.explanation === "string" && v.explanation.length > 0
          ? v.explanation.slice(0, MAX_EXPLANATION_CHARS)
          : null,
      provenance,
      createdBy: "", // filled by the route from the authenticated user
      createdAt: 0, // filled by the route
      runId,
    },
  };
}

export class InMemoryProposalStore implements ProposalStore {
  private readonly rows = new Map<string, StoredProposal>();

  async create(
    input: NewProposal,
  ): Promise<{ proposal: StoredProposal; supersededId: string | null }> {
    // Supersede any pending predecessor, then insert: the same atomic
    // ordering the Postgres partial unique index enforces at the database.
    let supersededId: string | null = null;
    for (const row of this.rows.values()) {
      if (row.boardId === input.boardId && row.status === "pending") {
        row.status = "superseded";
        row.decidedAt = input.createdAt;
        supersededId = row.id;
      }
    }
    const proposal: StoredProposal = {
      id: newProposalId(),
      orgId: input.orgId,
      boardId: input.boardId,
      meetingId: input.meetingId ?? null,
      status: "pending",
      operations: input.operations.map((op) => ({ ...op })),
      request: input.request,
      explanation: input.explanation ?? null,
      provenance: input.provenance ? { ...input.provenance } : null,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      decidedBy: null,
      decidedAt: null,
      appliedSeq: null,
      runId: input.runId ?? null,
    };
    this.rows.set(proposal.id, proposal);
    return { proposal: clone(proposal), supersededId };
  }

  async forBoard(boardId: string, limit = PROPOSAL_LIST_LIMIT): Promise<StoredProposal[]> {
    return [...this.rows.values()]
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map(clone);
  }

  async pendingForBoards(boardIds: readonly string[]): Promise<StoredProposal[]> {
    const boards = new Set(boardIds);
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" && boards.has(r.boardId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async get(boardId: string, id: string): Promise<StoredProposal | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    return clone(row);
  }

  async decide(
    boardId: string,
    id: string,
    decision: ProposalDecision,
  ): Promise<StoredProposal | undefined> {
    const row = this.rows.get(id);
    if (!row || row.boardId !== boardId) return undefined;
    // The transition guard: once decided, a proposal is immutable. The second
    // decider gets the current state back — their approve/reject had no
    // effect, which is exactly the answer the idempotent client wants.
    if (row.status !== "pending") return clone(row);
    row.status = decision.status;
    row.decidedBy = decision.decidedBy;
    row.decidedAt = decision.decidedAt;
    if (decision.appliedSeq !== undefined && decision.status === "approved") {
      row.appliedSeq = decision.appliedSeq;
    }
    return clone(row);
  }
}

function clone(p: StoredProposal): StoredProposal {
  return { ...p, operations: p.operations.map((op) => ({ ...op })) };
}
