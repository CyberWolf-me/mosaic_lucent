import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

// The drizzle handle type (Db["db"]) — the trio takes the handle, matching
// the other pg-* stores' constructor convention of taking what they query.
type Handle = Db["db"];
import {
  executionLedger,
  integrationActions,
  integrationConnections,
  integrationInboundChanges,
  integrationTaskLinks,
  integrationWebhookEvents,
} from "../db/schema.js";
import type {
  IntegrationActionRecord,
  IntegrationActionStore,
  IntegrationConnection,
  IntegrationProviderName,
  IntegrationStatus,
  IntegrationStore,
  IntegrationTaskLink,
  SyncedFields,
  LinkTaskInput,
  NewIntegrationConnection,
} from "../integrations/integrations.js";
import {
  newIntegrationId,
  normalizeConnection,
  normalizeLink,
} from "../integrations/integrations.js";
import type {
  ExecutionClaim,
  ExecutionLedger as ExecutionLedgerStore,
  ExecutionRecord,
} from "../integrations/ledger.js";
import { DEFAULT_STALE_AFTER_MS, isReclaimable } from "../integrations/ledger.js";
import { nextHealth, type CallOutcome, type ConnectionHealth } from "../integrations/health.js";
import type {
  InboundChangeRecord,
  InboundChangeStore,
  InboundField,
} from "../integrations/inbound.js";
import type {
  IntegrationEventClaim,
  IntegrationWebhookEvent,
  IntegrationWebhookEventStore,
} from "../integrations/webhook.js";

/**
 * The Postgres integration stores (Stage D6, ADR 0032) — the twins of the
 * InMemory pairs in integrations.ts/ledger.ts, parity-pinned by the
 * same-suite-over-both pattern (the billing-events convention).
 *
 * The races the InMemory pairs decide by event-loop ordering are decided
 * here by the database: the (org,provider) and (board,node,provider)
 * uniques carry the upserts; the ledger's composite PK decides attempts
 * (onConflictDoNothing — the first INSERT wins); the re-claim is a
 * status-guarded UPDATE whose WHERE restates isReclaimable, so two workers
 * that both decide a stale row is theirs still produce exactly one claimed
 * (the pg-stripe-events doctrine, copied verbatim).
 */

/* -------------------------------------------------------------------------- */
/* Connections + links                                                         */
/* -------------------------------------------------------------------------- */

