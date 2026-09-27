import { describe, expect, it } from "vitest";
import {
  appendChat,
  captureFrom,
  captureSince,
  createLineGate,
  decodeChat,
  decodeLine,
  encodeLine,
  MAX_LINE_CHARS,
  optedOutFrom,
  transcriberOf,
  decodeReaction,
  describeDisconnect,
  describeJoinFailure,
  encodeChat,
  encodeReaction,
  formatElapsed,
  gridColumns,
  handFrom,
  initials,
  MAX_CHAT_CHARS,
  MAX_CHAT_MESSAGES,
  peopleSentence,
  readCallMeta,
  rejoinMarker,
  rejoinOffer,
  REJOIN_TTL_MS,
  sortRoster,
  type ChatMessage,
} from "../src/meeting-room/callProtocol.js";
import { previewCopy, previewStateOf } from "../src/meeting-room/devices.js";
import { roomPeers } from "../src/meeting-room/roomPeers.js";

/** docs/28 A3.2: the call's rules, without a room, a camera or a browser. */

describe("host metadata and attributes", () => {
  it("reads the server's room metadata and nothing else", () => {
    const raw = JSON.stringify({
      v: 1,
      hosts: ["usr_a"],
      removed: [],
      startedBy: "usr_a",
      startedAt: 9,
    });
    expect(readCallMeta(raw)).toEqual({
      hosts: ["usr_a"],
      removed: [],
      startedBy: "usr_a",
      startedAt: 9,
    });
    expect(readCallMeta("")).toBeNull();
    expect(readCallMeta("not json")).toBeNull();
    expect(readCallMeta(JSON.stringify({ hosts: ["usr_a"] }))).toBeNull();
  });

  it("reads a raised hand and the transcribing mark", () => {
    expect(handFrom({ "lucent.hand": "1700000000000" })).toBe(1_700_000_000_000);
    expect(handFrom({ "lucent.hand": "" })).toBeNull();
    expect(handFrom({ "lucent.hand": "soon" })).toBeNull();
    expect(handFrom(undefined)).toBeNull();
    expect(captureFrom({ "lucent.capture": "on" })).toBe(true);
    expect(captureFrom({})).toBe(false);
  });
});

describe("chat and reactions on the data channel", () => {
  it("round-trips a message, trimmed, and refuses empty or over-long ones", () => {
    const bytes = encodeChat("  hello there  ", "m1", 5)!;
    expect(decodeChat(bytes)).toEqual({ id: "m1", text: "hello there", at: 5 });
    expect(encodeChat("   ", "m2", 5)).toBeNull();
    expect(encodeChat("x".repeat(MAX_CHAT_CHARS + 1), "m3", 5)).toBeNull();
    expect(decodeChat(new TextEncoder().encode("{oops"))).toBeNull();
    expect(
      decodeChat(new TextEncoder().encode(JSON.stringify({ v: 1, text: "   ", id: "x" }))),
    ).toBeNull();
  });

  it("clips an over-long message someone else's client sent", () => {
    const raw = new TextEncoder().encode(
      JSON.stringify({ v: 1, id: "m", text: "y".repeat(MAX_CHAT_CHARS + 50), at: 1 }),
    );
    expect(decodeChat(raw)!.text).toHaveLength(MAX_CHAT_CHARS);
  });

  it("only offered reactions decode, so nothing else can be painted over a tile", () => {
    expect(decodeReaction(encodeReaction("🎉"))).toBe("🎉");
    const bogus = new TextEncoder().encode(JSON.stringify({ v: 1, emoji: "BUY NOW" }));
    expect(decodeReaction(bogus)).toBeNull();
  });

  it("keeps each message once and bounds the history", () => {
    const m = (id: string, from = "usr_a"): ChatMessage => ({
      id,
      from,
      name: "A",
      text: id,
      at: 1,
    });
    let list = appendChat([], m("1"));
    list = appendChat(list, m("1"));
    list = appendChat(list, m("1", "usr_b"));
    expect(list.map((x) => `${x.from}:${x.id}`)).toEqual(["usr_a:1", "usr_b:1"]);
    for (let i = 0; i < MAX_CHAT_MESSAGES + 5; i++) list = appendChat(list, m(`n${i}`));
    expect(list).toHaveLength(MAX_CHAT_MESSAGES);
    expect(list.at(-1)!.id).toBe(`n${MAX_CHAT_MESSAGES + 4}`);
  });
});

