import { describe, expect, it } from "vitest";
import { toolParametersJsonSchema } from "@lucent/core";
import { MockProvider, mockReply } from "../src/providers/mock.js";
import { parseToolArguments } from "../src/providers/toolCall.js";
import { recentHistory } from "../src/provider.js";

/**
 * What Lucent says back (`reply`): a voice conversation speaks it instead of
 * reading out the change description (found in use: "the agent only reads the
 * changes it made in the chat").
 */

describe("the conversational reply", () => {
  it("is part of the tool contract the model fills in", () => {
    const params = toolParametersJsonSchema() as {
      properties: Record<string, { description?: string }>;
      required: string[];
    };
    expect(params.properties.reply?.description).toMatch(/spoken aloud/);
    expect(params.required).toEqual(["operations"]);
  });

  it("comes through the tool call, trimmed, and stays absent when the model gives none", () => {
    const withReply = parseToolArguments(
      JSON.stringify({
        operations: [],
        explanation: "Four services.",
        reply: "  There are four.  ",
      }),
    );
    expect(withReply.reply).toBe("There are four.");
    const without = parseToolArguments(JSON.stringify({ operations: [], explanation: "x" }));
    expect(without).not.toHaveProperty("reply");
    expect(parseToolArguments(JSON.stringify({ operations: [], reply: "   " }))).not.toHaveProperty(
      "reply",
    );
  });

  it("from the mock: an answer passes through; a change is confirmed with one question", async () => {
    expect(mockReply({ operations: [], explanation: "Which part do you mean?" })).toBe(
      "Which part do you mean?",
    );
    const built = mockReply({
      operations: [{ op: "CREATE_NODE", id: "n1", nodeType: "service", label: "Payments" }],
      explanation: "Added a payments service. It sits behind checkout.",
    });
    expect(built).toBe(
      "Done. Added a payments service. Should I add what happens when payments fails?",
    );
    const result = await new MockProvider().generateOperations({
      message: "a signup flow with email verification",
      workspace: { nodes: {}, edges: {}, groups: {}, shapes: {}, wireframes: {} } as never,
    } as never);
    expect(result.reply).toMatch(/^Done\. .+\?$/);
  });

  it("rides along in the history, so 'yes, do that' has something to answer", () => {
    const turns = recentHistory([
      { role: "user", text: "add payments" },
      {
        role: "ai",
        text: "Added a payments service.",
        reply: "Done. Should failed payments retry?",
      },
      { role: "user", text: "yes, retry three times" },
      { role: "ai", text: "Same words", reply: "Same words" },
    ]);
    expect(turns[1]!.text).toBe(
      "Added a payments service.\n(Said to the person: Done. Should failed payments retry?)",
    );
    expect(turns[3]!.text).toBe("Same words");
  });
});
