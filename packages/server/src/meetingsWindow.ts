import { withCorrections, type MeetingTranscript } from "./meetings.js";

/**
 * The meetings visible to the caller's window (Stage C1, review amendment 1):
 * a meeting whose startedAt precedes the oldest visible revision produced
 * board state only through revisions this caller cannot see, so its transcript
 * is outside the entitlement too. Meetings newer than the window are trivially
 * inside.
 *
 * Extracted for Stage C4 so the ask route and the search route share one
 * floor — the C4 acceptance criterion is that search and Ask see exactly the
 * same window, and a duplicated filter would be the first place that drifts.
 *
 * docs/28 S7: the meetings come back with people's corrections applied, so
 * Ask and search read the words as corrected — the same one place for both.
 */
export function visibleMeetings(
  meetings: MeetingTranscript[],
  oldestVisibleAt: number,
): MeetingTranscript[] {
  // forBoard returns newest-first.
  return meetings.filter((m) => m.startedAt >= oldestVisibleAt).map(withCorrections);
}
