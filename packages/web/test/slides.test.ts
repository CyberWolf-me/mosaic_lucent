import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";
import { buildSlidesDocument, slidesOf } from "../src/board/slides.js";

/**
 * docs/26 §6.1 presentation layout: the board's frames are its slides — in
 * reading order (or by the numbers in their names), presented one frame at a
 * time, and printed one page per frame at the frame's own size.
 */

const frame = (id: string, x: number, y: number, text?: string, extra = {}): Operation =>
  ({
    op: "CREATE_SHAPE",
    id,
    kind: "frame",
    position: { x, y },
    size: { width: 400, height: 225 },
    ...(text !== undefined ? { text } : {}),
    ...extra,
  }) as Operation;

describe("slidesOf", () => {
  it("reads frames in rows, top to bottom, left to right", () => {
    const ws = applyOperations(createWorkspace(), [
      frame("c", 500, 40, "Third"), // a little lower than "b", same row
      frame("b", 0, 0, "First"),
      frame("d", 0, 400, "Fourth"),
      frame("a", 1000, 10, "Also row one"),
      frame("h", 500, 400, "Hidden", { hidden: true }),
    ]);
    expect(slidesOf(ws).map((s) => s.id)).toEqual(["b", "c", "a", "d"]);
    expect(slidesOf(ws)[0]).toEqual({
      id: "b",
      title: "First",
      box: { x: 0, y: 0, width: 400, height: 225 },
    });
  });

  it("orders by the numbers in the names when every frame has one", () => {
    const numbered = applyOperations(createWorkspace(), [
      frame("x", 0, 0, "3. Ask"),
      frame("y", 500, 0, "1 Problem"),
      frame("z", 0, 400, "2) Solution"),
    ]);
    expect(slidesOf(numbered).map((s) => s.id)).toEqual(["y", "z", "x"]);
    // One unnumbered frame: reading order, so nothing is guessed.
    const mixed = applyOperations(numbered, [frame("w", 1000, 0, "Appendix")]);
    expect(slidesOf(mixed).map((s) => s.id)).toEqual(["x", "y", "w", "z"]);
  });

  it("a board without frames has no slides", () => {
    expect(slidesOf(createWorkspace())).toEqual([]);
  });
});

describe("printing slides", () => {
  const ws = applyOperations(createWorkspace(), [
    frame("one", 0, 0, "Problem"),
    frame("two", 500, 0, "Solution"),
    {
      op: "CREATE_SHAPE",
      id: "note",
      kind: "sticky",
      position: { x: 40, y: 60 },
      size: { width: 120, height: 80 },
      text: "Too slow",
    },
  ]);

  it("crops the board to one frame, without that frame's border", () => {
    const svg = buildBoardSvg(ws, 40, "one");
    expect(svg).toMatch(/^<svg [^>]*width="400" height="225" viewBox="0 0 400 225"/);
    expect(svg).toContain("Too slow");
    expect(svg).toContain(">Problem</text>");
    // Its own dashed border is the page edge now; the other frame keeps its.
    expect((svg.match(/stroke-dasharray="6 4"/g) ?? []).length).toBe(1);
    // A name that isn't a frame is ignored: the whole board.
    expect(buildBoardSvg(ws, 40, "note")).toMatch(/viewBox="-40 -40 /);
  });

  it("one page per slide at the frame's size, the title escaped", () => {
    const doc = buildSlidesDocument(ws, slidesOf(ws), "Deck </title><script>x()</script>", false);
    expect(doc.match(/<section class="slide/g)).toHaveLength(2);
    expect(doc).toContain("@page s0{size:400px 225px;margin:0}");
    expect(doc).toContain('aria-label="Solution"');
    expect(doc).not.toContain("<script>x()");
    expect(doc).not.toContain("window.print");
    expect(buildSlidesDocument(ws, slidesOf(ws), "Deck")).toContain("window.print");
  });
});
