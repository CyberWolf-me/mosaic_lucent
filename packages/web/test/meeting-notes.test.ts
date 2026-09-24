import { describe, expect, it } from "vitest";
import type { EnhancedNote } from "@lucent/ai";
import { noteToMarkdown, restamp } from "../src/meetingNotes.js";

/**
 * docs/27 N1, client side: a line's turn stamp says when in the meeting it
 * was written, so editing the notepad must not move lines in time — and the
 * Markdown copy keeps the person's words apart from the cited additions.
 */

describe("restamp", () => {
  it("stamps new lines with the turn count now", () => {
    expect(restamp([], "pricing → usage", 4)).toEqual([{ text: "pricing → usage", turn: 4 }]);
  });

  it("keeps a line's stamp when its text is edited later", () => {
    const before = [
      { text: "pricing", turn: 2 },
      { text: "owner?", turn: 5 },
    ];
    expect(restamp(before, "pricing → usage-based\nowner?\nmaya: page fri", 9)).toEqual([
      { text: "pricing → usage-based", turn: 2 },
      { text: "owner?", turn: 5 },
      { text: "maya: page fri", turn: 9 },
    ]);
  });

  it("a line inserted mid-page is new; the lines below keep their stamps", () => {
    const before = [
      { text: "pricing", turn: 2 },
      { text: "owner?", turn: 5 },
    ];
    expect(restamp(before, "pricing\nlaunch in q3\nowner?", 8)).toEqual([
      { text: "pricing", turn: 2 },
      { text: "launch in q3", turn: 8 },
      { text: "owner?", turn: 5 },
    ]);
  });

  it("deleting a middle line keeps the stamps around it", () => {
    const before = [
      { text: "a", turn: 1 },
      { text: "b", turn: 3 },
      { text: "c", turn: 6 },
    ];
    expect(restamp(before, "a\nc", 9)).toEqual([
      { text: "a", turn: 1 },
      { text: "c", turn: 6 },
    ]);
  });

  it("drops the stamps of deleted trailing lines", () => {
    const before = [
      { text: "a", turn: 1 },
      { text: "b", turn: 3 },
    ];
    expect(restamp(before, "a", 7)).toEqual([{ text: "a", turn: 1 }]);
  });
});

describe("noteToMarkdown", () => {
  const note: EnhancedNote = {
    template: "general",
    generatedAt: 1,
    by: "model",
    sections: [
      {
        title: "Decisions",
        items: [
          { text: "pricing → usage", source: "user", line: 0 },
          { text: "Usage-based pricing, billed monthly.", source: "ai", turns: [1, 1] },
        ],
      },
      {
        title: "Action items",
        items: [{ text: "Maya drafts the pricing page by Friday.", source: "ai", turns: [2, 4] }],
      },
    ],
  };

  it("writes the person's lines plain and cites the added ones by turn", () => {
    expect(noteToMarkdown(note, "Meeting · Sep 24")).toBe(
      [
        "# Meeting · Sep 24",
        "",
        "## Decisions",
        "",
        "- pricing → usage",
        "- Usage-based pricing, billed monthly. _(turn 2)_",
        "",
        "## Action items",
        "",
        "- Maya drafts the pricing page by Friday. _(turn 3–5)_",
        "",
      ].join("\n"),
    );
  });
});
