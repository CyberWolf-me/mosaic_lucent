import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { boards as boardsTable, organizations, users as usersTable } from "../src/db/schema.js";
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
      // Stage D10: the org-scoped GC feed — newest-synced first, capped.
      await store.linkTask(
        { orgId: "o", boardId: `${prefix}-b2`, nodeId: "n1", provider: "fake", externalId: "E3", lastSyncedStatus: "todo" },
        4_000,
      );
      const orgLinks = await store.linksForOrg("o", 10);
      // The re-link above bumped n1's syncedAt to 4_000: the linear link (3k)
      // and E3 (4k on another board) are in the feed; another org sees none.
      expect(orgLinks.length).toBeGreaterThanOrEqual(2);
      expect(orgLinks.every((l) => l.orgId === "o")).toBe(true);
      expect((await store.linksForOrg(`${prefix}-other-org`, 10)).length).toBe(0);
      // The cap is honored.
      expect((await store.linksForOrg("o", 1)).length).toBe(1);
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
        items: [{ nodeId: "n2", action: "create", title: "T2", status: "open", idempotencyKey: "ext_n2",
          // Stage D8: the capability warnings ride the item (the jsonb
          // round-trip — the approve gate reads them back from the store).
          warnings: [{ field: "dueDate", reason: "GitHub has no due-date field" }] }],
        createdBy: "u", now: 2,
        // Stage D9: the AI origin's provenance + the revision snapshot (the
        // columns migration 0022 adds — the round-trip both twins keep).
        origin: "ai",
        provenance: { request: "send the launch ones", explanation: "Launch-related." },
        sourceSeq: 1042,
      });
      expect(b.supersededId).toBe(a.record.id);
      expect(b.record.connectionId).toBe("int_1");
      expect(b.record.items).toHaveLength(1);
      // The warnings round-trip verbatim.
      expect(b.record.items[0]!.warnings).toEqual([
        { field: "dueDate", reason: "GitHub has no due-date field" },
      ]);
      // The D9 provenance round-trips: origin, the request/explanation
      // pair, and the revision the selection was computed against. The
      // FIRST record (no origin passed) reads as undefined — the callers'
      // default is "user".
      expect(b.record.origin).toBe("ai");
      expect(b.record.provenance).toEqual({
        request: "send the launch ones",
        explanation: "Launch-related.",
      });
      expect(b.record.sourceSeq).toBe(1042);
      expect(a.record.origin).toBeUndefined();

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

    it("Stage D10 pruneTerminal: the terminal set only, the terminal timestamp, bounded", async () => {
      const store = make();
      const mk = async (id: string, status: "processed" | "ignored" | "failed" | "received", at: number) => {
        await store.claim({ id, provider: "fake", orgId: "o", externalId: null, now: at - 1, staleAfterMs: 1 });
        if (status === "failed") await store.markFailed(id, "boom", at);
        else if (status === "processed") await store.markProcessed(id, "o", at);
        else if (status === "ignored") await store.markIgnored(id, at);
      };
      await mk(`${prefix}-p1`, "processed", 1_000);
      await mk(`${prefix}-p2`, "ignored", 1_100);
      await mk(`${prefix}-p3`, "processed", Date.now()); // fresh terminal
      await mk(`${prefix}-f1`, "failed", 1_200); // retryable — NEVER pruned
      await mk(`${prefix}-r1`, "received", 1_300); // in-flight — NEVER pruned
      // The prune is a GLOBAL bounded delete (an operational sweep, not a
      // per-board query), and this suite shares one database across runs by
      // design — the no-TRUNCATE convention. So the count can include old
      // terminal rows left by previous runs of this very contract (their ev1
      // rows are processed at 1_050). Assert on THIS test's rows by outcome,
      // not on the global count: the ids this test created are the contract;
      // the count's own bounds are pinned by the cap arm below, which uses a
      // fresh window and a limit of 1 against rows that cannot include
      // another run's ev1 if the cap itself is honoured.
      const pruned = await store.pruneTerminal(Date.now() - 1000, 100);
      expect(pruned).toBeGreaterThanOrEqual(2); // at least this test's two old terminal rows
      // failed + received still feed the sweep; the fresh terminal row does
      // not (not in the pending feed) and was not counted.
      const feed = new Set((await store.pending(2_000, Date.now() + 1, 100)).map((e) => e.id));
      expect(feed.has(`${prefix}-f1`)).toBe(true);
      expect(feed.has(`${prefix}-r1`)).toBe(true);
      // The cap: one row at a time.
      await mk(`${prefix}-p4`, "processed", 2_000);
      await mk(`${prefix}-p5`, "processed", 2_100);
      // The second prune may also carry a prior run's residue, but never
      // more than the cap — that is the bound being pinned.
      expect(await store.pruneTerminal(Date.now() - 1000, 1)).toBeLessThanOrEqual(1);
      expect(await store.pruneTerminal(Date.now() - 1000, 1)).toBeLessThanOrEqual(1);
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

      // Stage D10 pruneTerminal: the terminal set (applied/dismissed/
      // superseded) by decidedAt, never pending, bounded.
      const pending = await store.put(
        { ...base, nodeId: "nC", externalValue: "todo", mappedValue: "open" },
        "webhook",
        5_000,
      );
      expect(
        await store.pruneTerminal(Date.now(), 100),
      ).toBe(2); // nA (applied, decided 2_000) + nB (superseded, decided 4_000)
      const after = await store.forBoard(board);
      expect(after.find((r) => r.nodeId === "nC")).toMatchObject({ status: "pending" });
      expect(after.find((r) => r.nodeId === "nA")).toBeUndefined();
      expect(after.find((r) => r.nodeId === "nB")).toBeUndefined();
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
    // FK anchors. The shared contracts write rows that reference real
    // organizations and boards (`integration_connections.org_id`,
    // `integration_task_links/_actions/_inbound_changes.board_id` all carry
    // foreign keys), so the ids they use — org "o"/"org1" and each
    // contract's `${prefix}-*` boards — must exist. The in-memory twin has
    // no FKs and needs none; this seeding is the Postgres half's only
    // extra duty, per the same convention pg-store.test.ts uses for its
    // boards. Rows carry the run tag so repeated runs never collide.
    const { emptyWorkspace } = await import("../src/boards.js");
    const user = { id: `u-${tag}`, email: `int-${tag}@e.test`, name: "int", passwordHash: "x:y", tokenVersion: 0, createdAt: Date.now(), emailVerifiedAt: null };
    await target.db.insert(usersTable).values(user).onConflictDoNothing();
    for (const orgId of ["o", "org1", `pgi${tag}-org`, `${tag}-other-org`]) {
      await target.db
        .insert(organizations)
        .values({ id: orgId, name: `Integration anchor ${orgId}`, createdAt: Date.now() })
        .onConflictDoNothing();
    }
    const boardIds = [
      `pgi${tag}-board`, `pgi${tag}-b2`,
      `pga${tag}-ab`,
      `pgl${tag}-lb`, `pgl${tag}-lc`,
      `pgn${tag}-qb`,
    ];
    for (const id of boardIds) {
      await target.db
        .insert(boardsTable)
        .values({
          id,
          orgId: "o",
          ownerId: user.id,
          name: "anchor",
          workspace: emptyWorkspace("anchor"),
          createdAt: 0,
          updatedAt: 0,
        })
        .onConflictDoNothing();
    }
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
