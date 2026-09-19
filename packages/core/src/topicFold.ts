import type { Workspace } from "./model.js";
import type { Operation } from "./operations.js";
import { statementNodes } from "./model.js";

/**
 * Topic entity resolution (Stage C5, ADR 0025): normalize, group, and
 * challenge — never silently overrule.
 *
 * A statement's `topic` is a short authored key ("pricing") so related
 * statements group. The failure C5 exists for: different wordings mint
 * different keys ("price", "pricing-model") beside an existing "pricing",
 * and the group splits. Three layers fix it, in order of authority:
 *
 *   1. SAFE NORMALIZATION (automatic, this module): morphological variants
 *      fold to the board's existing authored key — only when the
 *      equivalence is deterministic and unambiguous. Runs on
 *      MACHINE-AUTHORED ops only, enforced by where `foldStatementTopics`
 *      is invoked (generate, MCP ops, proposal approve, room ai-actor
 *      batches, the web meeting-extraction apply) — never on a human's edit.
 *   2. RECOMMENDATION (the challenge layer, `possibleDuplicateTopics`):
 *      when two AUTHORED keys are variants but stay separate — the human
 *      wrote "Pricing Model" beside "Pricing" — Lucent surfaces a
 *      possible-duplicate with evidence. The human decides; the authored
 *      text is never rewritten by anything but their explicit action.
 *   3. DERIVED GROUPING (the read side): grouping readers call
 *      `canonicalizeTopic` on authored keys, so even an unmerged duplicate
 *      still answers "what happened with pricing?" — authored text
 *      preserved, grouping joined.
 *
 * THE INVARIANT (ADR 0025): human-authored semantic fields are immutable by
 * automatic canonicalization; AI and system recommendations may propose
 * changes, but only an explicit user action may apply them. The reducer's
 * automatic `superseded` marking is not a violation of this — it is
 * derived from an explicit later committed decision, not a rewrite of the
 * authored field.
 *
 * Everything here is deterministic and pure. Semantic aliases
 * (monetization ≈ pricing) are deliberately OUT of reach: the fold never
 * merges two topics merely because they are similar. An LLM resolver is a
 * future CONDITIONAL fallback (gated on measured duplicate rates, run only
 * on the ambiguous branch) — never per generation, and its own ADR first.
 */

/** Length bounds mirroring the op schema's topic caps. */
export const TOPIC_MAX_CHARS = 60;

/* -------------------------------------------------------------------------- */
/* canonicalizeTopic — the derived key                                        */
/* -------------------------------------------------------------------------- */

/**
 * The plural fold, symmetric with retrieval's `foldToken`: `ies` → `y`,
 * otherwise drop a trailing `s` (never `ss`). Applied to BOTH sides of any
 * comparison, so a linguistically imperfect fold only ever compares equal
 * against a token folded the same way.
 */
function foldSegment(segment: string): string {
  if (segment.length >= 4 && segment.endsWith("ies")) return `${segment.slice(0, -3)}y`;
  if (segment.length >= 4 && segment.endsWith("s") && !segment.endsWith("ss")) {
    return segment.slice(0, -1);
  }
  return segment;
}

/**
 * The stem rule retrieval's `tokensMatch` uses: two segments ≥ 5 chars with
 * a shared prefix ≥ 4 and short tails on either side. "price" ↔ "pricing"
 * folds here; "monetization" vs "monetary" does not (tails too long).
 */
function segmentsMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return true;
  if (a.length >= 5 && b.length >= 5) {
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
    return common >= 4 && a.length - common <= 4 && b.length - common <= 4;
  }
  return a === b;
}

