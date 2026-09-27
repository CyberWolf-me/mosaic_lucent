import { describe, expect, it } from "vitest";
import {
  classifyTurn,
  correctedTurns,
  meetingName,
  promptFromTranscript,
  type MeetingTranscript,
} from "../src/meetings.js";

/**
 * The meeting flow's pure decisions (E3 / R3): the classification heuristic
 * and the extraction prompt. DOM-free by design — MeetingView renders;
 * these are the parts that can be wrong in a way a screenshot won't show.
 */

const MEETING: MeetingTranscript = {
  id: "mtg_test",
  boardId: "brd_test",
  orgId: "org_test",
  startedAt: 0,
  endedAt: 1000,
  createdBy: "u1",
  createdAt: 0,
  turns: [
    // kind is what the flow saved — classifyTurn drafted it and the owner
    // let it stand; promptFromTranscript renders the SAVED classification.
    { speaker: "Ada", at: 100, text: "We'll add wallet payments.", kind: "decision" },
    { speaker: "Grace", at: 300, text: "The redirect is broken.", kind: "problem" },
    { speaker: "Ada", at: 500, text: "Unclassified remark." },
  ],
};

describe("classifyTurn", () => {
  it("decision beats all — commitments are the most valuable line to tag", () => {
    expect(classifyTurn("we'll add auth before checkout")).toBe("decision");
    expect(classifyTurn("Let's do it next sprint")).toBe("decision");
    expect(classifyTurn("we decided to ship friday")).toBe("decision");
  });

  it("spots problems, requirements, actions, hypotheses, solutions", () => {
    expect(classifyTurn("the login flow fails on Safari")).toBe("problem");
    expect(classifyTurn("We need audit logs for enterprise")).toBe("requirement");
    expect(classifyTurn("Action item: rotate the secrets")).toBe("action");
    expect(classifyTurn("maybe what if we cache the prompt")).toBe("hypothesis");
    expect(classifyTurn("the fix is a retry with backoff")).toBe("solution");
  });

  it("returns undefined for chatter", () => {
    expect(classifyTurn("Good morning everyone")).toBeUndefined();
    expect(classifyTurn("Nice weather today")).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(classifyTurn("WE'LL SHIP IT")).toBe("decision");
  });
});

describe("promptFromTranscript", () => {
  it("renders every turn, speaker-labelled, with classifications bracketed", () => {
    const prompt = promptFromTranscript(MEETING);
    expect(prompt).toContain("Ada [decision]: We'll add wallet payments.");
    expect(prompt).toContain("Grace [problem]: The redirect is broken.");
    expect(prompt).toContain("Ada: Unclassified remark.");
  });

  it("states the goal so the model builds rather than summarises", () => {
    const prompt = promptFromTranscript(MEETING);
    expect(prompt).toMatch(/Build a diagram/);
    expect(prompt).toMatch(/one node per distinct point/);
  });

  it("presents the transcript as quoted data below the instruction", () => {
    const prompt = promptFromTranscript(MEETING);
    const instructionAt = prompt.indexOf("Build a diagram");
    const transcriptAt = prompt.indexOf("Transcript:");
    expect(instructionAt).toBeLessThan(transcriptAt);
  });
});

describe("meetingName (ADR 0045)", () => {
  const at = new Date(2026, 8, 27, 9, 2).getTime();
  it("a title wins; an untitled meeting reads as its day, with the board when asked", () => {
    expect(meetingName({ title: "Pricing sync", startedAt: at }, "Board A")).toBe("Pricing sync");
    expect(meetingName({ startedAt: at })).toMatch(/^Meeting · /);
    expect(meetingName({ title: null, startedAt: at }, "Board A")).toMatch(/^Board A · /);
    expect(meetingName({ title: "", startedAt: at })).toMatch(/^Meeting · /);
  });
});

describe("correctedTurns (docs/28 S7)", () => {
  const turns = [
    { speaker: "A", at: 1, text: "one" },
    { speaker: "B", at: 2, text: "tow" },
  ];
  it("shows each turn's latest correction and keeps the original words beside it", () => {
    expect(correctedTurns({ turns })).toBe(turns);
    const read = correctedTurns({
      turns,
      corrections: [
        { turn: 1, text: "two?", by: "u", at: 10 },
        { turn: 1, text: "two", by: "u", at: 20 },
      ],
    });
    expect(read[1]).toMatchObject({ text: "two", original: "tow" });
    expect(read[0]).toBe(turns[0]);
  });
  it("a correction back to the original words is not marked edited", () => {
    const read = correctedTurns({ turns, corrections: [{ turn: 0, text: "one", by: "u", at: 5 }] });
    expect(read[0]!.original).toBeUndefined();
  });
});
