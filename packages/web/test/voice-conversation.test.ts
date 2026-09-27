import { describe, expect, it } from "vitest";
import {
  END_OF_TURN_MS,
  IDLE_END_MS,
  INTERIM_GRACE_MS,
  isEndOfConversation,
  spokenReply,
  voicePhaseLabel,
} from "../src/voiceConversation.js";
import {
  TRANSCRIPT_LINES,
  withTranscriptSegment,
  type VoiceAgentTranscript,
} from "../src/stt/voiceAgentSession.js";

/**
 * Talking with Lucent (found in use: "the agent only reads the changes it
 * made"): it answers with its conversational reply, keeps listening, and
 * stops when the person says they're done.
 */

describe("a voice conversation on the canvas", () => {
  it("hears when the person is done — and only then", () => {
    for (const done of [
      "that's all",
      "That's it.",
      "stop",
      "thanks, that's all",
      "okay thanks lucent that's it",
      "we're done",
      "bye",
      "No thanks",
      "end the conversation",
      "that's all for now",
    ]) {
      expect(isEndOfConversation(done), done).toBe(true);
    }
    for (const more of [
      "stop the checkout from retrying",
      "that's all the services we need, now connect them",
      "add a login page",
      "no, make it blue",
    ]) {
      expect(isEndOfConversation(more), more).toBe(false);
    }
  });

  it("speaks the model's reply, not the change description", () => {
    expect(
      spokenReply({
        outcome: "applied",
        ops: 3,
        reply: "Done — I added a cache in front of the API. Should it expire hourly?",
      }),
    ).toBe("Done — I added a cache in front of the API. Should it expire hourly?");
    expect(spokenReply({ outcome: "answered", text: "It has 4 services.", reply: "Four." })).toBe(
      "Four.",
    );
    expect(spokenReply({ outcome: "proposed", ops: 9, reply: "  " })).toBeNull();
    expect(spokenReply({ outcome: "failed", error: "The model timed out." })).toBe(
      "That didn't work: The model timed out.",
    );
    expect(spokenReply({ outcome: "rejected" })).toMatch(/another way/);
    expect(spokenReply({ outcome: "cancelled" })).toBeNull();
  });

  it("waits for a pause before taking the turn, longer while words are still coming", () => {
    expect(END_OF_TURN_MS).toBeLessThan(INTERIM_GRACE_MS);
    expect(IDLE_END_MS).toBeGreaterThan(INTERIM_GRACE_MS * 5);
    expect(voicePhaseLabel("idle")).toBeNull();
    expect(voicePhaseLabel("speaking")).toMatch(/tap the mic to stop/);
  });
});

describe("the voice agent's transcript", () => {
  const seg = (id: string, text: string, final = false, isAgent = false): VoiceAgentTranscript => ({
    id,
    text,
    final,
    isAgent,
    timestamp: 0,
  });

  it("grows each utterance in place and keeps the last few lines", () => {
    let lines = withTranscriptSegment([], seg("a", "add a"));
    lines = withTranscriptSegment(lines, seg("a", "add a login page"));
    lines = withTranscriptSegment(lines, seg("a", "add a login page", true));
    expect(lines).toEqual([{ id: "a", isAgent: false, text: "add a login page", final: true }]);
    lines = withTranscriptSegment(lines, seg("b", "Done. Should it have", false, true));
    lines = withTranscriptSegment(lines, seg("b", "Done. Should it have two-factor?", true, true));
    expect(lines.map((l) => l.text)).toEqual([
      "add a login page",
      "Done. Should it have two-factor?",
    ]);
    for (let i = 0; i < TRANSCRIPT_LINES + 2; i++) {
      lines = withTranscriptSegment(lines, seg(`x${i}`, `line ${i}`, true));
    }
    expect(lines).toHaveLength(TRANSCRIPT_LINES);
    expect(lines.at(-1)!.text).toBe(`line ${TRANSCRIPT_LINES + 1}`);
    expect(withTranscriptSegment(lines, seg("y", "   "))).toEqual(lines);
  });
});
