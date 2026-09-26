import { describe, expect, it } from "vitest";
import { describeMediaError, enableLocalMedia } from "../src/meeting-room/mediaErrors.js";

/**
 * docs/28 F18: a blocked mic or a busy camera used to go only to the console
 * while both controls said "on". The words come from the DOMException NAME
 * (the message varies by browser), and each device is enabled on its own.
 */
const named = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("describeMediaError", () => {
  it("names what to do for each failure", () => {
    expect(describeMediaError("microphone", named("NotAllowedError"))).toBe(
      "Microphone blocked. Allow it for this site in the address bar, then turn it on again.",
    );
    expect(describeMediaError("camera", named("NotFoundError"))).toBe(
      "No camera found. Check that one is connected and enabled.",
    );
    expect(describeMediaError("camera", named("NotReadableError"))).toBe(
      "Another app is using your camera. Close it, then try again.",
    );
    expect(describeMediaError("microphone", named("WeirdError", "device lost"))).toBe(
      "Couldn't turn on your microphone: device lost.",
    );
  });

  it("says nothing when the person cancelled the screen picker", () => {
    expect(describeMediaError("screen", named("NotAllowedError"))).toBeNull();
    expect(describeMediaError("screen", named("NotReadableError"))).toBe(
      "Another app is using screen sharing. Close it, then try again.",
    );
  });

  it("reads a plain DOMException-shaped object, not only Error", () => {
    expect(describeMediaError("microphone", { name: "SecurityError" })).toContain("blocked");
    expect(describeMediaError("camera", "string failure")).toBe("Couldn't turn on your camera.");
  });
});

describe("enableLocalMedia", () => {
  const participant = (fail: { mic?: unknown; cam?: unknown }) => {
    const calls: string[] = [];
    return {
      calls,
      local: {
        async setMicrophoneEnabled(on: boolean) {
          calls.push(`mic:${on}`);
          if (fail.mic) throw fail.mic;
        },
        async setCameraEnabled(on: boolean) {
          calls.push(`cam:${on}`);
          if (fail.cam) throw fail.cam;
        },
      },
    };
  };

  it("a blocked mic no longer skips the camera, and neither control lies", async () => {
    const p = participant({ mic: named("NotAllowedError") });
    const r = await enableLocalMedia(p.local, { mic: true, cam: true });
    expect(p.calls).toEqual(["mic:true", "cam:true"]);
    expect(r).toEqual({
      mic: false,
      cam: true,
      notice:
        "Microphone blocked. Allow it for this site in the address bar, then turn it on again. Others can't hear you until it's on.",
    });
  });

  it("reports both failures together", async () => {
    const p = participant({ mic: named("NotFoundError"), cam: named("NotReadableError") });
    const r = await enableLocalMedia(p.local, { mic: true, cam: true });
    expect(r.mic).toBe(false);
    expect(r.cam).toBe(false);
    expect(r.notice).toContain("No microphone found.");
    expect(r.notice).toContain("Another app is using your camera.");
  });

  it("turns on only what was asked for, and is quiet when all is well", async () => {
    const p = participant({});
    expect(await enableLocalMedia(p.local, { mic: true, cam: false })).toEqual({
      mic: true,
      cam: false,
      notice: null,
    });
    expect(p.calls).toEqual(["mic:true"]);
  });
});
