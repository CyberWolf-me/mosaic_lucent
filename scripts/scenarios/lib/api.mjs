/**
 * HTTP side of a scenario user. Bearer auth throughout: CSRF only applies to
 * cookie sessions, and the per-user rate meter keys on the bearer's user (a
 * cookie session would key 24 people on one IP).
 */

export class ApiError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} → ${status} ${JSON.stringify(body)?.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class Api {
  constructor(baseUrl, { counters } = {}) {
    this.baseUrl = baseUrl;
    this.counters = counters ?? new Map();
  }

  count(key) {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Raw request: never throws on HTTP status. */
  async raw(method, path, { token, body, headers = {}, timeoutMs = 120_000 } = {}) {
    const t0 = performance.now();
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, ms: performance.now() - t0, headers: res.headers };
  }

  /** Request that must succeed (2xx); returns the parsed body. */
  async req(method, path, opts = {}) {
    const r = await this.raw(method, path, opts);
    if (r.status < 200 || r.status >= 300) throw new ApiError(method, path, r.status, r.data);
    return r.data;
  }

  async signup(name, email, password) {
    const data = await this.req("POST", "/api/auth/signup", { body: { name, email, password } });
    return { name, email, password, token: data.token, id: data.user.id, user: data.user };
  }
}

/**
 * Each scenario user: identity, bearer, role on the board, and — once
 * connected — their realtime client, LiveKit participant, browser page.
 */
export class Person {
  constructor(api, account, role) {
    this.api = api;
    this.name = account.name;
    this.email = account.email;
    this.id = account.id;
    this.token = account.token;
    this.user = account.user;
    this.role = role;
    this.rt = null;
    this.call = null;
    this.page = null;
  }

  get(path, opts) {
    return this.api.req("GET", path, { ...opts, token: this.token });
  }
  post(path, body, opts) {
    return this.api.req("POST", path, { ...opts, body: body ?? {}, token: this.token });
  }
  patch(path, body, opts) {
    return this.api.req("PATCH", path, { ...opts, body, token: this.token });
  }
  put(path, body, opts) {
    return this.api.req("PUT", path, { ...opts, body, token: this.token });
  }
  del(path, opts) {
    return this.api.req("DELETE", path, { ...opts, token: this.token });
  }
  /** Same, but returns {status, data} instead of throwing. */
  try(method, path, body) {
    return this.api.raw(method, path, { body, token: this.token });
  }
}

export async function pMap(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function waitFor(fn, { timeout = 15_000, every = 250, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}${last instanceof Error ? `: ${last.message}` : ""}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
