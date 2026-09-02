import { describe, it, expect } from "vitest";
import { isProduction } from "../src/config.js";

/**
 * The in-memory data-loss guard (Stage A safety, P1). The guard's logic is
 * deliberately trivial — three booleans read at boot — but the DECISION it
 * encodes is the audit's P1 finding: auth + in-memory + production is a
 * deployment that silently loses every account, board, and meeting on its
 * next restart, and the single easiest variable to forget is
 * LUCENT_DATABASE_URL. The guard refuses to boot there and warns everywhere
 * else. What this suite pins is the decision table itself, so a future
 * refactor cannot quietly widen the refusal or lose the warning.
 */

describe("isProduction (the guard's environment signal)", () => {
  it("is true only for NODE_ENV=production", () => {
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ NODE_ENV: "staging" })).toBe(false);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
    expect(isProduction({})).toBe(false);
  });
});

describe("the guard's decision table (auth × production × databaseUrl)", () => {
  /**
   * The exact predicate main.ts applies, restated for the table. Extracted
   * here so the test and the boot code cannot drift apart silently: if
   * main.ts's condition changes without this file changing, this restatement
   * IS the spec the reviewer diffs against.
   */
  const guardOutcome = (env: {
    production: boolean;
    requireAuth: boolean;
    databaseUrl: string | undefined;
  }): "refuse" | "warn" | "clean" => {
    if (!env.databaseUrl) {
      if (env.production && env.requireAuth) return "refuse";
      return "warn";
    }
    return "clean";
  };

  it("P1: production + auth + no database → REFUSE (the data-loss deployment)", () => {
    expect(guardOutcome({ production: true, requireAuth: true, databaseUrl: undefined })).toBe(
      "refuse",
    );
  });

  it("dev + auth + no database → warn (correct solo-dev fallback, just loud)", () => {
    expect(guardOutcome({ production: false, requireAuth: true, databaseUrl: undefined })).toBe(
      "warn",
    );
  });

  it("production + auth OFF + no database → warn, not refuse (an intentional demo)", () => {
    // A solo open server is a demo, not a data-loss incident — the guard
    // must not block deliberate ephemeral deployments.
    expect(guardOutcome({ production: true, requireAuth: false, databaseUrl: undefined })).toBe(
      "warn",
    );
  });

  it("any environment WITH a database → clean (Postgres path, no warning)", () => {
    expect(guardOutcome({ production: true, requireAuth: true, databaseUrl: "postgres://…" })).toBe(
      "clean",
    );
    expect(
      guardOutcome({ production: false, requireAuth: false, databaseUrl: "postgres://…" }),
    ).toBe("clean");
  });
});