function rowToConnection(row: typeof integrationConnections.$inferSelect): IntegrationConnection {
  return {
    id: row.id,
    orgId: row.orgId,
    provider: row.provider as IntegrationProviderName,
    credentialRef: row.credentialRef,
    ...(row.config !== null && row.config !== undefined
      ? { config: row.config as Record<string, string> }
      : {}),
    scopes: (row.scopes as string[]) ?? [],
    status: row.status as IntegrationStatus,
    ...(row.health !== null && row.health !== undefined
      ? { health: row.health as ConnectionHealth }
      : {}),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToLink(row: typeof integrationTaskLinks.$inferSelect): IntegrationTaskLink {
  return {
    id: row.id,
    orgId: row.orgId,
    boardId: row.boardId,
    nodeId: row.nodeId,
    provider: row.provider as IntegrationProviderName,
    externalId: row.externalId,
    ...(row.url !== null ? { url: row.url } : {}),
    lastSyncedStatus: row.lastSyncedStatus,
    ...(row.lastSyncedFields !== null && row.lastSyncedFields !== undefined
      ? { lastSyncedFields: row.lastSyncedFields as SyncedFields }
      : {}),
    syncedAt: row.syncedAt,
  };
}

export class PostgresIntegrationStore implements IntegrationStore {
  constructor(private readonly db: Handle) {}

  async putConnection(
    input: NewIntegrationConnection & { config?: Record<string, string> },
    now: number,
  ): Promise<IntegrationConnection> {
    const normalized = normalizeConnection(input);
    const values = {
      id: newIntegrationId("int_"),
      orgId: normalized.orgId,
      provider: normalized.provider,
      credentialRef: normalized.credentialRef,
      config: normalized.config ?? null,
      scopes: normalized.scopes,
      status: "active" as const,
      createdBy: normalized.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    // The (org,provider) unique carries the upsert — the second config
    // replaces the first, never stacks.
    const [row] = await this.db
      .insert(integrationConnections)
      .values(values)
      .onConflictDoUpdate({
        target: [integrationConnections.orgId, integrationConnections.provider],
        // Reconnecting is a fresh start (docs/26 A5): active again, and the
        // old credential's failures no longer describe it.
        set: {
          credentialRef: values.credentialRef,
          config: values.config,
          scopes: values.scopes,
          status: "active",
          health: null,
          updatedAt: now,
        },
      })
      .returning();
    return rowToConnection(row!);
  }

  async connectionsForOrg(orgId: string): Promise<IntegrationConnection[]> {
    const rows = await this.db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.orgId, orgId))
      .orderBy(integrationConnections.createdAt);
    return rows.map(rowToConnection);
  }

  async connection(orgId: string, provider: string): Promise<IntegrationConnection | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, provider)),
      );
    return row ? rowToConnection(row) : undefined;
  }

  async connectionsFor(provider: string): Promise<IntegrationConnection[]> {
    const rows = await this.db
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.provider, provider),
          eq(integrationConnections.status, "active"),
        ),
      )
      .orderBy(integrationConnections.createdAt);
    return rows.map(rowToConnection);
  }

  async setConnectionStatus(
    orgId: string,
    provider: string,
    status: IntegrationStatus,
    now: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(integrationConnections)
      .set({ status, updatedAt: now })
      .where(
        and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, provider)),
      )
      .returning();
    return updated.length > 0;
  }

  async recordCall(
    orgId: string,
    provider: string,
    outcome: CallOutcome,
    now: number,
  ): Promise<void> {
    const current = await this.connection(orgId, provider);
    if (!current) return;
    await this.db
      .update(integrationConnections)
      .set({ health: nextHealth(current.health, outcome, now) })
      .where(
        and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.provider, provider)),
      );
  }

  async linkTask(input: LinkTaskInput, now: number): Promise<IntegrationTaskLink> {
    const normalized = normalizeLink(input);
    const values = {
      id: newIntegrationId("lnk_"),
      orgId: normalized.orgId,
      boardId: normalized.boardId,
      nodeId: normalized.nodeId,
      provider: normalized.provider,
      externalId: normalized.externalId,
      url: normalized.url ?? null,
      lastSyncedStatus: normalized.lastSyncedStatus,
      lastSyncedFields: normalized.lastSyncedFields ?? null,
      syncedAt: now,
    };
    // The (board,node,provider) unique carries the re-link upsert.
    const [row] = await this.db
      .insert(integrationTaskLinks)
      .values(values)
      .onConflictDoUpdate({
        target: [
          integrationTaskLinks.boardId,
          integrationTaskLinks.nodeId,
          integrationTaskLinks.provider,
        ],
        set: {
          externalId: values.externalId,
          url: values.url,
          lastSyncedStatus: values.lastSyncedStatus,
          // Merged over the stored baseline; absent leaves it as it was.
          lastSyncedFields: normalized.lastSyncedFields
            ? sql`coalesce(${integrationTaskLinks.lastSyncedFields}, '{}'::jsonb) || ${JSON.stringify(normalized.lastSyncedFields)}::jsonb`
            : sql`${integrationTaskLinks.lastSyncedFields}`,
          syncedAt: now,
        },
      })
      .returning();
    return rowToLink(row!);
  }

  async linksForBoard(boardId: string): Promise<IntegrationTaskLink[]> {
    const rows = await this.db
      .select()
      .from(integrationTaskLinks)
      .where(eq(integrationTaskLinks.boardId, boardId));
    return rows.map(rowToLink);
  }

  async linksForNode(boardId: string, nodeId: string): Promise<IntegrationTaskLink[]> {
    const rows = await this.db
      .select()
      .from(integrationTaskLinks)
      .where(
        and(eq(integrationTaskLinks.boardId, boardId), eq(integrationTaskLinks.nodeId, nodeId)),
      );
    return rows.map(rowToLink);
  }

  async linksForExternalId(provider: string, externalId: string): Promise<IntegrationTaskLink[]> {
    const rows = await this.db
      .select()
      .from(integrationTaskLinks)
      .where(
        and(
          eq(integrationTaskLinks.provider, provider),
          eq(integrationTaskLinks.externalId, externalId),
        ),
      );
    return rows.map(rowToLink);
  }

  async linksForOrg(orgId: string, limit: number): Promise<IntegrationTaskLink[]> {
    // Newest-synced first, capped: the link-GC arm's bounded feed.
    const rows = await this.db
      .select()
      .from(integrationTaskLinks)
      .where(eq(integrationTaskLinks.orgId, orgId))
      .orderBy(sql`${integrationTaskLinks.syncedAt} desc`)
      .limit(limit);
    return rows.map(rowToLink);
  }

  async unlink(boardId: string, nodeId: string, provider: string): Promise<boolean> {
    const deleted = await this.db
      .delete(integrationTaskLinks)
      .where(
        and(
          eq(integrationTaskLinks.boardId, boardId),
          eq(integrationTaskLinks.nodeId, nodeId),
          eq(integrationTaskLinks.provider, provider),
        ),
      )
      .returning();
    return deleted.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Action records                                                             */
/* -------------------------------------------------------------------------- */

type DbActionRow = typeof integrationActions.$inferSelect;

function rowToAction(row: DbActionRow): IntegrationActionRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    boardId: row.boardId,
    provider: row.provider as IntegrationProviderName,
    connectionId: row.connectionId,
    status: row.status as IntegrationActionRecord["status"],
    items: row.items as IntegrationActionRecord["items"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    ...(row.decidedBy !== null ? { decidedBy: row.decidedBy } : {}),
    ...(row.decidedAt !== null ? { decidedAt: row.decidedAt } : {}),
    ...(row.appliedAt !== null ? { appliedAt: row.appliedAt } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    // Stage D9: origin/provenance/sourceSeq (null-safe — pre-D9 rows read
    // as origin "user" by the callers' default).
    ...(row.origin !== null ? { origin: row.origin as "user" | "ai" } : {}),
    ...(row.provenance !== null
      ? { provenance: row.provenance as { request: string; explanation: string } }
      : {}),
    ...(row.sourceSeq !== null ? { sourceSeq: row.sourceSeq } : {}),
  };
}

export class PostgresIntegrationActionStore implements IntegrationActionStore {
  constructor(private readonly db: Handle) {}

  async propose(input: {
    orgId: string;
    boardId: string;
    provider: IntegrationProviderName;
    connectionId: string;
    items: IntegrationActionRecord["items"];
    createdBy: string;
    now: number;
    origin?: "user" | "ai";
    provenance?: { request: string; explanation: string };
    sourceSeq?: number | null;
  }): Promise<{ record: IntegrationActionRecord; supersededId: string | null }> {
    // Supersede any pending predecessor (the B3 create pattern).
    const pending = await this.db
      .select()
      .from(integrationActions)
      .where(
        and(
          eq(integrationActions.boardId, input.boardId),
          eq(integrationActions.provider, input.provider),
          eq(integrationActions.status, "pending"),
        ),
      );
    let supersededId: string | null = null;
    if (pending.length > 0) {
      supersededId = pending[0]!.id;
      await this.db
        .update(integrationActions)
        .set({ status: "superseded" })
        .where(eq(integrationActions.id, pending[0]!.id));
    }
    const [row] = await this.db
      .insert(integrationActions)
      .values({
        id: newIntegrationId("act_"),
        orgId: input.orgId,
        boardId: input.boardId,
        provider: input.provider,
        connectionId: input.connectionId,
        status: "pending",
        items: input.items,
        createdBy: input.createdBy,
        createdAt: input.now,
        origin: input.origin ?? null,
        provenance: input.provenance ?? null,
        sourceSeq: input.sourceSeq ?? null,
      })
      .returning();
    return { record: rowToAction(row!), supersededId };
  }

  async action(boardId: string, id: string): Promise<IntegrationActionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationActions)
      .where(eq(integrationActions.id, id));
    if (!row || row.boardId !== boardId) return undefined;
    return rowToAction(row);
  }

  async actionsForBoard(boardId: string): Promise<IntegrationActionRecord[]> {
    const rows = await this.db
      .select()
      .from(integrationActions)
      .where(eq(integrationActions.boardId, boardId))
      .orderBy(sql`${integrationActions.createdAt} desc`);
    return rows.map(rowToAction);
  }

  async decide(
    boardId: string,
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    now: number,
  ): Promise<IntegrationActionRecord | undefined> {
    const [existing] = await this.db
      .select()
      .from(integrationActions)
      .where(eq(integrationActions.id, id));
    if (!existing || existing.boardId !== boardId) return undefined;
    // The decided-once guard, SQL-guarded: the UPDATE matches zero rows when
    // another decider already wrote, and the re-read answers the original.
    if (existing.status !== "pending") return rowToAction(existing);
    await this.db
      .update(integrationActions)
      .set({ status: decision, decidedBy, decidedAt: now })
      .where(and(eq(integrationActions.id, id), eq(integrationActions.status, "pending")));
    const [row] = await this.db
      .select()
      .from(integrationActions)
      .where(eq(integrationActions.id, id));
    return row ? rowToAction(row) : undefined;
  }

  async applied(boardId: string, id: string, now: number): Promise<void> {
    await this.db
      .update(integrationActions)
      .set({ appliedAt: now })
      .where(and(eq(integrationActions.id, id), eq(integrationActions.boardId, boardId)));
  }
}

