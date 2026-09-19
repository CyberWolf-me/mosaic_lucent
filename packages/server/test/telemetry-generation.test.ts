import { describe, expect, it } from "vitest";
import { Telemetry, type TelemetryEvent } from "../src/telemetry.js";
import { MetricsRegistry } from "../src/obs/metrics.js";

/**
 * The generation OUTCOME LEDGER (2026-09 review §7): "Is Lucent unreliable,
 * or is the upstream provider unreliable?" — answered by counters, not
 * status-code archaeology. Every attempt is recorded with why it ended
 * (success / provider / validation / other), repairs count separately, and
 * the ledger's arithmetic is exact: attempts = success + the three failure
 * buckets. The Prometheus series are deliberately LABEL-FREE (the D10
 * cardinality rule): the per-provider split is the log's job.
 */

describe("Telemetry — the generation outcome ledger", () => {
  it("counts every attempt into exactly one bucket", () => {
    const t = new Telemetry();
    t.record({
      kind: "generate",
      ms: 100,
      provider: "mock",
      operations: 5,
      outcome: "success",
      repaired: false,
    });
    t.record({
      kind: "generate",
      ms: 60,
      provider: "mock",
      operations: 0,
      outcome: "provider",
      repaired: false,
    });
    t.record({
      kind: "generate",
      ms: 80,
      provider: "mock",
      operations: 0,
      outcome: "validation",
      repaired: true,
    });
    t.record({
      kind: "generate",
      ms: 10,
      provider: "mock",
      operations: 0,
      outcome: "other",
      repaired: false,
    });
    const g = t.snapshot().generation;
    expect(g.attempts).toBe(4);
    expect(g.success).toBe(1);
    expect(g.providerFailures).toBe(1);
    expect(g.validationFailures).toBe(1);
    expect(g.otherFailures).toBe(1);
    // The ledger's arithmetic: one bucket per attempt, always.
    expect(g.attempts).toBe(
      g.success + g.providerFailures + g.validationFailures + g.otherFailures,
    );
  });

  it("a repair co-occurs with its outcome — success and validation both count it", () => {
    const t = new Telemetry();
    // Repaired-then-validated: a success that cost two provider calls.
    t.record({
      kind: "generate",
      ms: 200,
      provider: "mock",
      operations: 7,
      outcome: "success",
      repaired: true,
    });
    // Repaired-but-still-invalid: the 422 arm.
    t.record({
      kind: "generate",
      ms: 250,
      provider: "mock",
      operations: 0,
      outcome: "validation",
      repaired: true,
    });
    const g = t.snapshot().generation;
    expect(g.repairs).toBe(2);
    expect(g.success).toBe(1);
    expect(g.validationFailures).toBe(1);
    expect(g.attempts).toBe(2);
  });

  it("failed attempts join the latency buffer (a 502's latency is real signal)", () => {
    const t = new Telemetry();
    t.record({
      kind: "generate",
      ms: 1_000,
      provider: "mock",
      operations: 0,
      outcome: "provider",
      repaired: false,
    });
    const snap = t.snapshot();
    expect(snap.latencyMs.generateMax).toBe(1_000);
    // Successes still read cleanly alongside: P50 over [1000] is 1000.
    expect(snap.latencyMs.generateP50).toBe(1_000);
  });

  it("the event emits to subscribers with its outcome (the bridge's input)", () => {
    const seen: TelemetryEvent[] = [];
    const t = new Telemetry();
    const stop = t.subscribe((e) => seen.push(e));
    t.record({
      kind: "generate",
      ms: 120,
      provider: "mock",
      operations: 3,
      outcome: "validation",
      repaired: true,
    });
    stop();
    expect(seen).toHaveLength(1);
    const gen = seen[0]!;
    if (gen.kind !== "generate") throw new Error(gen.kind);
    expect(gen.outcome).toBe("validation");
    expect(gen.repaired).toBe(true);
  });
});

describe("the Prometheus bridge — the outcome series", () => {
  it("buckets one attempt into exactly one series, label-free", () => {
    const metrics = new MetricsRegistry();
    // Mirror the app's exact definitions (app.ts).
    const attempts = metrics.counter({
      name: "lucent_generation_attempts_total",
      help: "x",
      labelNames: [],
    });
    // Registered but never incremented on purpose: the assertion below is
    // presence + cardinality, not counts — every series must render even
    // when its event never fires, which is exactly what these two prove.
    const _success = metrics.counter({
      name: "lucent_generation_success_total",
      help: "x",
      labelNames: [],
    });
    const providerFailures = metrics.counter({
      name: "lucent_generation_provider_failures_total",
      help: "x",
      labelNames: [],
    });
    const _validationFailures = metrics.counter({
      name: "lucent_generation_validation_failures_total",
      help: "x",
      labelNames: [],
    });
    const repairs = metrics.counter({
      name: "lucent_generation_repairs_total",
      help: "x",
      labelNames: [],
    });
    // The bridge path: one attempt, provider outcome, repaired.
    attempts.inc();
    providerFailures.inc();
    repairs.inc();

    const body = metrics.render();
    for (const name of [
      "lucent_generation_attempts_total",
      "lucent_generation_success_total",
      "lucent_generation_provider_failures_total",
      "lucent_generation_validation_failures_total",
      "lucent_generation_repairs_total",
    ]) {
      expect(body).toContain(name);
    }
    // Cardinality rule: no label braces on the generation series — no
    // provider, no board, no org. A dynamic label would give every gateway
    // its own series family for a question the totals already answer.
    for (const line of body.split("\n")) {
      if (line.includes("lucent_generation_") && line.includes("{")) {
        throw new Error(`cardinality violation: ${line}`);
      }
    }
  });
});
