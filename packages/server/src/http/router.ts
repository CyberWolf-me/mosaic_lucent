import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A tiny typed router for the framework-free HTTP layer.
 *
 * `app.ts` dispatched with a ladder of `if (method === … && url === …)` checks
 * against the raw request URL, which is why `/api/boards/:id/members/:userId`
 * had nowhere to live: a pattern with a hole in the middle is not string
 * equality, so those routes were written as `startsWith` plus `includes` plus a
 * hand-counted `split("/")[3]`. This gives us path params, middleware
 * composition and one place where the response envelope (JSON + CORS) is
 * decided -- without adopting Express and the dependency surface that comes
 * with it.
 *
 * `handle()` resolves to false when nothing matched, so the caller can fall
 * through to static file serving rather than the router owning every 404.
 */

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/** Default state: no fields. Named so the generic default reads clearly. */
export type EmptyState = Record<string, never>;

export interface RouteContext<S extends object = EmptyState> {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Parsed request URL; `url.pathname` is what routing matched on. */
  readonly url: URL;
  /** Captured `:name` segments, decoded. A `*name` tail is captured raw. */
  readonly params: Readonly<Record<string, string>>;
  /**
   * One captured segment. Total where `params[name]` is `string | undefined`:
   * `noUncheckedIndexedAccess` is on, and every parameter a matched pattern
   * declares is present by construction, so the alternative is a `!` at every
   * use site -- which is the same assertion, made where nothing can check it.
   */
  param(name: string): string;
  /** Per-request scratch space; middleware writes, handlers read. */
  readonly state: S;
  /** Raw request body as text, subject to the router's size cap. */
  text(): Promise<string>;
  /** Body parsed as JSON; an empty body yields `{}`. Throws on malformed JSON. */
  json<T = unknown>(): Promise<T>;
  /** Send a JSON response. Safe to call twice; later calls are ignored. */
  send(status: number, body: unknown, headers?: Record<string, string>): void;
}

export type Handler<S extends object> = (ctx: RouteContext<S>) => void | Promise<void>;

export type Middleware<S extends object> = (
  ctx: RouteContext<S>,
  next: () => Promise<void>,
) => void | Promise<void>;

export interface RouterOptions<S extends object> {
  /** Hard cap on request body size; the request is destroyed past it. */
  maxBodyBytes?: number;
  /** Headers added to every response (CORS, security headers). */
  baseHeaders?: (req: IncomingMessage) => Record<string, string>;
  /**
   * Called when a handler throws; must answer the request -- or rethrow, to
   * hand the failure to whatever wraps `handle()`. Rethrowing is the option a
   * caller needs when it already owns the 500 path: an error counter, a
   * telemetry event and a correlation id in the body are not things the router
   * can produce, and it must not answer first with a shape that skips them.
   */
  onError?: (ctx: RouteContext<S>, err: unknown) => void;
}

/**
 * `"*"` matches any method. Deliberately not part of `Method`: it is something
 * a route registers, never something a request arrives with.
 */
type RouteMethod = Method | "*";

interface Route<S extends object> {
  method: RouteMethod;
  /**
   * Pre-split pattern; a segment starting with ":" is a parameter, and a
   * trailing segment starting with "*" captures the rest of the path.
   */
  segments: string[];
  handler: Handler<S>;
}

const DEFAULT_MAX_BODY_BYTES = 25_000_000;

export class Router<S extends object = EmptyState> {
  private readonly routes: Route<S>[] = [];
  private readonly middleware: Middleware<S>[] = [];

  constructor(private readonly options: RouterOptions<S> = {}) {}

  /** Register middleware; runs in registration order around every match. */
  use(mw: Middleware<S>): this {
    this.middleware.push(mw);
    return this;
  }

