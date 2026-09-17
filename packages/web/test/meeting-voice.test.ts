import { describe, it, expect } from "vitest";
import {
  detectAddress,
  openBoardQuestions,
  shouldAnswerVoice,
  voiceAnswerCard,
} from "../src/meeting-voice.js";

/**
 * docs/25 V6 (M6.1): the text voice loop's two pure rules.
 *
 * Addressing is invocation, not mention — and permission is the mode
 * contract, not the transcript. Both are pinned without a DOM so the
 * meeting view can call them per final with no further judgment of its own.
 */
describe("detectAddress", () => {
  it("hears a leading Lucent in its usual shapes", () => {
    expect(detectAddress("Lucent, what did we decide about pricing?")).toEqual({
      addressed: true,
      query: "what did we decide about pricing?",
    });
    expect(detectAddress("hey lucent what is the deadline")).toEqual({
      addressed: true,
      query: "what is the deadline",
    });
    expect(detectAddress("LUCENT: summarize the risks")).toEqual({
      addressed: true,
      query: "summarize the risks",
    });
    expect(detectAddress("  lucent — who owns mobile?")).toEqual({
      addressed: true,
      query: "who owns mobile?",
    });
  });

  it("ignores mentions, bare names, and empty queries", () => {
    expect(detectAddress("the lucent approach seems fine").addressed).toBe(false);
    expect(detectAddress("hallucinate about lucent").addressed).toBe(false);
    expect(detectAddress("Sarah will handle it").addressed).toBe(false);
    // Addressed, but nothing asked: the loop must not spend a generation.
    expect(detectAddress("Lucent")).toEqual({ addressed: true, query: "" });
    expect(detectAddress("Lucent, ").query).toBe("");
  });
});

describe("shouldAnswerVoice", () => {
  it("answers addressed questions only in the assistant profiles", () => {
    const q = "Lucent, what did we decide?";
    expect(shouldAnswerVoice("assistant", q)).toBe(true);
    expect(shouldAnswerVoice("participant", q)).toBe(true);
    expect(shouldAnswerVoice("intelligence", q)).toBe(false);
    expect(shouldAnswerVoice("record", q)).toBe(false);
    // Record is silent at every volume; empty queries spend nothing anywhere.
    expect(shouldAnswerVoice("record", "Lucent, summarize everything")).toBe(false);
    expect(shouldAnswerVoice("assistant", "Lucent")).toBe(false);
    expect(shouldAnswerVoice("assistant", "just talking")).toBe(false);
  });
});

describe("voiceAnswerCard", () => {
  it("collapses citations to labels and carries errors visibly", () => {
    const card = voiceAnswerCard("Lucent, q?", {
      answer: "Postgres.",
      citations: [{ label: "Decision · pricing" }, {}],
    });
    expect(card.question).toBe("Lucent, q?");
    expect(card.answer).toBe("Postgres.");
    expect(card.citations).toEqual(["Decision · pricing"]);
    expect(card.error).toBeUndefined();
    const failed = voiceAnswerCard("Lucent, q?", { error: "paywall" });
    expect(failed.error).toBe("paywall");
    expect(failed.answer).toBe("");
  });
});

describe("openBoardQuestions", () => {
  const board = {
    nodes: {
      n1: { label: "Who owns mobile?", statement: { kind: "question", status: "open" } },
      n2: {
        label: "Use Postgres",
        statement: { kind: "decision", status: "resolved", topic: "db" },
      },
      n3: {
        label: "Settled question",
        statement: { kind: "question", status: "resolved" },
      },
      n4: {
        label: "Priced?",
        statement: { kind: "question", status: "open", topic: "pricing" },
      },
      n5: { label: "No statement here" },
    },
  };

  it("lists open questions only, capped, with the honest total", () => {
    expect(openBoardQuestions(null)).toEqual({ items: [], total: 0 });
    expect(openBoardQuestions(undefined)).toEqual({ items: [], total: 0 });
    const all = openBoardQuestions(board, 10);
    expect(all.total).toBe(2);
    expect(all.items).toEqual([
      { id: "n1", label: "Who owns mobile?" },
      { id: "n4", label: "Priced?", topic: "pricing" },
    ]);
    const capped = openBoardQuestions(board, 1);
    expect(capped.items).toHaveLength(1);
    expect(capped.total).toBe(2);
  });
});
