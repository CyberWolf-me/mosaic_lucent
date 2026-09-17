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
 * (as raised by the org floor) says external content may not leave at all.
 * Returns undefined when allowed, or the refusal body the route should `send`.
 */
export function integrationBoundary(
  board: { classification?: BoardClassification },
  org?: OrgPolicySource,
): ClassificationRefusal | undefined {
  return checkOutboundFor(board, org, "integration") ?? undefined;
}

/* ---------------------------------- Phase B --------------------------------
 * The org policy plane (docs/23 S2, docs/24 Phase B). One interface, one
 * shape: every field is either a classification floor (inheriting through
 * `stricterOf`) or an explicit org-wide denial of a boundary — never a new
 * authorization system. Orgs have no policy surface today beyond identity and
 * billing; this adds the settings the advisory's admin plane names, enforced
 * server-side at the SAME gates Phase A put on every outbound boundary, so
 * "policy beats board" is one function call and not a parallel permission
 * model (docs/24 §10).
 * -------------------------------------------------------------------------- */

/** Where the org stands on AI generation. */
export type OrgAiPolicy = "allowed" | "disabled";

/**
 * Where the org stands on the server STT route (docs/25 V1, §3.1). The
 * parallel of `OrgAiPolicy` for audio: `disabled` refuses session creation
 * for every caller in the org. It governs the SERVER route only — the
 * client-side providers (browser, on-device Whisper, LiveKit room) are the
 * user's own choice, and an org that needs those governed too has a client
 * deployment decision, not a setting this server can enforce.
 */
export type OrgServerStt = "allowed" | "disabled";

export interface OrgSettings {
  /**
   * The floor every board's tier is raised to (`stricterOf`): a board in a
   * `confidential`-floored org behaves at worst like `confidential` even
   * though its own label says `internal`, and no board label can lower it.
   * Absent means `internal` — the org sets no floor, Phase A behavior.
   */
  classificationFloor?: BoardClassification;
  /**
   * AI generation for every board in the org. `disabled` refuses BOTH
   * directions and the in-process mock too — it is the org saying "no AI in
   * our workspace", the strictest switch, deliberately stronger than the
   * classification floor (which only refuses external providers).
   */
  ai?: OrgAiPolicy;
  /** External sharing (link minting) disabled for every board. */
  sharingDisabled?: boolean;
  /** Agent/MCP access (op-apply route and MCP-marked reads) disabled. */
  agentDisabled?: boolean;
  /**
   * Server-hosted transcription (`POST /api/stt/sessions`) for every caller
   * in the org. `disabled` refuses session creation before any audio is
   * accepted — the audio-egress answer docs/25 §3.1 requires ahead of the
   * voice work: an org that keeps speech on-device says so here. Absent
   * means `allowed` (zero behavior change for untouched orgs).
   */
  serverStt?: OrgServerStt;
  /** Meeting capture disabled: the POST routes refuse for every board. */
  recordingDisabled?: boolean;
  /**
   * Which providers may process this org's content (docs/23 S3, docs/24
   * Phase C). This is the field that turns docs/06's honest "depends on
   * your provider's terms" into an enforceable setting: an org that
   * self-hosts, or that forbids caller-supplied keys, says so here and the
   * provider resolver obeys — ORG POLICY MAY RESTRICT, NEVER WIDEN: the
   * deployment flag (`LUCENT_ALLOW_BYO_KEYS`) is the ceiling an org can
   * only tighten, which is the deliberate opposite direction from Phase B's
   * floor rule, and stated so nobody "fixes" it.
   */
  providerPolicy?: OrgProviderPolicy;
}

/** Anything a gate can read an org's settings through (undefined = no policy). */
export type OrgPolicySource = { settings?: OrgSettings } | undefined;

/** The settings with every default resolved — the only shape gates read. */
export interface EffectiveOrgSettings {
  classificationFloor: BoardClassification;
  aiDisabled: boolean;
  sharingDisabled: boolean;
  agentDisabled: boolean;
  recordingDisabled: boolean;
  serverSttDisabled: boolean;
  providerPolicy: EffectiveProviderPolicy;
}

