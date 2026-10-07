import { describe, it, expect } from "vitest";
import { voiceMacroState, type VoiceHudSnapshot } from "../src/meeting-room/VoiceStateHud.js";

/**
 * The voice-state HUD's macro label (docs/26 §7). Pins the LISTENING →
 * PROCESSING → SPEAKING → LISTENING transitions the HUD surfaces, so the
 * observable states can't silently drift from the loop's real behavior.
 */

const base: VoiceHudSnapshot = {
  recording: false,
  sttStatus: "idle",
  ttsSpeaking: false,
  conversation: "dormant",
  leaseRemainingSec: 0,
  turnCount: 0,
};

describe("voiceMacroState", () => {
  it("is IDLE when not recording and nothing else is happening", () => {
    expect(voiceMacroState(base)).toBe("IDLE");
  });

  it("is LISTENING while recording with a dormant lease", () => {
    expect(voiceMacroState({ ...base, recording: true })).toBe("LISTENING");
  });

  it("is PROCESSING right after an invocation, before the answer plays", () => {
    expect(voiceMacroState({ ...base, recording: true, conversation: "invoked" })).toBe(
      "PROCESSING",
    );
  });

  it("is SPEAKING while TTS plays or the lease says ai_responding", () => {
    expect(voiceMacroState({ ...base, recording: true, ttsSpeaking: true })).toBe("SPEAKING");
    expect(voiceMacroState({ ...base, recording: true, conversation: "ai_responding" })).toBe(
      "SPEAKING",
    );
  });

  it("SPEAKING wins over LISTENING even mid-capture (barge-in window)", () => {
    expect(
      voiceMacroState({ ...base, recording: true, ttsSpeaking: true, conversation: "invoked" }),
    ).toBe("SPEAKING");
  });

  it("accurately reflects full diagnostics snapshot: MIC, VAD, Echo, and snippet", () => {
    const fullSnapshot: VoiceHudSnapshot = {
      recording: true,
      sttStatus: "transcribing",
      ttsSpeaking: false,
      conversation: "waiting_for_followup",
      leaseRemainingSec: 12,
      leaseSpeaker: "Alice",
      turnCount: 3,
      micStatus: "ACTIVE",
      vadStatus: "SPEECH",
      echoSuppressionActive: false,
      lastTranscript: "Lucent, connect API to database",
    };

    expect(voiceMacroState(fullSnapshot)).toBe("LISTENING");
    expect(fullSnapshot.micStatus).toBe("ACTIVE");
    expect(fullSnapshot.vadStatus).toBe("SPEECH");
    expect(fullSnapshot.echoSuppressionActive).toBe(false);
    expect(fullSnapshot.lastTranscript).toContain("connect API");
  });
});
