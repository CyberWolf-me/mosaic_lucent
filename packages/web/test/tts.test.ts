import { describe, it, expect, vi, afterEach } from "vitest";
import { browserTtsProvider, hostedTtsProvider, speakAnswer } from "../src/tts.js";

/**
 * docs/25 V7 (M6.2): the TTS seam.
 *
 * The properties: the browser engine speaks locally with nothing to bill;
 * the hosted engine POSTs text and plays returned audio; `speakAnswer`
 * falls back hosted → browser → honest reason, and a 503 (unconfigured
 * server) is the expected fallback trigger while any other refusal is
 * surfaced, never silently retried elsewhere.
 */

const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
  configurable: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  spoken.length = 0;
  played.length = 0;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Spoken {
  text: string;
  done: () => void;
  fail: () => void;
}
const spoken: Spoken[] = [];

function stubSpeechSynthesis() {
  vi.stubGlobal("window", {
    speechSynthesis: {
      speak: (u: { text: string; onend: (() => void) | null; onerror: (() => void) | null }) => {
        spoken.push({
          text: u.text,
          done: () => u.onend?.(),
          fail: () => u.onerror?.(),
        });
      },
      cancel: vi.fn(),
    },
    SpeechSynthesisUtterance: class {
      text: string;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  });
}

interface Played {
  url: string;
  paused: boolean;
  finish: () => void;
}
const played: Played[] = [];

function stubAudio() {
  vi.stubGlobal("window", {
    ...(globalThis.window as object | undefined),
    Audio: class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private onPause: () => void = () => {};
      constructor(readonly src: string) {
        const entry: Played = {
          url: src,
          paused: false,
          finish: () => {
            this.onended?.();
          },
        };
        played.push(entry);
        // No `this` alias: the pause hook closes over the entry, and the
        // arrow above reads the instance — both legal, neither aliased.
        this.onPause = () => {
          entry.paused = true;
        };
      }
      async play() {}
      pause() {
        this.onPause();
      }
    },
  });
  vi.stubGlobal("URL", {
    createObjectURL: (b: Blob) => `blob:${(b as Blob).size}`,
    revokeObjectURL: () => {},
  });
}

describe("browser TTS provider", () => {
  it("speaks locally and stop cancels", async () => {
    stubSpeechSynthesis();
    expect(browserTtsProvider.isSupported()).toBe(true);
    const playback = await browserTtsProvider.speak("hello there");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.text).toBe("hello there");
    playback.stop();
    await playback.done;
  });

  it("refuses empty text and reports an unsupporting browser", async () => {
    stubSpeechSynthesis();
    await expect(browserTtsProvider.speak("   ")).rejects.toThrow("nothing to speak");
    vi.unstubAllGlobals();
    expect(browserTtsProvider.isSupported()).toBe(false);
    expect(browserTtsProvider.unavailableReason()).toContain("speech synthesis");
  });
});

describe("hosted TTS provider", () => {
  it("POSTs text and plays the returned audio; stop pauses", async () => {
    stubAudio();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          }),
        );
      }),
    );
    const playback = await hostedTtsProvider.speak("hello");
    expect(calls).toEqual(["/api/tts/speak"]);
    expect(played).toHaveLength(1);
    playback.stop();
    expect(played[0]!.paused).toBe(true);
    await playback.done;
  });

  it("a 503 is the fallback signal, not a failure", async () => {
    stubAudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(503, { error: "nope" }))),
    );
    await expect(hostedTtsProvider.speak("hi")).rejects.toThrow("unconfigured");
  });
});

describe("speakAnswer", () => {
  it("prefers hosted; falls back to browser on 503", async () => {
    stubSpeechSynthesis();
    stubAudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(503, {}))),
    );
    const outcome = await speakAnswer("the answer");
    expect(outcome.provider).toBe("browser");
    expect(outcome.reason).toBeNull();
    expect(spoken.map((s) => s.text)).toEqual(["the answer"]);
    outcome.playback?.stop();
  });

  it("surfaces a non-503 refusal instead of retrying elsewhere", async () => {
    stubSpeechSynthesis();
    stubAudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(403, { error: "forbidden" }))),
    );
    const outcome = await speakAnswer("the answer");
    expect(outcome.provider).toBeNull();
    expect(outcome.reason).toBe("forbidden");
    expect(spoken).toHaveLength(0);
  });

  it("says so once when nothing can speak", async () => {
    const outcome = await speakAnswer("the answer");
    expect(outcome.provider).toBeNull();
    expect(outcome.reason).not.toBeNull();
    expect(await speakAnswer("   ").then((o) => o.reason)).toBe("nothing to speak");
  });
});
