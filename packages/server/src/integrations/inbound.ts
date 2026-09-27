import type { ExecutionStatus } from "@lucent/core";
import type { IntegrationProviderName } from "./integrations.js";
import { newIntegrationId } from "./integrations.js";

/**
 * The inbound-change queue (Stage D7, ADR 0033): the human-gated mirror
 * of D5/D6's outbound gate. Every inbound change queues for accept —
 * nothing auto-applies — because an external system mutating a Lucent
 * board without a human seeing it is the same trust violation in both
 * directions.
 *
 * THE DEDUPE LADDER (three layers, each honest):
 * 1. delivery-level — the webhook event ledger (webhook.ts) dedupes on
 *    sha256(provider + raw bytes).
 * 2. queue-level — below: a pending record for the same
 *    (board, node, provider, field) with the same external value
 *    refreshes detectedAt, not a second row; a NEW value updates the
 *    pending row (the row is "what the provider currently says", not a
 *    log of every callback).
 * 3. resolution-level — decided here: a record whose live board value
 *    already equals the mapped value is `applied`-equivalent on sight
 *    (the surfaces render it resolved); accept still works, as a no-op
 *    mark, so the queue can be cleared without a re-check dance.
 *
 * THE NEVER-GUESSES RULE GOVERNS INBOUND TOO (ADR 0032): an
 * untranslatable provider word ("In QA", a custom state) maps through
 * `mapStatus` to `undefined`, and the record carries
 * `mappedValue: undefined` + a `warning: true` flavor — dismiss-only,
 * never an apply. Lucent's state is preserved and the user is told why.
 */

export const INBOUND_CHANGE_STATUSES = ["pending", "applied", "dismissed", "superseded"] as const;
export type InboundChangeStatus = (typeof INBOUND_CHANGE_STATUSES)[number];

/** The field an inbound change touches. Status first (D7's scope — the
 * vocabulary mapStatus owns); the string anticipates title/assignee
 * landing later without a schema break. */
export const INBOUND_FIELDS = ["status"] as const;
export type InboundField = (typeof INBOUND_FIELDS)[number];

export interface InboundChangeRecord {
  id: string;
  orgId: string;
  boardId: string;
  provider: IntegrationProviderName;
  nodeId: string;
  externalId: string;
  field: InboundField;
  /** The raw provider word AT DETECTION — what the human reads. */
  externalValue: string;
  /** mapStatus(externalValue): the D1 word, or undefined when the word
   * does not translate (the warning record — dismiss-only). */
  mappedValue: ExecutionStatus | undefined;
  status: InboundChangeStatus;
  /** Where the detection came from; the sweeper's refetch and a webhook
   * land in the same queue through the same path. */
  source: "webhook" | "sweep";
  detectedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  appliedSeq?: number;
  /** The dismissal/supersession reason (audit, never a UI hint). */
  reason?: string;
}

export interface InboundChangeStore {
  /**
   * Put with the queue-level dedupe: a pending record for the same
   * (board, node, provider, field) either refreshes detectedAt (same
   * external value) or is updated in place to the new value — never a
   * second pending row for one field of one node.
   */
  put(
    input: Omit<InboundChangeRecord, "id" | "status" | "detectedAt" | "source">,
    source: InboundChangeRecord["source"],
    now: number,
  ): Promise<InboundChangeRecord>;
  /** The board's records, pending first then newest-detected first. */
  forBoard(boardId: string): Promise<InboundChangeRecord[]>;
  /** Board-scoped read: a leaked id is not a read. */
  change(boardId: string, id: string): Promise<InboundChangeRecord | undefined>;
  /**
   * The decided-once transition guard (the B3 pattern): a second decide
   * on an already-decided record is a no-op returning the current state.
   */
  decide(
    boardId: string,
    id: string,
    decision: "applied" | "dismissed",
    decidedBy: string,
    now: number,
    extra?: { appliedSeq?: number; reason?: string },
  ): Promise<InboundChangeRecord | undefined>;
  /** The sync route's supersession arm: every pending record for the
   * (board, node, provider, field) becomes superseded — the board's
   * pushed value is the newer human decision. */
  supersedePending(
    boardId: string,
    nodeIds: readonly string[],
    provider: string,
    field: InboundField,
    reason: string,
    now: number,
  ): Promise<number>;
  /**
   * Stage D10, ADR 0036: delete TERMINAL records (applied | dismissed |
   * superseded) whose decidedAt is older than the horizon. The cutoff
   * reads decidedAt (the decision's timestamp), never detectedAt — a
   * pending record has no decidedAt and is structurally unreachable
   * here. Capped per run.
   */
  pruneTerminal(decidedBefore: number, limit: number): Promise<number>;
}

/** The InMemory pair (the integrations.ts convention). */
export class InMemoryInboundChangeStore implements InboundChangeStore {
  private readonly records = new Map<string, InboundChangeRecord>();

  async put(
    input: Omit<InboundChangeRecord, "id" | "status" | "detectedAt" | "source">,
    source: InboundChangeRecord["source"],
    now: number,
  ): Promise<InboundChangeRecord> {
    const pending = [...this.records.values()].find(
      (r) =>
        r.boardId === input.boardId &&
        r.nodeId === input.nodeId &&
        r.provider === input.provider &&
        r.field === input.field &&
        r.status === "pending",
    );
    if (pending) {
      const updated: InboundChangeRecord = {
        ...pending,
        externalValue: input.externalValue,
        mappedValue: input.mappedValue,
        detectedAt: now,
        source,
      };
      this.records.set(pending.id, updated);
      return { ...updated };
    }
    const row: InboundChangeRecord = {
      ...input,
      id: newIntegrationId("inb_"),
      status: "pending",
      source,
      detectedAt: now,
    };
    this.records.set(row.id, row);
    return { ...row };
  }