describe("one transcript per call, everyone in it (docs/28 A3.5)", () => {
  it("files lines with the device that started transcribing first", () => {
    expect(transcriberOf([])).toBeNull();
    expect(
      transcriberOf([
        { identity: "b", captureAt: 20 },
        { identity: "a", captureAt: null },
        { identity: "c", captureAt: 10 },
      ]),
    ).toBe("c");
    // A tie can't split the call in two: every device picks the same one.
    expect(
      transcriberOf([
        { identity: "z", captureAt: 5 },
        { identity: "y", captureAt: 5 },
      ]),
    ).toBe("y");
    expect(captureSince({ "lucent.capture": "on" })).toBe(1);
    expect(captureSince({ "lucent.capture": "123" })).toBe(123);
    expect(captureSince({})).toBeNull();
    expect(optedOutFrom({ "lucent.optout": "1" })).toBe(true);
    expect(optedOutFrom({})).toBe(false);
  });

  it("carries only the words — who said it is the sender LiveKit names", () => {
    const bytes = encodeLine("  We ship Friday. ", 7)!;
    expect(decodeLine(bytes)).toEqual({ text: "We ship Friday.", at: 7 });
    expect(encodeLine("   ", 1)).toBeNull();
    expect(encodeLine("x".repeat(MAX_LINE_CHARS + 1), 1)).toBeNull();
    const spoofed = new TextEncoder().encode(
      JSON.stringify({ v: 1, text: "hi", at: 1, speaker: "The CEO" }),
    );
    expect(decodeLine(spoofed)).toEqual({ text: "hi", at: 1 });
    expect(decodeLine(new TextEncoder().encode("nope"))).toBeNull();
  });

  it("drops a flood from one device and lets everyone else through", () => {
    const gate = createLineGate(3, 1000);
    expect([0, 1, 2, 3].map((t) => gate("a", t))).toEqual([true, true, true, false]);
    expect(gate("b", 3)).toBe(true);
    expect(gate("a", 1001)).toBe(true);
  });
});

describe("why a call ended, and why a join failed (docs/28 §4.2, S4)", () => {
  it("names each disconnect reason in words, and leaving is not an event", () => {
    expect(describeDisconnect("CLIENT_INITIATED")).toEqual({ kind: "left" });
    expect(describeDisconnect("ROOM_DELETED")).toMatchObject({
      kind: "ended",
      text: "The host ended the meeting for everyone.",
    });
    expect(describeDisconnect("PARTICIPANT_REMOVED")).toMatchObject({ kind: "removed" });
    expect(describeDisconnect("DUPLICATE_IDENTITY")).toMatchObject({ kind: "replaced" });
    expect(describeDisconnect("SIGNAL_CLOSE")).toMatchObject({
      kind: "lost",
      text: "Lost the connection to the call.",
    });
    expect(describeDisconnect(undefined)).toMatchObject({ kind: "lost" });
  });

  it("turns the token route's answers into the lobby's copy", () => {
    expect(describeJoinFailure(503)).toBe(
      "Video calls aren't set up on this server. You can still transcribe on this device.",
    );
    expect(describeJoinFailure(403, { removed: true })).toBe(
      "The host removed you from this call.",
    );
    expect(describeJoinFailure(404)).toBe("You don't have access to this meeting's call.");
    expect(describeJoinFailure(null)).toMatch(/Check your connection/);
    expect(describeJoinFailure(500)).toMatch(/error 500/);
  });
});

