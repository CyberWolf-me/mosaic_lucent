import { defineConfig } from "vitest/config";

/**
 * Coverage floor for @lucent/mcp (baseline: 81.25% statements). The MCP
 * server is thin by design — it derives its tool schema from the same zod
 * union core owns — so the floor is lower than the harness packages and the
 * gate's job is narrower: catch a deleted test in the one place an agent
 * could otherwise send an operation the validator rejects.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      exclude: ["src/main.ts"],
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 80,
        lines: 75,
      },
    },
  },
});