  async forBoard(boardId: string): Promise<InboundChangeRecord[]> {
    const rank = (r: InboundChangeRecord): number => (r.status === "pending" ? 0 : 1);
    return [...this.records.values()]
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => rank(a) - rank(b) || b.detectedAt - a.detectedAt)
      .map((r) => ({ ...r }));
  }

  async change(boardId: string, id: string): Promise<InboundChangeRecord | undefined> {
    const found = this.records.get(id);
    if (!found || found.boardId !== boardId) return undefined;
    return { ...found };
  }

  async decide(
    boardId: string,
    id: string,
    decision: "applied" | "dismissed",
    decidedBy: string,
    now: number,
    extra?: { appliedSeq?: number; reason?: string },
  ): Promise<InboundChangeRecord | undefined> {
    const found = this.records.get(id);
    if (!found || found.boardId !== boardId) return undefined;
    if (found.status !== "pending") return { ...found };
    const updated: InboundChangeRecord = {
      ...found,
      status: decision,
      decidedBy,
      decidedAt: now,
      ...(extra?.appliedSeq !== undefined ? { appliedSeq: extra.appliedSeq } : {}),
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    };
    this.records.set(id, updated);
    return { ...updated };
  }

  async supersedePending(
    boardId: string,
    nodeIds: readonly string[],
    provider: string,
    field: InboundField,
    reason: string,
    now: number,
  ): Promise<number> {
    let count = 0;
    const wanted = new Set(nodeIds);
    for (const [id, record] of this.records) {
      if (
        record.boardId === boardId &&
        record.provider === provider &&
        record.field === field &&
        record.status === "pending" &&
        wanted.has(record.nodeId)
      ) {
        this.records.set(id, {
          ...record,
          status: "superseded",
          reason,
          decidedAt: now,
        });
        count += 1;
      }
    }
    return count;
  }

  async pruneTerminal(decidedBefore: number, limit: number): Promise<number> {
    const TERMINAL = new Set(["applied", "dismissed", "superseded"]);
    const doomed = [...this.records.values()]
      .filter((r) => TERMINAL.has(r.status) && (r.decidedAt ?? Infinity) < decidedBefore)
      .sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0))
      .slice(0, limit);
    for (const row of doomed) this.records.delete(row.id);
    return doomed.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Ingest: a verified change → the queue                                       */
/* -------------------------------------------------------------------------- */

/**
 * What ingest needs. Deliberately narrow: it resolves links, reads the
 * live board value, translates through the provider, and writes the
 * queue — it never applies anything (accept, the human decision, is
 * Batch 2's route).
 */
export interface IngestDeps {
  /** linksForExternalId(provider, externalId) — the new store method. */
  linksForExternalId: (
    provider: string,
    externalId: string,
  ) => Promise<
    Array<{
      orgId: string;
      boardId: string;
      nodeId: string;
      provider: IntegrationProviderName;
      externalId: string;
      lastSyncedStatus: string;
    }>
  >;
  /** board(boardId) → the live node's issue status, or null when the
   * node is gone or carries no issue (the honest "nothing to compare"). */
  boardNodeStatus: (boardId: string, nodeId: string) => Promise<string | null>;
  store: InboundChangeStore;
  /** The provider instance — mapStatus only; ingest touches no wire. */
  provider: { mapStatus(externalStatus: string): ExecutionStatus | undefined };
  now?: () => number;
}

export interface IngestOutcome {
  /** "queued" | "resolved" (the board already says it) | "unlinked" (no
   * link → no record — an issue Lucent never adopted is not ours). */
  outcome: "queued" | "resolved" | "unlinked";
  /** How many pending records the ingest touched (0 for unlinked). */
  count: number;
  /** Those records as queued — what an automation may act on (docs/26 A5). */
  records: InboundChangeRecord[];
}

export async function ingestInboundChange(
  deps: IngestDeps,
  change: { provider: string; externalId: string; status: string },
  orgId: string,
): Promise<IngestOutcome> {
  const now = (deps.now ?? Date.now)();
  const links = await deps.linksForExternalId(change.provider, change.externalId);
  if (links.length === 0) {
    return { outcome: "unlinked", count: 0, records: [] };
  }
  const records: InboundChangeRecord[] = [];
  for (const link of links) {
    // Org scoping: a webhook resolved to one org never writes another
    // org's board, even if two orgs somehow link the same external task.
    if (link.orgId !== orgId) continue;
    const liveValue = await deps.boardNodeStatus(link.boardId, link.nodeId);
    const mapped = deps.provider.mapStatus(change.status);
    if (liveValue !== null && mapped !== undefined && liveValue === mapped) {
      // Resolution-level dedupe: the provider's word is what the board
      // already says. No pending row — the fact is recorded on the link
      // at the next sync; a row would be noise asking for a decision
      // that has nothing to decide.
      continue;
    }
    const record = await deps.store.put(
      {
        orgId,
        boardId: link.boardId,
        provider: link.provider,
        nodeId: link.nodeId,
        externalId: link.externalId,
        field: "status",
        externalValue: change.status,
        mappedValue: mapped,
      },
      "webhook",
      now,
    );
    records.push(record);
  }
  return {
    outcome: links.some((l) => l.orgId === orgId) ? "queued" : "unlinked",
    count: records.length,
    records,
  };
}