/**
 * The org's effective settings — fail closed, same discipline as
 * `classificationOf`: an absent field is the permissive default (no org
 * policy is exactly today's behavior, and that is a migration decision),
 * but a field that is PRESENT and not interpretable (a direct database write,
 * a future rename) is read as the RESTRICTIVE answer: an unknown floor is
 * `restricted`, a non-boolean flag is `true`, an unknown `ai` value is
 * `disabled`. The routes validate every write, so the only way to store
 * garbage is to bypass them — and a gate that defaulted garbage to permissive
 * would open every boundary for exactly the row nobody can interpret.
 */
export function effectiveSettings(org: OrgPolicySource): EffectiveOrgSettings {
  const raw: OrgSettings = org?.settings ?? {};
  return {
    classificationFloor: isBoardClassification(raw.classificationFloor)
      ? raw.classificationFloor
      : raw.classificationFloor === undefined
        ? "internal"
        : "restricted",
    aiDisabled: raw.ai === "disabled" ? true : raw.ai === undefined ? false : raw.ai !== "allowed",
    sharingDisabled: coerceFlag(raw.sharingDisabled),
    agentDisabled: coerceFlag(raw.agentDisabled),
    recordingDisabled: coerceFlag(raw.recordingDisabled),
    // One honest boolean like `ai`: absent is allowed (today's behavior),
    // present-and-unintelligible is disabled (fail closed, same rule).
    serverSttDisabled:
      raw.serverStt === "disabled"
        ? true
        : raw.serverStt === undefined
          ? false
          : raw.serverStt !== "allowed",
    providerPolicy: effectiveProviderPolicy(raw.providerPolicy),
  };
}

function coerceFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  // Absent is the permissive default; present-and-unintelligible is not.
  return value !== undefined;
}

/** Validate an incoming PATCH body into settings, or name what is wrong. */
export function parseOrgSettings(
  body: Record<string, unknown>,
): { ok: true; settings: OrgSettings } | { ok: false; error: string } {
  const settings: OrgSettings = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    switch (key) {
      case "classificationFloor":
        if (!isBoardClassification(value)) {
          return {
            ok: false,
            error: "classificationFloor must be one of: internal, confidential, restricted",
          };
        }
        settings.classificationFloor = value;
        break;
      case "ai":
        if (value !== "allowed" && value !== "disabled") {
          return { ok: false, error: "ai must be 'allowed' or 'disabled'" };
        }
        settings.ai = value;
        break;
      case "serverStt":
        if (value !== "allowed" && value !== "disabled") {
          return { ok: false, error: "serverStt must be 'allowed' or 'disabled'" };
        }
        settings.serverStt = value;
        break;
      case "sharingDisabled":
      case "agentDisabled":
      case "recordingDisabled":
        if (typeof value !== "boolean") {
          return { ok: false, error: `${key} must be a boolean` };
        }
        (settings as Record<string, unknown>)[key] = value;
        break;
      case "providerPolicy": {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          return { ok: false, error: "providerPolicy must be an object" };
        }
        const policy: Record<string, unknown> = {};
        const raw = value as Record<string, unknown>;
        for (const sub of Object.keys(raw)) {
          if (sub !== "mode" && sub !== "allow") {
            return { ok: false, error: `unknown providerPolicy field "${sub}"` };
          }
        }
        if (raw.mode !== undefined) {
          if (!(ORG_PROVIDER_MODES as readonly string[]).includes(String(raw.mode))) {
            return {
              ok: false,
              error: `providerPolicy.mode must be one of: ${ORG_PROVIDER_MODES.join(", ")}`,
            };
          }
          policy.mode = raw.mode;
        }
        if (raw.allow !== undefined) {
          if (raw.allow === null) {
            // Explicit clear (see `OrgProviderPolicy.allow`): the route's
            // nested merge deletes the stored filter with it.
            policy.allow = null;
          } else if (
            !Array.isArray(raw.allow) ||
            raw.allow.length === 0 ||
            raw.allow.length > 50 ||
            !raw.allow.every((n) => typeof n === "string" && n.length > 0 && n.length <= 64)
          ) {
            return {
              ok: false,
              error:
                "providerPolicy.allow must be null or a non-empty array of provider names (≤64 chars each, ≤50 names)",
            };
          } else {
            policy.allow = raw.allow;
          }
        }
        settings.providerPolicy = policy as OrgProviderPolicy;
        break;
      }
      default:
        return { ok: false, error: `unknown org setting "${key}"` };
    }
  }
  return { ok: true, settings };
}

