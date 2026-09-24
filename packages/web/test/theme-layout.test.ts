import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, validateOperations, type Operation } from "@lucent/core";
import { THEME_LAYOUT, planThemeLayout, sortableStickies } from "../src/board/themeLayout.js";
import { sortedBy } from "../src/themes.js";

/**
 * docs/27 D2, the canvas side of "sort into themes": the model named the
 * themes; every coordinate comes from this layout — frames in rows from where
 * the stickies were, each theme's stickies in a grid inside its frame.
 */

function wall() {
  const ops: Operation[] = ["Signup", "Pricing", "Pricing 2", "Signup 2", "Dark mode"].map(
    (text, i): Operation => ({
      op: "CREATE_SHAPE",
      id: `s${i}`,
      kind: "sticky",
      position: { x: 400 + i * 37, y: 300 - i * 11 },
      size: { width: 150, height: 110 },
      text,
      z: 5 + i,
    }),
  );
  ops.push(
    {
      op: "CREATE_SHAPE",
      id: "locked",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: "Pinned",
      locked: true,
    },
    {
      op: "CREATE_SHAPE",
      id: "blank",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: " ",
    },
    {
      op: "CREATE_SHAPE",
      id: "rect",
      kind: "rect",
      position: { x: 0, y: 0 },
      size: { width: 50, height: 50 },
      text: "Box",
    },
  );
  return applyOperations(createWorkspace(), ops);
}

describe("sortableStickies", () => {
  it("keeps unlocked, visible stickies with text, in selection order", () => {
    const ws = wall();
    const got = sortableStickies(ws, ["s2", "locked", "s0", "blank", "rect", "gone"]);
    expect(got.map((s) => s.id)).toEqual(["s2", "s0"]);
  });
});

describe("planThemeLayout", () => {
  const ws = wall();
  const stickies = sortableStickies(ws, ["s0", "s1", "s2", "s3", "s4"]);
  let n = 0;
  const ops = planThemeLayout(
    stickies,
    {
      themes: [
        { title: "Signup", items: [0, 3] },
        { title: "Pricing", items: [1, 2] },
        { title: "Other", items: [4] },
      ],
    },
    () => `f${++n}`,
  );

  it("is a batch the validator accepts: frames below the notes, every note moved once", () => {
    expect(validateOperations(ws, ops)).toEqual([]);
    const frames = ops.filter((o) => o.op === "CREATE_SHAPE");
    expect(frames.map((f) => (f as { text?: string }).text)).toEqual([
      "Signup",
      "Pricing",
      "Other",
    ]);
    expect(frames.every((f) => (f as { z?: number }).z === 4)).toBe(true);
    const moved = ops.filter((o) => o.op === "UPDATE_SHAPE").map((o) => (o as { id: string }).id);
    expect(moved.sort()).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("starts at the notes' top-left and puts each note inside its theme's frame", () => {
    const next = applyOperations(ws, ops);
    const frame = (title: string) =>
      Object.values(next.shapes).find((s) => s.kind === "frame" && s.text === title)!;
    expect(frame("Signup").position).toEqual({ x: 400, y: 256 });
    const inside = (id: string, title: string) => {
      const s = next.shapes[id]!;
      const f = frame(title);
      return (
        s.position.x >= f.position.x &&
        s.position.y >= f.position.y + THEME_LAYOUT.title &&
        s.position.x + s.size.width <= f.position.x + f.size.width &&
        s.position.y + s.size.height <= f.position.y + f.size.height
      );
    };
    expect([
      inside("s0", "Signup"),
      inside("s3", "Signup"),
      inside("s1", "Pricing"),
      inside("s4", "Other"),
    ]).toEqual([true, true, true, true]);
  });

  it("nothing to lay out yields no ops", () => {
    expect(planThemeLayout([], { themes: [{ title: "x", items: [0] }] }, () => "f")).toEqual([]);
  });
});

describe("sortedBy", () => {
  it("says honestly which sorter answered", () => {
    expect(sortedBy({ themes: [], by: "model" })).toBe("sorted by theme");
    expect(sortedBy({ themes: [], by: "fallback", offline: "policy" })).toContain(
      "keeps its content from AI",
    );
  });
});
