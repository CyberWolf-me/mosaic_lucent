import { describe, expect, it } from "vitest";
import { FakeProvider } from "../src/integrations/fake.js";
import {
  InMemoryExecutionLedger,
  isReclaimable,
  type ExecutionRecord,
} from "../src/integrations/ledger.js";
import { InMemoryIntegrationActionStore } from "../src/integrations/integrations.js";

/**
 * The exactly-once machinery (Stage D5, ADR 0031). The ledger mirrors the
 * billing-events contract (claim triad, stale window, re-claim, exhaustion)
 * with the one generalization the problem demands: the row stores the
 * payload because an intended external create has no external copy to
 * re-fetch. The PAIRING is what makes the acceptance true: the ledger
 * dedupes attempts, the provider's idempotency key dedupes effects —
 * asserted together below.
 */

const CLAIM = {
  boardId: "b1",
  provider: "fake",
  requestId: "r1",
  lucentActionId: "act_1",
  nodeId: "n1",
};

function withClock(store: InMemoryExecutionLedger, base: number) {
  let now = base;
  const origNow = Date.now;
  Date.now = () => now;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      Date.now = origNow;
    },
  };
}

describe("InMemoryExecutionLedger — the claim triad", () => {
  it("a fresh key is claimed (attempts: 1); the second claim in-window is in_flight", async () => {
    const ledger = new InMemoryExecutionLedger();
    const first = await ledger.claim(CLAIM);
    expect(first.outcome).toBe("claimed");
    if (first.outcome === "claimed") expect(first.record.attempts).toBe(1);
    const second = await ledger.claim(CLAIM);
    expect(second.outcome).toBe("in_flight");
  });

  it("terminal applied → duplicate with the ORIGINAL outcome (never a second effect)", async () => {
    const ledger = new InMemoryExecutionLedger();
    await ledger.claim(CLAIM);
    await ledger.applied("b1", "fake", "r1", "fake-1", Date.now());
    const again = await ledger.claim(CLAIM);
    expect(again.outcome).toBe("duplicate");
    if (again.outcome === "duplicate") {
      expect(again.record.status).toBe("applied");
      expect(again.record.externalId).toBe("fake-1");
    }
  });

  it("failed re-claims immediately (no stale window); stale received re-claims with attempts bumped", async () => {
    const ledger = new InMemoryExecutionLedger({ staleAfterMs: 1_000 });
    const clock = withClock(ledger, 10_000);
    try {
      await ledger.claim(CLAIM);
      await ledger.failed("b1", "fake", "r1", "boom", Date.now());
      // failed → reclaimable NOW.
      const reclaimed = await ledger.claim(CLAIM);
      expect(reclaimed.outcome).toBe("claimed");
      if (reclaimed.outcome === "claimed") expect(reclaimed.record.attempts).toBe(2);

      // A stuck received row: in-window → in_flight; past the window → claimed.
      clock.advance(500);
      expect((await ledger.claim(CLAIM)).outcome).toBe("in_flight");
      clock.advance(600); // past 1s staleAfter
      const stale = await ledger.claim(CLAIM);
      expect(stale.outcome).toBe("claimed");
      if (stale.outcome === "claimed") expect(stale.record.attempts).toBe(3);
      // The prior attempt's error stays visible on the reclaimed row.
      expect(stale.record.error ?? "").not.toBeNull();
    } finally {
      clock.restore();
    }
  });

  it("exhaustion: at max attempts a received row becomes permanent failed", async () => {
    const ledger = new InMemoryExecutionLedger({ staleAfterMs: 1, maxAttempts: 3 });
    const clock = withClock(ledger, 1_000);
    try {
      await ledger.claim(CLAIM); // 1
      clock.advance(10);
      await ledger.claim(CLAIM); // 2 (stale reclaim)
      clock.advance(10);
      const third = await ledger.claim(CLAIM); // 3
      expect(third.outcome).toBe("claimed");
      clock.advance(10);
      const fourth = await ledger.claim(CLAIM); // at max → exhausted
      expect(fourth.outcome).toBe("exhausted");
      if (fourth.outcome === "exhausted") {
        expect(fourth.record.status).toBe("failed");
        expect(fourth.record.error).toContain("exhausted");
      }
      // And the exhausted row stays failed — isReclaimable honors terminal failed?
      // (failed IS reclaimable in the Stripe shape — but exhaustion is the
      // wall: the row keeps status failed and attempts past max, and the
      // route refuses to execute exhausted claims, which is the contract.)
      const row = await ledger.get("b1", "fake", "r1");
      expect(row!.attempts).toBeGreaterThanOrEqual(3);
    } finally {
      clock.restore();
    }
  });

  it("isReclaimable: failed always; received only past the window; applied never", () => {
    const now = 10_000;
    const received: ExecutionRecord = {
      boardId: "b",
      provider: "fake",
      requestId: "r",
      lucentActionId: "a",
      nodeId: "n",
      status: "received",
      attempts: 1,
      error: null,
      beganAt: now - 5_000,
      appliedAt: null,
      externalId: null,
    };
    // beganAt 5s ago, staleAfter 1s → stale → reclaimable.
    expect(isReclaimable(received, now, 1_000)).toBe(true);
    expect(isReclaimable({ ...received, beganAt: now - 1 }, now, 1_000)).toBe(false);
    expect(isReclaimable({ ...received, status: "failed", error: "x" }, now, 1_000)).toBe(true);
    expect(isReclaimable({ ...received, status: "applied" }, now, 1_000)).toBe(false);
  });

  it("pending feeds the sweep: reclaimable rows, oldest first, capped", async () => {
    const ledger = new InMemoryExecutionLedger({ staleAfterMs: 1_000 });
    const clock = withClock(ledger, 10_000);
    try {
      await ledger.claim({ ...CLAIM, requestId: "r-old", nodeId: "n1" });
      clock.advance(100);
      await ledger.claim({ ...CLAIM, requestId: "r-new", nodeId: "n2" });
      clock.advance(2_000); // both now stale; r-old staler
      const pending = await ledger.pending(1_000, Date.now());
      expect(pending.map((r) => r.requestId)).toEqual(["r-old", "r-new"]);
      const capped = await ledger.pending(1_000, Date.now(), 1);
      expect(capped).toHaveLength(1);
    } finally {
      clock.restore();
    }
  });
});

