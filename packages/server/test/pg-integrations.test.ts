import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { InMemoryIntegrationActionStore, InMemoryIntegrationStore } from "../src/integrations/integrations.js";
import {
  PostgresExecutionLedger,
  PostgresIntegrationActionStore,
  PostgresIntegrationStore,
  PostgresIntegrationWebhookEventStore,
  PostgresInboundChangeStore,
} from "../src/store/pg-integrations.js";
import type { IntegrationActionStore, IntegrationStore } from "../src/integrations/integrations.js";
import type { ExecutionLedger as ExecutionLedgerStore } from "../src/integrations/ledger.js";
import { InMemoryIntegrationWebhookEventStore, type IntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import {
  InMemoryInboundChangeStore,
  type InboundChangeStore,
  type InboundChangeRecord,
} from "../src/integrations/inbound.js";

/**
 * The D6 integration-store parity suites (the billing-events convention): the
 * same contract over the InMemory pair (always) and the Postgres pair (only
 * when LUCENT_TEST_DATABASE_URL is set — CI runs it), so the two can never
 * drift in shape. Per the pg-store convention, every id carries a per-run
 * tag and nothing TRUNCATEs — one shared database hosts every suite.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* -------------------------------------------------------------------------- */
/* The shared contract (run over both pairs)                                   */
/* -------------------------------------------------------------------------- */

function connectionContract(name: string, make: () => IntegrationStore, prefix: string) {
  describe(`integration store parity — ${name}`, () => {
    it("putConnection upserts per (org, provider); the config rides", async () => {
      const store = make();
      const org = `${prefix}-org`;
      const first = await store.putConnection(
        { orgId: org, provider: "fake", credentialRef: "R1", createdBy: "u", config: { teamId: "t1" } },
        1_000,
      );
      const second = await store.putConnection(
        { orgId: org, provider: "fake", credentialRef: "R2", createdBy: "u", config: { teamId: "t2" } },
        2_000,
      );
      const all = await store.connectionsForOrg(org);
      expect(all).toHaveLength(1);
      expect(all[0]!.credentialRef).toBe("R2");
      expect(all[0]!.config?.teamId).toBe("t2");
      expect(second.id).toBe(first.id);
      // Status flips without deleting.
      expect(await store.setConnectionStatus(org, "fake", "disabled", 3_000)).toBe(true);
      const after = await store.connection(org, "fake");
      expect(after!.status).toBe("disabled");
      expect(after!.credentialRef).toBe("R2");
    });

    it("linkTask upserts per (board, node, provider); reads are board-scoped", async () => {
      const store = make();
      const board = `${prefix}-board`;
      await store.linkTask(
        { orgId: "o", boardId: board, nodeId: "n1", provider: "fake", externalId: "E1", lastSyncedStatus: "todo" },
        1_000,
      );
      await store.linkTask(
        { orgId: "o", boardId: board, nodeId: "n1", provider: "fake", externalId: "E2", lastSyncedStatus: "done" },
        2_000,
      );
      const links = await store.linksForNode(board, "n1");
      expect(links).toHaveLength(1);
      expect(links[0]!.externalId).toBe("E2");
      expect(links[0]!.lastSyncedStatus).toBe("done");
      // A node with two providers keeps both links.
      await store.linkTask(
        { orgId: "o", boardId: board, nodeId: "n1", provider: "linear", externalId: "L1", lastSyncedStatus: "todo" },
        3_000,
      );
      expect(await store.linksForNode(board, "n1")).toHaveLength(2);
      // Another board sees nothing.
      expect(await store.linksForBoard(`${prefix}-other`)).toEqual([]);
      // Unlink drops exactly one.
      expect(await store.unlink(board, "n1", "fake")).toBe(true);
      expect(await store.linksForNode(board, "n1")).toHaveLength(1);
    });
  });
}

function actionContract(name: string, make: () => IntegrationActionStore, prefix: string) {
  describe(`action store parity — ${name}`, () => {
    it("propose supersedes per (board, provider); decide is once; connectionId rides", async () => {
      const store = make();
      const board = `${prefix}-ab`;
      const a = await store.propose({
        orgId: "o", boardId: board, provider: "fake", connectionId: "int_1",
        items: [{ nodeId: "n1", action: "create", title: "T", status: "open", idempotencyKey: "ext_n1" }],
        createdBy: "u", now: 1,
      });
      const b = await store.propose({
        orgId: "o", boardId: board, provider: "fake", connectionId: "int_1",
        items: [{ nodeId: "n2", action: "create", title: "T2", status: "open", idempotencyKey: "ext_n2" }],
        createdBy: "u", now: 2,
      });
      expect(b.supersededId).toBe(a.record.id);
      expect(b.record.connectionId).toBe("int_1");
      expect(b.record.items).toHaveLength(1);

      const decided = await store.decide(board, b.record.id, "approved", "u", 3);
      expect(decided!.status).toBe("approved");
      const second = await store.decide(board, b.record.id, "rejected", "u", 4);
      expect(second!.status).toBe("approved"); // decided once
      expect(second!.decidedAt).toBe(3);

      await store.applied(board, b.record.id, 5);
      const applied = await store.action(board, b.record.id);
      expect(applied!.appliedAt).toBe(5);
      // Board-scoped: another board cannot read the record.
      expect(await store.action(`${prefix}-other`, b.record.id)).toBeUndefined();
      // The history lists both rows newest-first.
      const history = await store.actionsForBoard(board);
      expect(history.map((r) => r.status).sort()).toEqual(["approved", "superseded"]);
    });
  });
}

function ledgerContract(name: string, make: () => ExecutionLedgerStore, prefix: string) {
  describe(`execution ledger parity — ${name}`, () => {
    it("claim → applied → duplicate (the original outcome); in-flight in the window", async () => {
      const ledger = make();
      const key = { boardId: `${prefix}-lb`, provider: "fake", requestId: `${prefix}-r1`, lucentActionId: "a", nodeId: "n" };
      const first = await ledger.claim(key);
      expect(first.outcome).toBe("claimed");
      if (first.outcome === "claimed") expect(first.record.attempts).toBe(1);
      const inWindow = await ledger.claim(key);
      expect(inWindow.outcome).toBe("in_flight"); // fresh, inside the window

      await ledger.applied(key.boardId, key.provider, key.requestId, "fake-1", Date.now());
      const dup = await ledger.claim(key);
      expect(dup.outcome).toBe("duplicate");
      if (dup.outcome === "duplicate") expect(dup.record.externalId).toBe("fake-1");
      const row = await ledger.get(key.boardId, key.provider, key.requestId);
      expect(row!.status).toBe("applied");
      expect(row!.externalId).toBe("fake-1");
    });

    it("failed re-claims immediately with attempts bumped; pending feeds the sweep", async () => {
      const ledger = make();
      const key = { boardId: `${prefix}-lc`, provider: "fake", requestId: `${prefix}-r2`, lucentActionId: "a", nodeId: "n" };
      await ledger.claim(key);
      await ledger.failed(key.boardId, key.provider, key.requestId, "boom", Date.now());
      const reclaimed = await ledger.claim(key);
      expect(reclaimed.outcome).toBe("claimed");
      if (reclaimed.outcome === "claimed") {
        expect(reclaimed.record.attempts).toBe(2);
        expect(reclaimed.record.error ?? "").not.toBeNull();
      }
      // A FAILED row is immediately reclaimable — it feeds the sweep.
      // (A fresh received row correctly does NOT: the window has not
      // elapsed; that is the in_flight arm above, not the sweep's.)
      await ledger.failed(key.boardId, key.provider, key.requestId, "again", Date.now());
      const feed = await ledger.pending(60_000, Date.now());
      expect(feed.some((r) => r.requestId === key.requestId)).toBe(true);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The D7 webhook-event ledger contract                                        */
/* -------------------------------------------------------------------------- */

function webhookEventContract(name: string, make: () => IntegrationWebhookEventStore, prefix: string) {
  describe(`webhook event ledger parity — ${name}`, () => {
    it("claim → processed → duplicate; the redelivered bytes are one event", async () => {
      const store = make();
      const id = `${prefix}-ev1`;
      const key = { id, provider: "fake", orgId: "org1", externalId: "FAKE-1", now: 1_000, staleAfterMs: 100 };
      const first = await store.claim(key);
      expect(first.outcome).toBe("claimed");
      await store.markProcessed(id, "org1", 1_050);
      const dup = await store.claim(key);
      expect(dup.outcome).toBe("duplicate");
      // pending() never lists a processed row.
      expect((await store.pending(0, 9_999, 50)).some((e) => e.id === id)).toBe(false);
    });

    it("a received row inside the window is in_flight; past it re-claims with attempts bumped", async () => {
      const store = make();
      const id = `${prefix}-ev2`;
      const key = { id, provider: "fake", orgId: "org1", externalId: null, now: 1_000, staleAfterMs: 100 };
      await store.claim(key);
      const inWindow = await store.claim({ ...key, now: 1_050 });
      expect(inWindow.outcome).toBe("in_flight");
      const reclaimed = await store.claim({ ...key, now: 1_101 });
      expect(reclaimed.outcome).toBe("claimed");
      if (reclaimed.outcome === "claimed") expect(reclaimed.event.attempts).toBe(2);
    });

    it("failed rows re-claim immediately; pending feeds the sweep with stale filtering", async () => {
      const store = make();
      const id = `${prefix}-ev3`;
      const key = { id, provider: "fake", orgId: null, externalId: "FAKE-3", now: 5_000, staleAfterMs: 100 };
      await store.claim(key);
      await store.markFailed(id, "queue down", 5_010);
      const reclaimed = await store.claim({ ...key, now: 5_020 });
      expect(reclaimed.outcome).toBe("claimed");
      // The sweep's feed: the re-claimed row (claimedAt 5_020, window
      // 100ms) is stale from now=5_120; at 5_100 it is 80ms old — not yet.
      expect((await store.pending(5_100 - 100, 5_100, 50)).some((e) => e.id === id)).toBe(false);
      expect((await store.pending(5_120 - 100, 5_120, 50)).some((e) => e.id === id)).toBe(true);
      // Ignored rows never feed the sweep.
      const id2 = `${prefix}-ev4`;
      await store.claim({ ...key, id: id2, now: 5_100 });
      await store.markIgnored(id2, 5_110);
      expect((await store.pending(9_999, 9_999, 50)).some((e) => e.id === id2)).toBe(false);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The D7 inbound-queue contract                                               */
/* -------------------------------------------------------------------------- */

function inboundContract(name: string, make: () => InboundChangeStore, prefix: string) {
  describe(`inbound queue parity — ${name}`, () => {
    const board = `${prefix}-qb`;

    it("put dedupes the pending row per (board, node, provider, field); forBoard is pending-first", async () => {
      const store = make();
      const base = {
        orgId: "org1",
        boardId: board,
        provider: "fake" as const,
        nodeId: "n1",
        externalId: "FAKE-1",
        field: "status" as const,
      };
      await store.put({ ...base, externalValue: "done", mappedValue: "completed" }, "webhook", 1_000);
      await store.put({ ...base, externalValue: "done", mappedValue: "completed" }, "webhook", 2_000);
      let rows = await store.forBoard(board);
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
      // A NEW value updates the pending row, never a second one.
      await store.put({ ...base, externalValue: "active", mappedValue: "in_progress" }, "webhook", 3_000);
      rows = await store.forBoard(board);
      const pending = rows.filter((r) => r.status === "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ externalValue: "active", detectedAt: 3_000 });
      // The warning row: mappedValue undefined round-trips as null.
      await store.put({ ...base, externalValue: "In QA", mappedValue: undefined }, "webhook", 4_000);
      rows = await store.forBoard(board);
      expect(rows.find((r) => r.status === "pending")!.mappedValue).toBeUndefined();
    });

    it("decide is once, board-scoped; supersedePending flips the named fields", async () => {
      const store = make();
      const base = {
        orgId: "org1",
        boardId: board,
        provider: "fake" as const,
        externalId: "FAKE-2",
        field: "status" as const,
      };
      const a = await store.put({ ...base, nodeId: "nA", externalValue: "done", mappedValue: "completed" }, "webhook", 1_000);
      await store.put({ ...base, nodeId: "nB", externalValue: "done", mappedValue: "completed" }, "webhook", 1_100);
      // Board-scoped read.
      expect(await store.change(`${prefix}-other`, a.id)).toBeUndefined();
      const decided = await store.decide(board, a.id, "applied", "u1", 2_000, { appliedSeq: 42 });
      expect(decided).toMatchObject({ status: "applied", appliedSeq: 42, decidedBy: "u1" });
      // Decided once: a second decide keeps the first outcome.
      const again = await store.decide(board, a.id, "dismissed", "u2", 3_000);
      expect(again).toMatchObject({ status: "applied", decidedBy: "u1" });
      // Supersession touches only the named nodes' pending rows.
      const count = await store.supersedePending(board, ["nA", "nB"], "fake", "status", "superseded by sync", 4_000);
      expect(count).toBe(1); // nA is decided; only nB was pending
      const rows = await store.forBoard(board);
      expect(rows.find((r) => r.nodeId === "nB")).toMatchObject({ status: "superseded" });
      expect(rows.find((r) => r.nodeId === "nA")).toMatchObject({ status: "applied" });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The halves                                                                 */
/* -------------------------------------------------------------------------- */

connectionContract("in-memory", () => new InMemoryIntegrationStore(), `int${tag}`);
actionContract("in-memory", () => new InMemoryIntegrationActionStore(), `act${tag}`);
ledgerContract("in-memory", () => new InMemoryExecutionLedger({ staleAfterMs: 60_000 }), `led${tag}`);
webhookEventContract("in-memory", () => new InMemoryIntegrationWebhookEventStore(), `whe${tag}`);
inboundContract("in-memory", () => new InMemoryInboundChangeStore(), `inb${tag}`);

describeIf("Postgres integration parity (needs LUCENT_TEST_DATABASE_URL)", () => {
  let target: Db;

  beforeAll(async () => {
    target = createDb(URL!);
    await migrate(target);
  });
  afterAll(async () => {
    await closeDb(target);
  });

  connectionContract("postgres", () => new PostgresIntegrationStore(target.db), `pgi${tag}`);
  actionContract("postgres", () => new PostgresIntegrationActionStore(target.db), `pga${tag}`);
  ledgerContract("postgres", () => new PostgresExecutionLedger(target.db, { staleAfterMs: 60_000 }), `pgl${tag}`);
  webhookEventContract("postgres", () => new PostgresIntegrationWebhookEventStore(target.db), `pgw${tag}`);
  inboundContract("postgres", () => new PostgresInboundChangeStore(target.db), `pgn${tag}`);
});
