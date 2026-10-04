import { describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { summarizeWorkspace } from "../src/provider.js";
import { buildUserPrompt, todayLine } from "../src/prompt.js";

/**
 * The prompt tells the model to resolve "by Friday" to a dueDate "against the
 * conversation's date". Until the request carried that date the model had
 * nothing to resolve against and guessed from training data — a live board
 * got "Friday" as a date a year in the past. The requester's local date is
 * now part of the request, rendered as one anchoring line.
 */
describe("today anchors relative deadlines", () => {
  it("renders the weekday with the date", () => {
    expect(todayLine("2026-09-23")).toMatch(/^Today is Wednesday, 2026-09-23/);
    expect(todayLine("2026-09-27")).toMatch(/^Today is Sunday, 2026-09-27/);
  });

  it("ignores malformed or impossible dates rather than anchoring to them", () => {
    expect(todayLine(undefined)).toBeNull();
    expect(todayLine("23/09/2026")).toBeNull();
    expect(todayLine("2026-02-30")).toBeNull();
    expect(todayLine("2026-13-01")).toBeNull();
  });

  it("sits in the user prompt, before the request, only when given", () => {
    const summary = summarizeWorkspace(createWorkspace());
    const withDate = buildUserPrompt({
      message: "Sam drafts it by Friday",
      summary,
      today: "2026-09-23",
    });
    expect(withDate.indexOf("Today is Wednesday")).toBeGreaterThan(-1);
    expect(withDate.indexOf("Today is")).toBeLessThan(withDate.indexOf("User request:"));
    const without = buildUserPrompt({ message: "Sam drafts it by Friday", summary });
    expect(without).not.toContain("Today is");
  });
});
