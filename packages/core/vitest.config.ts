import { defineConfig } from "vitest/config";

/**
 * Coverage floor for @lucent/core (H: "coverage floors per package,
 * ratcheted up"). The floor is a gate, not a scoreboard: it sits a few points
 * under the measured baseline (96.99% statements at the time it was set) so
 * it catches a regression — a deleted test, an added untested branch —
 * without failing a PR for a rounding wobble. Raising it is a one-line PR;
 * lowering it needs the reason written in the PR description.
 *
 * Core is the one package where the floor belongs this high: the operation
 * schema and reducer are the contract every other package compiles against,
 * and an untested branch here is a wire-format change no test caught.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      thresholds: {
        statements: 92,
        branches: 70,
        functions: 92,
        lines: 92,
      },
    },
  },
});
