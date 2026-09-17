import { describe, it, expect, vi, afterEach } from "vitest";
import { eventConsumerFromCallbacks, type SpeechEvent } from "../src/stt/events.js";
import { browserSttProvider } from "../src/stt/browser.js";
import { whisperSttProvider } from "../src/stt/whisper.js";
import { hostedSttProvider } from "../src/stt/hosted.js";
import { livekitSttProvider, configureLiveKit } from "../src/stt/livekit.js";
import type { VoiceEventHandlers } from "../src/stt/events.js";

vi.mock("livekit-client", () => {
  const store = ((globalThis as Record<string, unknown>).__lkStore ??= {}) as Record<
    string,
    (...args: never[]) => void
  >;
  class FakeRoom {
    on = (event: string, cb: (...args: never[]) => void) => {
      store[event] = cb;
    };
    connect = async () => {};
    disconnect = async () => {};
    localParticipant = { setMicrophoneEnabled: async () => {} };
  }
  return {
    Room: FakeRoom,
    RoomEvent: { TranscriptionReceived: "transcriptionReceived", Disconnected: "disconnected" },
  };
});

function lkHandlers(): Record<string, (segments: unknown) => void> {
  return (globalThis as Record<string, unknown>).__lkStore as Record<
    string,
    (segments: unknown) => void
  >;
}

