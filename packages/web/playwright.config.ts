import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

/**
 * Playwright config (H: E2E the plan promised).
 *
 * Two web servers, started in order: the backend (configured provider or mock, auth on,
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
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  /**
   * Two suites, because they have different prerequisites and must not be
   * conflated by a single pass/fail.
   *
   * `app` is what runs unattended: everything that works against the mock
   * provider, which is what CI boots. This is the default (`npm run test:e2e`).
   *
   * `scenarios` is `e2e/journeys/**`, the credentialed suite. It is *designed*
   * to fail without a real model — a-first-minute.spec.ts asserts outright that
   * "a run against a mock provider is not a pass", on the reasoning that a
   * green mock run proves only the reducer. CI has no provider key, so running
   * this suite there is a category error: it fails by construction, and a
   * permanently red job is one nobody reads. It is run deliberately, with
   * credentials, via `npm run test:e2e:scenarios`.
   *
   * Splitting them by project (rather than deleting the scenarios, or setting
   * SCENARIOS_ALLOW_MOCK=1 to silence the guard) keeps the strict assertion
   * intact and keeps the coverage. The guard still fires — just for the person
   * who runs that command, which is exactly who it was written for.
   */
  projects: [
    {
      name: "app",
      testIgnore: "**/journeys/**",
    },
    {
      name: "scenarios",
      testMatch: "**/journeys/**/*.spec.ts",
    },
  ],
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
        LUCENT_AI_PROVIDER: process.env.LUCENT_AI_PROVIDER || "mock",
        LUCENT_AI_KEY: process.env.LUCENT_AI_KEY || "",
        LUCENT_AI_BASE_URL: process.env.LUCENT_AI_BASE_URL || "",
        LUCENT_AI_MODEL: process.env.LUCENT_AI_MODEL || "",
        LUCENT_AI_FALLBACK_MODEL: process.env.LUCENT_AI_FALLBACK_MODEL || "",
        LUCENT_AI_NAME: process.env.LUCENT_AI_NAME || "",
        LUCENT_AI_TIMEOUT_MS: process.env.LUCENT_AI_TIMEOUT_MS || "0",
        LUCENT_IMAGE_PROVIDER: process.env.LUCENT_IMAGE_PROVIDER || "",
        LUCENT_IMAGE_BASE_URL: process.env.LUCENT_IMAGE_BASE_URL || "",
        LUCENT_IMAGE_KEY: process.env.LUCENT_IMAGE_KEY || "",
        LUCENT_IMAGE_MODEL: process.env.LUCENT_IMAGE_MODEL || "",
        LUCENT_IMAGE_NAME: process.env.LUCENT_IMAGE_NAME || "",
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
