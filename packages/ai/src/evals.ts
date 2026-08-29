import type { WorkspaceSummary } from "./provider.js";
import type { Operation } from "@lucent/core";
import type { LLMProvider } from "./provider.js";

/**
 * The golden set (M5): fixture inputs with expected shapes of output, and a
 * runner that scores a provider against them.
 *
 * WHAT THIS IS FOR. The prompt harness has unit tests, but a prompt edit can
 * silently change what a model *does* while every unit test stays green. The
 * golden set is the behaviour net: each case pins properties of a good answer
 * (these operations appear; those do not; the explanation is non-empty) rather
 * than exact bytes, so a wording improvement passes and a regression that
 * drops the connect-the-nodes step fails. CI runs the set against
 * `MockProvider` — the offline gate, in `test/golden-evals.test.ts`; with an
 * API key, `scripts/evals.ts` runs the same set against a real provider.
 *
 * WHY SUBSET MATCHING. Exact-match goldens break the moment a provider adds a
 * helpful second node; they also encourage fixtures that test the fixture.
 * Every expectation here is "for each expected op, some actual op matches
 * every field the expectation names" — a shape, not a transcript.
 */

export interface GoldenCase {
  /** Stable id, printed in reports and referenced when a case fails. */
  id: string;
  message: string;
  summary: WorkspaceSummary;
  /** Case-insensitive substring the explanation must contain, when set. */
  explanationIncludes?: string;
  /** Every expected op must subset-match some actual op. */
  expectOperations?: Array<GoldenOp>;
  /** No actual op may subset-match any of these. */
  forbidOperations?: Array<GoldenOp>;
  /** Inclusive floor on the operation count. Default 0 (question-answering). */
  minOperations?: number;
}

/** A partial operation: every named field must equal the actual's. */
export type GoldenOp = { op: Operation["op"] } & Record<string, unknown>;

export interface GoldenCaseResult {
  id: string;
  ok: boolean;
  reasons: string[];
}

export interface GoldenReport {
  passed: number;
  total: number;
  /** pass rate in [0,1]; the gate compares this against its threshold. */
  score: number;
  results: GoldenCaseResult[];
}

/**
 * Subset match: every field the expectation names must equal the actual's
 * (deep-equal, so nested expectations like a wireframe root's kind work).
 * Fields the expectation omits are free — a provider may add detail.
 */
export function operationMatches(expected: GoldenOp, actual: Operation): boolean {
  if (expected.op !== actual.op) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (key === "op") continue;
    if (!deepEqual((actual as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Score one case. Every check collects a reason, so a failing case reports
 * everything wrong with it rather than the first miss — an operator tuning a
 * prompt wants the full list.
 */
export async function runGoldenCase(
  provider: LLMProvider,
  golden: GoldenCase,
): Promise<GoldenCaseResult> {
  const reasons: string[] = [];
  let result;
  try {
    result = await provider.generateOperations({
      message: golden.message,
      summary: golden.summary,
      history: [],
    });
  } catch (err) {
    return {
      id: golden.id,
      ok: false,
      reasons: [`provider threw: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const ops = result.operations ?? [];
  const min = golden.minOperations ?? 0;
  if (ops.length < min) {
    reasons.push(`expected at least ${min} operations, got ${ops.length}`);
  }
  for (const expected of golden.expectOperations ?? []) {
    if (!ops.some((actual) => operationMatches(expected, actual))) {
      reasons.push(`no operation matches ${JSON.stringify(expected)}`);
    }
  }
  for (const forbidden of golden.forbidOperations ?? []) {
    if (ops.some((actual) => operationMatches(forbidden, actual))) {
      reasons.push(`forbidden operation present: ${JSON.stringify(forbidden)}`);
    }
  }
  if (golden.explanationIncludes) {
    const needle = golden.explanationIncludes.toLowerCase();
    if (!result.explanation || !result.explanation.toLowerCase().includes(needle)) {
      reasons.push(`explanation does not include ${JSON.stringify(golden.explanationIncludes)}`);
    }
  }
  return { id: golden.id, ok: reasons.length === 0, reasons };
}

export async function runGoldenSet(
  provider: LLMProvider,
  cases: readonly GoldenCase[],
): Promise<GoldenReport> {
  const results: GoldenCaseResult[] = [];
  for (const golden of cases) {
    results.push(await runGoldenCase(provider, golden));
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    passed,
    total: results.length,
    score: results.length === 0 ? 1 : passed / results.length,
    results,
  };
}
