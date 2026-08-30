import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Static file serving for the built web app (M0.6).
 *
 * Serving the SPA from the same origin as the API is what removes the dev
 * proxy from production: `/ws` upgrades on the same host, so no CORS, no
 * cross-origin cookie rules, and no second deployment target. It also lets us
 * set one Content-Security-Policy for the whole surface.
 *
 * Two cache tiers, matching how Vite emits:
 *  - `/assets/*` is content-hashed, so it's immutable for a year.
 *  - `index.html` must never be cached, or a deploy leaves clients pinned to
 *    a stale bundle that references deleted asset hashes.
 *
 * SPA fallback: any path that isn't a real file and isn't an API/WS route
 * returns index.html, because the client owns routing.
 */

export interface StaticOptions {
  /** Absolute path to the built web app (packages/web/dist). */
  root: string;
  /** When false the CSP is omitted — useful when a reverse proxy sets it. */
  csp?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Content-Security-Policy for the app.
 *
 * Each directive earns its place:
 *  - `default-src 'self'` — the baseline: nothing loads cross-origin unless
 *    a more specific directive allows it.
 *  - `script-src 'self'` plus `'wasm-unsafe-eval'` — transformers.js (the
 *    on-device Whisper path) compiles WebAssembly, which needs the wasm
 *    allowance but not full `unsafe-eval`.
 *  - `style-src 'self' 'unsafe-inline'` — the app sets inline styles on
 *    canvas elements for live drag positions. Removing this needs a nonce
 *    plumbed through every style prop; tracked but not M0 work.
 *  - `img-src 'self' data: blob: https:` — pasted images are data URLs until
 *    M3 moves them to object storage; `https:` covers linked images.
 *  - `connect-src 'self' https: wss:` — the API on this origin, the AI
 *    provider via the server (not the browser), and the /ws socket.
 *  - `worker-src 'self' blob:` — transformers.js spawns a blob worker.
 *  - `frame-src https:` — embed shapes render third-party iframes, which are
 *    additionally sandboxed at the element (see ShapeToolbar).
 *  - `object-src 'none'` and `frame-ancestors 'none'` — no plugins, and this
 *    app is never framed, which is the clickjacking defence.
 *  - `base-uri 'self'` — a hostile `<base>` can't retarget relative URLs.
 *  - `form-action 'self'` — no off-origin form posts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src https:",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** Only the microphone is needed (push-to-talk voice); everything else is denied. */
const PERMISSIONS_POLICY = [
  "microphone=(self)",
  "camera=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
].join(", ");

function securityHeaders(csp: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": PERMISSIONS_POLICY,
    // frame-ancestors in the CSP is the modern equivalent, but X-Frame-Options
    // still matters for older browsers that ignore the CSP directive.
    "x-frame-options": "DENY",
  };
  if (csp) headers["content-security-policy"] = CSP;
  return headers;
}

/**
 * Resolve a URL path to a file inside `root`, or null when it escapes.
 * Path traversal is the obvious attack here: `/../../etc/passwd` must not
 * resolve outside the served directory.
 */
function safePath(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes("\0")) return null;
  const candidate = resolve(join(root, normalize(decoded)));
  const rootResolved = resolve(root);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
  return candidate;
}

export interface StaticHandler {
  /**
   * Attempt to serve `req` from disk. Returns true when the request was
   * handled; false means the caller should continue to its own routes.
   */
  serve(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** True when a built app was found at construction time. */
  readonly available: boolean;
}

/**
 * Build a static handler for `root`. When the directory doesn't exist (a dev
 * run where the web app hasn't been built), `available` is false and `serve`
 * always returns false, so the server still answers API routes.
 */
export function createStaticHandler(options: StaticOptions): StaticHandler {
  const root = resolve(options.root);
  const csp = options.csp ?? true;
  let indexHtml: Buffer | null = null;
  let available = false;
  try {
    const stat = statSync(root);
    available = stat.isDirectory();
  } catch {
    available = false;
  }

  async function loadIndex(): Promise<Buffer | null> {
    if (indexHtml) return indexHtml;
    try {
      indexHtml = await readFile(join(root, "index.html"));
      return indexHtml;
    } catch {
      return null;
    }
  }

  return {
    available,
    async serve(req, res): Promise<boolean> {
      if (!available) return false;
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      // API, WebSocket and machine-facing paths belong to the app, never to
      // the filesystem. `/scim/` is here because the SCIM dispatch runs AFTER
      // the static handler in the request ladder, and a GET that fell through
      // to the SPA fallback answered 200 + index.html — a wrong body AND a
      // wrong status for a token-authenticated IdP endpoint, where the 401
      // is the security contract (found by the live test pass).
      if (
        pathname.startsWith("/api/") ||
        pathname.startsWith("/scim/") ||
        pathname === "/ws" ||
        pathname === "/health" ||
        pathname === "/metrics"
      ) {
        return false;
      }

      const filePath = safePath(root, pathname === "/" ? "/index.html" : pathname);
      if (filePath === null) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad path");
        return true;
      }

      // Try the exact file first.
      let stat: ReturnType<typeof statSync> | null = null;
      try {
        stat = statSync(filePath);
      } catch {
        stat = null;
      }

      if (stat?.isFile()) {
        const ext = extname(filePath).toLowerCase();
        const immutable = pathname.startsWith("/assets/");
        res.writeHead(200, {
          "content-type": MIME[ext] ?? "application/octet-stream",
          "content-length": String(stat.size),
          // Content-hashed assets never change; index.html must always be
          // revalidated or a deploy pins clients to a dead bundle.
          "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
          ...securityHeaders(csp),
        });
        if (req.method === "HEAD") {
          res.end();
          return true;
        }
        createReadStream(filePath).pipe(res);
        return true;
      }

      // SPA fallback: the client owns routing, so an unknown path that isn't
      // an asset request gets index.html. An unknown *asset* is a real 404 —
      // returning HTML for a missing .js would produce a confusing MIME error.
      if (pathname.startsWith("/assets/") || extname(pathname) !== "") {
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          ...securityHeaders(csp),
        });
        res.end("not found");
        return true;
      }

      const html = await loadIndex();
      if (!html) return false;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(html.byteLength),
        "cache-control": "no-cache",
        ...securityHeaders(csp),
      });
      res.end(req.method === "HEAD" ? undefined : html);
      return true;
    },
  };
}

/** Exported for tests and for a reverse proxy that wants the same policy. */
export const contentSecurityPolicy = CSP;
export const permissionsPolicy = PERMISSIONS_POLICY;
