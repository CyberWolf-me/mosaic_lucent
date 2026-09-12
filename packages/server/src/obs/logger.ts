import { randomUUID } from "node:crypto";

/**
 * Structured logging: one JSON object per line, stdout for everything except
 * `error`, which goes to stderr so a supervisor that only watches stderr still
 * sees failures.
 *
 * Hand-rolled rather than pino/winston, matching the zero-runtime-dependency
 * rule the rest of this package follows: what a single process piping newline
 * JSON to a collector needs is a level check, a serialiser and a redactor --
 * roughly this file -- not a transport, a worker thread and a plugin API.
 *
 * CONSOLE VS LOGGER (the rule): request-path code must use Logger (redacted,
 * sampled, request-id attached). `console.*` is reserved for ops-only output
 * with no request PII — boot/migration/shutdown lines, the dev mailer, and
 * storage-backend warnings that carry only ids/mime types, never board
 * content, prompts, emails, or secrets. A `console` line that interpolates
 * user content is a bug; move it to Logger.
 *
 * Three properties are load-bearing, and the tests pin each one:
 *
 *  - `child(fields)` returns a logger that merges those fields into every
 *    line, which is how a request id reaches log lines written deep inside a
 *    handler without being threaded through every function signature.
 *  - Redaction happens by key, recursively, because the realistic way to leak
 *    a session cookie is `log.info("request", { headers })` -- nobody logs
 *    `{ password: pw }` on purpose.
 *  - A dropped line costs one integer comparison. No merge, no walk, no
 *    JSON.stringify. That is what makes it safe to leave `log.debug` calls in
 *    the request path instead of deleting them after every debugging session.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Threshold, including "silent" for tests and for `--quiet`-style runs. */
export type LogThreshold = LogLevel | "silent";

export type LogFields = Record<string, unknown>;

/** Where a rendered line goes. Injected so tests capture instead of printing. */
export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  /** The configured threshold, for callers that report their own config. */
  readonly level: LogThreshold;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Level chosen at runtime -- the request logger picks it from the status. */
  log(level: LogLevel, message: string, fields?: LogFields): void;
  /** True when a line at this level would be written; guard costly fields with it. */
  enabled(level: LogLevel): boolean;
  /** A logger that merges `fields` into every line it writes. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Default "info". */
  level?: LogThreshold;
  /** Fields on every line (service name, version, pid). */
  base?: LogFields;
  /** Default: stdout, stderr for `error`. */
  sink?: LogSink;
  /** Wall clock for the `time` field; injected in tests. */
  now?: () => number;
  /** Extra key names to redact on top of the built-in set. Case-insensitive. */
  redactKeys?: readonly string[];
  /** Nested objects deeper than this render as "[truncated]". Default 6. */
  maxDepth?: number;
  /** Arrays longer than this are cut short. Default 64. */
  maxArrayLength?: number;
  /** Strings longer than this are cut short. Default 4096. */
  maxStringLength?: number;
}

const SEVERITY: Record<LogThreshold, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export const REDACTED = "[redacted]";

/**
 * Keys whose values never reach a log line. `time`/`level`/`msg` are reserved
 * instead of redacted: a caller field named `level` is renamed rather than
 * dropped, because a field that could overwrite the line's own severity is a
 * way to make a 500 show up as `debug` in whatever indexes these lines.
 */
const RESERVED = new Set(["time", "level", "msg"]);

/** Unambiguous: any key containing one of these is a secret. */
const SECRET_SUBSTRINGS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "credential",
  "session",
  "signature",
  "apikey",
];

/**
 * Ambiguous alone, so these match only as whole words: "key" must redact
 * `apiKey` and `signing_key` without redacting `monkey` or `keyboard`.
 */
const SECRET_WORDS = new Set(["key", "keys", "auth", "jwt", "otp", "salt", "bearer", "sig"]);

/** Split "set-cookie" and "apiKey" alike into lowercase words. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

/** True when a field name looks like it names a credential. */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_SUBSTRINGS.some((needle) => lower.includes(needle))) return true;
  return words(key).some((word) => SECRET_WORDS.has(word));
}

interface Limits {
  maxDepth: number;
  maxArrayLength: number;
  maxStringLength: number;
  isSecret: (key: string) => boolean;
}

