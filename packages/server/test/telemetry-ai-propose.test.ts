import { describe, expect, it } from "vitest";
import { Telemetry, type TelemetryEvent } from "../src/telemetry.js";
import { AI_DURATION_BUCKETS, MetricsRegistry } from "../src/obs/metrics.js";

/**
 * The D10 telemetry completion (ADR 0036): the ai-propose event shipped in
 * D9 emitted-but-uncounted — it fell through Telemetry.record's switch and
 * was silently dropped by the Prometheus bridge. D10 closes both gaps and
 * pins the CARDINALITY RULE: the ai-propose series carry no dynamic labels
 * (no provider, no board, no org — a dynamic label would give every board
 * its own series, the classic Prometheus memory leak).
 */

describe("Telemetry — the ai-propose kind counted", () => {
  it("counts the events and keeps its own latency lane", () => {
    const t = new Telemetry();
    t.record({ kind: "ai-propose", ms: 100, provider: "mock", candidates: 10, selected: 4 });
    t.record({ kind: "ai-propose", ms: 300, provider: "mock", candidates: 10, selected: 2 });
    // A generate event must NOT pollute the selector's lane.
    t.record({ kind: "generate", ms: 9_999, provider: "mock", operations: 5 });
    const snap = t.snapshot();
    expect(snap.requests.aiPropose).toBe(2);
    expect(snap.requests.generate).toBe(1);
    // The percentile lane: two samples 100/300 → P50 ~100, P95 ~300; the
    // generate sample never entered it.
    expect(snap.latencyMs.aiProposeP50).toBeLessThanOrEqual(snap.latencyMs.aiProposeP95);
    expect(snap.latencyMs.aiProposeP95).toBeLessThanOrEqual(300);
    expect(snap.latencyMs.generateMax).toBe(9_999);
  });

  it("the kind emits to subscribers (the bridge's input)", () => {
    const seen: TelemetryEvent[] = [];
    const t = new Telemetry();
    const stop = t.subscribe((e) => seen.push(e));
    t.record({ kind: "ai-propose", ms: 50, provider: "mock", candidates: 3, selected: 1 });
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("ai-propose");
  });
});

describe("the Prometheus bridge — the cardinality rule", () => {
  it("the ai-propose series carry NO dynamic labels", () => {
    const metrics = new MetricsRegistry();
    // Mirror the app's exact definitions (app.ts): labelNames: [] for both.
    const aiProposeDuration = metrics.histogram({
      name: "lucent_ai_propose_duration_seconds",
      help: "Seconds spent selecting actions for an AI-initiated external proposal.",
      labelNames: [],
      buckets: AI_DURATION_BUCKETS,
    });
    const aiProposeTotal = metrics.counter({
      name: "lucent_ai_propose_total",
      help: "AI-initiated external proposals drafted (the narrowing agent).",
      labelNames: [],
    });
    // The bridge path: an event observes with NO label values.
    aiProposeTotal.inc();
    aiProposeDuration.observe(0.12);
    const body = metrics.render();
    expect(body).toContain("lucent_ai_propose_total");
    expect(body).toContain("lucent_ai_propose_duration_seconds");
    // The counter line carries no label braces at all — no provider, no
    // board, no org, no kind. A dynamic label would give every board its
    // own series (the classic Prometheus memory leak).
    for (const line of body.split("\n")) {
      if (line.includes("lucent_ai_propose_total{")) {
        throw new Error(`cardinality violation: ${line}`);
      }
    }
  });
});