/* -------------------------------------------------------------------------- */
/* The execution ledger                                                       */
/* -------------------------------------------------------------------------- */

function rowToExecution(row: typeof executionLedger.$inferSelect): ExecutionRecord {
  return {
    boardId: row.boardId,
    provider: row.provider,
    requestId: row.requestId,
    lucentActionId: row.lucentActionId,
    nodeId: row.nodeId,
    status: row.status as ExecutionRecord["status"],
    attempts: row.attempts,
    error: row.error,
    beganAt: row.beganAt,
    appliedAt: row.appliedAt,
    externalId: row.externalId,
  };
}

/** The WHERE clause that restates isReclaimable — the re-claim guard. */
function reclaimGuard(staleAfterMs: number): ReturnType<typeof sql> {
  return sql`(${executionLedger.status} = 'failed' OR (${executionLedger.status} = 'received' AND ${executionLedger.beganAt} <= ${Date.now() - staleAfterMs}))`;
}

export class PostgresExecutionLedger implements ExecutionLedgerStore {
  private readonly staleAfterMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Handle,
    options?: { staleAfterMs?: number; maxAttempts?: number },
  ) {
    this.staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.maxAttempts = options?.maxAttempts ?? 6;
  }

  async claim(input: {
    boardId: string;
    provider: string;
    requestId: string;
    lucentActionId: string;
    nodeId: string;
  }): Promise<ExecutionClaim> {
    const now = Date.now();
    // First-INSERT-wins on the composite PK.
    const inserted = await this.db
      .insert(executionLedger)
      .values({
        boardId: input.boardId,
        provider: input.provider,
        requestId: input.requestId,
        lucentActionId: input.lucentActionId,
        nodeId: input.nodeId,
        status: "received",
        attempts: 1,
        beganAt: now,
      })
      .onConflictDoNothing({
        target: [executionLedger.boardId, executionLedger.provider, executionLedger.requestId],
      })
      .returning();
    if (inserted.length > 0) {
      return { outcome: "claimed", record: rowToExecution(inserted[0]!) };
    }
    const [existing] = await this.db
      .select()
      .from(executionLedger)
      .where(
        and(
          eq(executionLedger.boardId, input.boardId),
          eq(executionLedger.provider, input.provider),
          eq(executionLedger.requestId, input.requestId),
        ),
      );
    if (!existing) throw new Error("ledger claim raced and lost its row");
    if (existing.status === "applied") {
      return { outcome: "duplicate", record: rowToExecution(existing) };
    }
    if (existing.attempts >= this.maxAttempts) {
      const [stuck] = await this.db
        .update(executionLedger)
        .set({ status: "failed", error: "exhausted after max attempts" })
        .where(
          and(
            eq(executionLedger.boardId, input.boardId),
            eq(executionLedger.provider, input.provider),
            eq(executionLedger.requestId, input.requestId),
            sql`${executionLedger.attempts} >= ${this.maxAttempts}`,
          ),
        )
        .returning();
      return { outcome: "exhausted", record: rowToExecution(stuck ?? existing) };
    }
    if (isReclaimable(rowToExecution(existing), now, this.staleAfterMs)) {
      // The status-guarded re-claim: the loser's UPDATE matches zero rows.
      const reclaimed = await this.db
        .update(executionLedger)
        .set({
          status: "received",
          attempts: existing.attempts + 1,
          beganAt: now,
        })
        .where(
          and(
            eq(executionLedger.boardId, input.boardId),
            eq(executionLedger.provider, input.provider),
            eq(executionLedger.requestId, input.requestId),
            reclaimGuard(this.staleAfterMs),
          ),
        )
        .returning();
      if (reclaimed.length > 0) {
        return { outcome: "claimed", record: rowToExecution(reclaimed[0]!) };
      }
      // The guard raced: someone else re-claimed first — in_flight.
      return { outcome: "in_flight", record: rowToExecution(existing) };
    }
    return { outcome: "in_flight", record: rowToExecution(existing) };
  }

  async applied(
    boardId: string,
    provider: string,
    requestId: string,
    externalId: string,
    now: number,
  ): Promise<void> {
    await this.db
      .update(executionLedger)
      .set({ status: "applied", appliedAt: now, externalId })
      .where(
        and(
          eq(executionLedger.boardId, boardId),
          eq(executionLedger.provider, provider),
          eq(executionLedger.requestId, requestId),
        ),
      );
  }

  async failed(
    boardId: string,
    provider: string,
    requestId: string,
    error: string,
    now: number,
  ): Promise<void> {
    await this.db
      .update(executionLedger)
      .set({ status: "failed", error: error.slice(0, 500), beganAt: now })
      .where(
        and(
          eq(executionLedger.boardId, boardId),
          eq(executionLedger.provider, provider),
          eq(executionLedger.requestId, requestId),
        ),
      );
  }

  async get(
    boardId: string,
    provider: string,
    requestId: string,
  ): Promise<ExecutionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(executionLedger)
      .where(
        and(
          eq(executionLedger.boardId, boardId),
          eq(executionLedger.provider, provider),
          eq(executionLedger.requestId, requestId),
        ),
      );
    return row ? rowToExecution(row) : undefined;
  }

  async pending(staleAfterMs: number, now: number, limit = 50): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionLedger)
      .where(inArray(executionLedger.status, ["failed", "received"]))
      .orderBy(executionLedger.beganAt)
      .limit(limit * 2);
    return rows
      .map(rowToExecution)
      .filter((r) => isReclaimable(r, now, staleAfterMs))
      .slice(0, limit);
  }
}

