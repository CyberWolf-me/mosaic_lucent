import { describe, expect, it } from "vitest";
import { roomPeers } from "../src/meeting-room/roomPeers.js";
import {
  EXTERNAL_MEETING_CAPABILITIES,
  MOCK_MEETING_CAPABILITIES,
  NATIVE_MEETING_CAPABILITIES,
  capabilitiesFor,
} from "../src/meeting-capabilities.js";

describe("roomPeers", () => {
  it("tracks joins, tracks, speakers, and leaves", () => {
    let peers = roomPeers(new Map(), { type: "peer-joined", identity: "alice", name: "Alice" });
    peers = roomPeers(peers, { type: "peer-joined", identity: "bob", name: "Bob" });
    expect(peers.size).toBe(2);
    peers = roomPeers(peers, { type: "track", identity: "alice", kind: "audio", on: true });
    peers = roomPeers(peers, { type: "track", identity: "alice", kind: "video", on: true });
    expect(peers.get("alice")).toMatchObject({ micOn: true, camOn: true, speaking: false });
    peers = roomPeers(peers, { type: "speakers", identities: ["bob"] });
    expect(peers.get("alice")!.speaking).toBe(false);
    expect(peers.get("bob")!.speaking).toBe(true);
    peers = roomPeers(peers, { type: "track", identity: "alice", kind: "video", on: false });
    expect(peers.get("alice")!.camOn).toBe(false);
    peers = roomPeers(peers, { type: "peer-left", identity: "bob" });
    expect(peers.has("bob")).toBe(false);
    peers = roomPeers(peers, { type: "reset" });
    expect(peers.size).toBe(0);
  });

  it("creates shell entries for tracks arriving before join events", () => {
    const peers = roomPeers(new Map(), {
      type: "track",
      identity: "ghost",
      kind: "screen",
      on: true,
    });
    expect(peers.get("ghost")).toMatchObject({ screenOn: true, name: "ghost" });
  });
});

describe("meeting capabilities", () => {
  it("native owns media; external is turns-only; mock is least", () => {
    expect(NATIVE_MEETING_CAPABILITIES).toMatchObject({
      audio: true,
      video: true,
      screenShare: true,
      speakerIdentity: true,
    });
    expect(EXTERNAL_MEETING_CAPABILITIES).toMatchObject({
      audio: false,
      video: false,
      screenShare: false,
      transcript: true,
    });
    expect(MOCK_MEETING_CAPABILITIES.participants).toBe(false);
    expect(capabilitiesFor("native")).toBe(NATIVE_MEETING_CAPABILITIES);
    expect(capabilitiesFor("zoom")).toBe(EXTERNAL_MEETING_CAPABILITIES);
    expect(capabilitiesFor("meet")).toBe(EXTERNAL_MEETING_CAPABILITIES);
    expect(capabilitiesFor("teams")).toBe(EXTERNAL_MEETING_CAPABILITIES);
    expect(capabilitiesFor("mock")).toBe(MOCK_MEETING_CAPABILITIES);
    expect(capabilitiesFor("something-new")).toBe(MOCK_MEETING_CAPABILITIES);
  });
});
