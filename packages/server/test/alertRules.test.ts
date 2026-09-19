import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P6 (docs/20, advisory §22/§23) — the alert rules, kept honest.
 *
 * docs/20's acceptance criterion for this phase: "`helm template` emits the
 * rules; each rule annotation resolves to an existing file under
 * `docs/runbooks/`." The chart render is verified separately (helm lint +
 * template); these tests are the half that keeps the rules from rotting, and
 * they check two things the cluster cannot:
 *
 *   1. every `runbook:` annotation names a file that exists — the advisory
 *      makes "every alert must map to an action/runbook" mechanical, and a
 *      typo'd path is exactly the rot that turns an alert into a shrug;
 *   2. every metric a rule references is ACTUALLY EMITTED by the server. A
 *      rule on a nonexistent series is worse than no rule: it is silently
 *      always-false and buys false confidence.
 *
 * The second is the reason this test reads source rather than trusting the
 * template: it is the only way the two halves can be caught disagreeing.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const RULES_PATH = resolve(ROOT, "charts/lucent/templates/prometheusrules.yaml");

function readRules(): string {
  return readFileSync(RULES_PATH, "utf8");
}

/** Prometheus metric names the server registers (`name: "lucent_..."`). */
function emittedMetrics(): Set<string> {
  const sources = ["packages/server/src/app.ts", "packages/server/src/obs/metrics.ts"];
  const names = new Set<string>();
  for (const rel of sources) {
    const path = resolve(ROOT, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/name:\s*"(lucent_[a-z0-9_]+)"/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/** Every metric-looking identifier a PromQL expression references. */
function referencedMetrics(expr: string): string[] {
  // `lucent_x_total` etc, optionally followed by `_bucket`/`_count`/`_sum`
  // (Prometheus appends those to a histogram's base name).
  return [...expr.matchAll(/\b(lucent_[a-z0-9_]+?)(?:_bucket|_count|_sum)?\b/g)].map((m) => m[1]!);
}

describe("P6: the SLO alert rules", () => {
  it("ships a PrometheusRule gated on its values flag", () => {
    const text = readRules();
    expect(text).toContain("kind: PrometheusRule");
    expect(text).toContain(".Values.prometheusRules.enabled");
    // Off by default, like the ServiceMonitor: the CRDs may not be installed.
    const values = readFileSync(resolve(ROOT, "charts/lucent/values.yaml"), "utf8");
    expect(values).toMatch(/prometheusRules:\s*\n\s*enabled: false/);
  });

  it("EVERY alert names a runbook that exists", () => {
    // docs/20's acceptance criterion, as a test.
    const text = readRules();
    const runbooks = [...text.matchAll(/runbook:\s*(\S+)/g)].map((m) => m[1]!);
    expect(runbooks.length).toBeGreaterThan(0);
    const missing = runbooks.filter((rel) => !existsSync(resolve(ROOT, rel)));
    expect(missing).toEqual([]);
    // And they are the real ones, not a stub path someone created to pass.
    for (const rel of runbooks) {
      const body = readFileSync(resolve(ROOT, rel), "utf8");
      expect(body.length).toBeGreaterThan(200);
    }
  });

  it("EVERY rule carries a severity and a summary", () => {
    // An alert without a severity is one that pages nobody; without a summary
    // it is one an oncall cannot triage from the notification alone.
    const text = readRules();
    const alertNames = [...text.matchAll(/- alert:\s*(\S+)/g)].map((m) => m[1]!);
    expect(alertNames.length).toBeGreaterThanOrEqual(10);
    expect(new Set(alertNames).size).toBe(alertNames.length);
    // Each alert block must reach a `severity:` before the next alert starts.
    const blocks = text.split(/- alert:/).slice(1);
    for (const block of blocks) {
      const name = block.trim().split(/\s/)[0];
      expect(block, `${name} is missing severity`).toContain("severity:");
      expect(block, `${name} is missing a summary`).toContain("summary:");
      expect(block, `${name} is missing a runbook`).toContain("runbook:");
    }
  });

  it("EVERY metric a rule references is actually emitted", () => {
    // The rule that catches the template drifting from the server. A rule on
    // a nonexistent series never fires and never warns you about it.
    const emitted = emittedMetrics();
    expect(emitted.size).toBeGreaterThan(10);

    const text = readRules();
    const exprs = [
      ...text.matchAll(
        /expr:\s*\|?\s*([\s\S]*?)(?=\n\s{10}\S|\n\s{10}- alert|\n\s{6}- alert|\n\s{6}labels:)/g,
      ),
    ].map((m) => m[1]!);
    expect(exprs.length).toBeGreaterThan(0);

    const unknown = new Set<string>();
    for (const expr of exprs) {
      for (const metric of referencedMetrics(expr)) {
        if (!emitted.has(metric)) unknown.add(metric);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it("covers each SLO tier the reliability document names", () => {
    const text = readRules();
    // The four capabilities docs/reliability/slo.md makes Tier 1/2, plus the
    // tenancy and platform rules the advisory's §23 list implies.
    for (const slo of [
      "api-availability",
      "ai-latency",
      "realtime-reachability",
      "ai-provider",
      "tenant-isolation",
      "migration-safety",
    ]) {
      expect(text).toContain(`slo: ${slo}`);
    }
  });
});
