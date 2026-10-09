import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { ServerResponse } from "node:http";

// The dev server proxies /api to the Node backend so the browser only ever
// talks to its own origin and never holds an API key (docs/09 section 8).
// `/ws` is proxied too: without it the realtime socket dials the Vite port,
// which has no upgrade handler, so multiplayer silently never connects in dev.
//
// Vitest runs with the default `node` environment: there is deliberately no
// `test` block here, because nothing in this suite touches a DOM. The client
// modules that are exercised (http.ts, routes.ts, session.ts, api.ts,
// boards.ts) keep their logic in pure functions plus `fetch`, both of which a
// Node environment can test faithfully. If component tests are ever wanted,
// they need (a) devDependencies `jsdom` and `@testing-library/react`, and
// (b) a vitest config that imports `defineConfig` from "vitest/config"
// instead of "vite" and adds `test: { environment: "jsdom", globals: false }`
// — the "vite" `defineConfig` used below does not accept a `test` key.
//
// The test script passes --testTimeout=20000: the ELK suites run real layouts,
// and several sit near vitest's 5 s default (the determinism case takes ~4.6 s
// alone), so a busy machine failed them on the clock rather than on geometry.
export default defineConfig({
  plugins: [react()],
  // BUILD_ID reaches the bundle as a literal (support.ts reads it from
  // import.meta.env): the report a user pastes into a support request must
  // name the build that produced it, or "fixed yesterday" is unfalsifiable.
  // Empty when not building from a git checkout (e.g. a Docker build that
  // copies dist in) — support.ts then reports "unknown", which is honest.
  define: {
    "import.meta.env.BUILD_ID": JSON.stringify(
      process.env.LUCENT_BUILD_ID ?? process.env.GITHUB_SHA ?? "unknown",
    ),
    "import.meta.env.VITE_POSTHOG_KEY": JSON.stringify(
      process.env.LUCENT_POSTHOG_KEY ??
        process.env.POSTHOG_PROJECT_TOKEN ??
        "phc_vBhxMqMXBu7coEaZK7BAwpXetqaogvmu6cEfHbdBsyVH",
    ),
    "import.meta.env.VITE_POSTHOG_HOST": JSON.stringify(
      process.env.LUCENT_POSTHOG_HOST ?? process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    ),
  },
  server: {
    port: Number(process.env.LUCENT_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target:
          process.env.LUCENT_SERVER_URL ??
          `http://127.0.0.1:${process.env.LUCENT_API_PORT ?? 4387}`,
        changeOrigin: true,
        // A diagram generation can take ~30s; don't let the proxy cut it short.
        timeout: 130_000,
        proxyTimeout: 130_000,
        configure: (proxy) => {
          // Without this, a stopped backend makes the proxy drop the socket and
          // the browser sees an opaque network failure. Answer with JSON the
          // client can explain instead.
          proxy.on("error", (err, _req, res) => {
            const out = res as ServerResponse;
            if (out.headersSent || out.writableEnded) return;
            out.writeHead(503, { "content-type": "application/json" });
            out.end(
              JSON.stringify({
                error: "lucent server unreachable",
                detail: err.message,
              }),
            );
          });
        },
      },
      "/ws": {
        target:
          process.env.LUCENT_WS_URL ?? `ws://127.0.0.1:${process.env.LUCENT_API_PORT ?? 4387}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