/* -------------------------------------------------------------------------- */
/* The webhook delivery ledger (Stage D7, ADR 0033)                            */
/* -------------------------------------------------------------------------- */

type DbWebhookEventRow = typeof integrationWebhookEvents.$inferSelect;

function rowToWebhookEvent(row: DbWebhookEventRow): IntegrationWebhookEvent {
  return {
    id: row.id,
    provider: row.provider,
    orgId: row.orgId,
    externalId: row.externalId,
    status: row.status as IntegrationWebhookEvent["status"],
    attempts: row.attempts,
    ...(row.error !== null ? { error: row.error } : {}),
    claimedAt: row.claimedAt,
    receivedAt: row.receivedAt,
  };
}

export class PostgresIntegrationWebhookEventStore implements IntegrationWebhookEventStore {
  constructor(private readonly db: Handle) {}

  async claim(input: {
    id: string;
    provider: string;
    orgId: string | null;
    externalId: string | null;
    now: number;
    staleAfterMs: number;
  }): Promise<IntegrationEventClaim> {
    // First-INSERT-wins on the PK — the pg-stripe-events doctrine.
    const inserted = await this.db
      .insert(integrationWebhookEvents)
      .values({
        id: input.id,
        provider: input.provider,
        orgId: input.orgId,
        externalId: input.externalId,
        status: "received",
        attempts: 1,
        claimedAt: input.now,
        receivedAt: input.now,
      })
      .onConflictDoNothing({ target: integrationWebhookEvents.id })
      .returning();
    if (inserted.length > 0) {
      return { outcome: "claimed", event: rowToWebhookEvent(inserted[0]!) };
    }
    const [existing] = await this.db
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.id, input.id));
    if (!existing) throw new Error("webhook claim raced and lost its row");
    const record = rowToWebhookEvent(existing);
    // The claim ladder, the InMemory twin's order: FAILED re-claims
    // immediately; RECEIVED inside the window is in_flight; past it,
    // re-claim; anything decided is a duplicate.
    if (record.status === "failed") {
      const reclaimed = await this.db
        .update(integrationWebhookEvents)
        // `status: "received"` is load-bearing, not cosmetic: a re-claimed
        // FAILED row must leave the failed set. Leaving it failed with a
        // fresh `claimedAt` made the row invisible to `pending()`, whose
        // filter is `claimedAt <= staleAt` — a re-claimed row was therefore
        // never fed back to the sweep, which is the opposite of what
        // re-claiming it means.
        .set({ status: "received", claimedAt: input.now, attempts: record.attempts + 1 })
        .where(
          and(
            eq(integrationWebhookEvents.id, input.id),
            eq(integrationWebhookEvents.status, "failed"),
          ),
        )
        .returning();
      if (reclaimed.length > 0) {
        return { outcome: "claimed", event: rowToWebhookEvent(reclaimed[0]!) };
      }
      return { outcome: "duplicate", event: record };
    }
    if (record.status === "received") {
      const stale = input.now - record.claimedAt > input.staleAfterMs;
      if (!stale) return { outcome: "in_flight", event: record };
      // The status-guarded re-claim: the loser's UPDATE matches zero rows.
      const reclaimed = await this.db
        .update(integrationWebhookEvents)
        .set({ claimedAt: input.now, attempts: record.attempts + 1 })
        .where(
          and(
            eq(integrationWebhookEvents.id, input.id),
            eq(integrationWebhookEvents.status, "received"),
            lte(integrationWebhookEvents.claimedAt, input.now - input.staleAfterMs),
          ),
        )
        .returning();
      if (reclaimed.length > 0) {
        return { outcome: "claimed", event: rowToWebhookEvent(reclaimed[0]!) };
      }
      return { outcome: "in_flight", event: record };
    }
    return { outcome: "duplicate", event: record };
  }

  async pending(staleAt: number, now: number, limit: number): Promise<IntegrationWebhookEvent[]> {
    const rows = await this.db
      .select()
      .from(integrationWebhookEvents)
      .where(inArray(integrationWebhookEvents.status, ["received", "failed"]))
      .orderBy(integrationWebhookEvents.claimedAt)
      .limit(limit * 2);
    return rows
      .map(rowToWebhookEvent)
      .filter((e) => e.claimedAt <= staleAt && e.claimedAt <= now)
      .slice(0, limit);
  }

  async markProcessed(id: string, orgId: string | null, now: number): Promise<void> {
    await this.db
      .update(integrationWebhookEvents)
      .set({ status: "processed", orgId, claimedAt: now })
      .where(eq(integrationWebhookEvents.id, id));
  }

  async markIgnored(id: string, now: number): Promise<void> {
    await this.db
      .update(integrationWebhookEvents)
      .set({ status: "ignored", claimedAt: now })
      .where(eq(integrationWebhookEvents.id, id));
  }

  async markFailed(id: string, error: string, now: number): Promise<void> {
    await this.db
      .update(integrationWebhookEvents)
      .set({ status: "failed", error: error.slice(0, 500), claimedAt: now })
      .where(eq(integrationWebhookEvents.id, id));
  }

  async pruneTerminal(terminalBefore: number, limit: number): Promise<number> {
    // The structural guard the review demanded: status IN the terminal set
    // (failed excluded — retryable) AND claimedAt (the terminal timestamp,
    // never receivedAt) below the cutoff. A pending/in-flight row cannot
    // match even if the constant were mistyped. Bounded: select the capped
    // ids first, then delete by id (drizzle's delete has no .limit).
    const doomed = await this.db
      .select({ id: integrationWebhookEvents.id })
      .from(integrationWebhookEvents)
      .where(
        and(
          inArray(integrationWebhookEvents.status, ["processed", "ignored", "exhausted"]),
          lte(integrationWebhookEvents.claimedAt, terminalBefore),
        ),
      )
      .orderBy(integrationWebhookEvents.claimedAt)
      .limit(limit);
    if (doomed.length === 0) return 0;
    const deleted = await this.db
      .delete(integrationWebhookEvents)
      .where(
        inArray(
          integrationWebhookEvents.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: integrationWebhookEvents.id });
    return deleted.length;
  }
}

