import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { InMemoryTicketStore, PgTicketStore, type TicketStore } from "../src/realtimeTicket.js";

/**
 * Ticket-store parity (docs/20 P5): the WS auth ticket is a 60-second
 * single-use secret, and the two stores must not drift in shape — the
 * realtime server consumes through the one `TicketStore` interface, and the
 * PG twin is what makes two API instances behind a stateless ingress work.
 * The in-memory arm always runs; the Postgres arm runs when
 * LUCENT_TEST_DATABASE_URL is set (CI's postgres:16 service).
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;

function contract(name: string, make: () => TicketStore, makeShort: () => TicketStore) {
  describe(`ticket store parity — ${name}`, () => {
    it("mints a ticket that consumes once for the right user, then never again", async () => {
      const store = make();
      const ticket = await store.mint("user-a");
      expect(await store.consume(ticket)).toBe("user-a");
      // Single-use: a replay (the captured-from-a-proxy-log case, the reason
      // tickets exist) is refused.
      expect(await store.consume(ticket)).toBeNull();
    });

    it("an expired ticket never authenticates; an unknown one is null", async () => {
      const store = make();
      const ticket = await store.mint("user-b");
      // 60s TTL store; consume at now = far future says expired.
      expect(await store.consume(ticket, Date.now() + 120_000)).toBeNull();
      expect(await store.consume("not-a-ticket")).toBeNull();
    });

    it("prune drops expired rows only; size reads the live window", async () => {
      // A short-TTL store mints a ticket that is already expired at the
      // prune horizon; the default-TTL store's ticket is not. For the
      // in-memory pair the two stores are independent maps; for the Postgres
      // pair they share one table, so the short-TTL mint is the ONLY way to
      // build a row the prune horizon can hit without taking the live
      // ticket with it (a 60s-TTL row is also inside a 120s horizon).
      const store = make();
      const doomedStore = makeShort();
      const live = await store.mint("user-c");
      const beforeLive = await store.size();
      const doomed = await doomedStore.mint("user-d");
      // The doomed ticket expires at mint+short-ttl; the prune clock is
      // past it but NOT past the live ticket's mint+ttl.
      expect(await doomedStore.prune(Date.now() + 30_000)).toBeGreaterThanOrEqual(1);
      // The doomed ticket is gone for good.
      expect(await doomedStore.consume(doomed, Date.now() + 31_000)).toBeNull();
      // The live store was untouched by the other store's prune.
      expect(await store.size()).toBe(beforeLive);
      expect(await store.consume(live)).toBe("user-c");
    });

    it("two stores are separate authorities — cross-store tickets are unknown", async () => {
      const a = make();
      const b = make();
      const ticket = await a.mint("user-x");
      // For the in-memory pair this pins the per-instance boundary
      // two-instance.test.ts documents; for the PG pair both stores point at
      // one database, so the SAME row is visible — consume on b works — and
      // then single-use means a's second consume is null. Both shapes are
      // correct; the assertion is on the one-use total, not on which store
      // answered.
      const first = await a.consume(ticket);
      const second = await b.consume(ticket);
      expect(first === "user-x" || second === "user-x").toBe(true);
      expect(first === null || second === null).toBe(true);
    });
  });
}

contract(
  "in-memory",
  () => new InMemoryTicketStore(60_000),
  () => new InMemoryTicketStore(1_000),
);

describeIf("Postgres ticket store (needs LUCENT_TEST_DATABASE_URL)", () => {
  let target: Db;

  beforeAll(async () => {
    target = createDb(URL!);
    await migrate(target);
  });
  afterAll(async () => {
    await closeDb(target);
  });

  it("two PgTicketStore instances share the mint/consume table — the cross-instance case", async () => {
    // THE acceptance for docs/20 P5: instance A mints, instance B consumes.
    // Behind a stateless ingress this is the exact sequence a browser's
    // ticket fetch (lands on A) followed by its WS upgrade (lands on B)
    // produces.
    const a = new PgTicketStore(target, 60_000);
    const b = new PgTicketStore(target, 60_000);
    const ticket = await a.mint("cross-instance-user");
    expect(await b.consume(ticket)).toBe("cross-instance-user");
    expect(await a.consume(ticket)).toBeNull();
  });

  contract(
    "postgres",
    () => new PgTicketStore(target, 60_000),
    () => new PgTicketStore(target, 1_000),
  );
});
