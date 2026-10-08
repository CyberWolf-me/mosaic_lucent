/**
 * Analytics and error monitoring (docs/08 launch criteria).
 *
 * Deliberately local: counters and a bounded ring buffer of recent errors,
 * exposed on /metrics. No third-party SDK and no outbound telemetry, because
 * board content is sensitive (docs/06) and shipping it to an analytics vendor by
 * default would be the wrong trade. External sinks attach through `onEvent` or
 * `subscribe` without changing any call site; `src/app.ts` uses the latter to
 * mirror events into the Prometheus registry.
 */

/**
 * P1 (docs/20): the correlation id of the HTTP request that caused this
 * event. Optional because the vocabulary predates it and some events are
 * timer-driven (prunes, product counters) with no request to name. A log
 * field, never a metric label — the D10 cardinality rule holds: nothing
 * here becomes a Prometheus label, so the request id cannot explode the
 * series space. It travels with the event to every sink, so an access-log
 * line and its outcome row can be joined by one id.
 */
export interface Correlated {
  requestId?: string;
}

export type TelemetryEvent =
  | ({
      kind: "generate";
      ms: number;
      provider: string;
      operations: number;
      /**
       * WHY the generation ended (the 2026-09 review's §7): every attempt is
       * recorded — not only successes — so `/metrics` answers "is Lucent
       * unreliable, or is the upstream provider?" from counters instead of
       * status-code archaeology. Latency percentiles keep sampling the same
       * way; a failed attempt's ms rides along but the P50/P95 lanes read
       * best on successes, so failed attempts join the shared buffer too
       * (a 502's latency is real signal for the ops dashboards).
       */
      outcome: "success" | "provider" | "validation" | "other";
      repaired: boolean;
      /** Where a batch with no valid operation failed the schema; no model content. */
      schemaIssues?: string[];
    } & Correlated)
  | ({ kind: "image"; ms: number; provider: string } & Correlated)
  /**
   * The answer path (Stage C1): a question about the board, answered with
   * citations. Its own kind rather than a generate row with operations: 0 —
   * answer latency and citation survival are the signals this surface needs
   * to watch, and folding them into generate would make both unreadable.
   */
  | ({ kind: "ask"; ms: number; provider: string; citations: number } & Correlated)
  /**
   * The AI-propose path (Stage D9): a narrowing selection that became a
   * pending external proposal. Its own kind for the same reason as ask —
   * selection latency and the candidates→selected ratio are this surface's
   * signals, invisible inside a generate row.
   */
  | ({
      kind: "ai-propose";
      ms: number;
      provider: string;
      candidates: number;
      selected: number;
    } & Correlated)
  | ({ kind: "error"; route: string; status: number; message: string } & Correlated)
  /**
   * A request we turned away, tagged with why. `plan:<entitlement key>` is a
   * bucket of its own rather than part of `quota` because the two ask for
   * opposite responses: a quota refusal is deployment capacity we control and
   * may need to raise, while a plan refusal is revenue waiting to be collected.
   * Summed together, a week of customers hitting their plan ceiling reads as a
   * week of undersized limits, and gets answered by provisioning instead of by
   * an upgrade prompt.
   */
  | ({
      kind: "refused";
      route: string;
      reason:
        | "rate"
        | "quota"
        | `csrf:${string}`
        | `plan:${string}`
        /**
         * docs/24 Phase C: an org's policy plane turned the request away —
         * distinct from `rate`/`quota` (deployment capacity) and `plan`
         * (revenue). `policy:provider` is the provider-policy gate (S3);
         * `policy:boundary` is the classification/org-boundary gate (S1/S2).
         * Each is a refusal an admin caused deliberately, so it must be
         * observable separately — an alert that pages a human on `rate` must
         * not fire on a customer exercising their own policy.
         */
        | `policy:${string}`;
    } & Correlated)
  /**
   * PRODUCT ANALYTICS (2026-09 review §10): "what do users actually do?" —
   * the behavioral counters, as distinct from the technical RED series. The
   * vocabulary is a FIXED, small set (the D10 cardinality rule: the series
   * are label-free, so a new event means a new name here, never a dynamic
   * label). Extending it is a deliberate act, one line.
   */
  | { kind: "product"; event: ProductEvent }
  /** The activation metric (§10's headline): signup → first board, in
   * seconds, observed once per org's first board. Its own kind because it
   * is a distribution, not a count — the histogram is the deliverable. */
  | { kind: "timeToFirstBoard"; seconds: number };

