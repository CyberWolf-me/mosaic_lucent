/**
 * A minimal Prometheus-compatible metrics registry: counters, gauges,
 * histograms, rendered in the text exposition format.
 *
 * Why not prom-client: this package has zero runtime dependencies on purpose,
 * and the part of prom-client we would use is the part below -- a labelled
 * series map plus a text renderer. The part we would inherit (default metrics
 * pulled from perf hooks, a cluster aggregator, registries as globals) is
 * surface we do not want in a process that already exposes /metrics behind
 * auth.
 *
 * Two rules the API enforces rather than documents:
 *
 *  - Metric and label names are validated at registration, so a bad name fails
 *    at boot instead of producing a scrape a collector rejects at 3am.
 *  - Every metric has a hard series cap. An unbounded label value (a board id,
 *    a raw URL, an error message) is the standard way a metrics endpoint turns
 *    into a memory leak and then into a scrape timeout; past the cap the
 *    metric folds new combinations into one "__overflow__" series, which is
 *    visible in a dashboard instead of silently fatal.
 */

/** Label values are always strings: Prometheus has no other kind. */
export type Labels = Readonly<Record<string, string>>;

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricDef {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export interface HistogramDef extends MetricDef {
  /** Upper bounds, ascending, in the metric's base unit. */
  buckets?: readonly number[];
}

/** One rendered data point. */
export interface Sample {
  name: string;
  labels: Labels;
  value: number;
}

/** Content type Prometheus expects for the text exposition format. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * 5ms to 10s. Wide enough that a cache hit and a slow AI-backed request land in
 * different buckets, coarse enough that the series count per route stays small.
 */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Provider calls are seconds-scale; the HTTP buckets would all be "+Inf". */
export const AI_DURATION_BUCKETS: readonly number[] = [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120];

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_MAX_SERIES = 1000;
const OVERFLOW = "__overflow__";
/** Series key separator: a NUL never appears in a label value we accept. */
const SEPARATOR = String.fromCharCode(0);

function checkName(name: string): void {
  if (!METRIC_NAME.test(name)) throw new Error(`invalid metric name: ${JSON.stringify(name)}`);
}

function checkLabelNames(labelNames: readonly string[]): void {
  for (const label of labelNames) {
    if (!LABEL_NAME.test(label)) throw new Error(`invalid label name: ${JSON.stringify(label)}`);
    // "le" belongs to histogram buckets; a metric that also defined it would
    // render two le labels on one bucket line and break the parser.
    if (label === "le") throw new Error('label name "le" is reserved for histograms');
  }
}

/**
 * The labelled-series map every metric type shares. Missing labels render as
 * empty strings (Prometheus treats an empty value as absent) and unknown ones
 * are ignored: a mislabelled call in a request path should cost an odd-looking
 * series, not a 500.
 */
class SeriesStore<V> {
  private readonly entries = new Map<string, { labels: Labels; value: V }>();
  private overflow: { labels: Labels; value: V } | undefined;

  constructor(
    private readonly labelNames: readonly string[],
    private readonly maxSeries: number,
    private readonly zero: () => V,
  ) {}

  /** Fetch or create the series for these labels, honouring the cap. */
  get(labels?: Labels): V {
    const resolved = this.resolve(labels);
    const key = this.labelNames.map((name) => resolved[name] ?? "").join(SEPARATOR);
    const existing = this.entries.get(key);
    if (existing) return existing.value;
    if (this.entries.size >= this.maxSeries) {
      this.overflow ??= { labels: this.fold(), value: this.zero() };
      return this.overflow.value;
    }
    const created = { labels: resolved, value: this.zero() };
    this.entries.set(key, created);
    return created.value;
  }

  /** Read without creating, so `get()`-style assertions cannot inflate the map. */
  peek(labels?: Labels): V | undefined {
    const resolved = this.resolve(labels);
    const key = this.labelNames.map((name) => resolved[name] ?? "").join(SEPARATOR);
    return this.entries.get(key)?.value;
  }

  list(): Array<{ labels: Labels; value: V }> {
    const all = [...this.entries.values()];
    if (this.overflow) all.push(this.overflow);
    return all;
  }

  size(): number {
    return this.entries.size + (this.overflow ? 1 : 0);
  }

  private resolve(labels: Labels | undefined): Labels {
    const out: Record<string, string> = {};
    for (const name of this.labelNames) out[name] = labels?.[name] ?? "";
    return out;
  }

  private fold(): Labels {
    const out: Record<string, string> = {};
    for (const name of this.labelNames) out[name] = OVERFLOW;
    return out;
  }
}

interface Box {
  n: number;
}

export class Counter {
  readonly type = "counter";
  private readonly store: SeriesStore<Box>;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    maxSeries: number,
  ) {
    this.store = new SeriesStore(labelNames, maxSeries, () => ({ n: 0 }));
    // An unlabelled counter is materialised at registration so it scrapes as 0
    // from boot: a rate() over a series that only appears after the first error
    // has a hole exactly where the incident starts.
    if (labelNames.length === 0) this.store.get();
  }

  inc(labels?: Labels, value = 1): void {
    // A NaN would poison the series permanently, and a negative increment makes
    // a counter non-monotonic, which breaks rate() rather than this process.
    if (!Number.isFinite(value) || value < 0) return;
    this.store.get(labels).n += value;
  }

  get(labels?: Labels): number {
    return this.store.peek(labels)?.n ?? 0;
  }

  samples(): Sample[] {
    return this.store.list().map((entry) => ({
      name: this.name,
      labels: entry.labels,
      value: entry.value.n,
    }));
  }
}

