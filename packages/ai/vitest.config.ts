import { defineConfig } from "vitest/config";

/**
 * Coverage floor for @lucent/ai (baseline: 87.28% statements). The floor
 * gates the harness — prompt building, provider adapters, streaming, repair,
 * the cache and the eval runner — where an untested branch is a model-behaviour
 * change no test noticed. The provider adapters legitimately carry some
 * uncovered surface (error paths only a flaky upstream hits), so the floor
 * sits below core's.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 84,
        branches: 80,
        functions: 88,
        lines: 84,
      },
    },
  },
});
