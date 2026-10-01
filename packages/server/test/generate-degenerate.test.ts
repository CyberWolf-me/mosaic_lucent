import { describe, it, expect } from "vitest";
import { summarizeWorkspace } from "@lucent/ai";
import type { GenerateResult, LLMProvider } from "@lucent/ai";
import { createWorkspace, applyOperations } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { handleGenerate } from "../src/generate.js";

/**
 * Degenerate-result guard: a free gateway intermittently collapses a structured
 * request into a lone sticky note or a single node. When the request plainly
 * asked for a diagram but the batch is that thin, the pipeline re-asks ONCE for
 * a real diagram and takes it only if it comes back materially richer. These
 * tests script the provider so the re-ask is observable.
 */

const emptySummary = summarizeWorkspace(createWorkspace());

const STICKY: Operation[] = [
  { op: "CREATE_SHAPE", id: "s1", kind: "sticky", position: { x: 0, y: 0 }, size: { width: 160, height: 120 }, text: "the whole flow" },
];
const RICH_FLOW: Operation[] = [
  { op: "CREATE_NODE", id: "a", nodeType: "step", label: "Sign up" },
  { op: "CREATE_NODE", id: "b", nodeType: "step", label: "Verify email" },
  { op: "CREATE_NODE", id: "c", nodeType: "step", label: "Choose plan" },
  { op: "CONNECT_NODES", source: "a", target: "b", relationship: "leads_to" },
  { op: "CONNECT_NODES", source: "b", target: "c", relationship: "leads_to" },
];
const ONE_NODE: Operation[] = [{ op: "CREATE_NODE", id: "x", nodeType: "step", label: "X" }];

function scriptedProvider(responses: GenerateResult[]): LLMProvider & { calls: Array<{ message: string }> } {
  const calls: Array<{ message: string }> = [];
  return {
    name: "scripted",
    calls,
    async generateOperations(request: { message: string }) {
      calls.push({ message: request.message });
      const next = responses[calls.length - 1];
      if (!next) throw new Error("script exhausted");
      return next;
    },
    async generateAnswer() {
      throw new Error("scripted provider cannot answer questions");
    },
  } as never;
}

const opsOf = (r: Awaited<ReturnType<typeof handleGenerate>>) =>
  (r.body as { operations: Operation[] }).operations;

describe("degenerate-result guard", () => {
  it("re-asks once and replaces a lone sticky note with the richer diagram", async () => {
    const provider = scriptedProvider([
      { operations: STICKY, usage: { inputTokens: 10, outputTokens: 5 } },
      { operations: RICH_FLOW, explanation: "built the flow", usage: { inputTokens: 20, outputTokens: 8 } },
    ]);
    const result = await handleGenerate(provider, {
      message: "design a 5-step user onboarding flowchart",
      summary: emptySummary,
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.message).toContain("Rebuild it properly");
    const ops = opsOf(result);
    expect(ops.filter((o) => o.op === "CREATE_NODE")).toHaveLength(3);
    expect(ops.some((o) => o.op === "CREATE_SHAPE")).toBe(false);
    // Both calls are real spend: the re-ask's tokens join the first's.
    expect(result.completion?.usage).toEqual({ inputTokens: 30, outputTokens: 13 });
  });

  it("leaves an explicit sticky-note request alone (one shape is the answer)", async () => {
    const provider = scriptedProvider([{ operations: STICKY }]);
    const result = await handleGenerate(provider, {
      message: "add a sticky note that says hello",
      summary: emptySummary,
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(1); // no re-ask
    expect(opsOf(result).some((o) => o.op === "CREATE_SHAPE")).toBe(true);
  });

  it("does not re-ask a generation that already produced a real diagram", async () => {
    const provider = scriptedProvider([{ operations: RICH_FLOW }]);
    const result = await handleGenerate(provider, {
      message: "design a 5-step user onboarding flowchart",
      summary: emptySummary,
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(opsOf(result).filter((o) => o.op === "CREATE_NODE")).toHaveLength(3);
  });

  it("keeps the first result when the re-ask is also degenerate (never loops), but still meters it", async () => {
    const provider = scriptedProvider([
      { operations: STICKY, usage: { inputTokens: 10, outputTokens: 5 } },
      // One node is not materially richer than one shape, so it is rejected —
      // but the call still happened and must be billed.
      { operations: ONE_NODE, usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const result = await handleGenerate(provider, {
      message: "design a 5-step user onboarding flowchart",
      summary: emptySummary,
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2); // exactly one re-ask, no more
    const ops = opsOf(result);
    expect(ops.some((o) => o.op === "CREATE_SHAPE")).toBe(true); // original kept
    expect(ops.some((o) => o.op === "CREATE_NODE")).toBe(false);
    // A discarded re-ask is still real spend: both calls are metered.
    expect(result.completion?.usage).toEqual({ inputTokens: 13, outputTokens: 7 });
  });

  it("does not fire on a non-empty board — a thin addition is not a failed fresh build", async () => {
    // A board that already has content: a lone new shape here is a normal
    // modification (the connectivity guard handles floats), not the degenerate
    // "fresh build collapsed to a sticky" symptom. Re-asking would risk
    // rebuilding/duplicating the existing diagram.
    const existing = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "existing", nodeType: "step", label: "Existing" },
    ]);
    const provider = scriptedProvider([{ operations: STICKY }]);
    const result = await handleGenerate(provider, {
      message: "design a 5-step user onboarding flowchart",
      summary: summarizeWorkspace(existing),
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(1); // no re-ask on a non-empty board
  });

  it("keeps the first result when the re-ask itself fails (provider throws)", async () => {
    // Only the sticky is scripted; the re-ask call runs off the end of the
    // script and throws. requestRicher swallows it and the first result stands.
    const provider = scriptedProvider([{ operations: STICKY }]);
    const result = await handleGenerate(provider, {
      message: "design a 5-step user onboarding flowchart",
      summary: emptySummary,
    });
    expect(result.status).toBe(200);
    expect(provider.calls).toHaveLength(2); // the re-ask was attempted…
    expect(opsOf(result).some((o) => o.op === "CREATE_SHAPE")).toBe(true); // …and the sticky stands
  });
});
