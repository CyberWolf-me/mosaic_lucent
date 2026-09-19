/**
 * Meeting-source capabilities (native-first direction, §17).
 *
 * What each meeting source can actually do, stated once so the UI never
 * pretends an unavailable capability exists: an external import shows no
 * camera button, a mock source shows no people at all. `recording` is
 * policy-controlled rather than boolean — audio is never stored by
 * default, transcripts follow retention.
 */

export type RecordingPolicy = "policy";

export interface MeetingCapabilities {
  audio: boolean;
  video: boolean;
  screenShare: boolean;
  participants: boolean;
  transcript: boolean;
  /** True, false, or "depends" (per-vendor, per-meeting). */
  speakerIdentity: boolean | "depends";
  chat: boolean;
  recording: RecordingPolicy | "depends";
}

/** A live Lucent room: we own media, identity, and lifecycle. */
export const NATIVE_MEETING_CAPABILITIES: MeetingCapabilities = {
  audio: true,
  video: true,
  screenShare: true,
  participants: true,
  transcript: true,
  speakerIdentity: true,
  chat: false,
  recording: "policy",
};

/**
 * An imported external meeting (Zoom/Meet/Teams via the turns-only
 * connector seam): turns and participants arrive; media stays outside.
 */
export const EXTERNAL_MEETING_CAPABILITIES: MeetingCapabilities = {
  audio: false,
  video: false,
  screenShare: false,
  participants: true,
  transcript: true,
  speakerIdentity: "depends",
  chat: false,
  recording: "depends",
};

/** The offline mock connector: scripted turns for tests and dev, nothing else. */
export const MOCK_MEETING_CAPABILITIES: MeetingCapabilities = {
  audio: false,
  video: false,
  screenShare: false,
  participants: false,
  transcript: true,
  speakerIdentity: false,
  chat: false,
  recording: "depends",
};

export type MeetingSourceKind = "native" | "external" | "mock";

/** Source name → capabilities. Unknown names get the mock (least) set. */
export function capabilitiesFor(source: string): MeetingCapabilities {
  if (source === "native") return NATIVE_MEETING_CAPABILITIES;
  if (source === "mock") return MOCK_MEETING_CAPABILITIES;
  if (source === "zoom" || source === "meet" || source === "teams") {
    return EXTERNAL_MEETING_CAPABILITIES;
  }
  return MOCK_MEETING_CAPABILITIES;
}
