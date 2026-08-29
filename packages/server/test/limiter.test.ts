import { describe, expect, it, beforeEach } from "vitest";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";

/**
 * Limiter + ticket store unit tests (M0.3). The integration coverage (per-IP
 * buckets, single-use tickets over the wire) lives in security.test.ts.
 */

describe("Limiter", () => {
  let now: number;
  let l: Limiter;

  beforeEach(() => {
    now = 1_000_000;
    l = new Limiter(3, 60_000, () => now);
  });

  it("allows up to the per-window limit", () => {
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("a").allowed).toBe(false);
  });

  it("refuses with retry-after in seconds, never zero", () => {
    l.check("a");
    l.check("a");
    l.check("a");
    const r = l.check("a");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", () => {
    expect(l.check("a").allowed).toBe(true);
    expect(l.check("b").allowed).toBe(true);
    expect(l.check("a").remaining).toBe(1);
    expect(l.check("b").remaining).toBe(1);
  });

  it("ages out entries after the window", () => {
    l.check("a");
    l.check("a");
    l.check("a");
    now += 61_000;
    expect(l.check("a").allowed).toBe(true);
  });

  it("prune() removes empty buckets and reports the count", () => {
    l.check("a");
    now += 61_000;
    const removed = l.prune();
    expect(removed).toBe(1);
    expect(l.size()).toBe(0);
  });
});

describe("InMemoryTicketStore", () => {
  it("mints opaque tickets and consumes them once", () => {
    const t = new InMemoryTicketStore(60_000);
    const ticket = t.mint("usr_1");
    expect(t.consume(ticket)).toBe("usr_1");
    expect(t.consume(ticket)).toBeNull();
  });

  it("rejects an unknown ticket", () => {
    const t = new InMemoryTicketStore(60_000);
    expect(t.consume("never-minted")).toBeNull();
  });

  it("rejects an expired ticket", () => {
    const t = new InMemoryTicketStore(60_000);
    const ticket = t.mint("usr_1");
    expect(t.consume(ticket, Date.now() + 120_000)).toBeNull();
  });

  it("prune drops only expired entries", () => {
    const t = new InMemoryTicketStore(60_000);
    t.mint("a");
    t.mint("b");
    const removed = t.prune(Date.now() + 120_000);
    expect(removed).toBe(2);
    expect(t.size()).toBe(0);
  });

  it("different users get different tickets", () => {
    const t = new InMemoryTicketStore(60_000);
    const a = t.mint("u_a");
    const b = t.mint("u_b");
    expect(a).not.toBe(b);
    expect(t.consume(a)).toBe("u_a");
    expect(t.consume(b)).toBe("u_b");
  });
});
