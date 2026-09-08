import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createStaticHandler, contentSecurityPolicy, permissionsPolicy } from "../src/static.js";

/**
 * Pin the static file handler (M0.6). A real loopback HTTP server carries the
 * requests because the handler streams the file body via `pipe()`; a hand-
 * rolled mock response would have to fake the entire stream surface to test
 * the same surface area, which adds noise and false confidence.
 *
 * Cases:
 *   - CSP / permissions-policy / nosniff / x-frame-options on every served file
 *   - immutable cache for /assets/*, no-cache for index.html
 *   - SPA fallback for unknown extensionless paths
 *   - 404 (no HTML leak) for unknown asset paths
 *   - 400 on path traversal that escapes the served root
 *   - /api/*, /ws, /health, /metrics fall through to the caller
 *   - non-GET methods fall through
 *   - unavailable handler (no build dir) reports false
 */

let root: string;
let baseUrl: string;
let downstreamHits = 0;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lucent-static-"));
  // Build a minimal Vite-style dist tree: hashed assets, an index, a robots.txt.
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "app.abc123.js"), "console.log('app');");
  writeFileSync(join(root, "assets", "main.def456.css"), "body { color: black; }");
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><html><head></head><body>hi</body></html>",
  );
  writeFileSync(join(root, "robots.txt"), "User-agent: *\nDisallow:\n");

  const handler = createStaticHandler({ root });
  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const handled = await handler.serve(req, res);
    if (handled) return;
    downstreamHits++;
    res.writeHead(418, { "content-type": "text/plain; charset=utf-8" });
    res.end("downstream");
  });
  await new Promise<void>((resolveFn) => server.listen(0, "127.0.0.1", () => resolveFn()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveFn, rejectFn) =>
    server.close((err) => (err ? rejectFn(err) : resolveFn())),
  );
  rmSync(root, { recursive: true, force: true });
});

interface Resp {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function fetchAs(path: string, method = "GET"): Promise<Resp> {
  const res = await fetch(`${baseUrl}${path}`, { method, redirect: "manual" });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body };
}

describe("createStaticHandler", () => {
  it("reports available=true when the root directory exists", () => {
    const handler = createStaticHandler({ root });
    expect(handler.available).toBe(true);
  });

  it("reports available=false when the root does not exist", () => {
    const handler = createStaticHandler({ root: resolve(root, "does-not-exist") });
    expect(handler.available).toBe(false);
  });

  it("serves index.html with no-cache and a complete security header set", async () => {
    const r = await fetchAs("/");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["content-security-policy"]).toBe(contentSecurityPolicy);
    expect(r.headers["permissions-policy"]).toBe(permissionsPolicy);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.body).toContain("hi");
  });

  it("serves /assets/* with an immutable cache header", async () => {
    const r = await fetchAs("/assets/app.abc123.js");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.body).toContain("console.log");
  });

  it("returns the SPA fallback for an unknown extensionless path", async () => {
    const r = await fetchAs("/some/route/that/does/not/exist");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).toContain("hi");
  });

  it("returns 404 (not HTML) for an unknown asset path", async () => {
    const r = await fetchAs("/assets/missing.zzz.js");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("rejects path traversal with a 400", async () => {
    // `decodeURIComponent` collapses "%2e%2e" to ".." but `normalize()` then
    // strips the leading ".." so the path lands at `<root>/package.json` and
    // returns 404. Either outcome (400 or 404) means the resolver refused to
    // serve a file outside `root`. A 200 would be the regression we're guarding
    // against.
    const r = await fetchAs("/%2e%2e/package.json");
    expect([400, 404]).toContain(r.status);
    expect(r.status).not.toBe(200);
  });

  it("rejects a null-byte path with a 400", async () => {
    // null bytes are an explicit reject branch in safePath — they can't sneak
    // through normalize() and would otherwise truncate the resolved path.
    const r = await fetchAs("/index.html%00.png");
    expect(r.status).toBe(400);
  });

  it("falls through for /api/*, /ws, /health, /metrics (and /metrics/prometheus — the live D10 pass caught the SPA answering it)", async () => {
    const before = downstreamHits;
    for (const p of ["/api/boards", "/ws", "/health", "/metrics", "/metrics/prometheus"]) {
      const r = await fetchAs(p);
      expect(r.status).toBe(418);
      expect(r.body).toBe("downstream");
    }
    expect(downstreamHits - before).toBe(5);
  });

  it("falls through for non-GET methods on an otherwise-static path", async () => {
    const r = await fetchAs("/", "POST");
    expect(r.status).toBe(418);
    expect(r.body).toBe("downstream");
  });

  it("omits the CSP when csp:false is requested, but keeps the other headers", async () => {
    const noCsp = createStaticHandler({ root, csp: false });
    const noCspServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await noCsp.serve(req, res);
      if (handled) return;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolveFn) => noCspServer.listen(0, "127.0.0.1", () => resolveFn()));
    const port = (noCspServer.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/robots.txt`);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    expect(res.status).toBe(200);
    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["permissions-policy"]).toBe(permissionsPolicy);
    await new Promise<void>((resolveFn) => noCspServer.close(() => resolveFn()));
  });
});
