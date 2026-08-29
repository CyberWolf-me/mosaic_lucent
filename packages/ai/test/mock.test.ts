import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import { MockProvider, summarizeWorkspace } from "../src/index.js";
import { parseModelJson } from "../src/providers/anthropic.js";

describe("MockProvider", () => {
  it("produces a valid e-commerce graph that the reducer accepts", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message: "I'm building an e-commerce platform",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const next = applyOperations(ws, operations);
    expect(next.nodes.checkout).toBeDefined();
    expect(next.nodes.stripe).toBeDefined();
  });

  it("supports the add-authentication follow-up against existing state", async () => {
    const provider = new MockProvider();
    let ws = createWorkspace();
    ws = applyOperations(
      ws,
      (
        await provider.generateOperations({
          message: "e-commerce store",
          summary: summarizeWorkspace(ws),
        })
      ).operations,
    );
    const followup = await provider.generateOperations({
      message: "add authentication",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, followup.operations)).toHaveLength(0);
    ws = applyOperations(ws, followup.operations);
    expect(ws.nodes.auth?.label).toBe("Authentication");
  });

  it("answers a question with no operations (Phase C answer channel)", async () => {
    const provider = new MockProvider();
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Payment" },
    ]);
    const res = await provider.generateOperations({
      message: "What is on this board?",
      summary: summarizeWorkspace(ws),
    });
    expect(res.operations).toHaveLength(0);
    expect(res.explanation).toMatch(/Payment|nodes/);
  });

  it("includes the selection in the built prompt", async () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    ]);
    const { buildUserPrompt } = await import("../src/prompt.js");
    const prompt = buildUserPrompt({
      message: "explain this",
      summary: summarizeWorkspace(ws, ["checkout"]),
    });
    expect(prompt).toContain("Selected");
    expect(prompt).toContain("checkout");
  });
});

describe("parseModelJson", () => {
  it("extracts operations from a model text response", () => {
    const text = `Here you go:
{ "operations": [ { "op": "CREATE_NODE", "id": "a", "nodeType": "t", "label": "A" } ], "explanation": "ok" }`;
    const result = parseModelJson(text);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("ok");
  });

  it("throws on invalid operations", () => {
    const text = `{ "operations": [ { "op": "NOPE" } ] }`;
    expect(() => parseModelJson(text)).toThrow(/invalid operations/);
  });
});