/**
 * THE combined gate — Phase B's one function every outbound call site uses.
 * The board's tier (as raised by the org's floor) is checked first, then the
 * org's explicit denials. The org's floor can only ever RAISE the tier
 * (`stricterOf` — inheritance, not copy-on-write: a board created before the
 * policy is governed by it, and its own label cannot loosen it), and an
 * org-wide boolean refuses every board regardless of tier, including the
 * in-process-mock exemption the board tier alone does not reach.
 */
export function checkOutboundFor(
  board: { classification?: BoardClassification },
  org: OrgPolicySource,
  boundary: OutboundBoundary,
  options: { provider?: { name: string } } = {},
): ClassificationRefusal | null {
  const effective = effectiveSettings(org);
  const own = classificationOf(board);
  const tier = stricterOf(own, effective.classificationFloor);
  const boardRefusal = checkOutbound(tier, boundary, options);
  if (boardRefusal) {
    // A tier the board was RAISED to must not be reported as the board's own
    // label — a user reading "this board is classified confidential" about a
    // board they set to internal would hunt for a setting they never made.
    // The effective tier is still echoed; the sentence names its source.
    if (tier !== own) {
      return {
        ...boardRefusal,
        error: boardRefusal.error.replace(
          /^this board is classified \w+/,
          "this board is governed as " + tier + " (its organization's classification floor)",
        ),
      };
    }
    return boardRefusal;
  }
  const orgError = orgDenialFor(effective, boundary);
  if (!orgError) return null;
  return { boundary, classification: tier, error: orgError };
}

/**
 * docs/25 V1 (§3.1): the server-STT refusal for an org's effective settings,
 * or null when the route may proceed. Deliberately NOT another
 * OutboundBoundary: STT audio is not board content crossing a tier gate — it
 * is a service the org allows or forbids wholesale, the same shape as the
 * org's `ai: "disabled"` switch.
 */
export function serverSttRefusal(settings: EffectiveOrgSettings): string | null {
  return settings.serverSttDisabled
    ? "this organization's policy disables server-hosted transcription — use on-device speech-to-text"
    : null;
}

/**
 * The org's denial for the boundary, or null. The three booleans are plain;
 * `ai` is the org's strictest switch — `disabled` refuses every generation,
 * the in-process mock included, because the org said no to AI in the
 * workspace, not just to AI leaving it. The org has no `integration` boolean:
 * the floor already gates that boundary through the tier (confidential
 * forbids integrations), and a second switch over the same act would be the
 * parallel-policy shape docs/24 §10 forbids.
 */
function orgDenialFor(settings: EffectiveOrgSettings, boundary: OutboundBoundary): string | null {
  switch (boundary) {
    case "ai":
      return settings.aiDisabled
        ? "this organization's policy disables AI generation for every board"
        : null;
    case "integration":
      return null;
    case "sharing":
      return settings.sharingDisabled
        ? "this organization's policy disables external sharing for every board"
        : null;
    case "agent":
      return settings.agentDisabled
        ? "this organization's policy disables agent (MCP) access for every board"
        : null;
  }
}

/* ---------------------------------- Phase C --------------------------------
 * The per-org provider policy (docs/23 S3, docs/24 Phase C). Phase B gave
 * the org a floor and four denials; this is the fifth answer — WHICH
 * PROVIDER may process the org's content — and it is the field that turns
 * docs/06's honest "depends on your provider's terms" into something an
 * admin can set and the resolver must obey.
 *
 * The direction rule, stated because it is the OPPOSITE of Phase B's and
 * somebody will try to "fix" it: ORG POLICY MAY RESTRICT, NEVER WIDEN. The
 * deployment's `LUCENT_ALLOW_BYO_KEYS` is the ceiling; an org saying "any"
 * does not unlock BYO on a deployment that turned it off (that refusal
 * happens in the resolver before any org is even known). An org saying
 * "byo-forbidden" locks the key out even on a BYO-enabled deployment.
 *
 * What "self-hosted" means here, honestly: the server cannot probe a
 * provider's infrastructure, so SELF-HOSTING IS AN OPERATOR DECLARATION —
 * `LUCENT_AI_SELF_HOSTED=1` marks the deployment's configured provider as
 * running on infrastructure the org controls. A BYO key is NEVER self-hosted
 * by construction: the BYO path targets fixed public endpoints (the OpenAI
 * URL is a constant in modelRouter.ts), so it is cloud by definition, and a
 * self-hosted-only org refuses it without needing to trust anyone's word.
 * The in-process mock passes every mode (it leaves nothing to trust — the
 * advisory's §24 fallback again).
 * -------------------------------------------------------------------------- */

