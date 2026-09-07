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

export type TelemetryEvent =
  | { kind: "generate"; ms: number; provider: string; operations: number }
  | { kind: "image"; ms: number; provider: string }
  /**
   * The answer path (Stage C1): a question about the board, answered with
   * citations. Its own kind rather than a generate row with operations: 0 —
   * answer latency and citation survival are the signals this surface needs
   * to watch, and folding them into generate would make both unreadable.
   */
  | { kind: "ask"; ms: number; provider: string; citations: number }
  /**
   * The AI-propose path (Stage D9): a narrowing selection that became a
   * pending external proposal. Its own kind for the same reason as ask —
   * selection latency and the candidates→selected ratio are this surface's
   * signals, invisible inside a generate row.
   */
  | {
      kind: "ai-propose";
      ms: number;
      provider: string;
      candidates: number;
      selected: number;
    }
  | { kind: "error"; route: string; status: number; message: string }
  /**
   * A request we turned away, tagged with why. `plan:<entitlement key>` is a
   * bucket of its own rather than part of `quota` because the two ask for
   * opposite responses: a quota refusal is deployment capacity we control and
   * may need to raise, while a plan refusal is revenue waiting to be collected.
   * Summed together, a week of customers hitting their plan ceiling reads as a
   * week of undersized limits, and gets answered by provisioning instead of by
   * an upgrade prompt.
   */
  | {
      kind: "refused";
      route: string;
      reason: "rate" | "quota" | `csrf:${string}` | `plan:${string}`;
    };

export interface ErrorRecord {
  at: number;
  route: string;
  status: number;
  message: string;
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  requests: { generate: number; image: number; ask: number };
  errors: { total: number; byStatus: Record<string, number> };
  refusals: { rate: number; quota: number; plan: number };
  latencyMs: { generateP50: number; generateP95: number; generateMax: number };
  operationsEmitted: number;
  recentErrors: ErrorRecord[];
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
  private operationsEmitted = 0;
  private errorTotal = 0;
  private readonly byStatus = new Map<number, number>();
  private refusedRate = 0;
  private refusedQuota = 0;
  private refusedPlan = 0;
  private readonly latencies: number[] = [];
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
      case "error":
        this.errorTotal += 1;
        this.byStatus.set(event.status, (this.byStatus.get(event.status) ?? 0) + 1);
        this.recentErrors.push({
          at: Date.now(),
          route: event.route,
          status: event.status,
          // Truncated: an error detail can carry a whole provider response.
          message: event.message.slice(0, 300),
        });
        if (this.recentErrors.length > ERROR_BUFFER) this.recentErrors.shift();
        break;
      case "refused":
        // Only `rate` and `plan:*` get a bucket of their own; `quota` and every
        // `csrf:*` share the fall-through, exactly as they did before plan
        // gating existed, so the two long-standing series keep their meaning.
        if (event.reason === "rate") this.refusedRate += 1;
        else if (event.reason.startsWith("plan:")) this.refusedPlan += 1;
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
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      requests: { generate: this.generateCount, image: this.imageCount, ask: this.askCount },
      errors: {
        total: this.errorTotal,
        byStatus: Object.fromEntries([...this.byStatus].map(([k, v]) => [String(k), v])),
      },
      refusals: { rate: this.refusedRate, quota: this.refusedQuota, plan: this.refusedPlan },
      latencyMs: {
        generateP50: percentile(sorted, 50),
        generateP95: percentile(sorted, 95),
        generateMax: sorted.length ? Math.round(sorted[sorted.length - 1]!) : 0,
      },
      operationsEmitted: this.operationsEmitted,
      recentErrors: [...this.recentErrors].reverse(),
    };
  }
}
