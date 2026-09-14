import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEvents } from "../src/db/schema.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { seedAnchors } from "./helpers/seedAnchors.js";
import {
  InMemoryOutbox,
  OUTBOX_MAX_ATTEMPTS,
  OutboxDispatcher,
  PostgresOutbox,
  type OutboxEvent,
  type OutboxStore,
} from "../src/outbox.js";

/**
 * P2 (docs/20, advisory §18/§19) — domain events + the transactional outbox.
 *
 * The property worth testing is not "an append works". It is the one the
 * advisory's problem statement names: the DB transaction succeeds and the
 * event publish fails, or vice versa. These tests drive the three acceptance
 * criteria docs/20 fixes for this phase:
 *
 *   1. commit succeeds, the process dies before dispatch -> after restart the
 *      event still delivers;
 *   2. duplicate delivery is observable and harmless (a consumer that records
 *      `event.id` sees it once);
 *   3. a row written outside a transaction is impossible to do by accident.
 *
 * The third is a property of the API shape (`append(event, tx)`), so it is
 * pinned by showing that an aborted transaction takes its outbox row with it
 * — which is exactly what "outside a transaction" would fail to do.
 */

const TEST_URL = process.env.LUCENT_TEST_DATABASE_URL;

describe("the in-memory outbox (the no-database dev path)", () => {
  it("appends, lists in order, and marks dispatched once", async () => {
    const store = new InMemoryOutbox();
    const first = await store.append({ type: "BoardOperationCommitted", boardId: "b1", payload: { seq: 1 } });
    const second = await store.append({ type: "MeetingEnded", orgId: "o1" });

    const pending = await store.pending(10);
    expect(pending.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(await store.pendingCount()).toBe(2);

    expect(await store.markDispatched(first.id)).toBe(true);
    // First-wins: a second dispatcher's mark matches nothing.
    expect(await store.markDispatched(first.id)).toBe(false);
    expect(await store.pendingCount()).toBe(1);
  });

  it("a failed attempt leaves the row pending with its error recorded", async () => {
    const store = new InMemoryOutbox();
    const event = await store.append({ type: "StripeEventApplied", orgId: "o1" });
    await store.markFailed(event.id, "provider exploded");

    const [row] = await store.pending(10);
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBe("provider exploded");
    expect(row!.dispatchedAt).toBeUndefined();
  });
});

describe("the dispatcher", () => {
  it("delivers to the named consumer and marks the row dispatched", async () => {
    const store = new InMemoryOutbox();
    await store.append({ type: "BoardOperationCommitted", boardId: "b1", payload: { seq: 7 } });
    const seen: OutboxEvent[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      consumers: { BoardOperationCommitted: [(e) => void seen.push(e)] },
    });

    const result = await dispatcher.tick();
    expect(result.delivered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.seq).toBe(7);
    // Drained: a second tick has nothing to do.
    expect((await dispatcher.tick()).delivered).toBe(0);
    expect(await store.pendingCount()).toBe(0);
  });

  it("an event type with no consumer is marked dispatched, not left as fake backlog", async () => {
    // Otherwise a vocabulary entry added before its consumer accumulates
    // forever and the queue-depth metric reads as a backlog no work can clear.
    const store = new InMemoryOutbox();
    await store.append({ type: "AssetStored", boardId: "b1" });
    const dispatcher = new OutboxDispatcher({ store, consumers: {} });
    expect((await dispatcher.tick()).delivered).toBe(1);
    expect(await store.pendingCount()).toBe(0);
  });

  it("a throwing consumer leaves the row for the retry and records why", async () => {
    const store = new InMemoryOutbox();
    await store.append({ type: "ExternalTaskSynced", boardId: "b1" });
    let calls = 0;
    const dispatcher = new OutboxDispatcher({
      store,
      consumers: {
        ExternalTaskSynced: [
          () => {
            calls += 1;
            throw new Error("linear is down");
          },
        ],
      },
    });

    const first = await dispatcher.tick();
    expect(first.failed).toBe(1);
    expect(first.delivered).toBe(0);
    const [row] = await store.pending(10);
    expect(row!.lastError).toBe("linear is down");
    expect(await store.pendingCount()).toBe(1);

    // The next tick retries it — at-least-once, not at-most-once.
    const second = await dispatcher.tick();
    expect(second.failed).toBe(1);
    expect(calls).toBe(2);
  });

  it("duplicate delivery is harmless when the consumer keys on event.id", async () => {
    // ACCEPTANCE 2. The consumer in the real system records the id it has
    // already handled; here the same idea, so a redelivery is observable
    // and inert.
    //
    // The redelivery is manufactured the way a crash manufactures one: the
    // consumer does its work and THEN throws, so the row stays undispatched
    // (the dispatcher never got to mark it) while the side effect already
    // happened. That is the exact window at-least-once delivery opens.
    const store = new InMemoryOutbox();
    await store.append({ type: "MeetingEnded", boardId: "b1" });
    const handled = new Set<string>();
    let effects = 0;
    let firstPass = true;
    const consumer = (e: OutboxEvent) => {
      if (!handled.has(e.id)) {
        handled.add(e.id);
        effects += 1;
      }
      if (firstPass) {
        firstPass = false;
        throw new Error("crash after the side effect, before the ack");
      }
    };
    const dispatcher = new OutboxDispatcher({ store, consumers: { MeetingEnded: [consumer] } });

    const first = await dispatcher.tick();
    expect(first.failed).toBe(1);
    // Still pending: the ack never landed.
    expect(await store.pendingCount()).toBe(1);

    // The retry delivers the same event a second time — and the consumer's
    // id check makes it inert.
    const second = await dispatcher.tick();
    expect(second.delivered).toBe(1);
    expect(effects).toBe(1);
    expect(handled.size).toBe(1);
    expect(await store.pendingCount()).toBe(0);
  });

  it("a re-entrant tick does not double-deliver the batch in flight", async () => {
    const store = new InMemoryOutbox();
    await store.append({ type: "MeetingEnded", boardId: "b1" });
    let inFlight = 0;
    const dispatcher = new OutboxDispatcher({
      store,
      consumers: {
        MeetingEnded: [
          async () => {
            inFlight += 1;
            // While this consumer is suspended, a timer fires a second tick.
            const overlapping = await dispatcher.tick();
            expect(overlapping.delivered).toBe(0);
          },
        ],
      },
    });
    expect((await dispatcher.tick()).delivered).toBe(1);
    expect(inFlight).toBe(1);
  });

  it("subscribe() attaches a consumer after construction and detaches cleanly", async () => {
    const store = new InMemoryOutbox();
    await store.append({ type: "ProposalApproved", boardId: "b1" });
    const dispatcher = new OutboxDispatcher({ store, consumers: {} });
    const seen: string[] = [];
    const stop = dispatcher.subscribe("ProposalApproved", (e) => void seen.push(e.id));
    await dispatcher.tick();
    expect(seen).toHaveLength(1);

    await store.append({ type: "ProposalApproved", boardId: "b1" });
    stop();
    await dispatcher.tick();
    expect(seen).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The Postgres twin — same contract, plus the transactional guarantee        */
/* -------------------------------------------------------------------------- */

describe.skipIf(!TEST_URL)("PostgresOutbox", () => {
  let target: Db;
  let store: PostgresOutbox;

  beforeAll(async () => {
    target = createDb(TEST_URL!);
    await migrate(target);
    await target.db.delete(outboxEvents);
    store = new PostgresOutbox(target);
  });

  afterAll(async () => {
    await target.db.delete(outboxEvents);
    await closeDb(target);
  });

  /**
   * The table is shared with any other process pointed at the same database,
   * so each test clears it first rather than depending on what the previous
   * test left. A dispatcher's `tick()` drains whatever is pending, so
   * leftover rows would silently change a delivered count.
   */
  async function reset(): Promise<void> {
    await target.db.delete(outboxEvents);
  }

  it("round-trips an event with its scope and payload", async () => {
    await reset();
    const appended = await store.append({
      type: "BoardOperationCommitted",
      boardId: "board-a",
      orgId: "org-a",
      payload: { seq: 42 },
    });
    const [row] = await store.pending(10);
    expect(row!.id).toBe(appended.id);
    expect(row!.type).toBe("BoardOperationCommitted");
    expect(row!.boardId).toBe("board-a");
    expect(row!.orgId).toBe("org-a");
    expect(row!.payload.seq).toBe(42);
    expect(row!.attempts).toBe(0);
  });

  it("ACCEPTANCE 1: a committed transaction's event survives a crash before dispatch", async () => {
    await reset();
    // The whole point of the outbox. Write the row inside a committed
    // transaction, then "crash" before the dispatcher ever runs (we simply
    // never call it — the process is gone). A fresh store instance reads the
    // durable row and delivers it.
    await target.db.transaction(async (tx) => {
      await store.append({ type: "MeetingEnded", boardId: "board-crash" }, tx);
    });

    // A new process would open a new pool: this is that.
    const restarted = new PostgresOutbox(createDb(TEST_URL!));
    const seen: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store: restarted,
      consumers: { MeetingEnded: [(e) => void seen.push(e.boardId!)] },
    });
    expect((await dispatcher.tick()).delivered).toBe(1);
    expect(seen).toEqual(["board-crash"]);
  });

  it("ACCEPTANCE 3: an aborted transaction takes its outbox row with it", async () => {
    await reset();
    // The inverse of acceptance 1, and what makes "a row written outside a
    // transaction is impossible" true: the row is not merely written near the
    // change, it is inside the same transaction. Roll back and neither exists.
    let thrown = false;
    await expect(
      target.db.transaction(async (tx) => {
        await store.append({ type: "StripeEventApplied", orgId: "org-rollback" }, tx);
        thrown = true;
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    expect(thrown).toBe(true);

    // The row is gone: the rollback took it, exactly as it took the state
    // change it described.
    expect(await store.pendingCount()).toBe(0);
  });

  it("markDispatched is first-wins under a race: exactly one caller wins", async () => {
    await reset();
    await store.append({ type: "AssetStored", boardId: "board-race" });
    const [row] = await store.pending(1);
    const [a, b] = await Promise.all([
      store.markDispatched(row!.id),
      store.markDispatched(row!.id),
    ]);
    // Exactly one of the two returns true — the status-guarded UPDATE is
    // what makes this safe across two API instances.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("a poison row stops being retried past the attempt ceiling", async () => {
    await reset();
    const event = await store.append({ type: "ExternalTaskSynced", boardId: "board-poison" });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
      await store.markFailed(event.id, `attempt ${i}`);
    }
    const pending = await store.pending(50);
    expect(pending.find((e) => e.id === event.id)).toBeUndefined();
    // It is not deleted: the operator finds it by its recorded error.
    expect(await store.pendingCount()).toBe(1);
  });

  it("prune drops delivered rows and leaves undispatched ones alone", async () => {
    await reset();
    await store.append({ type: "AssetStored", boardId: "board-keep" });
    const delivered = await store.append({ type: "AssetStored", boardId: "board-drop" });
    await store.markDispatched(delivered.id, Date.now() - 10 * 60_000);

    const removed = await store.prune(60_000);
    expect(removed).toBe(1);
    const remaining = await store.pending(50);
    expect(remaining.some((e) => e.boardId === "board-keep")).toBe(true);
    expect(remaining.some((e) => e.boardId === "board-drop")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The commit path: op log + outbox event are one statement                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!TEST_URL)("BoardOperationCommitted rides the op-log commit", () => {
  let target: Db;
  let store: PostgresBoardStore;

  /**
   * `op_log.board_id` carries a real FK to `boards`, which itself FKs org and
   * owner. The commit path is therefore only exercisable against seeded
   * anchors — the same shape `pg-integrations.test.ts` needs. One org, one
   * user, reused by every board this suite writes.
   */
  async function seedBoard(boardId: string): Promise<void> {
    await seedAnchors(target, {
      orgId: "org-outbox",
      userId: "user-outbox",
      email: "outbox@example.com",
      boardIds: [boardId],
    });
  }

  beforeAll(async () => {
    target = createDb(TEST_URL!);
    await migrate(target);
    await target.db.delete(outboxEvents);
    store = new PostgresBoardStore(target);
  });

  afterAll(async () => {
    await target.db.delete(outboxEvents);
    await closeDb(target);
  });

  it("a committed batch writes exactly one BoardOperationCommitted event with its seq", async () => {
    const boardId = `b-outbox-${Date.now()}`;
    await seedBoard(boardId);
    await target.db.delete(outboxEvents);
    const result = await store.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "default", label: "A" } as never],
      by: "user-outbox",
      label: "ai: draw",
      at: Date.now(),
      orgId: "org-outbox",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await target.db.select().from(outboxEvents);
    expect(rows.filter((r) => r.boardId === boardId)).toHaveLength(1);
    expect(rows[0]!.type).toBe("BoardOperationCommitted");
    expect(rows[0]!.boardId).toBe(boardId);
    expect(rows[0]!.orgId).toBe("org-outbox");
    // The payload names the seq, not the ops: a subscriber resyncs from the
    // log rather than trusting a payload copy.
    expect((rows[0]!.payload as { seq: number }).seq).toBe(result.seq);
    expect(rows[0]!.payload).not.toHaveProperty("ops");
  });

  it("a replayed requestId writes NO event: the duplicate arm is silent", async () => {
    const boardId = `b-outbox-dup-${Date.now()}`;
    const requestId = `req-${Date.now()}`;
    await seedBoard(boardId);
    await target.db.delete(outboxEvents);
    const entry = {
      boardId,
      ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "default", label: "A" } as never],
      by: "user-outbox",
      label: "ai: draw",
      at: Date.now(),
      requestId,
    };
    const first = await store.appendOp(entry);
    expect(first.ok).toBe(true);
    const second = await store.appendOp(entry);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.duplicate).toBe(true);

    // One event, not two: the second statement's `evt` CTE read from an `ins`
    // that inserted nothing, so there was no row to announce.
    const rows = await target.db.select().from(outboxEvents);
    // Scoped to this board: the table is shared with any other suite pointed
    // at the same database, so a global count would be a flake, not a fact.
    expect(rows.filter((r) => r.boardId === boardId)).toHaveLength(1);
  });

  it("a lost race writes NO event: no seq, nothing to announce", async () => {
    const boardId = `b-outbox-lost-${Date.now()}`;
    await seedBoard(boardId);
    const base = {
      boardId,
      ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "default", label: "A" } as never],
      by: "user-outbox",
      label: "",
      at: Date.now(),
    };
    const first = await store.appendOp({ ...base, expectedSeq: 1 });
    expect(first.ok).toBe(true);
    // Same expectedSeq again: the head has moved, so this one is `conflict`.
    const second = await store.appendOp({ ...base, expectedSeq: 1 });
    expect(second.ok).toBe(false);

    const rows = await target.db.select().from(outboxEvents);
    expect(rows.filter((r) => r.boardId === boardId)).toHaveLength(1);
  });
});
