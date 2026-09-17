import { describe, it, expect, beforeEach, vi } from "vitest";
import { configureLiveKit } from "../src/stt/livekit.js";
import { getSttProvider, isAnyVoiceSupported, sttProviderStatus } from "../src/stt/index.js";

/**
 * The provider registry gained a third member (LiveKit), then a fourth
 * (hosted diarizing STT, docs/25 V1). The old fallback was a binary flip
 * between browser and whisper, which with more providers could land on
 * another unsupported one.
 */
describe("stt registry", () => {
  beforeEach(() => {
    configureLiveKit({ url: "", tokenUrl: "", room: "" });
  });

  it("lists all four providers with a supported flag", () => {
    const ids = sttProviderStatus().map((p) => p.id);
    expect(ids).toEqual(["browser", "whisper", "livekit", "hosted"]);
  });

  it("reports LiveKit unavailable, with a reason, until it is configured", () => {
    const before = sttProviderStatus().find((p) => p.id === "livekit")!;
    expect(before.supported).toBe(false);
    expect(before.reason).toBeTruthy();
  });

  it("never silently returns an unconfigured LiveKit provider", () => {
    // Asking for livekit while unconfigured must fall through to something else
    // (or back to livekit only if nothing at all is supported).
    const chosen = getSttProvider("livekit");
    if (chosen.id === "livekit") {
      expect(isAnyVoiceSupported()).toBe(false);
    } else {
      expect(chosen.isSupported()).toBe(true);
    }
  });

  it("refuses to start LiveKit without configuration and explains why", () => {
    const onError = vi.fn();
    const provider = sttProviderStatus().find((p) => p.id === "livekit")!;
    expect(provider.supported).toBe(false);
    // start() surfaces the same reason through onError rather than throwing.
    const livekit = getSttProvider("livekit");
    if (livekit.id === "livekit") {
      const session = livekit.start({ onFinal: () => {}, onError });
      expect(session).toBeNull();
      expect(onError).toHaveBeenCalled();
    }
  });

  it("treats a url without a token endpoint as still unconfigured", () => {
    // Pretend a mic exists so the config check is what decides. Without this the
    // node test env fails the mic probe first, which is also correct behaviour.
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
      configurable: true,
    });
    try {
      configureLiveKit({ url: "wss://example.livekit.cloud", tokenUrl: "", room: "r" });
      const status = sttProviderStatus().find((p) => p.id === "livekit")!;
      expect(status.supported).toBe(false);
      expect(status.reason).toMatch(/token/i);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  it("reports a missing server URL before a missing token endpoint", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
      configurable: true,
    });
    try {
      configureLiveKit({ url: "", tokenUrl: "/api/livekit/token", room: "r" });
      const status = sttProviderStatus().find((p) => p.id === "livekit")!;
      expect(status.reason).toMatch(/server URL/i);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });
});
