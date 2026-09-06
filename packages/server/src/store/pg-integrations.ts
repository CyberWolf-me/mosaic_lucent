import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

// The drizzle handle type (Db["db"]) — the trio takes the handle, matching
// the other pg-* stores' constructor convention of taking what they query.
type Handle = Db["db"];
import {
  executionLedger,
  integrationActions,
  integrationConnections,
  integrationTaskLinks,
} from "../db/schema.js";
import type {
  IntegrationActionRecord,
  IntegrationActionStore,
  IntegrationConnection,
  IntegrationProviderName,
  IntegrationStatus,
  IntegrationStore,
  IntegrationTaskLink,
  LinkTaskInput,
  NewIntegrationConnection,
} from "../integrations/integrations.js";
import { newIntegrationId, normalizeConnection, normalizeLink } from "../integrations/integrations.js";
import type {
  ExecutionClaim,
  ExecutionLedger as ExecutionLedgerStore,
  ExecutionRecord,
} from "../integrations/ledger.js";
import { DEFAULT_STALE_AFTER_MS, isReclaimable } from "../integrations/ledger.js";

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
        set: {
          credentialRef: values.credentialRef,
          config: values.config,
          scopes: values.scopes,
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
        and(
          eq(integrationConnections.orgId, orgId),
          eq(integrationConnections.provider, provider),
        ),
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
        and(
          eq(integrationConnections.orgId, orgId),
          eq(integrationConnections.provider, provider),
        ),
      )
      .returning();
    return updated.length > 0;
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
function reclaimGuard(
  staleAfterMs: number,
): ReturnType<typeof sql> {
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
        target: [
          executionLedger.boardId,
          executionLedger.provider,
          executionLedger.requestId,
        ],
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