export class Gauge {
  readonly type = "gauge";
  private readonly store: SeriesStore<Box>;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    maxSeries: number,
  ) {
    this.store = new SeriesStore(labelNames, maxSeries, () => ({ n: 0 }));
    if (labelNames.length === 0) this.store.get();
  }

  set(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    this.store.get(labels).n = value;
  }

  inc(value = 1, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    this.store.get(labels).n += value;
  }

  dec(value = 1, labels?: Labels): void {
    this.inc(-value, labels);
  }

  get(labels?: Labels): number {
    return this.store.peek(labels)?.n ?? 0;
  }

  samples(): Sample[] {
    return this.store.list().map((entry) => ({
      name: this.name,
      labels: entry.labels,
      value: entry.value.n,
    }));
  }
}

interface Buckets {
  /** Per-bucket counts; made cumulative only at render time. */
  counts: number[];
  sum: number;
  count: number;
}

/** Ascending, de-duplicated, finite. "+Inf" is implicit and always rendered. */
function normaliseBuckets(buckets: readonly number[]): number[] {
  const finite = buckets.filter((bound) => Number.isFinite(bound));
  const sorted = [...new Set(finite)].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error("a histogram needs at least one finite bucket");
  return sorted;
}

export class Histogram {
  readonly type = "histogram";
  readonly buckets: readonly number[];
  private readonly store: SeriesStore<Buckets>;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
    buckets: readonly number[],
    maxSeries: number,
  ) {
    this.buckets = normaliseBuckets(buckets);
    const width = this.buckets.length;
    this.store = new SeriesStore(labelNames, maxSeries, () => ({
      counts: new Array<number>(width).fill(0),
      sum: 0,
      count: 0,
    }));
    if (labelNames.length === 0) this.store.get();
  }

  observe(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    const entry = this.store.get(labels);
    entry.count += 1;
    entry.sum += value;
    // A linear scan over about a dozen bounds beats a binary search here, and
    // only the matching bucket is incremented -- the cumulative sums are built
    // at render time, so an observation costs one increment, not eleven.
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
        return;
      }
    }
    // Above the top bound: counted only in +Inf, which is `count`.
  }

  /** Cumulative view of one series, for assertions and for a JSON snapshot. */
  snapshot(labels?: Labels): {
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  } {
    const entry = this.store.peek(labels);
    let running = 0;
    const buckets = this.buckets.map((le, i) => {
      running += entry?.counts[i] ?? 0;
      return { le, count: running };
    });
    return { count: entry?.count ?? 0, sum: entry?.sum ?? 0, buckets };
  }

  samples(): Sample[] {
    const out: Sample[] = [];
    for (const entry of this.store.list()) {
      let running = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        running += entry.value.counts[i] ?? 0;
        out.push({
          name: `${this.name}_bucket`,
          labels: { ...entry.labels, le: formatBucket(this.buckets[i]!) },
          value: running,
        });
      }
      // +Inf always equals _count; a scrape without it is rejected.
      out.push({
        name: `${this.name}_bucket`,
        labels: { ...entry.labels, le: "+Inf" },
        value: entry.value.count,
      });
      out.push({ name: `${this.name}_sum`, labels: entry.labels, value: entry.value.sum });
      out.push({ name: `${this.name}_count`, labels: entry.labels, value: entry.value.count });
    }
    return out;
  }
}

type Metric = Counter | Gauge | Histogram;

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

export interface RegistryOptions {
  /** Series per metric before new label combinations fold into one. */
  maxSeriesPerMetric?: number;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Array<() => void> = [];
  private readonly maxSeries: number;

  constructor(options: RegistryOptions = {}) {
    this.maxSeries = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES;
  }

  counter(def: MetricDef): Counter {
    const existing = this.reuse(def, "counter");
    if (existing) return existing as Counter;
    return this.add(new Counter(def.name, def.help, def.labelNames ?? [], this.maxSeries));
  }

  gauge(def: MetricDef): Gauge {
    const existing = this.reuse(def, "gauge");
    if (existing) return existing as Gauge;
    return this.add(new Gauge(def.name, def.help, def.labelNames ?? [], this.maxSeries));
  }