  add(method: Method, pattern: string, handler: Handler<S>): this {
    this.routes.push({ method, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler<S>): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler<S>): this {
    return this.add("POST", pattern, handler);
  }
  patch(pattern: string, handler: Handler<S>): this {
    return this.add("PATCH", pattern, handler);
  }
  put(pattern: string, handler: Handler<S>): this {
    return this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler<S>): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Answer this pattern whatever the method is, so one handler can own a path
   * the way a prefix block does -- including the methods it refuses. A block
   * that answers 405 has to be reached by the method it rejects, and a prefix
   * that owns its own 404 has to be reached by the paths under it that do not
   * exist; both are unreachable when every registration names a method.
   *
   * Registration order still decides, so a method-specific route registered
   * before this one still wins.
   */
  any(pattern: string, handler: Handler<S>): this {
    this.routes.push({ method: "*", segments: splitPath(pattern), handler });
    return this;
  }

  /**
   * Route one request. Returns true when a route matched (and has answered or
   * will answer), false when the caller should try something else.
   */
  async handle(req: IncomingMessage, res: ServerResponse, initialState: S): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = splitPath(url.pathname);
    const method = (req.method ?? "GET").toUpperCase() as Method;

    for (const route of this.routes) {
      if (route.method !== "*" && route.method !== method) continue;
      const params = match(route.segments, path);
      if (!params) continue;
      const ctx = this.makeContext(req, res, url, params, initialState);
      try {
        await this.runWithMiddleware(ctx, route.handler);
      } catch (err) {
        this.fail(ctx, err);
      }
      return true;
    }
    return false;
  }

  /**
   * Run a list of middleware in order against `req`/`res` without a route.
   * Useful for one-off routes the caller wires by hand (e.g. the CSRF
   * token-mint endpoint that needs to write a Set-Cookie before any route
   * handler runs).
   */
  async runMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    initialState: S,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ctx = this.makeContext(req, res, url, {}, initialState);
    try {
      await this.runWithMiddleware(ctx, async () => {
        ctx.send(404, { error: "not found" });
      });
    } catch (err) {
      this.fail(ctx, err);
    }
    return true;
  }

  private async runWithMiddleware(ctx: RouteContext<S>, handler: Handler<S>): Promise<void> {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      // Guard against a middleware calling next() twice, which would otherwise
      // run the handler more than once on one request.
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      const mw = this.middleware[i];
      if (!mw) {
        await handler(ctx);
        return;
      }
      await mw(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
  }

  private fail(ctx: RouteContext<S>, err: unknown): void {
    if (this.options.onError) {
      this.options.onError(ctx, err);
      return;
    }
    ctx.send(500, { error: "internal error" });
  }

  private makeContext(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    params: Record<string, string>,
    state: S,
  ): RouteContext<S> {
    const maxBytes = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const base = this.options.baseHeaders?.(req) ?? {};
    let bodyPromise: Promise<string> | null = null;

    const ctx: RouteContext<S> = {
      req,
      res,
      url,
      params,
      param: (name) => {
        const value = params[name];
        // A name the matched pattern never declared. That is a routing bug, not
        // a bad request, so it fails loudly here instead of resolving to "" and
        // asking a store for an empty id.
        if (value === undefined) throw new Error(`route has no parameter ":${name}"`);
        return value;
      },
      state,
      text: () => {
        bodyPromise ??= readBody(req, maxBytes);
        return bodyPromise;
      },
      json: async <T>(): Promise<T> => {
        const raw = await ctx.text();
        return (raw.trim() ? JSON.parse(raw) : {}) as T;
      },
      send: (status, body, headers) => {
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          ...base,
          ...headers,
        });
        res.end(body === undefined ? "" : JSON.stringify(body));
      },
    };
    return ctx;
  }
}

/** "/api/boards/:id" becomes ["api","boards",":id"]; trailing slashes ignored. */
function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/**
 * Match a pattern against a concrete path, returning captured params or null.
 *
 * A trailing `*name` captures one or more remaining segments, joined and
 * *undecoded*: the value is a path fragment, and decoding it would turn an
 * encoded `%2F` into a separator indistinguishable from a real one. One or
 * more rather than zero or more, so `/api/x/*rest` leaves `/api/x` itself to be
 * registered separately -- a prefix block and the collection at its root are
 * different answers.
 */
function match(pattern: string[], path: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    if (expected.startsWith("*")) {
      const rest = path.slice(i);
      if (rest.length === 0) return null;
      params[expected.slice(1)] = rest.join("/");
      return params;
    }
    const actual = path[i];
    if (actual === undefined) return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = safeDecode(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  // No wildcard: the loop has checked every segment the pattern names, so all
  // that is left to reject is a path with segments the pattern does not.
  return path.length === pattern.length ? params : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Read a request body with a hard size cap. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
