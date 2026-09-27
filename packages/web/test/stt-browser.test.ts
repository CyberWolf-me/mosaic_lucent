import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserSttProvider,
  isTransientSpeechError,
  MAX_RESTARTS_IN_WINDOW,
} from "../src/stt/browser.js";
import type { SpeechEvent, VoiceEventHandlers } from "../src/stt/events.js";

/**
 * The browser recognizer the way Chrome actually behaves in a long capture
 * (found in use: "it only gets about four words, then resets"): it raises
 * `no-speech` on a pause, ends itself and must be started again, and can end
 * mid-phrase without ever finalizing what it heard. None of that may end the
 * person's session or lose their words; a blocked mic or a restart storm may.
 */

interface FakeRecognition {
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  started: boolean;
}

let instances: FakeRecognition[] = [];

function stubChrome() {
  instances = [];
  vi.stubGlobal("window", {
    SpeechRecognition: class {
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      lang = "";
      interimResults = false;
      continuous = false;
      started = false;
      constructor() {
        instances.push(this);
      }
      start() {
        this.started = true;
      }
      stop() {
        this.started = false;
      }
    },
  });
  // No getUserMedia: the provider starts the recognizer straight away.
  vi.stubGlobal("navigator", {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function collector() {
  const events: SpeechEvent[] = [];
  const errors: string[] = [];
  const handlers: VoiceEventHandlers = {
    onEvent: (e) => events.push(e),
    onError: (m) => errors.push(m),
  };
  return {
    handlers,
    errors,
    finals: () => events.flatMap((e) => (e.type === "final" ? [(e as { text: string }).text] : [])),
  };
}

const latest = () => instances[instances.length - 1]!;

function hear(text: string, final: boolean) {
  latest().onresult!({
    resultIndex: 0,
    results: { length: 1, 0: { 0: { transcript: text }, isFinal: final, length: 1 } },
  });
}

describe("the browser recognizer in a long capture", () => {
  it("keeps going through a pause: no-speech and aborted are not errors", () => {
    stubChrome();
    const c = collector();
    browserSttProvider.startWithEvents!(c.handlers);
    latest().onerror!({ error: "no-speech" });
    latest().onend!();
    expect(instances).toHaveLength(2);
    expect(latest().started).toBe(true);
    latest().onerror!({ error: "aborted" });
    latest().onend!();
    expect(c.errors).toEqual([]);
    expect(isTransientSpeechError("no-speech")).toBe(true);
    expect(isTransientSpeechError("not-allowed")).toBe(false);
  });

  it("keeps words the recognizer never finalized when it ends mid-phrase", () => {
    stubChrome();
    const c = collector();
    browserSttProvider.startWithEvents!(c.handlers);
    hear("we should ship the", false);
    hear("we should ship the pricing change", false);
    // Chrome ends the session (its own restart) without a final.
    latest().onend!();
    expect(c.finals()).toEqual(["we should ship the pricing change"]);
    // The next session carries on; its finals arrive once each.
    hear("on Friday", true);
    expect(c.finals()).toEqual(["we should ship the pricing change", "on Friday"]);
  });

  it("keeps what was heard when the person stops mid-sentence", () => {
    stubChrome();
    const c = collector();
    const session = browserSttProvider.startWithEvents!(c.handlers);
    hear("add a cache in front of", false);
    session!.stop();
    expect(c.finals()).toEqual(["add a cache in front of"]);
  });

  it("stops and says so when the mic is blocked, instead of restarting", () => {
    stubChrome();
    const c = collector();
    browserSttProvider.startWithEvents!(c.handlers);
    latest().onerror!({ error: "not-allowed" });
    latest().onend!();
    expect(instances).toHaveLength(1);
    expect(c.errors[0]).toMatch(/Microphone access is blocked/);
  });

  it("gives up on a restart storm, and says what to try", () => {
    stubChrome();
    const c = collector();
    browserSttProvider.startWithEvents!(c.handlers);
    for (let i = 0; i <= MAX_RESTARTS_IN_WINDOW; i++) latest().onend!();
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toMatch(/keeps stopping/);
    const count = instances.length;
    latest().onend?.();
    expect(instances).toHaveLength(count);
  });

  it("reports the network only when it stays down", () => {
    stubChrome();
    const c = collector();
    browserSttProvider.startWithEvents!(c.handlers);
    latest().onerror!({ error: "network" });
    latest().onend!();
    latest().onerror!({ error: "network" });
    expect(c.errors).toEqual([]);
    latest().onerror!({ error: "network" });
    expect(c.errors[0]).toMatch(/network/);
  });
});
