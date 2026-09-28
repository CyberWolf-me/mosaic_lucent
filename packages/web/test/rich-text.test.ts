import { describe, expect, it } from "vitest";
import { hasRichText, parseInline, parseRichText, plainText, safeHref } from "../src/richText.js";

/**
 * Minimal rich text for shape text (docs/26 §6.4): a small markdown subset
 * read from the text a shape already stores. What's under test: the inline
 * marks, the blocks (headings, lists, code), that arithmetic and snake_case
 * stay words, that only safe links become links, and the plain words an
 * export gets.
 */

describe("parseInline", () => {
  it("reads bold, italic, struck, code and links — nested where it makes sense", () => {
    expect(parseInline("a **bold _and italic_** `x = 1` ~~no~~")).toEqual([
      { kind: "text", text: "a " },
      {
        kind: "bold",
        children: [
          { kind: "text", text: "bold " },
          { kind: "italic", children: [{ kind: "text", text: "and italic" }] },
        ],
      },
      { kind: "text", text: " " },
      { kind: "code", text: "x = 1" },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "no" }] },
    ]);
    expect(parseInline("see [the spec](https://example.com/spec) now")).toEqual([
      { kind: "text", text: "see " },
      {
        kind: "link",
        href: "https://example.com/spec",
        children: [{ kind: "text", text: "the spec" }],
      },
      { kind: "text", text: " now" },
    ]);
  });

  it("leaves arithmetic, snake_case and unsafe links as words", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
    expect(parseInline("user_id_field")).toEqual([{ kind: "text", text: "user_id_field" }]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[click](javascript:alert(1))" },
    ]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("mailto:ada@example.com")).toBe("mailto:ada@example.com");
  });

  it("links a bare address, without the sentence's full stop", () => {
    expect(parseInline("Docs at https://lucent.dev/docs.")).toEqual([
      { kind: "text", text: "Docs at " },
      {
        kind: "link",
        href: "https://lucent.dev/docs",
        children: [{ kind: "text", text: "https://lucent.dev/docs" }],
      },
      { kind: "text", text: "." },
    ]);
  });
});

describe("parseRichText", () => {
  it("reads headings, bullets, numbered lines and a code block", () => {
    const blocks = parseRichText(
      ["# Launch", "- **Pricing** page", "2. ship", "```ts", "const x = 1;", "  y();", "```"].join(
        "\n",
      ),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "bullet", "numbered", "code"]);
    expect(blocks[3]).toEqual({ kind: "code", lang: "ts", text: "const x = 1;\n  y();" });
    expect(blocks[2]).toMatchObject({ kind: "numbered", n: 2 });
  });

  it("keeps an unclosed code block to the end", () => {
    expect(parseRichText("```\nstill code\nmore")).toEqual([
      { kind: "code", lang: null, text: "still code\nmore" },
    ]);
  });
});

describe("hasRichText and plainText", () => {
  it("tells markup from plain words", () => {
    expect(hasRichText("Just a note")).toBe(false);
    expect(hasRichText("2 * 3 = 6")).toBe(false);
    expect(hasRichText("a **b**")).toBe(true);
    expect(hasRichText("- one\n- two")).toBe(true);
    expect(hasRichText("```\ncode\n```")).toBe(true);
  });

  it("gives the words without the markup", () => {
    expect(plainText("# Plan\n- **Ship** [it](https://x.dev)\n```\nrun()\n```")).toBe(
      "Plan\n• Ship it\nrun()",
    );
  });
});