/* -------------------------------------------------------------------------- */
/* The inbound queue (Stage D7, ADR 0033)                                      */
/* -------------------------------------------------------------------------- */

type DbInboundRow = typeof integrationInboundChanges.$inferSelect;

function rowToInbound(row: DbInboundRow): InboundChangeRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    boardId: row.boardId,
    provider: row.provider as IntegrationProviderName,
    nodeId: row.nodeId,
    externalId: row.externalId,
    field: row.field as InboundField,
    externalValue: row.externalValue,
    mappedValue: (row.mappedValue as InboundChangeRecord["mappedValue"]) ?? undefined,
    status: row.status as InboundChangeRecord["status"],
    source: row.source as InboundChangeRecord["source"],
    detectedAt: row.detectedAt,
    ...(row.decidedBy !== null ? { decidedBy: row.decidedBy } : {}),
    ...(row.decidedAt !== null ? { decidedAt: row.decidedAt } : {}),
    ...(row.appliedSeq !== null ? { appliedSeq: row.appliedSeq } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}

export class PostgresInboundChangeStore implements InboundChangeStore {
  constructor(private readonly db: Handle) {}

  async put(
    input: Omit<InboundChangeRecord, "id" | "status" | "detectedAt" | "source">,
    source: InboundChangeRecord["source"],
    now: number,
  ): Promise<InboundChangeRecord> {
    // The queue-level dedupe, code-decided (the InMemory twin's ladder):
    // a pending row for the same (board, node, provider, field) updates
    // in place; no row, insert. Two workers racing both update the same
    // row — the LAST webhook wins, which is the honest "the provider
    // currently says" semantics.
    const pending = await this.db
      .select()
      .from(integrationInboundChanges)
      .where(
        and(
          eq(integrationInboundChanges.boardId, input.boardId),
          eq(integrationInboundChanges.nodeId, input.nodeId),
          eq(integrationInboundChanges.provider, input.provider),
          eq(integrationInboundChanges.field, input.field),
          eq(integrationInboundChanges.status, "pending"),
        ),
      );
    if (pending.length > 0) {
      const [row] = await this.db
        .update(integrationInboundChanges)
        .set({
          externalValue: input.externalValue,
          mappedValue: input.mappedValue ?? null,
          detectedAt: now,
          source,
        })
        .where(eq(integrationInboundChanges.id, pending[0]!.id))
        .returning();
      return rowToInbound(row!);
    }
    const [row] = await this.db
      .insert(integrationInboundChanges)
      .values({
        id: newIntegrationId("inb_"),
        orgId: input.orgId,
        boardId: input.boardId,
        provider: input.provider,
        nodeId: input.nodeId,
        externalId: input.externalId,
        field: input.field,
        externalValue: input.externalValue,
        mappedValue: input.mappedValue ?? null,
        status: "pending",
        source,
        detectedAt: now,
      })
      .returning();
    return rowToInbound(row!);
  }