describe("rejoin after a reload (S6)", () => {
  it("offers the call back within the window, and not after", () => {
    const marker = rejoinMarker("brd_1", 1_000);
    expect(rejoinOffer(marker, 1_000 + 60_000)).toEqual({ boardId: "brd_1" });
    expect(rejoinOffer(marker, 1_000 + REJOIN_TTL_MS + 1)).toBeNull();
    expect(rejoinOffer(null, 1_000)).toBeNull();
    expect(rejoinOffer("{broken", 1_000)).toBeNull();
    expect(rejoinOffer(JSON.stringify({ boardId: 3, at: 1 }), 2)).toBeNull();
  });
});

describe("the roster and the stage", () => {
  it("lists raised hands first in the order they went up, then you, then hosts, then by name", () => {
    const e = (
      name: string,
      extra: Partial<{ isLocal: boolean; host: boolean; handAt: number }> = {},
    ) => ({
      identity: name,
      name,
      isLocal: extra.isLocal ?? false,
      host: extra.host ?? false,
      handAt: extra.handAt ?? null,
    });
    const sorted = sortRoster([
      e("Zed"),
      e("Amy"),
      e("You", { isLocal: true }),
      e("Hal", { host: true }),
      e("Kim", { handAt: 20 }),
      e("Bo", { handAt: 10 }),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(["Bo", "Kim", "You", "Hal", "Amy", "Zed"]);
  });

  it("steps the grid like Meet, and says who's here", () => {
    expect([1, 2, 4, 5, 9, 10, 17].map(gridColumns)).toEqual([1, 2, 2, 3, 3, 4, 5]);
    expect(peopleSentence([])).toBe("No one else is here yet.");
    expect(peopleSentence(["Ada"])).toBe("Ada is in this call.");
    expect(peopleSentence(["Ada", "Bo"])).toBe("Ada and Bo are in this call.");
    expect(peopleSentence(["Ada", "Bo", "Cy"])).toBe("Ada, Bo and 1 other are in this call.");
    expect(peopleSentence(["Ada", "Bo", "Cy", "Di"])).toBe(
      "Ada, Bo and 2 others are in this call.",
    );
  });

  it("formats the call clock and initials", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("bo")).toBe("BO");
    expect(initials("  ")).toBe("?");
  });

  it("keeps hands, the transcribing mark and link quality per person", () => {
    let peers = roomPeers(new Map(), { type: "peer-joined", identity: "a", name: "Ada" });
    peers = roomPeers(peers, {
      type: "attributes",
      identity: "a",
      attributes: { "lucent.hand": "5", "lucent.capture": "9", "lucent.optout": "1" },
    });
    peers = roomPeers(peers, { type: "quality", identity: "a", quality: "poor" });
    expect(peers.get("a")).toMatchObject({
      handAt: 5,
      capture: true,
      captureAt: 9,
      optedOut: true,
      quality: "poor",
    });
    // Quality for someone who already left doesn't bring them back.
    peers = roomPeers(peers, { type: "quality", identity: "ghost", quality: "lost" });
    expect(peers.has("ghost")).toBe(false);
  });
});

describe("the lobby's device states (S4)", () => {
  it("reads getUserMedia failures by their stable names", () => {
    const err = (name: string) => Object.assign(new Error("x"), { name });
    expect(previewStateOf(err("NotAllowedError"))).toBe("denied");
    expect(previewStateOf(err("NotFoundError"))).toBe("missing");
    expect(previewStateOf(err("OverconstrainedError"))).toBe("missing");
    expect(previewStateOf(err("NotReadableError"))).toBe("busy");
    expect(previewStateOf(err("TypeError"))).toBe("failed");
    expect(previewCopy("microphone", "denied")).toBe(
      "Microphone blocked. Allow it for this site in the address bar, then Retry.",
    );
    expect(previewCopy("camera", "busy")).toBe("Another app is using your camera.");
    expect(previewCopy("camera", "ready")).toBeNull();
  });
});
