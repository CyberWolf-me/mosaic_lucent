import { defineConfig } from "@playwright/test";

/**
 * Playwright config (H: E2E the plan promised).
 *
 * Two web servers, started in order: the backend (mock provider, auth on,
 * loopback 4387 — exactly what `npm run start -w @lucent/server` serves) and
 * the Vite dev server whose `/api` proxy targets it. Both are reused across
 * specs; a fresh storageState-free context means every spec story starts
 * anonymous, which is the user's first minute.
 *
 * CI installs browsers itself; locally `npx playwright install chromium`
 * honours PLAYWRIGHT_BROWSERS_PATH.
 */
const API_PORT = Number(process.env.LUCENT_API_PORT ?? 4390);
const WEB_PORT = Number(process.env.LUCENT_WEB_PORT ?? 5199);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      // dist, not `npm run start`: the workspace start script's prestart
      // rebuilds core+ai+server, which can outrun even a generous readiness
      // timeout. CI builds before running Playwright; locally dist exists
      // from any previous `npm run build -w @lucent/server`.
      command: "node ../server/dist/main.js",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        ...process.env,
        LUCENT_REQUIRE_AUTH: "1",
        LUCENT_PORT: String(API_PORT),
        // The smoke suite is the offline story: the mock provider answers
        // deterministically, so no key or gateway in the ambient environment
        // can steer the run. `undefined` deletes the key (selectProvider
        // treats an empty string as unset).
        LUCENT_AI_PROVIDER: "mock",
        LUCENT_AI_KEY: "",
        LUCENT_AI_BASE_URL: "",
        LUCENT_STRIPE_SECRET_KEY: "",
        LUCENT_STRIPE_WEBHOOK_SECRET: "",
        // Vite proxies with changeOrigin, so the backend sees its own Host —
        // the CSRF origin allowlist must name the URL the browser actually
        // sits on, or every cookie-authenticated POST 403s with `origin`.
        LUCENT_WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
      },
    },
    {
      command: "npm run dev -w @lucent/web -- --port " + WEB_PORT + " --host 127.0.0.1",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, LUCENT_API_PORT: String(API_PORT) },
    },
  ],
});