/**
 * Step 1 (voice advisory): the SpeechEvent stream is the seam's primitive.
 *
 * The load-bearing properties, each pinned here: one bridge derives
 * callbacks (final→onFinal, interim→onInterim, lifecycle silent — interim
 * can never become a turn structurally); identity fields stay distinct
 * (speakerId vs participantId, display precedence documented, never an
 * identity claim); every provider emits started/final(s)/stopped in order.
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
  recorders.length = 0;
  configureLiveKit({ url: "", tokenUrl: "", room: "" });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function collector() {
  const events: SpeechEvent[] = [];
  const errors: string[] = [];
  const statuses: string[] = [];
  let started = false;
  const handlers: VoiceEventHandlers = {
    onEvent: (e) => {
      events.push(e);
    },
    onStart: () => {
      started = true;
    },
    onError: (m) => {
      errors.push(m);
    },
    onStatus: (s) => {
      statuses.push(s);
    },
  };
  return {
    events,
    errors,
    statuses,
    handlers,
    isStarted: () => started,
    finals: () => events.filter((e) => e.type === "final"),
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const recorders: Array<{
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  stop: () => void;
}> = [];

class FakeRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: unknown) {
    recorders.push(this);
  }
  start() {}
  stop() {
    this.onstop?.();
  }
}

function stubMic() {
  const tracks = [{ stop: vi.fn() }];
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })) },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return tracks;
}

describe("eventConsumerFromCallbacks (the one bridge)", () => {
  it("routes final→onFinal with display precedence, interim→onInterim, lifecycle silent", () => {
    const finals: Array<{ text: string; speaker: string | undefined }> = [];
    const interims: string[] = [];
    const ev = eventConsumerFromCallbacks({
      onFinal: (text, meta) => {
        finals.push({ text, speaker: meta?.speaker });
      },
      onInterim: (t) => {
        interims.push(t);
      },
    });
    ev.onEvent({
      type: "final",
      text: "a",
      at: 1,
      participantId: "alice",
      speakerId: "spk_2",
      source: "hosted",
    });
    ev.onEvent({ type: "final", text: "b", at: 2, participantId: "bob", source: "livekit" });
    ev.onEvent({ type: "final", text: "c", at: 3, source: "browser" });
    ev.onEvent({ type: "interim", text: "partial", at: 4, source: "browser" });
    ev.onEvent({ type: "speech_started", at: 0 });
    ev.onEvent({ type: "speech_stopped", at: 5 });
    // Display precedence only: raw label over stream identity over absent —
    // and interim/lifecycle can never surface as finals.
    expect(finals).toEqual([
      { text: "a", speaker: "spk_2" },
      { text: "b", speaker: "bob" },
      { text: "c", speaker: undefined },
    ]);
    expect(interims).toEqual(["partial"]);
  });
});

describe("browser provider events", () => {
  interface FakeRecognition {
    onresult: ((event: unknown) => void) | null;
    start: () => void;
    stop: () => void;
  }
  let recognition: FakeRecognition | null = null;

  function stubRecognition() {
    recognition = {
      onresult: null,
      start: vi.fn(),
      stop: vi.fn(),
    };
    const instance = recognition;
    vi.stubGlobal("window", {
      SpeechRecognition: class {
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        lang = "";
        interimResults = false;
        continuous = false;
        start() {
          instance.onresult = this.onresult;
          (instance.start as ReturnType<typeof vi.fn>)();
        }
        stop() {
          (instance.stop as ReturnType<typeof vi.fn>)();
        }
      },
    });
  }

  it("emits started, per-utterance finals, interims, then stopped", async () => {
    stubRecognition();
    const c = collector();
    const session = browserSttProvider.startWithEvents!(c.handlers);
    expect(session).not.toBeNull();
    await flush();
    expect(c.isStarted()).toBe(true);
    expect(c.events[0]).toMatchObject({ type: "speech_started" });

    recognition!.onresult!({
      resultIndex: 0,
      results: {
        length: 2,
        0: { 0: { transcript: "hello" }, isFinal: true, length: 1 },
        1: { 0: { transcript: " wor" }, isFinal: false, length: 1 },
      },
    });
    const finals = c.finals();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ type: "final", text: "hello", source: "browser" });
    expect(finals[0]).not.toHaveProperty("speakerId");
    expect(
      c.events.filter((e) => e.type === "interim").map((e) => (e as { text: string }).text),
    ).toEqual([" wor"]);

    session!.stop();
    expect(c.events[c.events.length - 1]).toMatchObject({ type: "speech_stopped" });
  });
});

describe("whisper provider events", () => {
  it("emits started then stopped with no final when nothing was recorded", async () => {
    stubMic();
    const c = collector();
    const session = whisperSttProvider.startWithEvents!(c.handlers);
    expect(session).not.toBeNull();
    await flush();
    expect(c.isStarted()).toBe(true);
    expect(c.events[0]).toMatchObject({ type: "speech_started" });
    session!.stop();
    await flush();
    // No chunks: the transformers import is never touched, no final, no error.
    expect(c.finals()).toEqual([]);
    expect(c.errors).toEqual([]);
    expect(c.events[c.events.length - 1]).toMatchObject({ type: "speech_stopped" });
  });
});

describe("hosted provider events", () => {
  function stubRoutes() {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/stt/sessions")
          return Promise.resolve(jsonResponse(200, { sessionId: "stt_1" }));
        if (url === "/api/stt/sessions/stt_1/audio")
          return Promise.resolve(
            jsonResponse(200, {
              finals: [
                {
                  text: "mixed mic turn",
                  speaker: "spk_02",
                  start: 0.5,
                  end: 1.2,
                  confidence: 0.9,
                },
              ],
            }),
          );
        if (url === "/api/stt/sessions/stt_1/close")
          return Promise.resolve(jsonResponse(200, { finals: [], audioSeconds: 4, minutes: 0 }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("emits started, timing-bearing finals, and stopped last after the flush", async () => {
    stubMic();
    stubRoutes();
    const c = collector();
    const session = hostedSttProvider.startWithEvents!(c.handlers);
    expect(session).not.toBeNull();
    await flush();
    expect(c.events[0]).toMatchObject({ type: "speech_started" });

    recorders[0]!.ondataavailable!({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    await flush();
    const finals = c.finals();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      type: "final",
      text: "mixed mic turn",
      speakerId: "spk_02",
      startMs: 500,
      endMs: 1200,
      confidence: 0.9,
      source: "hosted",
    });
    expect(finals[0]).not.toHaveProperty("participantId");

    session!.stop();
    await flush();
    // Boundary flush first, stopped last — the last turn is never losable.
    expect(c.events[c.events.length - 1]).toMatchObject({ type: "speech_stopped" });
    expect(c.errors).toEqual([]);
  });
});

describe("livekit provider events", () => {
  function stubLiveKit() {
    stubMic();
    configureLiveKit({ url: "wss://x", tokenUrl: "/api/livekit/token", room: "r" });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/livekit/token")
          return Promise.resolve(jsonResponse(200, { token: "tok", url: "wss://x" }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("attributes interim and joined finals by participant identity, emitting the final at stop", async () => {
    stubLiveKit();
    const c = collector();
    const session = livekitSttProvider.startWithEvents!(c.handlers);
    expect(session).not.toBeNull();
    await flush();
    expect(c.isStarted()).toBe(true);

    const onTx = lkHandlers()["transcriptionReceived"]!;
    onTx([{ text: "half a", final: false, participant: { identity: "usr_alice", name: "Alice" } }]);
    onTx([{ text: "a full thought", final: true, participant: "usr_alice" }]);
    // Finals accumulate while running — no final event yet (turn cadence
    // preserved: per-utterance finals would change billed extraction calls).
    expect(c.finals()).toEqual([]);
    const interims = c.events.filter((e) => e.type === "interim");
    expect(interims).toHaveLength(2);
    expect(interims[0]).toMatchObject({
      text: "half a",
      participantId: "Alice",
      source: "livekit",
    });

    session!.stop();
    const finals = c.finals();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({
      text: "a full thought",
      participantId: "usr_alice",
      source: "livekit",
    });
    expect(finals[0]).not.toHaveProperty("speakerId");
    expect(c.events[c.events.length - 1]).toMatchObject({ type: "speech_stopped" });
  });
});
