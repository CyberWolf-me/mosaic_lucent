import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { recentHistory, summarizeWorkspace, SUMMARY_LIMITS } from "../src/provider.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/prompt.js";
import { AI_OPERATION_NAMES } from "@lucent/core";

/**
 * The summary is the model's only view of the board. It previously carried nodes
 * and edges alone, so groups it was told to maintain, shapes it can now create,
 * and wireframes it may replace were all invisible.
 */

function boardWithEverything() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_GROUP", id: "payments", label: "Payments", children: [] },
    { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    { op: "CREATE_NODE", id: "stripe", nodeType: "service", label: "Stripe", groupId: "payments" },
    { op: "CONNECT_NODES", source: "checkout", target: "stripe", relationship: "pays" },
    {
      op: "CREATE_SHAPE",
      id: "note-1",
      kind: "sticky",
      position: { x: 10, y: 20 },
      size: { width: 150, height: 110 },
      text: "Check Stripe fallbacks",
    },
    {
      op: "CREATE_SHAPE",
      id: "note-2",
      kind: "rect",
      position: { x: 200, y: 20 },
      size: { width: 150, height: 72 },
      locked: true,
    },
    { op: "CONNECT_SHAPES", id: "link-1", source: "note-1", target: "note-2", label: "then" },
    {
      op: "CREATE_WIREFRAME",
      id: "wf-1",
      title: "Checkout",
      viewport: "mobile",
      root: { kind: "screen" },
    },
  ]);
}

describe("summarizeWorkspace", () => {
  it("includes groups, shapes, shape links, and wireframes", () => {
    const s = summarizeWorkspace(boardWithEverything());
    expect(s.groups).toEqual([{ id: "payments", label: "Payments", children: ["stripe"] }]);
    expect(s.shapes?.map((x) => x.id)).toEqual(["note-1", "note-2"]);
    expect(s.shapes?.[0]?.text).toBe("Check Stripe fallbacks");
    expect(s.shapes?.[1]?.locked).toBe(true);
    expect(s.shapeLinks).toEqual([
      { id: "link-1", source: "note-1", target: "note-2", label: "then" },
    ]);
    expect(s.wireframes).toEqual([{ id: "wf-1", title: "Checkout", viewport: "mobile" }]);
  });

  it("carries a node's group membership", () => {
    const s = summarizeWorkspace(boardWithEverything());
    expect(s.nodes.find((n) => n.id === "stripe")?.groupId).toBe("payments");
    expect(s.nodes.find((n) => n.id === "checkout")?.groupId).toBeUndefined();
  });

  it("omits empty collections so a fresh board stays small", () => {
    const s = summarizeWorkspace(createWorkspace());
    expect(s.groups).toBeUndefined();
    expect(s.shapes).toBeUndefined();
    expect(s.shapeLinks).toBeUndefined();
    expect(s.wireframes).toBeUndefined();
    expect(s.selection).toBeUndefined();
  });

  it("caps shape count and truncates long shape text", () => {
    const many = Array.from({ length: SUMMARY_LIMITS.shapes + 25 }, (_, i) => ({
      op: "CREATE_SHAPE" as const,
      id: `s${i}`,
      kind: "sticky" as const,
      position: { x: i, y: 0 },
      size: { width: 10, height: 10 },
      text: "x".repeat(SUMMARY_LIMITS.shapeTextChars + 50),
    }));
    const s = summarizeWorkspace(applyOperations(createWorkspace(), many));
    expect(s.shapes).toHaveLength(SUMMARY_LIMITS.shapes);
    expect(s.shapes?.[0]?.text?.length).toBeLessThanOrEqual(SUMMARY_LIMITS.shapeTextChars);
  });

  it("still carries the selection", () => {
    const s = summarizeWorkspace(boardWithEverything(), ["checkout", "note-1"]);
    expect(s.selection).toEqual(["checkout", "note-1"]);
  });
});

