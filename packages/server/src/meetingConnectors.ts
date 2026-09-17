/**
 * External meeting connectors (docs/24 Phase E, docs/25 V3).
 *
 * The convergence rule, structural: a connector's ONLY job is turns into
 * the same store. Native capture, a Zoom cloud recording, or a Meet
 * transcript all land as `MeetingTurn[]` through `validateTurns` and the
 * same insert — downstream (checkpoints, extraction, provenance, Ask,
 * search) cannot tell where a turn came from, which is exactly the point.
 *
 * Deliberately NOT the ops-approval/inbound queue: that machinery gates
 * MUTATIONS (external tasks becoming board ops). A transcript import is a
 * SAVE, and its human gate is the editor floor — the same floor as a
 * manual save, because both record what was said. Forcing minutes through
 * an ops-approval flow would be the wrong shape worn proudly.
 *
 * Credentials follow the BYO rule, never stored: a vendor source takes the
 * caller's OAuth token per request (`credential`), uses it once, and drops
 * it. What ships today is the `mock` source (scripted turns for the route
 * tests and offline dev); vendor adapters (Zoom/Meet/Teams) arrive against
 * this interface with their per-request credential, plus the docs/25 §3.3
 * authorized-attendee grant — not as edits to the route.
 */

export interface ExternalMeetingRef {
  /** Opaque vendor meeting id (recording/transcript id). Echoed, never interpreted. */
  id: string;
  /** Human label for logs and the import response (never trusted for authz). */
  title?: string;
}

export interface ExternalMeetingSource {
  /** Registry key: "mock", later "zoom" / "meet" / "teams". */
  readonly name: string;
  /**
   * Fetch one meeting's transcript. `credential` is the caller's
   * vendor token for this request only — used once, never stored, never
   * logged. Throw on provider failure (the route answers 502); return
   * turns (possibly dirty — the route validates before anything persists).
   */
  fetchTranscript(
    ref: ExternalMeetingRef,
    credential?: string,
  ): Promise<{ turns: unknown; title?: string }>;
}

/** What the routes share: name → source. Built by createApp (mock included). */
export interface MeetingConnectorRegistry {
  sources: Map<string, ExternalMeetingSource>;
}

/**
 * The offline double: scripted turns per ref id, for route tests and for
 * exercising the import path with no vendor. An unknown ref id throws
 * (like a vendor 404); a ref mapped to garbage exercises the route's
 * validation refusal.
 */
export class MockMeetingSource implements ExternalMeetingSource {
  readonly name = "mock";

  constructor(private readonly scripts: Record<string, { turns: unknown; title?: string }> = {}) {}

  async fetchTranscript(ref: ExternalMeetingRef): Promise<{ turns: unknown; title?: string }> {
    const script = this.scripts[ref.id];
    if (!script) throw new Error(`mock source has no meeting ${ref.id}`);
    return { turns: script.turns, ...(script.title ? { title: script.title } : {}) };
  }
}
