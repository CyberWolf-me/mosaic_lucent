import { defineConfig } from "vitest/config";

/**
 * Coverage floor for @lucent/i18n (baseline: 100% statements). A dictionary
 * with missing-key fallbacks is exactly the kind of module that "feels"
 * covered while its failure paths never run, so the floor is the measured
 * ceiling minus a rounding margin: the round-trip tests are the contract,
 * and anything under 98 means a lookup path regressed.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 98,
        branches: 90,
        functions: 98,
        lines: 98,
      },
    },
  },
});
