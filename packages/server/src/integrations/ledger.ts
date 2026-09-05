/**
 * The external-action execution ledger (Stage D5, ADR 0031): the
 * Stripe-event idempotency shape, generalized to outbound external
 * mutations. billing/events.ts is the precedent copied almost verbatim —
 * the claim triad, the status-guarded re-claim, the stale window, max
 * attempts — with ONE deliberate divergence it inherits from the problem:
 * the row STORES the task inputs. A Stripe event can be re-fetched from
 * Stripe's own store ("the ledger deliberately keeps no payload"); an
 * intended external create has NO external authoritative copy — if the
 * request never arrived, the pending record is the only place the inputs
 * exist. The row IS the replay source.
 *
 * THE PAIRING THAT MAKES EXACTLY-ONCE TRUE (the acceptance's literal
 * wording): the ledger dedupes ATTEMPTS (a retried request re-claims its
 * row, never starts a second logical execution), and the provider call's
 * idempotency key dedupes EFFECTS (a request that reached the provider but
 * whose response was lost returns the SAME external task on retry — the
 * Stripe client precedent: "the request may never have reached the
 * provider, and if it did the idempotency key covers us"). Either alone
 * fails the acceptance: the ledger alone gives at-most-one-VISIBLE-
 * attempt (a timed-out create may have landed → LIN-482 AND LIN-483); the
 * key alone gives at-most-one-effect-per-key but nothing names the
 * attempt.
 *
 * Key: the composite (boardId, provider, requestId) — the owner's named
 * triplet. `lucentActionId` rides as a column so the approval record that
 * owns the execution can find its rows.
 */

/** The execution states. "received" = claimed/running (the Stripe ledger's
 * word, kept for the pattern parity); no "ignored" — an external action
 * either applies or fails. */
export type ExecutionStatus = "received" | "applied" | "failed";

export interface ExecutionRecord {
  boardId: string;
  provider: string;
  requestId: string;
  /** The approval record that owns this execution (its lucentActionId). */
  lucentActionId: string;
  /** The node this execution creates/updates (for per-item rows). */
  nodeId: string;
  status: ExecutionStatus;
  /** How many times work has been STARTED. First claim is 1. */
  attempts: number;
  error: string | null;
  /** When the current attempt started (the stale-window clock). */
  beganAt: number;
  appliedAt: number | null;
  /** The external id that landed, once applied — the Lucent reference. */
  externalId: string | null;
}

export const DEFAULT_STALE_AFTER_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 6;

export type ExecutionClaim =
  | { outcome: "claimed"; record: ExecutionRecord }
  | { outcome: "duplicate"; record: ExecutionRecord }
  | { outcome: "in_flight"; record: ExecutionRecord }
  | { outcome: "exhausted"; record: ExecutionRecord };

/** The single shared re-claim rule (the events.ts isReclaimable parity). */
export function isReclaimable(record: ExecutionRecord, now: number, staleAfterMs: number): boolean {
  if (record.status === "failed") return true;
  return record.status === "received" && now - record.beganAt >= staleAfterMs;
}

export interface ExecutionLedger {
  /**
   * First-INSERT-wins on the composite key. A fresh key → claimed (this
   * caller owns the execution); a terminal row → duplicate (answer with the
   * original outcome); a fresh row inside the stale window → in_flight;
   * a reclaimable row (failed, or stale) → claimed with attempts bumped.
   * At max attempts → exhausted (permanent failed; the reason visible).
   */
  claim(input: {
    boardId: string;
    provider: string;
    requestId: string;
    lucentActionId: string;
    nodeId: string;
  }): Promise<ExecutionClaim>;
  /** Mark applied + the external reference that landed. */
  applied(
    boardId: string,
    provider: string,
    requestId: string,
    externalId: string,
    now: number,
  ): Promise<void>;
  /** Mark failed with the error (immediately reclaimable). */
  failed(
    boardId: string,
    provider: string,
    requestId: string,
    error: string,
    now: number,
  ): Promise<void>;
  /** One row by its composite key (the approve route's duplicate answer). */
  get(
    boardId: string,
    provider: string,
    requestId: string,
  ): Promise<ExecutionRecord | undefined>;
  /** Reclaimable rows, oldest first (the sweep's feed). */
  pending(staleAfterMs: number, now: number, limit?: number): Promise<ExecutionRecord[]>;
}

