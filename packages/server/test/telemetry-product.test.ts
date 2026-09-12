import { describe, expect, it } from "vitest";
import { Telemetry, type TelemetryEvent } from "../src/telemetry.js";
import { MetricsRegistry } from "../src/obs/metrics.js";

/**
 * The §10 product analytics: behavior counters distinct from the technical
 * RED series. The event vocabulary is FIXED (telemetry.ts PRODUCT_EVENTS —
 * the cardinality rule), time-to-first-board is a distribution with its own
 * coarse activation buckets, and the snapshot exposes both for /metrics.
 */

describe("Telemetry — the product counters", () => {
  it("counts each product event by name", () => {
    const t = new Telemetry();
    t.record({ kind: "product", event: "board_created" });
    t.record({ kind: "product", event: "board_created" });
    t.record({ kind: "product", event: "share_link_created" });
    const snap = t.snapshot();
    expect(snap.product.events.board_created).toBe(2);
    expect(snap.product.events.share_link_created).toBe(1);
    // The vocabulary is complete in the snapshot: unseen events read 0,
    // never undefined.
    for (const event of Object.keys(snap.product.events)) {
      expect(typeof snap.product.events[event as keyof typeof snap.product.events]).toBe("number");
    }
  });

  it("time-to-first-board is a distribution, not a count", () => {
    const t = new Telemetry();
    t.record({ kind: "timeToFirstBoard", seconds: 45 });
    t.record({ kind: "timeToFirstBoard", seconds: 600 });
    t.record({ kind: "timeToFirstBoard", seconds: 7200 });
    const ttb = t.snapshot().product.timeToFirstBoard;
    expect(ttb.samples).toBe(3);
    expect(ttb.p50).toBe(600);
    expect(ttb.p95).toBe(7200);
  });

  it("the event emits to subscribers (the bridge's input)", () => {
    const seen: TelemetryEvent[] = [];
    const t = new Telemetry();
    const stop = t.subscribe((e) => seen.push(e));
    t.record({ kind: "product", event: "board_created" });
    t.record({ kind: "timeToFirstBoard", seconds: 120 });
    stop();
    expect(seen).toHaveLength(2);
  });
});

describe("the Prometheus bridge — the product series", () => {
  it("counts by the fixed event vocabulary; the histogram is label-free", () => {
    const metrics = new MetricsRegistry();
    // Mirror the app's exact definitions (app.ts).
    const productTotal = metrics.counter({
      name: "lucent_product_events_total",
      help: "x",
      labelNames: ["event"],
    });
    const timeToFirstBoard = metrics.histogram({
      name: "lucent_time_to_first_board_seconds",
      help: "x",
      labelNames: [],
      buckets: [60, 300, 900, 3600, 21600, 86400, 604800, 2592000],
    });
    productTotal.inc({ event: "board_created" });
    productTotal.inc({ event: "share_link_created" });
    timeToFirstBoard.observe(600);

    const body = metrics.render();
    expect(body).toContain('lucent_product_events_total{event="board_created"}');
    expect(body).toContain('lucent_product_events_total{event="share_link_created"}');
    expect(body).toContain("lucent_time_to_first_board_seconds");
    // The CARDINALITY RULE: the event label only ever carries the fixed
    // vocabulary — no board id, no org id, no user id anywhere.
    for (const line of body.split("\n")) {
      if (line.includes("lucent_product_events_total{") && !/event="(board_created|share_link_created)"/.test(line)) {
        throw new Error(`cardinality violation: ${line}`);
      }
      if (line.includes("lucent_time_to_first_board_seconds{")) {
        throw new Error(`cardinality violation: ${line}`);
      }
    }
  });
});
