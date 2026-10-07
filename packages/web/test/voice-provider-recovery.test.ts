import { describe, expect, it, vi } from "vitest";
import { isTransientSpeechError, MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW_MS } from "../src/stt/browser.js";
import { hostedDegradedReason } from "../src/stt/hosted.js";
import { speakAnswer, type TtsProvider } from "../src/tts.js";
import { VoiceFSM } from "@lucent/core";

describe("Voice Provider Failure & Degradation Recovery (Task 1.6)", () => {
  describe("STT Failure & Degradation Handling", () => {
    it("recognizes transient Chrome errors that should NOT terminate the voice session", () => {
      expect(isTransientSpeechError("no-speech")).toBe(true);
      expect(isTransientSpeechError("aborted")).toBe(true);
      expect(isTransientSpeechError("network")).toBe(true);
      expect(isTransientSpeechError("not-allowed")).toBe(false);
      expect(isTransientSpeechError("audio-capture")).toBe(false);
    });

    it("formats honest degradation notices for hosted STT dropped chunks", () => {
      const reason1 = hostedDegradedReason(false, 2);
      expect(reason1).toContain("About 4 seconds of audio weren't transcribed");

      const reason2 = hostedDegradedReason(true, 0);
      expect(reason2).toContain("returns the text when you stop");

      const reasonNone = hostedDegradedReason(false, 0);
      expect(reasonNone).toBeNull();
    });
  });

  describe("TTS Fallback & Error Resilience", () => {
    it("falls back to browser TTS when hosted TTS returns 503 or fails", async () => {
      let browserCalled = false;
      const failingHostedProvider: TtsProvider = {
        id: "hosted",
        isSupported: () => true,
        unavailableReason: () => null,
        speak: async () => {
          throw new Error("unconfigured (503)");
        },
      };

      const fallbackBrowserProvider: TtsProvider = {
        id: "browser",
        isSupported: () => true,
        unavailableReason: () => null,
        speak: async () => {
          browserCalled = true;
          return {
            stop: () => {},
            done: Promise.resolve(),
          };
        },
      };

      const result = await speakAnswer(
        "Hello from Lucent co-pilot",
        failingHostedProvider,
        fallbackBrowserProvider,
      );

      expect(browserCalled).toBe(true);
      expect(result.provider).toBe("browser");
      expect(result.playback).toBeDefined();
    });

    it("reports honest reason when both hosted and browser TTS are unavailable", async () => {
      const failingHostedProvider: TtsProvider = {
        id: "hosted",
        isSupported: () => false,
        unavailableReason: () => "Server speech proxy not configured.",
        speak: async () => {
          throw new Error("unsupported");
        },
      };

      const failingBrowserProvider: TtsProvider = {
        id: "browser",
        isSupported: () => false,
        unavailableReason: () => "Browser does not support SpeechSynthesis.",
        speak: async () => {
          throw new Error("unsupported");
        },
      };

      const result = await speakAnswer(
        "Important notification",
        failingHostedProvider,
        failingBrowserProvider,
      );

      expect(result.playback).toBeNull();
      expect(result.reason).toContain("Browser does not support SpeechSynthesis");
    });
  });

  describe("FSM State Recovery Under Provider Failure", () => {
    it("transitions from processing to error and resets to dormant on timeout", () => {
      const fsm = new VoiceFSM("listening", 1000);
      fsm.dispatch({
        type: "TURN_FINALIZED",
        turn: { id: "t1", text: "draw architecture", at: 1100, source: "browser" },
        at: 1100,
      });
      expect(fsm.state).toBe("processing");

      // LLM call times out after 15s
      fsm.dispatch({
        type: "PROVIDER_FAIL",
        error: "LLM generation timed out after 15000ms",
        recoverable: false,
        at: 16100,
      });
      expect(fsm.state).toBe("error");
      expect(fsm.snapshot.lastError).toBe("LLM generation timed out after 15000ms");

      // User resets or retries
      fsm.dispatch({ type: "RESET", at: 16200 });
      expect(fsm.state).toBe("dormant");
    });

    it("recovers gracefully from transient STT disconnect back to listening", () => {
      const fsm = new VoiceFSM("listening", 1000);

      // Transient socket disconnect
      fsm.dispatch({
        type: "PROVIDER_FAIL",
        error: "WebSocket reconnecting",
        recoverable: true,
        at: 1200,
      });
      expect(fsm.state).toBe("recovering");

      // Connection restored
      fsm.dispatch({ type: "RECOVERED", at: 1500 });
      expect(fsm.state).toBe("listening");
    });
  });
});