export const ORG_PROVIDER_MODES = ["any", "byo-forbidden", "self-hosted-only"] as const;

export type OrgProviderMode = (typeof ORG_PROVIDER_MODES)[number];

export interface OrgProviderPolicy {
  /**
   * "any" — today's behavior, the deployment decides.
   * "byo-forbidden" — the org never uses a caller-supplied key, even on a
   *   BYO-enabled deployment.
   * "self-hosted-only" — only an in-process provider or the deployment's
   *   declared-self-hosted provider answers; BYO cloud keys are refused, and
   *   so is an ordinary cloud operator provider (the org's content does not
   *   leave its infrastructure at all).
   */
  mode?: OrgProviderMode;
  /**
   * An optional name filter layered UNDER every mode: when present, only a
   * provider whose name is listed may process the org's content. The token
   * "self-hosted" matches the deployment's declared-self-hosted provider,
   * so an org can pin the class of endpoint without naming a model. The
   * in-process mock always passes (refusing it punishes only offline dev).
   *
   * `null` is accepted ONLY in a PATCH body and means "clear the filter";
   * it never reaches storage — the route deletes the key on merge (see
   * routes/settings.ts). A `null` found in storage is garbage like any other
   * unintelligible value, and `effectiveProviderPolicy` fails it closed.
   */
  allow?: string[] | null;
}

/** What the resolver reports about the provider it picked, for the policy. */
export interface ProviderFact {
  name: string;
  /** True when the call rides a caller-supplied (cloud) key. */
  byok: boolean;
  /** The operator's declaration that the configured provider is self-hosted. */
  selfHosted: boolean;
}

/** A provider-policy refusal, ready for the route's 403 body. */
export interface ProviderPolicyRefusal {
  mode: OrgProviderMode;
  error: string;
}

/** The providerPolicy with every default resolved (see `effectiveSettings`). */
export interface EffectiveProviderPolicy {
  mode: OrgProviderMode;
  allow: string[] | null;
}

function effectiveProviderPolicy(raw: OrgProviderPolicy | undefined): EffectiveProviderPolicy {
  if (raw === undefined) return { mode: "any", allow: null };
  const mode = (ORG_PROVIDER_MODES as readonly string[]).includes(String(raw.mode ?? "any"))
    ? (raw.mode ?? "any")
    : // Fail closed: a present-but-unintelligible mode is the strictest answer.
      "self-hosted-only";
  let allow: string[] | null = null;
  if (raw.allow !== undefined) {
    allow = Array.isArray(raw.allow)
      ? raw.allow.filter((n): n is string => typeof n === "string")
      : // Present-and-unintelligible list: nothing is allowed.
        [];
  }
  return { mode, allow };
}

/**
 * May this provider serve under this org's policy? Null when yes; the refusal
 * names the mode so the client (and the audit of the answer) can say why.
 */
export function providerPolicyRefusal(
  policy: EffectiveProviderPolicy,
  fact: ProviderFact,
): ProviderPolicyRefusal | null {
  const inProcess = !providerLeavesProcess({ name: fact.name });
  switch (policy.mode) {
    case "any":
      break;
    case "byo-forbidden":
      if (fact.byok) {
        return {
          mode: policy.mode,
          error:
            "this organization's provider policy forbids bring-your-own keys; only the configured provider may process its content",
        };
      }
      break;
    case "self-hosted-only":
      if (fact.byok) {
        return {
          mode: policy.mode,
          error:
            "this organization's provider policy allows only self-hosted processing; a bring-your-own cloud key leaves the org's infrastructure",
        };
      }
      if (!inProcess && !fact.selfHosted) {
        return {
          mode: policy.mode,
          error:
            "this organization's provider policy allows only self-hosted processing; this deployment's configured provider is not marked self-hosted (LUCENT_AI_SELF_HOSTED)",
        };
      }
      break;
  }
  if (policy.allow !== null && !inProcess) {
    const named =
      policy.allow.includes(fact.name) || (fact.selfHosted && policy.allow.includes("self-hosted"));
    if (!named) {
      return {
        mode: policy.mode,
        error: `this organization's provider policy allows only: ${policy.allow.join(", ")}`,
      };
    }
  }
  return null;
}
