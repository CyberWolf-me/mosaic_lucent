import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider, summarizeWorkspace } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp, routeLabel, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import type { StoredBoard } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { readConfig, type Config } from "../src/config.js";
import {
  createLogger,
  silentLogger,
  REDACTED,
  type LogLevel,
  type Logger,
} from "../src/obs/logger.js";
import { MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "../src/obs/metrics.js";

/**
 * Observability (M0.4).
 *
 * obs/logger.ts and obs/metrics.ts shipped with no importer and no test, so
 * LUCENT_LOG_LEVEL was a documented flag with no effect and the process had no
 * request-level signal at all. These tests pin the seam that made them real:
 * one correlation id per request, one structured access line, RED series keyed
 * on a *bounded* route template, and a scrape endpoint that is as gated as
 * /metrics already was.
 *
 * The unhandled-error case is the load-bearing one. `createServer(async …)`
 * never awaited the handler, so a rejection that escaped a route's own catch
 * became an unhandled rejection — which in current Node kills the process. The
 * test below drives exactly that path and expects a 500 instead of a corpse.
 */

const SECRET = "test-secret-at-least-16-chars";
const EMPTY_SUMMARY = summarizeWorkspace(createWorkspace());

interface AppHandle extends App {
  base: string;
  ws: string;
}

let app: AppHandle | null = null;

/** Captures what a logger would have written, with the level it was written at. */
interface Capture {
  lines: Array<{ level: LogLevel; record: Record<string, unknown> }>;
  logger: Logger;
}

function capturingLogger(level: LogLevel = "debug"): Capture {
  const lines: Capture["lines"] = [];
  const logger = createLogger({
    level,
    sink: (line, at) =>
      lines.push({ level: at, record: JSON.parse(line) as Record<string, unknown> }),
  });
  return { lines, logger };
}

interface BootOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  boardStore?: InMemoryBoardStore;
  /** Supplied when a test needs to read the JSON snapshot as well as the scrape. */
  telemetry?: Telemetry;
  /**
   * Off by default, which leaves the app bearer-only: `authCtx.sessionCookie`
   * exists only when a session store does. A test that needs the cookie path --
   * the CSRF check is unreachable without it -- opts in here rather than the
   * whole suite growing a login flow it never used.
   */
  sessionStore?: InMemorySessionStore;
  /** Off by default too: without it the org routes answer 503, not a role. */
  orgStore?: InMemoryOrgStore;
}