  histogram(def: HistogramDef): Histogram {
    const existing = this.reuse(def, "histogram");
    if (existing) return existing as Histogram;
    return this.add(
      new Histogram(
        def.name,
        def.help,
        def.labelNames ?? [],
        def.buckets ?? DEFAULT_DURATION_BUCKETS,
        this.maxSeries,
      ),
    );
  }

  /**
   * Register a callback that refreshes gauges just before a render. Sampling
   * memory and CPU on a timer would keep the process awake; sampling them at
   * scrape time is both cheaper and more truthful.
   */
  collect(sample: () => void): void {
    this.collectors.push(sample);
  }

  has(name: string): boolean {
    return this.metrics.has(name);
  }

  names(): string[] {
    return [...this.metrics.keys()];
  }

  /** Every sample in registration order, for tests and for a JSON view. */
  samples(): Sample[] {
    this.runCollectors();
    return [...this.metrics.values()].flatMap((metric) => metric.samples());
  }

  /** The Prometheus text exposition format, ready to serve. */
  render(): string {
    this.runCollectors();
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      for (const sample of metric.samples()) lines.push(formatSample(sample));
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : "";
  }

  private runCollectors(): void {
    for (const sample of this.collectors) {
      try {
        sample();
      } catch {
        // A broken collector must not fail the scrape: partial metrics are far
        // more useful during an incident than a 500 on /metrics.
      }
    }
  }

  private add<M extends Metric>(metric: M): M {
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /**
   * Registering the same definition twice returns the same metric; registering a
   * different one under the same name throws. `createApp` is constructed many
   * times per test run, sometimes against a shared registry -- that should not
   * be a boot failure, but a name collision between two different metrics has
   * to be, because the exposition would carry two conflicting TYPE lines.
   */
  private reuse(def: MetricDef, type: MetricType): Metric | undefined {
    checkName(def.name);
    checkLabelNames(def.labelNames ?? []);
    const existing = this.metrics.get(def.name);
    if (!existing) return undefined;
    if (
      existing.type !== type ||
      existing.help !== def.help ||
      !sameLabels(existing.labelNames, def.labelNames ?? [])
    ) {
      throw new Error(`metric ${def.name} is already registered with a different definition`);
    }
    return existing;
  }
}

/** HELP text is a single line: newlines and backslashes are the only escapes. */
export function escapeHelp(help: string): string {
  let out = "";
  for (const char of help) {
    const code = char.charCodeAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (code < 0x20 || code === 0x7f) out += " ";
    else out += char;
  }
  return out;
}

/**
 * Label values are quoted, so a quote, a backslash or a newline inside one has
 * to be escaped or the line stops parsing at the wrong place. Other control
 * characters have no defined escape in the text format, so they become spaces
 * rather than a scrape a collector rejects wholesale.
 *
 * The newline branch emits the two characters `\` and `n`, not a newline.
 * Passing the character through unchanged is what escaping looks like when it is
 * wrong, and it costs the whole scrape rather than one series.
 */
export function escapeLabelValue(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (code < 0x20 || code === 0x7f) out += " ";
    else out += char;
  }
  return out;
}

export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatBucket(bound: number): string {
  return String(bound);
}

function formatSample(sample: Sample): string {
  const pairs = Object.entries(sample.labels).filter(([, value]) => value !== "");
  const labels =
    pairs.length > 0
      ? `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",")}}`
      : "";
  return `${sample.name}${labels} ${formatValue(sample.value)}`;
}

/**
 * Process-level gauges, sampled at scrape time. These are the metrics that
 * answer "is the leak in the process or in the load?" before any application
 * metric is useful, which is why they are worth the twenty lines.
 */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  const startTime = registry.gauge({
    name: "lucent_process_start_time_seconds",
    help: "Start time of the process since the unix epoch, in seconds.",
  });
  startTime.set(Math.floor((Date.now() - Math.round(process.uptime() * 1000)) / 1000));

  const rss = registry.gauge({
    name: "lucent_process_resident_memory_bytes",
    help: "Resident memory size of the process, in bytes.",
  });
  const heapUsed = registry.gauge({
    name: "lucent_nodejs_heap_used_bytes",
    help: "V8 heap in use, in bytes.",
  });
  const heapTotal = registry.gauge({
    name: "lucent_nodejs_heap_total_bytes",
    help: "V8 heap allocated, in bytes.",
  });
  const cpu = registry.counter({
    name: "lucent_process_cpu_seconds_total",
    help: "Total user and system CPU time consumed by the process, in seconds.",
  });
  let cpuSeen = 0;

  registry.collect(() => {
    const memory = process.memoryUsage();
    rss.set(memory.rss);
    heapUsed.set(memory.heapUsed);
    heapTotal.set(memory.heapTotal);
    // cpuUsage() is cumulative microseconds since start; a counter only takes
    // increments, so feed it the delta since the previous scrape.
    const usage = process.cpuUsage();
    const seconds = (usage.user + usage.system) / 1e6;
    cpu.inc(undefined, Math.max(0, seconds - cpuSeen));
    cpuSeen = seconds;
  });
}