/** Split any authored topic into raw lowercase segments ("Pricing Model" → pricing, model). */
function rawSegments(topic: string): string[] {
  return topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * The canonical key of an AUTHORED topic: the per-segment morphological
 * fold, joined with dashes. "Pricing Model" → "pricing-model";
 * "Prices" → "price"; "Launch Dates" → "launch-date". Legacy free-form
 * topics (which predate the kebab contract) normalize the same way — the
 * derived key never throws on them.
 */
export function canonicalizeTopic(topic: string): string {
  const segments = rawSegments(topic).map(foldSegment);
  if (!segments.length) return "";
  return segments.join("-");
}

/* -------------------------------------------------------------------------- */
/* variants — the deterministic equivalence                                    */
/* -------------------------------------------------------------------------- */

/** The folded comparison form of a canonical key's segments. */
function comparisonSet(key: string): Set<string> {
  return new Set(rawSegments(key).map(foldSegment));
}

/**
 * Do two canonical keys name the same subject morphologically?
 *
 * TRUE when their folded segment sets are EQUAL, or one is a PROPER SUBSET
 * of the other (the modifier-dropping rule: "pricing-model" ⊃ "pricing",
 * "launch-date" ⊃ "launch" — when launch exists). Additionally, single
 * segments compare by the stem rule (price ~ pricing), so subset logic
 * works across inflections: {"price"} ⊆ {"pricing"} via segmentsMatch.
 *
 * FALSE for everything else, BY DESIGN: monetization vs pricing (no segment
 * relation), customer-acquisition vs user-acquisition ("customer" ≁
 * "user"). This is the "never merge the merely similar" rule, mechanical.
 */
export function topicsAreVariants(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const setA = comparisonSet(a);
  const setB = comparisonSet(b);
  const subsetOf = (small: Set<string>, large: Set<string>): boolean => {
    if (small.size >= large.size) return false;
    for (const seg of small) {
      if (![...large].some((other) => segmentsMatch(seg, other))) return false;
    }
    return true;
  };
  // Equal folded sets (with per-segment stem matching).
  if (setA.size === setB.size) {
    const everyA = [...setA].every((seg) => [...setB].some((o) => segmentsMatch(seg, o)));
    const everyB = [...setB].every((seg) => [...setA].some((o) => segmentsMatch(seg, o)));
    if (everyA && everyB) return true;
  }
  return subsetOf(setA, setB) || subsetOf(setB, setA);
}

/* -------------------------------------------------------------------------- */
/* the fold — machine-authored ops only, by placement                         */
/* -------------------------------------------------------------------------- */

/** The board's existing authored topic keys, in first-seen order. */
export function existingTopics(workspace: Workspace): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const node of statementNodes(workspace)) {
    const topic = node.statement?.topic;
    if (topic && !seen.has(topic)) {
      seen.add(topic);
      topics.push(topic);
    }
  }
  return topics;
}

/** A statement-carrying op that bears a topic. */
type _StatementOpWithTopic =
  | { op: "SET_STATEMENT"; id: string; statement: { topic?: string } | null }
  | { op: "UPDATE_STATEMENT"; id: string; topic?: string | null };

