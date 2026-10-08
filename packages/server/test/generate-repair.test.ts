import { describe, it, expect } from "vitest";
import { parseToolArguments, summarizeWorkspace } from "@lucent/ai";
import type { GenerateResult, LLMProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { handleGenerate } from "../src/generate.js";

/**
 * M5: the bounded repair round. A batch that fails validation goes back to
 * the provider exactly once — with its own output and the validator's errors
 * — and the corrected batch rides the same filter/stamp/validate path as the
 * first. These tests script the provider so the round is observable: how many
 * calls happened, what the second call was asked, and what the response says.
 */

const emptySummary = summarizeWorkspace(createWorkspace());

const BAD_BATCH: Operation[] = [
  { op: "CONNECT_NODES", source: "ghost", target: "phantom", relationship: "x" },
];
const GOOD_BATCH: Operation[] = [
  { op: "CREATE_NODE", id: "fixed", nodeType: "step", label: "Fixed" },
];

/** Provider that fails validation on the first call, answers a script after. */
function scriptedProvider(
  responses: Array<GenerateResult | (() => GenerateResult)>,
): LLMProvider & {
  calls: Array<{ message: string }>;
} {
  const calls: Array<{ message: string }> = [];
  return {
    name: "scripted",
    calls,
    async generateOperations(request: { message: string }) {
      calls.push({ message: request.message });
      const next = responses[calls.length - 1];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
    // Stage C1 made generateAnswer part of the interface; unreachable here.
    async generateAnswer() {
      throw new Error("scripted provider cannot answer questions");
    },
  } as never;
}

describe("bounded repair round", () => {
  it("retries once with the rejected batch in the prompt, then succeeds", async () => {
    const provider = scriptedProvider([
      { operations: BAD_BATCH, usage: { inputTokens: 10, outputTokens: 5 } },
      {
        operations: GOOD_BATCH,
        explanation: "fixed it",
        usage: { inputTokens: 20, outputTokens: 8 },
      },
    ]);
    const result = await handleGenerate(provider, { message: "add a node", summary: emptySummary });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    // The repair prompt carries the validator's complaints and the batch.
    expect(provider.calls[1]!.message).toContain("rejected by the validator");
    expect(provider.calls[1]!.message).toContain("ghost");
    const body = result.body as { operations: unknown[] };
    expect(body.operations).toHaveLength(1);
    // Metering sums BOTH calls: a repair round is real spend.
    expect(result.completion?.usage).toEqual({ inputTokens: 30, outputTokens: 13 });
  });

  it("answers 422 with repaired:true when the repair also fails validation", async () => {
    const provider = scriptedProvider([{ operations: BAD_BATCH }, { operations: BAD_BATCH }]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(422);
    expect(provider.calls).toHaveLength(2); // exactly one repair round, no more
    expect((result.body as { repaired?: boolean }).repaired).toBe(true);
  });

  it("a provider failure inside the repair round is not a 502", async () => {
    const provider = scriptedProvider([{ operations: BAD_BATCH }]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    // The first call succeeded; the honest answer is the validation failure,
    // with the original errors, not a provider error.
    expect(result.status).toBe(422);
    expect((result.body as { repaired?: boolean }).repaired).toBe(false);
    expect((result.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
  });

  it("never retries a batch that passed validation", async () => {
    const provider = scriptedProvider([{ operations: GOOD_BATCH }]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("meters a single clean call exactly once (no phantom repair-round double-count)", async () => {
    // Regression guard: usageFor is handed the prior attempt ONLY when a repair
    // actually replaced the result. When no repair runs, firstResult === result,
    // so summing them would double a single call's tokens. "x" is not structural,
    // so the degenerate guard does not fire either — exactly one billed call.
    const provider = scriptedProvider([
      { operations: GOOD_BATCH, usage: { inputTokens: 12, outputTokens: 9 } },
    ]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(result.completion?.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
  });
});

describe("schema repair round", () => {
  /** A real parse of a batch where no operation passes the schema. */
  const schemaFailure = () =>
    parseToolArguments(
      { operations: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A", groupId: "" }] },
      { usage: { inputTokens: 7, outputTokens: 3 } },
    );

  it("retries once with the schema issues and the original request, then succeeds", async () => {
    const provider = scriptedProvider([
      schemaFailure,
      { operations: GOOD_BATCH, usage: { inputTokens: 20, outputTokens: 8 } },
    ]);
    const result = await handleGenerate(provider, { message: "add a node", summary: emptySummary });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.message).toContain("rejected by the operation schema");
    expect(provider.calls[1]!.message).toContain("0.groupId");
    expect(provider.calls[1]!.message).toContain("add a node");
    expect(result.repaired).toBe(true);
    expect(result.schemaIssues).toEqual(["CREATE_NODE.groupId:too_small"]);
    // The failed call's tokens are metered with the repair call's.
    expect(result.completion?.usage).toEqual({ inputTokens: 27, outputTokens: 11 });
  });

  it("never runs the validation round after the schema round", async () => {
    const provider = scriptedProvider([
      schemaFailure,
      { operations: [...GOOD_BATCH, ...BAD_BATCH] },
    ]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    expect((result.body as { operations: unknown[] }).operations).toHaveLength(1);
  });

  it("answers 422 validation, not a 502, when the repair also fails the schema", async () => {
    const provider = scriptedProvider([schemaFailure, schemaFailure]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(422);
    expect(result.outcome).toBe("validation");
    expect(provider.calls).toHaveLength(2);
    const body = result.body as { detail: string; schemaIssues: string[] };
    expect(body.detail).toMatch(/Model returned invalid operations/);
    expect(body.schemaIssues).toEqual(["CREATE_NODE.groupId:too_small"]);
  });

  it("keeps a transport failure on the first call a 502 with no retry", async () => {
    const provider = scriptedProvider([
      () => {
        throw new Error("upstream 503");
      },
    ]);
    const result = await handleGenerate(provider, { message: "x", summary: emptySummary });
    expect(result.status).toBe(502);
    expect(provider.calls).toHaveLength(1);
    expect(result.schemaIssues).toBeUndefined();
  });
});
