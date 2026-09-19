/**
 * Board governance tiers (docs/23 S1, docs/24 Phase A) — the client mirror.
 *
 * Copied, not imported: the browser bundle does not depend on the server
 * package (same split as MeetingTurn). The server remains authoritative —
 * it validates every write against its own declared tiers, so a typo here
 * could only ever produce a client-side refusal, never a fourth tier.
 * What the client owns is the honest description of what each tier DOES,
 * because that is what the picker shows before anyone clicks.
 */

export const BOARD_TIERS = ["internal", "confidential", "restricted"] as const;

export type BoardTier = (typeof BOARD_TIERS)[number];

export function isBoardTier(value: unknown): value is BoardTier {
  return typeof value === "string" && (BOARD_TIERS as readonly string[]).includes(value);
}

/** Button labels, in least → most restrictive order. */
export const TIER_LABELS: Record<BoardTier, string> = {
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
};

/**
 * What each tier forbids, in the user's words. Mirrors the server matrix
 * (classification.ts FORBIDDEN): internal forbids nothing, confidential
 * forbids integrations + sharing, restricted additionally forbids external
 * AI and agent reads. If the server matrix ever changes, this text must
 * change with it — a picker that misdescribes the gate is worse than none.
 */
export const TIER_DESCRIPTIONS: Record<BoardTier, string> = {
  internal: "Today's behavior. AI, integrations, sharing, and agent access all work.",
  confidential:
    "No external integrations and no share links. AI generation and agent access still work.",
  restricted:
    "Nothing leaves: no external AI, no integrations, no share links, no agent reads. Members can still read and edit.",
};