describe("recentHistory", () => {
  it("keeps only user and ai turns, dropping errors", () => {
    const turns = recentHistory([
      { role: "user", text: "build a flow" },
      { role: "error", text: "provider failed" },
      { role: "ai", text: "done" },
    ]);
    expect(turns).toEqual([
      { role: "user", text: "build a flow" },
      { role: "ai", text: "done" },
    ]);
  });

  it("keeps the most recent turns, oldest first", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ role: "user", text: `m${i}` }));
    const turns = recentHistory(entries);
    expect(turns).toHaveLength(SUMMARY_LIMITS.historyTurns);
    expect(turns[0]?.text).toBe(`m${20 - SUMMARY_LIMITS.historyTurns}`);
    expect(turns.at(-1)?.text).toBe("m19");
  });

  it("truncates a very long message", () => {
    const turns = recentHistory([{ role: "user", text: "y".repeat(5000) }]);
    expect(turns[0]?.text.length).toBeLessThanOrEqual(SUMMARY_LIMITS.historyChars);
  });

  it("returns an empty array for an empty conversation", () => {
    expect(recentHistory([])).toEqual([]);
  });
});

describe("SYSTEM_PROMPT", () => {
  it("lists operation names from the schema rather than a hand-written set", () => {
    for (const name of AI_OPERATION_NAMES) {
      expect(SYSTEM_PROMPT, name).toContain(name);
    }
  });

  it("never advertises the human-only coordinate operation", () => {
    expect(SYSTEM_PROMPT).not.toContain("MOVE_NODE");
  });

  it("tells the model to edit rather than regenerate", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("editing the existing board");
  });
});

describe("buildUserPrompt", () => {
  it("renders every board section the model needs", () => {
    const prompt = buildUserPrompt({
      message: "add a note about refunds",
      summary: summarizeWorkspace(boardWithEverything(), ["note-1"]),
    });
    expect(prompt).toContain("Existing nodes:");
    expect(prompt).toContain("Existing groups:");
    expect(prompt).toContain("Existing board objects");
    expect(prompt).toContain("Existing shape connectors:");
    expect(prompt).toContain("Existing wireframes:");
    expect(prompt).toContain("Check Stripe fallbacks");
    expect(prompt).toContain("[group: payments]");
    expect(prompt).toContain("User request: add a note about refunds");
  });

  it("includes recent conversation turns when supplied", () => {
    const prompt = buildUserPrompt({
      message: "make it simpler",
      summary: summarizeWorkspace(createWorkspace()),
      history: [
        { role: "user", text: "build a checkout flow" },
        { role: "ai", text: "Created a checkout flow." },
      ],
    });
    expect(prompt).toContain("Recent conversation");
    // The role moved from a "User:"/"Lucent:" text prefix onto the envelope tag
    // (M5): a user turn beginning "Lucent:" used to be indistinguishable from a
    // real assistant turn. Same two assertions — each turn is present and
    // attributed to the right speaker — read off the attribute that now carries it.
    expect(prompt).toContain('<untrusted-turn role="user">\nbuild a checkout flow');
    expect(prompt).toContain('<untrusted-turn role="assistant">\nCreated a checkout flow.');
  });

  it("omits sections that have no content", () => {
    const prompt = buildUserPrompt({
      message: "start something",
      summary: summarizeWorkspace(createWorkspace()),
    });
    expect(prompt).not.toContain("Existing groups:");
    expect(prompt).not.toContain("Existing board objects");
    expect(prompt).not.toContain("Recent conversation");
  });

  it("resolves a selected shape by kind and text", () => {
    const prompt = buildUserPrompt({
      message: "delete this",
      summary: summarizeWorkspace(boardWithEverything(), ["note-1"]),
    });
    expect(prompt).toContain("Selected");
    expect(prompt).toContain("note-1 (sticky: Check Stripe fallbacks)");
  });
});
