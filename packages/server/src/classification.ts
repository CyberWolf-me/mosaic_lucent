/**
 * Board classification (docs/23 S1, docs/24 Phase A).
 *
 * The advisory's keystone ask, in Lucent's terms: a governance label on the
 * board that every OUTBOUND boundary reads before content leaves the org. The
 * label is not decoration — each tier gates a different set of boundaries, and
 * a tier that gates nothing is a lie the freeze rule (docs/17) forbids.
 *
 * Three tiers, not the advisory's four: `PUBLIC` was dropped because a board
 * whose content is public needs no gate at all, which makes the label an
 * alias for `internal` with a friendlier name. If a real public-sharing
 * product ask arrives it gets its own decision, not a no-op tier here.
 *
 *   tier           AI   integration   sharing   agent
 *   -----------------------------------------------------
 *   internal        ✓        ✓           ✓        ✓      (today's behavior)
 *   confidential    ✓        ✗           ✗        ✓
 *   restricted      ✗        ✗           ✗        ✗
 *
 * WHY EACH BOUNDARY IS GATED WHERE IT IS:
 *
 *  - `ai` — the board's content enters a prompt sent to whichever provider the
 *    deployment configured (`/api/generate`, `/api/generate/stream`, and the
 *    Ask route's read direction). Refused on `restricted` UNLESS the provider
 *    runs in-process: the offline mock never leaves the machine, so refusing it
 *    would break local dev and the deterministic diagram path for no gain.
 *    That exception is the advisory's own §24 fallback ("if there is no
 *    approved AI provider at all, Lucent can still fall back to structured
 *    workspace data + deterministic generators").
 *  - `integration` — an external task is created in Linear/GitHub/Jira with the
 *    board's action text in the payload. Already minimized to title +
 *    description + a marker; the gate decides whether it may leave AT ALL.
 *  - `sharing` — a share link is a capability that hands board content to
 *    whoever holds the token, including people outside the org.
 *  - `agent` — an MCP/agent client (Claude, Cursor, a script) reads board state
 *    over the ops route with the user's token, and the agent's own model is a
 *    third party the org never chose. Refused on `restricted`.
 *
 * FAIL CLOSED, at both unknown inputs. An unrecognized provider name counts
 * as external, and a stored value that is not one of the declared tiers (only
 * reachable by a direct database write — every route validates) resolves to
 * the strictest tier. Unset means `internal`: existing boards keep working,
 * which is a migration decision, not a policy one — raising an org's floor is
 * Phase B's classification policy.
 */

/** The tiers. Order is least → most restrictive, which `stricterOf` relies on. */
export const BOARD_CLASSIFICATIONS = ["internal", "confidential", "restricted"] as const;

export type BoardClassification = (typeof BOARD_CLASSIFICATIONS)[number];

/** The boundary an outbound action crosses. */
export type OutboundBoundary = "ai" | "integration" | "sharing" | "agent";

export function isBoardClassification(value: unknown): value is BoardClassification {
  return typeof value === "string" && (BOARD_CLASSIFICATIONS as readonly string[]).includes(value);
}

/**
 * A board's classification, defaulting to `internal`. Every gate calls this
 * rather than reading the field, so the default lives in exactly one place and
 * a board written by an older build (no field) behaves like today.
 *
 * A value that is present but not a declared tier resolves to the STRICTEST
 * tier, not the default one: the only way to get such a value past route
 * validation is a direct database write, and a gate that guessed "internal"
 * for garbage would open every boundary for exactly the row that cannot be
 * interpreted. Fail-closed means the uninterpretable row refuses outward
 * traffic until a human fixes the label.
 */
export function classificationOf(board: {
  classification?: BoardClassification;
}): BoardClassification {
  const value = board.classification ?? null;
  if (value === null) return "internal";
  return isBoardClassification(value) ? value : "restricted";
}

/** The stricter of two tiers. Phase B's org floor uses this. */
export function stricterOf(a: BoardClassification, b: BoardClassification): BoardClassification {
  return BOARD_CLASSIFICATIONS.indexOf(a) >= BOARD_CLASSIFICATIONS.indexOf(b) ? a : b;
}

/**
 * True when the provider's output requires leaving this process. The offline
 * mock (`name === "mock"`) runs in-process; anything else — a real vendor, a
 * gateway, or a test double whose name we do not recognize — is treated as
 * external. Fail-closed is the right direction for a gate: the cost of a false
 * positive is a refusal an operator can see and explain, and the cost of a
 * false negative is company content at a third party the policy said no to.
 *
 * Phase C (docs/24) replaces this heuristic with the org's provider policy;
 * until then it is deliberately conservative and documented as such.
 */
export function providerLeavesProcess(provider: { name: string }): boolean {
  return provider.name !== "mock";
}

/** A refusal, ready to become the route's response body. */
export interface ClassificationRefusal {
  /** The boundary that was refused. */
  boundary: OutboundBoundary;
  /** The board's tier, echoed so the client can name it. */
  classification: BoardClassification;
  /** Human-readable, specific, and safe to show a user. */
  error: string;
}

/** What each tier forbids. `internal` forbids nothing, by definition. */
const FORBIDDEN: Record<BoardClassification, readonly OutboundBoundary[]> = {
  internal: [],
  confidential: ["integration", "sharing"],
  restricted: ["ai", "integration", "sharing", "agent"],
};

const BOUNDARY_LABEL: Record<OutboundBoundary, string> = {
  ai: "sending board content to an external AI provider",
  integration: "sending board content to an external integration",
  sharing: "creating a share link",
  agent: "letting an external agent read this board",
};

/**
 * May this boundary be crossed for a board at this tier? Returns null when the
 * action is allowed, or the refusal to hand back to the caller.
 *
 * `options.provider` is consulted only for the `ai` boundary: an in-process
 * provider is not an outbound boundary at all, so a `restricted` board can
 * still be generated against offline (the deterministic path the advisory's
 * §24 keeps available when no approved provider exists).
 */
export function checkOutbound(
  classification: BoardClassification,
  boundary: OutboundBoundary,
  options: { provider?: { name: string } } = {},
): ClassificationRefusal | null {
  if (!FORBIDDEN[classification].includes(boundary)) return null;
  if (boundary === "ai" && options.provider && !providerLeavesProcess(options.provider))
    return null;
  return {
    boundary,
    classification,
    error: `this board is classified ${classification}, which forbids ${BOUNDARY_LABEL[boundary]}`,
  };
}

/**
 * Shorthand for the integration boundary. The integration routes share one
 * body: after the editor guard, refuse once if the board's classification
 * says external content may not leave at all. Returns undefined when allowed,
 * or the refusal body the route should `send`.
 */
export function integrationBoundary(board: {
  classification?: BoardClassification;
}): ClassificationRefusal | undefined {
  return checkOutbound(classificationOf(board), "integration") ?? undefined;
}