  async forBoard(boardId: string): Promise<InboundChangeRecord[]> {
    const rows = await this.db
      .select()
      .from(integrationInboundChanges)
      .where(eq(integrationInboundChanges.boardId, boardId))
      .orderBy(
        sql`${integrationInboundChanges.status} = 'pending' desc, ${integrationInboundChanges.detectedAt} desc`,
      );
    return rows.map(rowToInbound);
  }

  async change(boardId: string, id: string): Promise<InboundChangeRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(integrationInboundChanges)
      .where(eq(integrationInboundChanges.id, id));
    if (!row || row.boardId !== boardId) return undefined;
    return rowToInbound(row);
  }

  async decide(
    boardId: string,
    id: string,
    decision: "applied" | "dismissed",
    decidedBy: string,
    now: number,
    extra?: { appliedSeq?: number; reason?: string },
  ): Promise<InboundChangeRecord | undefined> {
    // The decided-once guard, SQL-guarded: the UPDATE matches zero rows
    // when another decider already wrote.
    const updated = await this.db
      .update(integrationInboundChanges)
      .set({
        status: decision,
        decidedBy,
        decidedAt: now,
        ...(extra?.appliedSeq !== undefined ? { appliedSeq: extra.appliedSeq } : {}),
        ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      })
      .where(
        and(
          eq(integrationInboundChanges.id, id),
          eq(integrationInboundChanges.boardId, boardId),
          eq(integrationInboundChanges.status, "pending"),
        ),
      )
      .returning();
    if (updated.length > 0) return rowToInbound(updated[0]!);
    const [existing] = await this.db
      .select()
      .from(integrationInboundChanges)
      .where(eq(integrationInboundChanges.id, id));
    return existing ? rowToInbound(existing) : undefined;
  }

  async supersedePending(
    boardId: string,
    nodeIds: readonly string[],
    provider: string,
    field: InboundField,
    reason: string,
    now: number,
  ): Promise<number> {
    if (nodeIds.length === 0) return 0;
    const updated = await this.db
      .update(integrationInboundChanges)
      .set({ status: "superseded", reason, decidedAt: now })
      .where(
        and(
          eq(integrationInboundChanges.boardId, boardId),
          inArray(integrationInboundChanges.nodeId, [...nodeIds]),
          eq(integrationInboundChanges.provider, provider),
          eq(integrationInboundChanges.field, field),
          eq(integrationInboundChanges.status, "pending"),
        ),
      )
      .returning();
    return updated.length;
  }

  async pruneTerminal(decidedBefore: number, limit: number): Promise<number> {
    // The same structural guard: terminal statuses + decidedAt (the
    // decision's timestamp; pending rows have decidedAt NULL and cannot
    // match lte). Bounded: the capped-id select, then delete by id.
    const doomed = await this.db
      .select({ id: integrationInboundChanges.id })
      .from(integrationInboundChanges)
      .where(
        and(
          inArray(integrationInboundChanges.status, ["applied", "dismissed", "superseded"]),
          lte(integrationInboundChanges.decidedAt, decidedBefore),
        ),
      )
      .orderBy(integrationInboundChanges.decidedAt)
      .limit(limit);
    if (doomed.length === 0) return 0;
    const deleted = await this.db
      .delete(integrationInboundChanges)
      .where(
        inArray(
          integrationInboundChanges.id,
          doomed.map((row) => row.id),
        ),
      )
      .returning({ id: integrationInboundChanges.id });
    return deleted.length;
  }
}
