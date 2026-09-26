/**
 * Meeting behavior profiles (docs/24 Phase D, docs/25 V2).
 *
 * Recording always captures and checkpoints turns; the profile decides what
 * else the meeting does. The split is behavior, not a prompt toggle:
 *
 * - `record` — transcript only. No extraction call, no generation spend, no
 *   board writes. A Record meeting that burns a generation is a clause-4
 *   defect (shipped behavior wrong), not a missing feature.
 * - `intelligence` — captures and classifies (decisions, actions, questions,
 *   risks) as you talk. Lucent stays silent; board changes are always proposed
 *   for review, never applied silently.
 * - `assistant` — the normal Lucent meeting mode (the default). Everything
 *   Intelligence does, plus: answers aloud when explicitly invoked ("Lucent,
 *   …") through the conversational lease, and performs canvas actions on an
 *   explicit command (small ones directly, large ones as a reviewed proposal).
 * - `participant` — future: proactive intervention under an explicit policy.
 *   Behaves as Assistant for now.
 *
 * `effectiveMode` is the only thing the capture loop reads; the selected
 * mode is what the UI shows and the transcript records.
 */

export const MEETING_MODES = ["record", "intelligence", "assistant", "participant"] as const;

export type MeetingMode = (typeof MEETING_MODES)[number];

export function isMeetingMode(value: unknown): value is MeetingMode {
  return typeof value === "string" && (MEETING_MODES as readonly string[]).includes(value);
}

/** The behavior a selected mode runs as. Assistant/participant are Intelligence until M6. */
export function effectiveMode(mode: MeetingMode): "record" | "intelligence" {
  return mode === "record" ? "record" : "intelligence";
}

/** Whether the extraction loop may fire under this mode. False burns nothing. */
export function modeAllowsExtraction(mode: MeetingMode): boolean {
  return effectiveMode(mode) === "intelligence";
}

/**
 * True when the selected mode is not yet the full experience. Assistant's voice
 * loop is built (the conversational lease speaks on explicit invocation), so it
 * is no longer degraded; only Participant (proactive intervention) is future.
 */
export function modeDegraded(mode: MeetingMode): boolean {
  return mode === "participant";
}

export const MODE_LABELS: Record<MeetingMode, string> = {
  record: "Record",
  intelligence: "Intelligence",
  assistant: "Assistant",
  participant: "Participant",
};

/** One-line disclosure per mode, rendered under the picker. */
export const MODE_NOTES: Record<MeetingMode, string> = {
  record: "Transcript only — no AI extraction, no spoken answers, no board changes.",
  intelligence:
    "Captures and classifies decisions, actions, questions and risks as you talk. Lucent stays silent; any board change is proposed for your approval, never applied silently.",
  assistant:
    "The normal meeting mode. Captures and understands everything, but only answers aloud when you say “Lucent…”, and only changes the board on an explicit command or an approved proposal.",
  participant:
    "Future: proactive participation under an explicit policy. Behaves as Assistant for now.",
};
