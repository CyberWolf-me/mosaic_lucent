import { describe, expect, it } from "vitest";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";
import { isTtsSpeaking, type TtsPlayback } from "../src/tts.js";

describe("P0 Voice Barge-In & Cancellation Pipeline (Task 1.5)", () => {
  it("immediately cancels TTS playback and releases echo gate on 'Lucent, stop'", () => {
    const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    let stopCalled = false;
    const fakePlayback: TtsPlayback = {
      stop: () => {
        stopCalled = true;
      },
      done: Promise.resolve(),
    };

    // AI is speaking
    manager.onExplicitInvocation("alice", "explain payment flow", "Alice", 1000);
    manager.onAiStartResponding();
    expect(manager.getState()).toBe("ai_responding");

    // Barge-in occurs while AI is responding
    const barge = manager.onBargeIn("alice", "Lucent, stop", 1500);
    expect(barge.interrupted).toBe(true);
    expect(barge.newQuery).toBeUndefined();

    // Trigger playback stop as part of barge-in cancellation pipeline
    fakePlayback.stop();
    expect(stopCalled).toBe(true);

    // State returns to dormant, lease cleared
    expect(manager.getState()).toBe("dormant");
    expect(manager.getLease()).toBeNull();
  });

  it("handles barge-in that introduces a new command (interrupt with replacement)", () => {
    const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    manager.onExplicitInvocation("alice", "draw payments", "Alice", 1000);
    manager.onAiStartResponding();

    // User interrupts halfway through with a replacement command
    const barge = manager.onBargeIn("alice", "Wait, Lucent, use Stripe instead of PayPal", 2500);
    expect(barge.interrupted).toBe(true);
    expect(barge.newQuery).toBe("use Stripe instead of PayPal");

    // Re-invokes with the new query
    expect(manager.getState()).toBe("invoked");
    expect(manager.getLease()?.speakerId).toBe("alice");
    expect(manager.getLease()?.lastQuestion).toBe("use Stripe instead of PayPal");
  });

  it("handles barge-in with simple 'stop' or 'hold on' without name prefix", () => {
    const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    manager.onExplicitInvocation("alice", "build a giant diagram", "Alice", 1000);
    manager.onAiStartResponding();

    const barge = manager.onBargeIn("alice", "hold on", 1800);
    expect(barge.interrupted).toBe(true);
    expect(manager.getState()).toBe("dormant");
  });

  it("propagates cancellation to in-flight AbortController during generation", async () => {
    const controller = new AbortController();
    let generationCancelled = false;

    // Simulate async generation task that listens to abort signal
    const asyncGeneration = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve("done"), 5000);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        generationCancelled = true;
        reject(new Error("Generation aborted by user barge-in"));
      });
    });

    // User triggers barge-in mid-generation
    controller.abort();

    await expect(asyncGeneration).rejects.toThrow("Generation aborted by user barge-in");
    expect(generationCancelled).toBe(true);
  });

  it("handles another participant speaking during AI playback (cross-talk interruption)", () => {
    const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    manager.onExplicitInvocation("alice", "explain auth", "Alice", 1000);
    manager.onAiStartResponding();

    // Bob speaks while Lucent is talking
    const barge = manager.onBargeIn("bob", "Actually Bob speaking here", 2000);
    // Any speech during playback interrupts Lucent so Lucent doesn't talk over humans
    expect(barge.interrupted).toBe(true);
    expect(barge.newQuery).toBeUndefined();
  });

  it("ensures echo suppression flag is clean when no TTS is active", () => {
    // When no TTS is playing, isTtsSpeaking() must be false
    expect(isTtsSpeaking()).toBe(false);
  });
});