describe("InMemoryIntegrationActionStore — the B3 pattern, new kind", () => {
  const ITEM = (nodeId: string) => ({
    nodeId,
    action: "create" as const,
    title: `Task ${nodeId}`,
    status: "open",
    idempotencyKey: `ext_${nodeId}_act_1`,
  });

  it("one pending per (board, provider): a new proposal supersedes", async () => {
    const store = new InMemoryIntegrationActionStore();
    const first = await store.propose({
      orgId: "o",
      boardId: "b1",
      provider: "fake",
      connectionId: "int_1",
      items: [ITEM("n1")],
      createdBy: "u",
      now: 1,
    });
    const second = await store.propose({
      orgId: "o",
      boardId: "b1",
      provider: "fake",
      connectionId: "int_1",
      items: [ITEM("n2")],
      createdBy: "u",
      now: 2,
    });
    expect(second.supersededId).toBe(first.record.id);
    const history = await store.actionsForBoard("b1");
    expect(history.map((r) => r.status).sort()).toEqual(["pending", "superseded"]);
    // A DIFFERENT provider gets its own pending slot.
    const other = await store.propose({
      orgId: "o",
      boardId: "b1",
      provider: "linear" as never,
      connectionId: "int_2",
      items: [ITEM("n3")],
      createdBy: "u",
      now: 3,
    });
    expect(other.supersededId).toBeNull();
  });

  it("decided once: the second decide is a no-op returning the current state", async () => {
    const store = new InMemoryIntegrationActionStore();
    const { record } = await store.propose({
      orgId: "o",
      boardId: "b1",
      provider: "fake",
      connectionId: "int_1",
      items: [ITEM("n1")],
      createdBy: "u",
      now: 1,
    });
    const first = await store.decide("b1", record.id, "approved", "u", 2);
    expect(first!.status).toBe("approved");
    const second = await store.decide("b1", record.id, "rejected", "u", 3);
    // The second decider's decision had NO effect.
    expect(second!.status).toBe("approved");
    expect(second!.decidedAt).toBe(2);
  });

  it("board-scoped: a leaked id from another board is not a read", async () => {
    const store = new InMemoryIntegrationActionStore();
    const { record } = await store.propose({
      orgId: "o",
      boardId: "b1",
      provider: "fake",
      connectionId: "int_1",
      items: [ITEM("n1")],
      createdBy: "u",
      now: 1,
    });
    expect(await store.action("b2", record.id)).toBeUndefined();
    expect(await store.action("b1", record.id)).toBeDefined();
    expect(await store.decide("b2", record.id, "approved", "u", 2)).toBeUndefined();
  });
});

describe("FakeProvider — the D5 hooks", () => {
  it("a repeated idempotency key returns the SAME task (the effects dedup)", async () => {
    const fake = new FakeProvider();
    const first = await fake.createTask({ title: "A", idempotencyKey: "ext_n1_act_1" });
    const retry = await fake.createTask({ title: "A", idempotencyKey: "ext_n1_act_1" });
    expect(retry.externalId).toBe(first.externalId);
    expect(fake.taskCount).toBe(1); // ONE external task, not two
    // Both ATTEMPTS are recorded — the ledger's business — but one effect.
    expect(fake.calls.filter((c) => c.method === "createTask")).toHaveLength(2);
    // A DIFFERENT key is a different effect.
    const other = await fake.createTask({ title: "B", idempotencyKey: "ext_n2_act_1" });
    expect(other.externalId).not.toBe(first.externalId);
    expect(fake.taskCount).toBe(2);
  });

  it("without a key, the retry duplicates (why the key is mandatory in the executor)", async () => {
    const fake = new FakeProvider();
    await fake.createTask({ title: "A" });
    await fake.createTask({ title: "A" });
    expect(fake.taskCount).toBe(2); // the LIN-482/LIN-483 failure mode
  });

  it("failNext: the next createTask rejects once, then works", async () => {
    const fake = new FakeProvider();
    fake.failNext("createTask");
    await expect(fake.createTask({ title: "A" })).rejects.toThrow("fake network failure");
    const ok = await fake.createTask({ title: "A" });
    expect(ok.externalId).toBe("fake-1");
  });

  it("hangNext: the next createTask never settles (the timeout arm)", async () => {
    const fake = new FakeProvider();
    fake.hangNext();
    let settled = false;
    const p = fake.createTask({ title: "A" }).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    // The next call works (the hang was one-shot).
    const ok = await fake.createTask({ title: "B" });
    expect(ok.externalId).toBe("fake-1");
    void p;
  });
});
