import { describe, it, expect, vi, afterEach } from "vitest";
import { getSttProvider, hostedSttProvider, sttProviderStatus } from "../src/stt/index.js";
import type { VoiceHandlers } from "../src/stt/index.js";

/**
 * docs/25 V1: the hosted (server diarizing) STT slot, client side.
 *
 * The contract under test: mic here, transcript there — session lifecycle
 * over authed POSTs, finals with speaker labels reaching `onFinal`'s meta,
 * and every server refusal (503 unconfigured, 403 policy, dead mic)
 * surfacing as the `onError` message, never as an empty transcript.
 * (vitest runs in node here: mic, MediaRecorder, and fetch are all stubs.)
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
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function liveSessionRoutes() {
  return stubFetch((url) => {
    if (url === "/api/stt/sessions") return jsonResponse(200, { sessionId: "stt_1" });
    if (url === "/api/stt/sessions/stt_1/audio")
      return jsonResponse(200, { finals: [{ text: "hello there", speaker: "spk_01" }] });
    if (url === "/api/stt/sessions/stt_1/close")
      return jsonResponse(200, { finals: [], audioSeconds: 4, minutes: 0 });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const recorders: FakeRecorder[] = [];

class FakeRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  startedWith: number | undefined;
  stopped = false;
  constructor(readonly stream: unknown) {
    recorders.push(this);
  }
  start(ms?: number) {
    this.startedWith = ms;
  }
  stop() {
    this.stopped = true;
  }
  emit(data: Blob) {
    this.ondataavailable?.({ data });
  }
}

function stubMic() {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  return { stream, tracks };
}

function handlers(): VoiceHandlers & {
  finals: Array<{ text: string; speaker: string | undefined }>;
  errors: string[];
  statuses: string[];
  started: boolean;
} {
  const h = {
    finals: [] as Array<{ text: string; speaker: string | undefined }>,
    errors: [] as string[],
    statuses: [] as string[],
    started: false,
    onFinal: (text: string, meta?: { speaker?: string }) => {
      h.finals.push({ text, speaker: meta?.speaker });
    },
    onError: (message: string) => {
      h.errors.push(message);
    },
    onStatus: (status: "idle" | "listening" | "transcribing" | "connecting") => {
      h.statuses.push(status);
    },
    onStart: () => {
      h.started = true;
    },
  };
  return h;
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("hosted STT provider", () => {
  it("streams chunks and surfaces speaker-labelled finals, closing the session on stop", async () => {
    stubMic();
    const fetchMock = liveSessionRoutes();
    const h = handlers();
    const session = hostedSttProvider.start(h);
    expect(session).not.toBeNull();
    await flush();
    expect(h.started).toBe(true);
    expect(h.statuses).toEqual(["connecting", "listening"]);

    const recorder = recorders[0] ?? null;
    expect(recorder).not.toBeNull();
    recorder!.emit(new Blob([new Uint8Array([1, 2, 3])]));
    await flush();
    expect(h.finals).toEqual([{ text: "hello there", speaker: "spk_01" }]);

    session!.stop();
    await flush();
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain("/api/stt/sessions/stt_1/close");
    expect(h.errors).toEqual([]);
  });

  it("a 503 becomes the honest unconfigured message, not an empty transcript", async () => {
    stubMic();
    stubFetch((url) => {
      if (url === "/api/stt/sessions")
        return jsonResponse(503, { error: "server transcription is not configured" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const h = handlers();
    hostedSttProvider.start(h);
    await flush();
    expect(h.started).toBe(false);
    expect(h.finals).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toContain("isn't configured");
  });

  it("a 403 carries the server's policy reason to the user", async () => {
    stubMic();
    stubFetch((url) => {
      if (url === "/api/stt/sessions")
        return jsonResponse(403, { error: "org forbids server transcription" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const h = handlers();
    hostedSttProvider.start(h);
    await flush();
    expect(h.errors).toEqual(["org forbids server transcription"]);
  });

  it("needs a mic; without one it says so and never touches the network", async () => {
    const fetchMock = stubFetch(() => {
      throw new Error("must not fetch without a mic");
    });
    expect(hostedSttProvider.isSupported()).toBe(false);
    expect(hostedSttProvider.unavailableReason?.()).toContain("microphone");
    const h = handlers();
    expect(hostedSttProvider.start(h)).toBeNull();
    expect(h.errors).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("joins the registry, fallback order, and status surface", () => {
    stubMic();
    expect(getSttProvider("hosted").id).toBe("hosted");
    expect(sttProviderStatus().map((p) => p.id)).toContain("hosted");
  });
});
