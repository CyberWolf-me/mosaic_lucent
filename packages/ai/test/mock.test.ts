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

describe("MockProvider statement semantics (Stage C2)", () => {
  it("'we decided $15/month' creates a decision born resolved, superseding the $20 proposal", async () => {
    const provider = new MockProvider();
    // The board the message describes: the $20 proposal already exists (the
    // supersession target the decision names).
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "pricing-proposal", nodeType: "idea", label: "Proposal: $20/month" },
      { op: "SET_STATEMENT", id: "pricing-proposal", statement: { kind: "proposal", status: "open", topic: "pricing" } },
    ]);
    const { operations } = await provider.generateOperations({
      message: "From the meeting: Sarah: 'We decided to price it at $15/month.' The board currently shows a node proposing $20/month (id pricing-proposal).",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const statement = operations.find((o) => o.op === "SET_STATEMENT");
    expect(statement).toMatchObject({
      op: "SET_STATEMENT",
      id: "pricing-decision",
      statement: { kind: "decision", status: "resolved", topic: "pricing", supersedes: ["pricing-proposal"] },
    });
    // And applying the batch visibly supersedes the old proposal.
    const next = applyOperations(ws, operations);
    expect(next.nodes["pricing-proposal"]?.statement?.status).toBe("superseded");
  });

  it("a rejection flips the existing proposal's statement to rejected", async () => {
    const provider = new MockProvider();
    let ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "usage-pricing", nodeType: "idea", label: "Proposal: usage-based pricing" },
      { op: "SET_STATEMENT", id: "usage-pricing", statement: { kind: "proposal", status: "open", topic: "pricing" } },
    ]);
    const { operations } = await provider.generateOperations({
      message: "From the meeting: Lena: 'No, we're not doing usage-based pricing.'",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    expect(operations).toContainEqual({ op: "UPDATE_STATEMENT", id: "usage-pricing", status: "rejected" });
  });

  it("a hedged suggestion is a proposal statement, open and unowned", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message: "From a brainstorm: Jin: 'We should probably ask Sarah about pricing at some point.'",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    expect(operations).toContainEqual({
      op: "SET_STATEMENT",
      id: "ask-sarah-idea",
      statement: { kind: "proposal", status: "open", topic: "pricing" },
    });
    // And the proposal-never-a-decision rule: no resolved status anywhere.
    expect(operations.some((o) => o.op === "SET_STATEMENT" && o.statement?.status === "resolved")).toBe(false);
  });

  it("a commitment carries an action statement alongside its owner", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message: "From a brainstorm: David: 'I'll prepare the launch brief by Friday.'",
      summary: summarizeWorkspace(ws),
    });
    expect(operations).toContainEqual({
      op: "SET_STATEMENT",
      id: "launch-brief",
      statement: { kind: "action", status: "open", topic: "launch" },
    });
  });
});
