import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_AFTER_MS,
  InMemoryStripeEventStore,
  truncateError,
  type StripeEventStore,
} from "../src/billing/events.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { seedAnchors } from "./helpers/seedAnchors.js";
import { stripeEvents } from "../src/db/schema.js";
import { sql } from "drizzle-orm";
import { migrate } from "../src/db/migrate.js";
import { PostgresStripeEventStore } from "../src/store/pg-stripe-events.js";

/**
 * The Stripe webhook idempotency ledger, contract-first: the same suite runs
 * over the in-memory store (always) and the Postgres twin (when
 * LUCENT_TEST_DATABASE_URL is set), which is the whole reason both exist. If a
 * behaviour is asserted here, both implementations must show it — the ledger's
 * claim protocol is what makes webhook handling exactly-once *in effect*, and
 * a divergence between the two halves would mean local tests and production
 * disagree about what a duplicate is.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;

/** Unique per run, per the pg suites' shared-database rule (pg-store.test.ts). */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function event(id: string, type = "invoice.paid") {
  return { id, type, livemode: "test" as const };
}

function ledgerSuite(name: string, makeStore: () => StripeEventStore | Promise<StripeEventStore>) {
  describe(`StripeEventStore contract: ${name}`, () => {
    it("claims a new event, once, with attempts=1", async () => {
      const store = await makeStore();
      const claim = await store.claim(event(`evt_new_${tag}`), 1000);
      expect(claim.outcome).toBe("claimed");
      if (claim.outcome !== "claimed") return;
      expect(claim.record.status).toBe("received");
      expect(claim.record.attempts).toBe(1);
      expect(claim.record.receivedAt).toBe(1000);
      expect(claim.record.orgId).toBeNull();
      expect(claim.record.processedAt).toBeNull();
    });

    it("answers duplicate for a terminal row and in_flight for a fresh one", async () => {
      const store = await makeStore();
      const id = `evt_states_${tag}`;

      await store.markProcessed(id, "org_1", 2000); // not seen yet — patch must be a no-op…
      const first = await store.claim(event(id), 2000);
      expect(first.outcome).toBe("claimed");
      await store.markProcessed(id, "org_1", 2000);

      // Terminal: a redelivery is a duplicate whether it arrives tomorrow…
      const dup = await store.claim(event(id), 2_000_000);
      expect(dup.outcome).toBe("duplicate");
      if (dup.outcome === "duplicate") {
        expect(dup.record.status).toBe("processed");
        expect(dup.record.orgId).toBe("org_1");
      }

      // …and ignored is terminal too.
      const id2 = `evt_ign_${tag}`;
      await store.claim(event(id2), 1000);
      await store.markIgnored(id2, 1500);
      expect((await store.claim(event(id2), 2000)).outcome).toBe("duplicate");

      // In-flight: claimed moments ago and not finished.
      const id3 = `evt_live_${tag}`;
      await store.claim(event(id3), 2000);
      const racing = await store.claim(event(id3), 2000 + DEFAULT_STALE_AFTER_MS - 1);
      expect(racing.outcome).toBe("in_flight");
    });

    it("re-claims a stale received row and a failed row, bumping attempts", async () => {
      const store = await makeStore();

      // A crash: claimed, never marked. After the stale window it is work again.
      const crashed = `evt_crash_${tag}`;
      await store.claim(event(crashed), 1000);
      const recovered = await store.claim(event(crashed), 1000 + DEFAULT_STALE_AFTER_MS);
      expect(recovered.outcome).toBe("claimed");
      if (recovered.outcome === "claimed") {
        expect(recovered.record.attempts).toBe(2);
        expect(recovered.record.receivedAt).toBe(1000 + DEFAULT_STALE_AFTER_MS);
      }
      // Still inside the window it belongs to the first worker.
      const fresh = `evt_fresh_${tag}`;
      await store.claim(event(fresh), 1000);
      expect((await store.claim(event(fresh), 1000 + 1)).outcome).toBe("in_flight");

      // A failure is re-claimable immediately: recording it exists so it retries.
      const failed = `evt_fail_${tag}`;
      await store.claim(event(failed), 1000);
      await store.markFailed(failed, "price not in catalogue", 1100);
      const retry = await store.claim(event(failed), 1200);
      expect(retry.outcome).toBe("claimed");
      if (retry.outcome === "claimed") {
        expect(retry.record.attempts).toBe(2);
        // The last failure's reason stays visible while the retry runs.
        expect(retry.record.error).toBe("price not in catalogue");
      }
    });

    it("reports pending() oldest-first: failed rows and abandoned received rows", async () => {
      const store = await makeStore();
      const a = `evt_pend_a_${tag}`;
      const b = `evt_pend_b_${tag}`;
      const c = `evt_pend_c_${tag}`;

      await store.claim(event(a), 1000);
      await store.claim(event(b), 2000);
      await store.claim(event(c), 3000);
      await store.markFailed(b, "boom", 2100);
      await store.markProcessed(c, null, 3100); // terminal: never pending

      const staleAfter = 5000;
      const at = 1000 + staleAfter; // a is abandoned, b failed, c done
      const rows = await store.pending(at, { staleAfterMs: staleAfter });
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
      expect(ids).not.toContain(c);
      // Oldest first, so a bounded sweep works through the backlog in order.
      expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));

      expect(await store.pending(at, { staleAfterMs: staleAfter, limit: 1 })).toHaveLength(1);
    });

    it("prunes only terminal rows past the cutoff", async () => {
      const store = await makeStore();
      const done = `evt_prune_done_${tag}`;
      const failed = `evt_prune_fail_${tag}`;
      const live = `evt_prune_live_${tag}`;

      await store.claim(event(done), 1000);
      await store.markProcessed(done, null, 1000);
      await store.claim(event(failed), 1000);
      await store.markFailed(failed, "boom", 1000);
      await store.claim(event(live), 1000);

      // before=2000: the processed row qualifies, the failed one does not
      // (its reason is still work), and the received one belongs to a worker.
      //
      // The COUNT is not asserted globally: the table is shared with any other
      // suite pointed at this database, and `prune` is a global DELETE, so
      // residue from an earlier run makes an exact count a flake rather than a
      // fact. What matters is the OUTCOME per row, which is what a scope-agnostic
      // prune has to get right anyway.
      const pruned = await store.prune(2000);
      expect(pruned).toBeGreaterThanOrEqual(1);
      expect((await store.get(done))?.status).toBeUndefined();
      expect((await store.get(failed))?.status).toBe("failed");
      expect((await store.get(live))?.status).toBe("received");
    });

    it("truncates error text to the documented cap", () => {
      expect(truncateError("a\n b\t c")).toBe("a b c");
      const long = truncateError("x".repeat(600));
      expect(long.length).toBeLessThanOrEqual(501); // 500 chars + the ellipsis
      expect(long.endsWith("…")).toBe(true);
    });
  });
}

ledgerSuite("in-memory", () => new InMemoryStripeEventStore());

describeIf("StripeEventStore contract: Postgres", () => {
  let db: Db;

  beforeAll(async () => {
    db = createDb(URL!);
    await migrate(db);
    // `stripe_events.org_id` carries a real FK to `organizations`. This suite
    // asserts the claim ladder's semantics, not FK enforcement, so the anchor
    // the tests name (`org_1`) is seeded here — the reason it only ever passed
    // while it was not running against a real database.
    await seedAnchors(db, { orgId: "org_1", userId: "usr_billing", boardIds: [] });
    // Clear this suite's own rows from any previous run. `pending()` is
    // bounded and ordered OLDEST-FIRST, and this suite uses fixed low
    // timestamps (1000/2000/3000), so residue from an earlier run sorts ahead
    // of the current run's rows and consumes the whole window — the assertion
    // then fails for a reason unrelated to the claim ladder. Scoped by the
    // suite's own id prefix, so a concurrently running suite is untouched.
    await db.db.delete(stripeEvents).where(sql`${stripeEvents.id} like 'evt\\_%'`);
  });
  afterAll(async () => {
    await closeDb(db);
  });

  ledgerSuite("postgres", () => new PostgresStripeEventStore(db));
});