/** The product-event vocabulary. Fixed on purpose; extend deliberately. */
export const PRODUCT_EVENTS = ["board_created", "share_link_created"] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

export interface ErrorRecord {
  at: number;
  route: string;
  status: number;
  message: string;
  /** The request's correlation id, when the error rode a request (P1). */
  requestId?: string;
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  requests: { generate: number; image: number; ask: number; aiPropose: number };
  errors: { total: number; byStatus: Record<string, number> };
  refusals: { rate: number; quota: number; plan: number; policy: number };
  latencyMs: {
    generateP50: number;
    generateP95: number;
    generateMax: number;
    /** The selector's own lane (D10): "Ask Lucent to draft" → preview is
     * the surface's latency budget, distinct from a full generation. */
    aiProposeP50: number;
    aiProposeP95: number;
  };
  operationsEmitted: number;
  recentErrors: ErrorRecord[];
  /**
   * The generation outcome ledger (2026-09 review §7): every attempt counted
   * by why it ended. attempts = success + provider + validation + other,
   * exactly; repairs can co-occur with success (a repaired batch that
   * validated) or with validation (a repair that didn't save it).
   */
  generation: {
    attempts: number;
    success: number;
    providerFailures: number;
    validationFailures: number;
    otherFailures: number;
    repairs: number;
  };
  /** The §10 product counters: behavior, not infrastructure. */
  product: {
    events: Record<ProductEvent, number>;
    timeToFirstBoard: { p50: number; p95: number; samples: number };
  };
}

/** Keep the last N errors so /metrics can show what is actually failing. */
const ERROR_BUFFER = 20;
/** Latency samples kept for percentiles; bounded so memory stays flat. */
const LATENCY_SAMPLES = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index]!);
}

function deliver(sink: (event: TelemetryEvent) => void, event: TelemetryEvent): void {
  try {
    sink(event);
  } catch {
    // Nowhere to report this: the logger is not a dependency of this module, and
    // a sink that throws on every event would flood whatever we handed it to.
    // Dropping one sink's copy is strictly better than dropping the response.
  }
}

export class Telemetry {
  private readonly startedAt = Date.now();
  private generateCount = 0;
  private imageCount = 0;
  private askCount = 0;
  /** The D9 selector count (D10 wired it — it shipped emitted but uncounted). */
  private aiProposeCount = 0;
  private operationsEmitted = 0;
  private errorTotal = 0;
  /** The outcome ledger: every generate attempt lands in exactly one bucket. */
  private generateProvider = 0;
  private generateValidation = 0;
  private generateOther = 0;
  private generateRepairs = 0;
  /** The product counters (§10): what users actually do. */
  private readonly productCounts = new Map<ProductEvent, number>();
  private readonly timeToFirstBoardSamples: number[] = [];
  private readonly byStatus = new Map<number, number>();
  private refusedRate = 0;
  private refusedQuota = 0;
  private refusedPlan = 0;
  /** docs/24 Phase C: refusals an ORG policy caused (S1/S2/S3 gates). */
  private refusedPolicy = 0;
  private readonly latencies: number[] = [];
  /** The selector's own samples: a selection round-trip is a different
   * latency budget than a full generation, and folding it into the shared
   * buffer would make both percentiles lie. */
  private readonly aiProposeLatencies: number[] = [];
  private readonly recentErrors: ErrorRecord[] = [];

  /** Sinks attached after construction; see `subscribe`. */
  private readonly listeners = new Set<(event: TelemetryEvent) => void>();

  /** Optional sink for forwarding to an external monitor later. */
  constructor(private readonly onEvent?: (event: TelemetryEvent) => void) {}

