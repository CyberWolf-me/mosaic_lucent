/**
 * Meeting behavior profiles (docs/24 Phase D, docs/25 V2).
 *
 * Recording always captures and checkpoints turns; the profile decides what
 * else the meeting does. The split is behavior, not a prompt toggle:
 *
 * - `record` — transcript only. No extraction call, no generation spend, no
 *   board writes. A Record meeting that burns a generation is a clause-4
 *   defect (shipped behavior wrong), not a missing feature.
 * - `intelligence` — today's default: the differential extraction loop runs
 *   over captured turns exactly as before.
 * - `assistant` / `participant` — reserved for the M6 voice work. They
 *   behave as Intelligence today, disclosed in the UI rather than refused:
 *   refusing a selected mode strands the user's meeting, while a disclosed
 *   degradation keeps capture and intelligence working.
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

/** True when the selected mode degrades to Intelligence (voice responses unbuilt). */
export function modeDegraded(mode: MeetingMode): boolean {
  return mode === "assistant" || mode === "participant";
}

export const MODE_LABELS: Record<MeetingMode, string> = {
  record: "Record",
  intelligence: "Intelligence",
  assistant: "Assistant",
  participant: "Participant",
};

/** One-line disclosure per mode, rendered under the picker. */
export const MODE_NOTES: Record<MeetingMode, string> = {
  record: "Transcript only — no AI extraction, no board changes, no generation spend.",
  intelligence: "Live transcript plus decisions, actions, and board updates as you talk.",
  assistant:
    "Answers when you say “Lucent…” out loud (spoken when a voice is available; mute anytime).",
  participant:
    "Behaves as Assistant for now — proactive participation arrives after M6 is reliable.",
};