/** The InMemory pair (the events.ts convention; the PG twin lands with D6). */
export class InMemoryExecutionLedger implements ExecutionLedger {
  private readonly rows = new Map<string, ExecutionRecord>();
  private readonly staleAfterMs: number;
  private readonly maxAttempts: number;

  constructor(options?: { staleAfterMs?: number; maxAttempts?: number }) {
    this.staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private key(boardId: string, provider: string, requestId: string): string {
    return `${boardId}|${provider}|${requestId}`;
  }

  async claim(input: {
    boardId: string;
    provider: string;
    requestId: string;
    lucentActionId: string;
    nodeId: string;
  }): Promise<ExecutionClaim> {
    const k = this.key(input.boardId, input.provider, input.requestId);
    const now = Date.now();
    const existing = this.rows.get(k);
    if (!existing) {
      const record: ExecutionRecord = {
        boardId: input.boardId,
        provider: input.provider,
        requestId: input.requestId,
        lucentActionId: input.lucentActionId,
        nodeId: input.nodeId,
        status: "received",
        attempts: 1,
        error: null,
        beganAt: now,
        appliedAt: null,
        externalId: null,
      };
      this.rows.set(k, record);
      return { outcome: "claimed", record: { ...record } };
    }
    // Terminal: the answer is the original outcome, never a second effect.
    if (existing.status === "applied") {
      return { outcome: "duplicate", record: { ...existing } };
    }
    // Exhausted: max attempts reached, stays failed, refuses re-claims.
    if (existing.attempts >= this.maxAttempts && existing.status === "received") {
      const stuck: ExecutionRecord = { ...existing, status: "failed", error: "exhausted after max attempts" };
      this.rows.set(k, stuck);
      return { outcome: "exhausted", record: { ...stuck } };
    }
    if (isReclaimable(existing, now, this.staleAfterMs)) {
      const reclaimed: ExecutionRecord = {
        ...existing,
        status: "received",
        attempts: existing.attempts + 1,
        // The error from the prior attempt deliberately stays visible.
        beganAt: now,
      };
      this.rows.set(k, reclaimed);
      return { outcome: "claimed", record: { ...reclaimed } };
    }
    // Fresh and inside the window: someone else is executing it right now.
    return { outcome: "in_flight", record: { ...existing } };
  }

  async applied(
    boardId: string,
    provider: string,
    requestId: string,
    externalId: string,
    now: number,
  ): Promise<void> {
    const k = this.key(boardId, provider, requestId);
    const row = this.rows.get(k);
    if (!row) return;
    this.rows.set(k, { ...row, status: "applied", appliedAt: now, externalId });
  }

  async failed(
    boardId: string,
    provider: string,
    requestId: string,
    error: string,
    now: number,
  ): Promise<void> {
    const k = this.key(boardId, provider, requestId);
    const row = this.rows.get(k);
    if (!row) return;
    this.rows.set(k, { ...row, status: "failed", error: error.slice(0, 500), beganAt: now });
  }

  async get(
    boardId: string,
    provider: string,
    requestId: string,
  ): Promise<ExecutionRecord | undefined> {
    const row = this.rows.get(this.key(boardId, provider, requestId));
    return row ? { ...row } : undefined;
  }

  async pending(staleAfterMs: number, now: number, limit = 50): Promise<ExecutionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => isReclaimable(r, now, staleAfterMs))
      .sort((a, b) => a.beganAt - b.beganAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
