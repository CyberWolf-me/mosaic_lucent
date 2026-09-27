import { describe, expect, it } from "vitest";
import {
  IMPORT_MAX_TURNS,
  parseTranscript,
  transcriptTurns,
  type ParsedTranscript,
} from "../src/transcriptImport.js";

/**
 * Transcript files from other tools (docs/28 S12): each vendor's export
 * shape reads into the same turns, speakers are taken as the file names them
 * and never guessed, and the store's limits are met by merging and splitting,
 * never by quietly dropping words.
 */

function ok(result: ReturnType<typeof parseTranscript>): ParsedTranscript {
  if ("error" in result) throw new Error(result.error);
  return result;
}

describe("parseTranscript", () => {
  it("reads Teams WebVTT: voice tags name the speaker, and one speaker's cues merge", () => {
    const vtt = [
      "WEBVTT",
      "",
      "0b1c2d3e-1",
      "00:00:01.200 --> 00:00:03.900",
      "<v Ada Lovelace>We go annual next quarter.</v>",
      "",
      "0b1c2d3e-2",
      "00:00:04.000 --> 00:00:05.500",
      "<v Ada Lovelace>Starting in January.</v>",
      "",
      "0b1c2d3e-3",
      "00:00:06.000 --> 00:00:08.000",
      "<v Bo Chen>And the free tier stays.</v>",
    ].join("\n");
    const parsed = ok(parseTranscript(vtt, "Pricing review.vtt"));
    expect(parsed.format).toBe("vtt");
    expect(parsed.source).toBe("teams");
    expect(parsed.turns).toEqual([
      {
        speaker: "Ada Lovelace",
        text: "We go annual next quarter. Starting in January.",
        offsetMs: 1200,
      },
      { speaker: "Bo Chen", text: "And the free tier stays.", offsetMs: 6000 },
    ]);
    expect(parsed.speakers).toEqual(["Ada Lovelace", "Bo Chen"]);
    expect(parsed.durationMs).toBe(4800);
  });

  it("reads Zoom WebVTT: numbered cues, the speaker before a colon", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:02.310 --> 00:00:04.020",
      "Ada Lovelace: Let's start with pricing.",
      "",
      "2",
      "00:01:10.000 --> 00:01:12.500",
      "Bo Chen: I'll update the page by Friday.",
    ].join("\n");
    const parsed = ok(parseTranscript(vtt, "GMT20260928-zoom.vtt"));
    expect(parsed.source).toBe("zoom");
    expect(parsed.turns.map((t) => [t.speaker, t.offsetMs])).toEqual([
      ["Ada Lovelace", 2310],
      ["Bo Chen", 70000],
    ]);
  });

  it("reads SRT, and a line with no speaker is just Speaker", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:02,000",
      "Welcome, everyone.",
      "",
      "2",
      "00:00:03,000 --> 00:00:04,000",
      "Cy: Thanks — shall we start?",
    ].join("\n");
    const parsed = ok(parseTranscript(srt, "call.srt"));
    expect(parsed.format).toBe("srt");
    expect(parsed.turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Speaker", "Welcome, everyone."],
      ["Cy", "Thanks — shall we start?"],
    ]);
  });

  it("reads plain text: a speaker on each line, with or without a clock", () => {
    const text = [
      "[00:00:05] Ada: We go annual.",
      "[00:00:09] Bo: Agreed.",
      "Ada: Then billing needs annual invoices.",
      "",
      "See https://example.com: not a speaker",
    ].join("\n");
    const parsed = ok(parseTranscript(text, "notes.txt"));
    expect(parsed.format).toBe("text");
    expect(parsed.turns.map((t) => [t.speaker, t.text, t.offsetMs])).toEqual([
      ["Ada", "We go annual.", 5000],
      ["Bo", "Agreed.", 9000],
      ["Ada", "Then billing needs annual invoices.", null],
      ["Speaker", "See https://example.com: not a speaker", null],
    ]);
  });

  it("reads Otter and Meet exports: a speaker and a time, then the words", () => {
    const text = [
      "Ada Lovelace  0:03",
      "We go annual next quarter.",
      "",
      "Bo Chen  0:41",
      "I'll update the pricing page.",
      "And ping legal.",
    ].join("\n");
    const parsed = ok(parseTranscript(text, "Pricing review.txt"));
    expect(parsed.source).toBe("otter");
    expect(parsed.turns).toEqual([
      { speaker: "Ada Lovelace", text: "We go annual next quarter.", offsetMs: 3000 },
      {
        speaker: "Bo Chen",
        text: "I'll update the pricing page. And ping legal.",
        offsetMs: 41000,
      },
    ]);
  });

  it("splits a turn longer than the store allows, at sentence ends", () => {
    const sentence = "This is one sentence about the plan that goes on for a while. ";
    const long = `Ada: ${sentence.repeat(60)}`;
    const parsed = ok(parseTranscript(long, "long.txt"));
    expect(parsed.turns.length).toBeGreaterThan(1);
    for (const t of parsed.turns) {
      expect(t.speaker).toBe("Ada");
      expect(t.text.length).toBeLessThanOrEqual(2000);
      expect(t.text.endsWith(".")).toBe(true);
    }
    expect(parsed.turns.map((t) => t.text).join(" ")).toBe(sentence.repeat(60).trim());
  });

  it("says why a file can't be read", () => {
    expect(parseTranscript("", "x.txt")).toEqual({ error: "That file is empty." });
    expect(parseTranscript("WEBVTT\n\nNOTE nothing said", "x.vtt")).toEqual({
      error: "Lucent couldn't find anything said in that file.",
    });
    expect("error" in parseTranscript("x".repeat(2_000_001))).toBe(true);
  });
});

describe("transcriptTurns", () => {
  it("places turns in time from the meeting's start, and says what didn't fit", () => {
    const parsed = ok(
      parseTranscript(
        Array.from({ length: IMPORT_MAX_TURNS + 3 }, (_, i) =>
          i % 2 ? `Bo: line ${i}` : `Ada: line ${i}`,
        ).join("\n"),
        "many.txt",
      ),
    );
    const { turns, dropped } = transcriptTurns(parsed, 1_000_000);
    expect(turns).toHaveLength(IMPORT_MAX_TURNS);
    expect(dropped).toBe(3);
    expect(turns[0]).toEqual({ speaker: "Ada", text: "line 0", at: 1_000_000 });
    expect(turns[1]!.at).toBe(1_001_000);

    const timed = ok(parseTranscript("[00:00:05] Ada: hi\n[00:00:02] Bo: out of order", "t.txt"));
    // Never backwards: a file's clock can jump; the transcript can't.
    expect(transcriptTurns(timed, 0).turns.map((t) => t.at)).toEqual([5000, 5000]);
  });
});