function topicOf(op: Operation): { key: string; isClear: boolean } | undefined {
  if (op.op === "SET_STATEMENT") {
    const topic = op.statement?.topic;
    if (typeof topic === "string" && topic.length > 0) return { key: topic, isClear: false };
    return undefined; // no topic, or statement: null (a clear)
  }
  if (op.op === "UPDATE_STATEMENT") {
    if (op.topic === null) return { key: "", isClear: true };
    if (typeof op.topic === "string" && op.topic.length > 0) {
      return { key: op.topic, isClear: false };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Fold machine-authored statement topics against the board's existing
 * authored keys. THE OP BOUNDARY OF THE C5 CONTRACT:
 *
 * - An op topic that variant-matches EXACTLY ONE existing key becomes that
 *   key — the board converges to the key it already uses, not to any
 *   system-preferred spelling.
 * - ZERO matches (novel) or MULTIPLE matches (ambiguous) → untouched. The
 *   ambiguity guard is the mechanical form of "never merge the merely
 *   similar."
 * - Batch-internal collisions: an existing key wins over a new one;
 *   otherwise the shortest-then-lexicographic key is the representative
 *   the colliding ops converge on, so the same batch is deterministic
 *   regardless of op order.
 * - Topic clears pass through untouched; so do non-statement ops and
 *   statement ops without topics. Idempotent: folding an already-folded
 *   batch changes nothing.
 *
 * NEVER call this on a human's ops — that is rule 2 of the contract,
 * enforced by every call site (each one pinned by a test).
 */
export function foldStatementTopics(
  ops: readonly Operation[],
  existing: readonly string[],
): Operation[] {
  if (!ops.length) return [...ops];
  // The authored keys visible to this fold, seeded with the board's own and
  // extended as the batch introduces representatives.
  const authored = new Set(existing.filter((t) => t.length > 0));

  const result: Operation[] = [];
  // First pass: resolve each op's topic against the authored set, computing
  // batch-internal representatives deterministically.
  const resolutions: Array<{ index: number; key: string } | undefined> = [];
  const pending: Array<{ index: number; key: string; matches: string[] }> = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    const topic = topicOf(op);
    if (!topic || topic.isClear) {
      resolutions[i] = undefined;
      continue;
    }
    // Exact authored match: already canonical, never rewritten.
    if (authored.has(topic.key)) {
      resolutions[i] = undefined;
      continue;
    }
    const matches = [...authored].filter((t) => topicsAreVariants(t, topic.key));
    if (matches.length === 1) {
      resolutions[i] = { index: i, key: matches[0]! };
      continue;
    }
    if (matches.length > 1) {
      // Ambiguous: untouched, whichever keys collide.
      resolutions[i] = undefined;
      continue;
    }
    // Novel: this op may become the representative later colliding ops fold
    // onto. Deterministic: first novel key in op order wins the slot, but
    // a shorter-then-lexicographic key preempts it for stability.
    pending.push({ index: i, key: topic.key, matches: [] });
    resolutions[i] = undefined;
  }

  // Batch-internal collisions among novel keys: group them by variant
  // relation — transitively (a~b, b~c ⇒ one group) — pick the
  // representative (shortest, then lexicographic — stable across op
  // orders), and fold the group's ops onto it.
  const used = new Set<string>();
  for (const entry of pending) {
    if (used.has(entry.key)) continue;
    // Transitive closure: keep absorbing pending keys that variant-match
    // ANY member of the group so far.
    const group = [entry];
    used.add(entry.key);
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of pending) {
        if (used.has(candidate.key)) continue;
        const matchesGroup = group.some(
          (g) => g.key === candidate.key || topicsAreVariants(g.key, candidate.key),
        );
        if (matchesGroup) {
          group.push(candidate);
          used.add(candidate.key);
          grew = true;
        }
      }
    }
    if (group.length <= 1) continue;
    const representative = group
      .map((g) => g.key)
      .sort((x, y) => x.length - y.length || x.localeCompare(y))[0]!;
    for (const g of group) {
      resolutions[g.index] = { index: g.index, key: representative };
    }
  }

  // Second pass: apply resolutions.
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    const resolution = resolutions[i];
    if (!resolution) {
      result.push(op);
      continue;
    }
    if (op.op === "SET_STATEMENT") {
      result.push({
        ...op,
        statement: { ...op.statement!, topic: resolution.key },
      });
    } else if (op.op === "UPDATE_STATEMENT") {
      result.push({ ...op, topic: resolution.key });
    } else {
      // Unreachable: resolutions exist only for statement ops.
      result.push(op);
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* the detector — rule 3's evidence-first challenge                           */
/* -------------------------------------------------------------------------- */

/** One side of a possible-duplicate pair: the authored key and its evidence. */
export interface TopicDuplicateSide {
  /** The authored key exactly as the board holds it. */
  topic: string;
  /** How many statements carry this authored key. */
  statements: number;
  /** The distinct meetings this topic's statements originated from. */
  meetings: string[];
}

/** A possible-duplicate recommendation (the generic shape's first instance). */
export interface TopicDuplicate {
  /** Stable for a pair: the two authored keys, sorted. */
  id: string;
  type: "merge-topic";
  /** [dup, existing] — the dup is the longer/lexicographically-later key. */
  targets: [TopicDuplicateSide, TopicDuplicateSide];
  /**
   * The canonical key both sides derive to — what grouping already joins
   * them under, and what an accepted merge converges on.
   */
  canonical: string;
}

/**
 * Detect variant-authored-topic pairs that persist as separate strings —
 * the rule-3 challenge. Every pair carries its evidence (rule 4): how
 * many statements each side holds and which meetings they came from, read
 * from provenance. Pure, computed on demand, NEVER persisted; the decision
 * (merge / keep separate) belongs to the human.
 *
 * Unrelated authored keys, or boards whose keys are already unified,
 * produce nothing — a detector that fires on everything is the annoying
 * reviewer the recommendation philosophy refuses to be.
 */
export function possibleDuplicateTopics(workspace: Workspace): TopicDuplicate[] {
  // Evidence per authored key.
  const sides = new Map<string, TopicDuplicateSide>();
  for (const node of statementNodes(workspace)) {
    const statement = node.statement;
    const topic = statement?.topic;
    if (!topic) continue;
    const side = sides.get(topic) ?? { topic, statements: 0, meetings: [] };
    side.statements += 1;
    const meetingId = statement.provenance?.meetingId ?? node.provenance?.meetingId;
    if (meetingId && !side.meetings.includes(meetingId)) side.meetings.push(meetingId);
    sides.set(topic, side);
  }

  const keys = [...sides.keys()];
  const duplicates: TopicDuplicate[] = [];
  const paired = new Set<string>();
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = keys[i]!;
      const b = keys[j]!;
      if (!topicsAreVariants(a, b)) continue;
      if (paired.has(a) || paired.has(b)) continue;
      paired.add(a);
      paired.add(b);
      // The dup is the longer (modifier-bearing) key; the existing is the
      // shorter — the key an accepted merge converges on.
      const [dup, existing] =
        a.length > b.length || (a.length === b.length && a.localeCompare(b) > 0)
          ? [sides.get(a)!, sides.get(b)!]
          : [sides.get(b)!, sides.get(a)!];
      duplicates.push({
        id: `merge-topic:${[a, b].sort().join("|")}`,
        type: "merge-topic",
        targets: [dup, existing],
        canonical: canonicalizeTopic(existing.topic) || canonicalizeTopic(dup.topic),
      });
    }
  }
  // Deterministic order: by the pair id.
  duplicates.sort((x, y) => x.id.localeCompare(y.id));
  return duplicates.slice(0, 10);
}