async function bootApp(options: BootOptions = {}): Promise<AppHandle> {
  const env = options.env ?? {};
  const limits = limitsFromEnv();
  const config: Config = {
    ...readConfig(env),
    requireAuth: env.LUCENT_REQUIRE_AUTH !== "0",
  };
  const built = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: options.boardStore ?? new InMemoryBoardStore(),
    ...(options.sessionStore ? { sessionStore: options.sessionStore } : {}),
    ...(options.orgStore ? { orgStore: options.orgStore } : {}),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: options.telemetry ?? new Telemetry(),
    authLimiter: new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs),
    tickets: new InMemoryTicketStore(60_000),
    logger: options.logger,
  });
  const handle = built as unknown as App & { server: import("node:http").Server };
  return await new Promise<AppHandle>((resolve) => {
    handle.server.listen(0, "127.0.0.1", () => {
      const { port } = handle.server.address() as AddressInfo;
      resolve({ ...handle, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` });
    });
  });
}

async function api(
  h: AppHandle,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { token, ...rest } = init;
  const headers: Record<string, string> = {
    ...(rest.body ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${h.base}${path}`, { ...rest, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

async function signup(h: AppHandle, email: string): Promise<string> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  return body.token as string;
}

/** One sample by name, matched on a subset of its labels. */
function sampleValue(
  metrics: MetricsRegistry,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  return metrics
    .samples()
    .find(
      (s) =>
        s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value),
    )?.value;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

describe("routeLabel", () => {
  it("passes the operational paths through unchanged", () => {
    for (const path of ["/health", "/metrics", "/metrics/prometheus", "/ws"]) {
      expect(routeLabel(path)).toBe(path);
    }
  });

  it("folds everything outside /api into one series", () => {
    // The static handler serves a hashed bundle per build; labelling those by
    // path would mint a new series on every deploy.
    expect(routeLabel("/")).toBe("static");
    expect(routeLabel("/assets/index-4f3a9b1c.js")).toBe("static");
    expect(routeLabel("/favicon.ico")).toBe("static");
  });

  it("keeps the literal segments of a real route", () => {
    expect(routeLabel("/api/boards")).toBe("/api/boards");
    expect(routeLabel("/api/auth/login")).toBe("/api/auth/login");
    expect(routeLabel("/api/auth/2fa/enroll")).toBe("/api/auth/2fa/enroll");
  });

  it("collapses every id shape this server mints", () => {
    expect(routeLabel("/api/boards/brd_9aXk2Qw")).toBe("/api/boards/:id");
    expect(routeLabel("/api/orgs/org_1/members/usr_2")).toBe("/api/orgs/:id/members/:id");
    expect(routeLabel("/api/boards/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/api/boards/:id");
    // A bare share/session token: no prefix, but long enough to be unmistakable.
    expect(routeLabel("/api/boards/abcdefghijklmnopqrstuvwxyz")).toBe("/api/boards/:id");
  });

  it("strips the query string", () => {
    expect(routeLabel("/api/boards?limit=5&cursor=brd_1")).toBe("/api/boards");
  });

  it("labels an unknown segment :seg rather than echoing it", () => {
    // The fail-safe: when the allowlist drifts behind the router, the cost is a
    // vaguer label, never an unbounded one.
    expect(routeLabel("/api/wibble")).toBe("/api/:seg");
    expect(routeLabel("/api/boards/brd_1/wibble")).toBe("/api/boards/:id/:seg");
  });

  it("caps depth so an invented path cannot mint a series per variation", () => {
    expect(routeLabel("/api/a/b/c/d/e/f")).toBe("/api/other");
  });

  it("is bounded under a scan", () => {
    // The property that actually matters: a prober walking ids, verbs and depths
    // must not be able to grow the label set.
    const labels = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      labels.add(routeLabel(`/api/boards/brd_${i}`));
      labels.add(routeLabel(`/api/boards/brd_${i}/members/usr_${i}`));
      labels.add(routeLabel(`/api/${i}/${i}/${i}/${i}/${i}/${i}`));
      labels.add(routeLabel(`/assets/chunk-${i}.js`));
    }
    expect(labels.size).toBe(4);
  });
});

describe("logger", () => {
  it("drops everything below the threshold before doing any work", () => {
    const { lines, logger } = capturingLogger("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("silences the default app logger entirely", () => {
    expect(silentLogger.enabled("error")).toBe(false);
    expect(silentLogger.level).toBe("silent");
  });

  it("redacts secret-shaped keys at any depth", () => {
    const { lines, logger } = capturingLogger();
    logger.info("attempt", {
      email: "ana@example.com",
      password: "hunter2",
      authorization: "Bearer abc",
      nested: { apiKey: "sk-live-1", sessionToken: "t", keep: "visible" },
    });
    const record = lines[0]!.record;
    expect(record.email).toBe("ana@example.com");
    expect(record.password).toBe(REDACTED);
    expect(record.authorization).toBe(REDACTED);
    const nested = record.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe(REDACTED);
    expect(nested.sessionToken).toBe(REDACTED);
    expect(nested.keep).toBe("visible");
    // And nothing leaked through the serialised form either.
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("cannot have its envelope overwritten by a caller field", () => {
    const { lines, logger } = capturingLogger();
    logger.warn("real", { level: "info", msg: "spoofed", time: 0 });
    const record = lines[0]!.record;
    expect(record.level).toBe("warn");
    expect(record.msg).toBe("real");
    expect(record.field_level).toBe("info");
    expect(record.field_msg).toBe("spoofed");
  });

  it("survives values that would break JSON.stringify", () => {
    const { lines, logger } = capturingLogger();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() =>
      logger.info("cyclic", { cyclic, when: new Date(0), blob: new Uint8Array(4) }),
    ).not.toThrow();
    const record = lines[0]!.record;
    expect((record.cyclic as Record<string, unknown>).self).toBe("[circular]");
    expect(record.when).toBe("1970-01-01T00:00:00.000Z");
    expect(record.blob).toBe("[binary 4 bytes]");
  });

  it("merges child fields into every line", () => {
    const { lines, logger } = capturingLogger();
    logger.child({ requestId: "req_1" }).info("one");
    expect(lines[0]!.record.requestId).toBe("req_1");
  });
});

describe("metrics registry", () => {
  it("renders the exposition format a scraper accepts", () => {
    const metrics = new MetricsRegistry();
    const hits = metrics.counter({ name: "demo_total", help: "Demo hits.", labelNames: ["route"] });
    hits.inc({ route: "/api/boards" });
    const text = metrics.render();
    expect(text).toContain("# HELP demo_total Demo hits.");
    expect(text).toContain("# TYPE demo_total counter");
    expect(text).toContain('demo_total{route="/api/boards"} 1');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("returns the same metric for an identical definition and refuses a conflicting one", () => {
    // createApp is constructed many times per test run, sometimes against one
    // registry: that must not be a boot failure.
    const metrics = new MetricsRegistry();
    const def = { name: "demo_total", help: "Demo hits." };
    expect(metrics.counter(def)).toBe(metrics.counter(def));
    expect(() => metrics.gauge(def)).toThrow();
  });

  it("escapes a label value that would break a line", () => {
    const metrics = new MetricsRegistry();
    // A quote, a newline and a backslash in one value: the newline is the one
    // that matters, because emitting the character itself splits the exposition
    // line in two and the whole scrape is rejected.
    metrics.counter({ name: "demo_total", help: "d", labelNames: ["ua"] }).inc({ ua: 'a"b\nc\\d' });
    const rendered = metrics.render();
    const line = rendered.split("\n").find((l) => l.startsWith("demo_total{"))!;
    expect(line).toBe('demo_total{ua="a\\"b\\nc\\\\d"} 1');
    expect(rendered.split("\n").filter((l) => l.startsWith("demo_total"))).toHaveLength(1);
  });

  it("folds runaway label combinations into one overflow series", () => {
    const metrics = new MetricsRegistry({ maxSeriesPerMetric: 4 });
    const hits = metrics.counter({ name: "demo_total", help: "d", labelNames: ["id"] });
    for (let i = 0; i < 50; i += 1) hits.inc({ id: `id_${i}` });
    const samples = metrics.samples().filter((s) => s.name === "demo_total");
    expect(samples).toHaveLength(5);
    expect(samples.at(-1)!.labels.id).toBe("__overflow__");
    expect(samples.at(-1)!.value).toBe(46);
  });

  it("samples gauges at scrape time, not on a timer", () => {
    const metrics = new MetricsRegistry();
    const live = metrics.gauge({ name: "demo_live", help: "d" });
    let rooms = 0;
    metrics.collect(() => live.set(rooms));
    rooms = 7;
    expect(sampleValue(metrics, "demo_live")).toBe(7);
    rooms = 2;
    expect(metrics.render()).toContain("demo_live 2");
  });

  it("keeps a broken collector from failing the whole scrape", () => {
    const metrics = new MetricsRegistry();
    metrics.gauge({ name: "demo_live", help: "d" }).set(1);
    metrics.collect(() => {
      throw new Error("sampler broke");
    });
    expect(metrics.render()).toContain("demo_live 1");
  });
});

describe("request correlation", () => {
  it("stamps a fresh id on every response", async () => {
    app = await bootApp();
    const first = await api(app, "/health");
    const second = await api(app, "/health");
    const a = first.headers.get("x-request-id")!;
    const b = second.headers.get("x-request-id")!;
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("ignores an inbound id when nothing is in front of the process", async () => {
    // Same rule clientKey applies to X-Forwarded-For, for the same reason: with
    // no proxy in front, that header can only have come from the caller, and a
    // caller who picks the id can collide two unrelated requests in the log.
    app = await bootApp();
    const res = await api(app, "/health", { headers: { "x-request-id": "caller-chosen-id" } });
    expect(res.headers.get("x-request-id")).not.toBe("caller-chosen-id");
  });

  it("honours a well-formed inbound id behind a trusted proxy", async () => {
    app = await bootApp({ env: { LUCENT_TRUST_PROXY: "1" } });
    const res = await api(app, "/health", { headers: { "x-request-id": "edge-7f3a9b1c-002" } });
    expect(res.headers.get("x-request-id")).toBe("edge-7f3a9b1c-002");
  });

  it("refuses an inbound id that would not survive a header or a log line", async () => {
    app = await bootApp({ env: { LUCENT_TRUST_PROXY: "1" } });
    // Nothing outside [A-Za-z0-9._:-] is accepted. A value that is not Latin-1
    // cannot even be sent by a conformant client, so the charset rule is really
    // about the two places the value lands: an echoed header and a log line.
    for (const bad of ["short", "has spaces in it", "id/with/slashes", "a".repeat(129)]) {
      const res = await api(app, "/health", { headers: { "x-request-id": bad } });
      expect(res.headers.get("x-request-id")).not.toBe(bad);
    }
  });
});

describe("RED series", () => {
  it("labels a request by route template, never by id", async () => {
    app = await bootApp();
    const token = await signup(app, "obs-red@example.com");
    const res = await api(app, "/api/boards/brd_notreal9", { token });
    expect(res.status).toBe(404);

    expect(
      sampleValue(app.metrics, "lucent_http_requests_total", {
        method: "GET",
        route: "/api/boards/:id",
        status: "404",
      }),
    ).toBe(1);
    expect(
      sampleValue(app.metrics, "lucent_http_request_duration_seconds_count", {
        method: "GET",
        route: "/api/boards/:id",
      }),
    ).toBe(1);
    // The whole point of the template: the id must appear in no label anywhere.
    const everyLabel = app.metrics
      .samples()
      .flatMap((s) => Object.values(s.labels))
      .join(" ");
    expect(everyLabel).not.toContain("brd_notreal9");
  });

  it("returns in-flight to zero once the response is done", async () => {
    app = await bootApp();
    await api(app, "/health");
    expect(sampleValue(app.metrics, "lucent_http_requests_in_flight")).toBe(0);
  });

  it("records the status class the caller actually saw", async () => {
    app = await bootApp();
    await api(app, "/api/boards", { token: "not-a-real-token" });
    expect(
      sampleValue(app.metrics, "lucent_http_requests_total", {
        route: "/api/boards",
        status: "401",
      }),
    ).toBe(1);
  });
});

describe("GET /metrics/prometheus", () => {
  it("is gated on auth exactly as /metrics is", async () => {
    app = await bootApp();
    const anonymous = await fetch(`${app.base}/metrics/prometheus`);
    expect(anonymous.status).toBe(401);

    const token = await signup(app, "obs-scrape@example.com");
    const scrape = await fetch(`${app.base}/metrics/prometheus`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(scrape.status).toBe(200);
    expect(scrape.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);

    const text = await scrape.text();
    expect(text).toContain("# TYPE lucent_http_requests_total counter");
    expect(text).toContain("# TYPE lucent_http_request_duration_seconds histogram");
    expect(text).toContain("lucent_http_requests_in_flight");
    // Every non-comment line has to be "name{labels} value", or a collector
    // rejects the payload wholesale rather than skipping the bad line.
    for (const line of text.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"))) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(?:[{][^\n]*[}])? -?(?:[0-9]|[+]Inf|NaN)/);
    }
  });

  it("leaves the JSON /metrics contract alone", async () => {
    // /metrics is a JSON body the suite asserts on; a scraper wants one
    // unambiguous metrics_path. They are two endpoints on purpose.
    app = await bootApp();
    const token = await signup(app, "obs-json@example.com");
    const res = await api(app, "/metrics", { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.recentErrors)).toBe(true);
  });
});

/** A store whose read fails the way a dead connection pool fails. */
class ExplodingBoardStore extends InMemoryBoardStore {
  override get(_id: string): Promise<StoredBoard | undefined> {
    return Promise.reject(new Error("pool exhausted"));
  }
}

describe("the outermost error boundary", () => {
  it("answers 500 where it used to kill the process", async () => {
    // `createServer(async …)` does not await the handler, so a rejection that
    // escaped a route's own catch became an unhandled rejection — fatal in
    // current Node. This test reaching its assertions at all is the proof: with
    // the boundary missing, the run dies here instead of failing.
    const capture = capturingLogger();
    app = await bootApp({ logger: capture.logger, boardStore: new ExplodingBoardStore() });
    const token = await signup(app, "obs-boom@example.com");
    const res = await api(app, "/api/boards/brd_explode1", { token });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal error");
    // The id in the body is the one thing a user can quote back that finds the
    // exact line in the log, so it has to match the header.
    expect(res.body.requestId).toBe(res.headers.get("x-request-id"));
    // And it must not leak why: "pool exhausted" is for the log, not the caller.
    expect(JSON.stringify(res.body)).not.toContain("pool exhausted");

    expect(
      sampleValue(app.metrics, "lucent_http_unhandled_errors_total", {
        route: "/api/boards/:id",
      }),
    ).toBe(1);

    const failure = capture.lines.find((l) => l.record.msg === "unhandled_request_error")!;
    expect(failure.level).toBe("error");
    expect(failure.record.route).toBe("/api/boards/:id");
    expect(failure.record.message).toBe("pool exhausted");
    expect(failure.record.requestId).toBe(res.body.requestId);
  });

  it("keeps serving after one request has blown up", async () => {
    app = await bootApp({ boardStore: new ExplodingBoardStore() });
    const token = await signup(app, "obs-after@example.com");
    expect((await api(app, "/api/boards/brd_explode2", { token })).status).toBe(500);
    expect((await api(app, "/health")).status).toBe(200);
  });
});

describe("the access log", () => {
  it("writes one line per request at the level its status deserves", async () => {
    const capture = capturingLogger();
    app = await bootApp({ logger: capture.logger });
    await api(app, "/health");
    await api(app, "/api/boards", { token: "not-a-real-token" });

    const access = capture.lines.filter((l) => l.record.msg === "http_request");
    const health = access.find((l) => l.record.route === "/health")!;
    const boards = access.find((l) => l.record.route === "/api/boards")!;

    expect(health.level).toBe("info");
    expect(health.record.status).toBe(200);
    expect(health.record.method).toBe("GET");
    expect(typeof health.record.durationMs).toBe("number");
    expect(typeof health.record.requestId).toBe("string");

    // A 4xx is a correct answer to a bad request; only a 5xx is a server fault.
    expect(boards.level).toBe("warn");
    expect(boards.record.status).toBe(401);
  });

  it("says nothing at all under the default app logger", async () => {
    // createApp defaults to silentLogger so no suite has to know it exists.
    app = await bootApp();
    await api(app, "/health");
    expect(app.metrics.names()).toContain("lucent_http_requests_total");
  });
});

describe("telemetry bridged into Prometheus", () => {
  /**
   * telemetry.ts has counted refusals since M0, but only into the JSON snapshot
   * on /metrics: rate-limit and CSRF refusals -- the two an on-call actually
   * pages on -- had no series at all, so neither was alertable. The snapshot
   * also folds every `csrf:*` in with `quota`, a shape three tests in
   * test/usage.test.ts pin deliberately. The bridge therefore has one job the
   * JSON cannot do: give each refusal class its own series without moving
   * anything the snapshot already promises.
   */

  /** The session cookie alone -- deliberately without the CSRF pair. */
  async function sessionCookie(h: AppHandle, email: string): Promise<string> {
    const res = await fetch(`${h.base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name: "cookied" }),
    });
    expect(res.status).toBe(201);
    const jar = res.headers.getSetCookie().map((raw) => raw.split(";")[0]!);
    const session = jar.find((c) => c.startsWith("lucent_session="));
    expect(session).toBeTruthy();
    return session!;
  }

  it("counts a rate-limit refusal against its route", async () => {
    app = await bootApp({ env: { LUCENT_AUTH_LIMIT_PER_WINDOW: "1" } });
    const bad = JSON.stringify({ email: "nobody@example.com", password: "password123" });
    const first = await api(app, "/api/auth/login", { method: "POST", body: bad });
    const second = await api(app, "/api/auth/login", { method: "POST", body: bad });
    expect(first.status).toBe(401);
    expect(second.status).toBe(429);

    expect(
      sampleValue(app.metrics, "lucent_refusals_total", {
        route: "/api/auth/login",
        reason: "rate",
      }),
    ).toBe(1);
  });

  it("gives a CSRF refusal its own class while the snapshot keeps it in quota", async () => {
    const telemetry = new Telemetry();
    app = await bootApp({ telemetry, sessionStore: new InMemorySessionStore() });
    const cookie = await sessionCookie(app, "csrf@example.com");

    // A session cookie with no CSRF pair fails the double-submit check. Sent
    // without a bearer token on purpose: verifyCsrf short-circuits for a request
    // carrying no session cookie, so a bearer client never reaches this refusal.
    const refused = await api(app, "/api/boards", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(refused.status).toBe(403);

    expect(
      sampleValue(app.metrics, "lucent_refusals_total", { route: "/api/boards", reason: "csrf" }),
    ).toBe(1);
    // Unmoved: the scrape is where `csrf` separates from `quota`, not here.
    expect(telemetry.snapshot().refusals).toEqual({ rate: 0, quota: 1, plan: 0 });
  });

  it("times the provider call, not the request around it", async () => {
    app = await bootApp();
    const token = await signup(app, "gen@example.com");
    const generated = await api(app, "/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "draw me a flowchart", summary: EMPTY_SUMMARY }),
    });
    expect(generated.status).toBe(200);

    const labels = { kind: "generate", provider: "mock" };
    expect(sampleValue(app.metrics, "lucent_ai_call_duration_seconds_count", labels)).toBe(1);
    // Seconds, from an event carrying `ms`: forgetting the divide would put a
    // fast mock call in the +Inf bucket and read as a two-minute provider stall.
    expect(sampleValue(app.metrics, "lucent_ai_call_duration_seconds_sum", labels)!).toBeLessThan(
      1,
    );
  });

  it("detaches from the injected Telemetry when the app closes", async () => {
    // The instance outlives the app -- main.ts builds it and hands it over. A
    // subscription surviving close() would keep writing into a registry nobody
    // scrapes, and would double-count for a suite that boots two apps around one
    // Telemetry.
    const telemetry = new Telemetry();
    const closed = await bootApp({ telemetry });
    const refusal = { kind: "refused", route: "/api/boards", reason: "rate" } as const;

    telemetry.record(refusal);
    expect(sampleValue(closed.metrics, "lucent_refusals_total", { reason: "rate" })).toBe(1);

    await closed.close();
    telemetry.record(refusal);
    expect(sampleValue(closed.metrics, "lucent_refusals_total", { reason: "rate" })).toBe(1);
    // Still counting for itself: only the bridge detached.
    expect(telemetry.snapshot().refusals.rate).toBe(2);
  });

  it("keeps answering when a sink throws", async () => {
    // A monitoring bug must not become a request bug. `record` is the last thing
    // a handler does before answering and is called without an await, so an
    // unguarded sink would turn a delivered generation into an unhandled
    // rejection -- and both throwing sinks here are attached ahead of the bridge.
    const telemetry = new Telemetry(() => {
      throw new Error("constructor sink is down");
    });
    app = await bootApp({ telemetry });
    const detach = telemetry.subscribe(() => {
      throw new Error("subscribed sink is down");
    });
    try {
      const token = await signup(app, "sink@example.com");
      const generated = await api(app, "/api/generate", {
        method: "POST",
        token,
        body: JSON.stringify({ message: "draw me a flowchart", summary: EMPTY_SUMMARY }),
      });
      expect(generated.status).toBe(200);
    } finally {
      detach();
    }
    expect(
      sampleValue(app.metrics, "lucent_ai_call_duration_seconds_count", {
        kind: "generate",
        provider: "mock",
      }),
    ).toBe(1);
  });
});

describe("authorization denials", () => {
  /**
   * Both role guards answer 404 whether the row is missing or merely out of
   * reach, which is right for the caller and blinding for us: in
   * `lucent_http_requests_total` a stranger probing board ids and a member
   * locked out of their own board are the same line. `lucent_authz_denials_total`
   * is where they separate -- and it is what the `route` argument every guard
   * already took was for, which until now nothing read.
   */

  it("counts a board denial but not a genuine miss", async () => {
    app = await bootApp();
    const owner = await signup(app, "owner@example.com");
    const stranger = await signup(app, "stranger@example.com");

    const created = await api(app, "/api/boards", {
      method: "POST",
      token: owner,
      body: JSON.stringify({ name: "Private", workspace: createWorkspace() }),
    });
    expect([200, 201]).toContain(created.status);
    const boardId = created.body.id as string;

    const denied = await api(app, `/api/boards/${boardId}`, { token: stranger });
    expect(denied.status).toBe(404);
    const labels = { route: "/api/boards/:id", scope: "board" };
    expect(sampleValue(app.metrics, "lucent_authz_denials_total", labels)).toBe(1);

    // Same 404 to the caller, and deliberately not the same series: nothing was
    // withheld, so counting it would drown the signal in ordinary bad links.
    const missing = await api(app, "/api/boards/brd_doesnotexist", { token: owner });
    expect(missing.status).toBe(404);
    expect(sampleValue(app.metrics, "lucent_authz_denials_total", labels)).toBe(1);
  });

  it("counts an org denial under its own scope", async () => {
    app = await bootApp({ orgStore: new InMemoryOrgStore() });
    const token = await signup(app, "outsider@example.com");

    const denied = await api(app, "/api/orgs/org_someoneelse/audit", { token });
    expect(denied.status).toBe(404);
    expect(
      sampleValue(app.metrics, "lucent_authz_denials_total", {
        route: "/api/orgs/:id/audit",
        scope: "org",
      }),
    ).toBe(1);
  });
});