  /**
   * Attach a sink after construction, returning the call that detaches it.
   *
   * The constructor argument cannot serve every caller. Whoever owns the process
   * builds the instance and hands it to `createApp` already made, so the app has
   * no way to reach that argument -- and the app is precisely what wants these
   * events, to mirror them into its metrics registry. A Set, so detaching is
   * cheap and detaching twice is a no-op rather than an error.
   */
  subscribe(listener: (event: TelemetryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  record(event: TelemetryEvent): void {
    switch (event.kind) {
      case "generate":
        this.generateCount += 1;
        this.operationsEmitted += event.operations;
        this.latencies.push(event.ms);
        if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
        // The outcome ledger: exactly one bucket per attempt.
        if (event.outcome === "provider") this.generateProvider += 1;
        else if (event.outcome === "validation") this.generateValidation += 1;
        else if (event.outcome === "other") this.generateOther += 1;
        if (event.repaired) this.generateRepairs += 1;
        break;
      case "image":
        this.imageCount += 1;
        break;
      case "ask":
        this.askCount += 1;
        // Answer latency shares the sample buffer with generate: both are
        // provider round-trips the same percentile machinery watches, and a
        // separate buffer would need its own snapshot fields for no new signal.
        this.latencies.push(event.ms);
        if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
        break;
      case "ai-propose":
        this.aiProposeCount += 1;
        this.aiProposeLatencies.push(event.ms);
        if (this.aiProposeLatencies.length > LATENCY_SAMPLES) this.aiProposeLatencies.shift();
        break;
      case "product": {
        const current = this.productCounts.get(event.event) ?? 0;
        this.productCounts.set(event.event, current + 1);
        break;
      }
      case "timeToFirstBoard":
        this.timeToFirstBoardSamples.push(event.seconds);
        if (this.timeToFirstBoardSamples.length > LATENCY_SAMPLES)
          this.timeToFirstBoardSamples.shift();
        break;
      case "error":
        this.errorTotal += 1;
        this.byStatus.set(event.status, (this.byStatus.get(event.status) ?? 0) + 1);
        this.recentErrors.push({
          at: Date.now(),
          route: event.route,
          status: event.status,
          // Truncated: an error detail can carry a whole provider response.
          message: event.message.slice(0, 300),
          ...(event.requestId ? { requestId: event.requestId } : {}),
        });
        if (this.recentErrors.length > ERROR_BUFFER) this.recentErrors.shift();
        break;
      case "refused":
        // Only `rate` and `plan:*` get a bucket of their own; `quota` and every
        // `csrf:*` share the fall-through, exactly as they did before plan
        // gating existed, so the two long-standing series keep their meaning.
        if (event.reason === "rate") this.refusedRate += 1;
        else if (event.reason.startsWith("plan:")) this.refusedPlan += 1;
        else if (event.reason.startsWith("policy:")) this.refusedPolicy += 1;
        else this.refusedQuota += 1;
        break;
    }
    this.emit(event);
  }

  /**
   * Fan out to every sink, isolating each one from the request path. Recording
   * is the last thing a handler does before answering, and `record` is called
   * without an await from inside route bodies: a throwing sink would turn the
   * refusal we meant to report into a 500, losing the answer as well as the
   * metric. A sink that cannot count is a monitoring bug, not a request bug.
   */
  private emit(event: TelemetryEvent): void {
    if (this.onEvent) deliver(this.onEvent, event);
    for (const listener of this.listeners) deliver(listener, event);
  }

  snapshot(): MetricsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const aiSorted = [...this.aiProposeLatencies].sort((a, b) => a - b);
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: {
        generate: this.generateCount,
        image: this.imageCount,
        ask: this.askCount,
        aiPropose: this.aiProposeCount,
      },
      errors: {
        total: this.errorTotal,
        byStatus: Object.fromEntries([...this.byStatus].map(([k, v]) => [String(k), v])),
      },
      refusals: {
        rate: this.refusedRate,
        quota: this.refusedQuota,
        plan: this.refusedPlan,
        policy: this.refusedPolicy,
      },
      latencyMs: {
        generateP50: percentile(sorted, 50),
        generateP95: percentile(sorted, 95),
        generateMax: sorted.length ? Math.round(sorted[sorted.length - 1]!) : 0,
        aiProposeP50: percentile(aiSorted, 50),
        aiProposeP95: percentile(aiSorted, 95),
      },
      operationsEmitted: this.operationsEmitted,
      recentErrors: [...this.recentErrors].reverse(),
      generation: {
        attempts: this.generateCount,
        success:
          this.generateCount - this.generateProvider - this.generateValidation - this.generateOther,
        providerFailures: this.generateProvider,
        validationFailures: this.generateValidation,
        otherFailures: this.generateOther,
        repairs: this.generateRepairs,
      },
      product: {
        events: PRODUCT_EVENTS.reduce(
          (acc, e) => {
            acc[e] = this.productCounts.get(e) ?? 0;
            return acc;
          },
          {} as Record<ProductEvent, number>,
        ),
        timeToFirstBoard: {
          p50: percentile(
            [...this.timeToFirstBoardSamples].sort((a, b) => a - b),
            50,
          ),
          p95: percentile(
            [...this.timeToFirstBoardSamples].sort((a, b) => a - b),
            95,
          ),
          samples: this.timeToFirstBoardSamples.length,
        },
      },
    };
  }
}