function clampString(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max} chars]`;
}

/**
 * Make an arbitrary value safe to JSON.stringify and safe to publish: secrets
 * removed, cycles broken, BigInt/Error/Date/binary given a readable form, and
 * every dimension bounded. A logger that throws (BigInt, a cyclic object) or
 * that emits a five-megabyte line is a logger that takes the process with it.
 */
function sanitize(value: unknown, limits: Limits, depth: number, seen: Set<object>): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return clampString(value, limits.maxStringLength);
    case "number":
      // JSON.stringify turns Infinity/NaN into null, which reads as "no value".
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return `${value}`;
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  const object = value as object;
  if (object instanceof Error) {
    return {
      name: object.name,
      message: clampString(object.message, limits.maxStringLength),
      ...(object.stack ? { stack: clampString(object.stack, limits.maxStringLength) } : {}),
    };
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }
  if (object instanceof Uint8Array) return `[binary ${object.byteLength} bytes]`;
  if (seen.has(object)) return "[circular]";
  if (depth >= limits.maxDepth) return "[truncated]";

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const kept: unknown[] = object
        .slice(0, limits.maxArrayLength)
        .map((item) => sanitize(item, limits, depth + 1, seen));
      if (object.length > limits.maxArrayLength) {
        kept.push(`[+${object.length - limits.maxArrayLength} more]`);
      }
      return kept;
    }
    if (object instanceof Set) return sanitize([...object], limits, depth, seen);
    const entries = object instanceof Map ? [...object.entries()] : Object.entries(object);
    const out: Record<string, unknown> = {};
    for (const [rawKey, item] of entries) {
      const key = String(rawKey);
      if (limits.isSecret(key)) {
        out[key] = REDACTED;
        continue;
      }
      const clean = sanitize(item, limits, depth + 1, seen);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  } finally {
    // Path-scoped, not global: two siblings pointing at one object are not a
    // cycle, and calling them "[circular]" would hide real data.
    seen.delete(object);
  }
}

function sanitizeFields(fields: LogFields, limits: Limits): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (limits.isSecret(key)) {
      out[key] = REDACTED;
      continue;
    }
    const clean = sanitize(value, limits, 1, new Set());
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

/** Merge already-sanitised fields, keeping the reserved keys ours. */
function assign(target: Record<string, unknown>, fields: LogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    target[RESERVED.has(key) ? `field_${key}` : key] = value;
  }
}

const defaultSink: LogSink = (line, level) => {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

interface Core {
  level: LogThreshold;
  threshold: number;
  sink: LogSink;
  now: () => number;
  limits: Limits;
}

class JsonLogger implements Logger {
  constructor(
    private readonly core: Core,
    /** Sanitised at construction, so a line only walks its own call-site fields. */
    private readonly fields: LogFields,
  ) {}

  get level(): LogThreshold {
    return this.core.level;
  }

  enabled(level: LogLevel): boolean {
    return SEVERITY[level] <= this.core.threshold;
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  log(level: LogLevel, message: string, fields?: LogFields): void {
    // The level check comes first and touches nothing else: a dropped line does
    // no merging, no walking and no serialising.
    if (SEVERITY[level] > this.core.threshold) return;

    const record: Record<string, unknown> = {
      time: new Date(this.core.now()).toISOString(),
      level,
      msg: message,
    };
    assign(record, this.fields);
    if (fields) assign(record, sanitizeFields(fields, this.core.limits));

    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      // sanitize() should have made this unreachable; if it did not, a broken
      // log line must not become a failed request.
      line = JSON.stringify({
        time: record.time,
        level,
        msg: message,
        logError: (err as Error).message,
      });
    }
    this.core.sink(line, level);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.core, {
      ...this.fields,
      ...sanitizeFields(fields, this.core.limits),
    });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const extra = new Set((options.redactKeys ?? []).map((key) => key.toLowerCase()));
  const core: Core = {
    level,
    threshold: SEVERITY[level],
    sink: options.sink ?? defaultSink,
    now: options.now ?? Date.now,
    limits: {
      maxDepth: options.maxDepth ?? 6,
      maxArrayLength: options.maxArrayLength ?? 64,
      maxStringLength: options.maxStringLength ?? 4096,
      isSecret: (key) => extra.has(key.toLowerCase()) || isSecretKey(key),
    },
  };
  return new JsonLogger(core, sanitizeFields(options.base ?? {}, core.limits));
}

/** Drops everything. The default inside `createApp` so test suites stay quiet. */
export const silentLogger: Logger = createLogger({ level: "silent" });

/**
 * Parse a threshold. An unrecognised value falls back instead of silencing the
 * process: `LUCENT_LOG_LEVEL=INFO!` must not be the reason an incident has no
 * logs, so "silent" has to be spelled out.
 */
export function parseLogLevel(
  value: string | undefined,
  fallback: LogThreshold = "info",
): LogThreshold {
  const normalised = value?.trim().toLowerCase();
  if (!normalised) return fallback;
  switch (normalised) {
    case "silent":
    case "off":
    case "none":
      return "silent";
    case "error":
    case "fatal":
      return "error";
    case "warn":
    case "warning":
      return "warn";
    case "info":
      return "info";
    case "debug":
    case "trace":
    case "verbose":
      return "debug";
    default:
      return fallback;
  }
}

export function logLevelFromEnv(env: { LUCENT_LOG_LEVEL?: string } = process.env): LogThreshold {
  return parseLogLevel(env.LUCENT_LOG_LEVEL);
}

/** Correlation id for one request; randomUUID is collision-free enough here. */
export function newRequestId(): string {
  return randomUUID();
}
