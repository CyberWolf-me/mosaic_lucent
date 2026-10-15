import { defineConfig } from "vitest/config";

/**
 * Vitest config for @lucent/web.
 *
 * This file exists for one reason: **keeping Playwright's specs out of the
 * unit run.** `e2e/**` is a Playwright suite — it imports `@playwright/test`,
 * and vitest has no `test` global, so collecting one of those files throws
 * `Playwright Test did not expect test.describe() to be called here` and fails
 * the whole suite while running zero tests.
 *
 * The previous fix lived in the `test` script as `--exclude e2e/**`, which was
 * wrong in a way that only shows up on nested paths. Vitest's CLI `--exclude`
 * *replaces* its built-in default list rather than adding to it, and the glob
 * `e2e/**` does not match `e2e/workflows/foo.spec.ts`. So the top-level
 * `e2e/smoke.spec.ts` was excluded while all twelve specs one directory deeper
 * were collected — and the run went red on files the author had explicitly
 * meant to skip.
 *
 * Stating `exclude` here has both properties the script-level flag lacked: it
 * extends the defaults, so `node_modules` and `dist` stay excluded, and
 * `e2e/**` is matched recursively.
 *
 * Environment: the default `node` is deliberate. Nothing in this suite touches
 * a DOM — the client modules exercised (http.ts, routes.ts, session.ts, api.ts,
 * boards.ts) keep their logic in pure functions plus `fetch`, both of which a
 * Node environment tests faithfully. Component tests would need `jsdom` and
 * `@testing-library/react` as devDependencies and `environment: "jsdom"` here.
 *
 * Note the `--testTimeout=20000` in the `test` script stays: the ELK suites run
 * real layouts and several sit near vitest's 5 s default (the determinism case
 * takes ~4.6 s alone), so a busy machine failed them on the clock rather than on
 * geometry.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "**/e2e/**"],
  },
});
