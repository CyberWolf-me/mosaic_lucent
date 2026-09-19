# 0025 — Normalize, group, and challenge — never silently overrule

- Status: Accepted
- Date: 2026-09-04

## Context

Statement topics (Stage C2, ADR 0021) are short authored kebab keys so
related statements group. The failure Stage C5 exists for: different
wordings mint different keys — "price", "pricing-model" beside an existing
"pricing" — and the group splits. ADR 0021 designed `topic` as the seam
("entity resolution enriches the key later without changing the op");
ADR 0023 governs what C5 may persist (nothing derived, without its own ADR).

The owner's decisions, with two refinements that shaped the contract:

1. **Teach + deterministic fold — no LLM resolver round.** An extra model
   call per generation to fix "pricing" vs "pricing-model" is the wrong
   architecture: another call, another latency, another failure mode,
   another prompt to maintain — for a problem morphology handles. The model
   is TAUGHT to reuse existing keys (visual-agent v5, both meeting-extraction
   prompts), and the fold is the safety net. Semantic aliases
   (monetization ≈ pricing) stay separate until measured duplicate rates
   justify a future **conditional** resolver — one that runs only on the
   ambiguous branch, never per generation.
2. **Universal normalization, not universal rewriting.** The fold runs at
   every authoritative boundary — but only on MACHINE-authored ops. The
   first draft's "never rewrite the human" became the sharper four-rule
   contract after the owner's challenge: a workspace that blindly accepts
   everything the human says is as untrustworthy as one that silently
   overrules them.

## Decision: the C5 contract, four rules

1. **Safe normalization is automatic.** Morphological variants fold to the
   board's existing authored key — only when the equivalence is
   deterministic (segment sets equal, or one a proper subset — the
   modifier-dropping rule, so launch-date → launch when launch exists) and
   unambiguous (exactly one candidate; two candidates = untouched). Runs on
   machine-authored ops at every boundary: generate (including the repair
   re-emission), MCP/agent ops, proposal approval, room commits with the
   ai actor, and the web client's send/proposal paths. The board converges
   on the key IT already uses — never a system-preferred spelling.
2. **Human-authored text is never silently rewritten.** The precise
   invariant: _human-authored semantic fields are immutable by automatic
   canonicalization; AI and system recommendations may propose changes, but
   only an explicit user action may apply them._ Machine-ops-only by
   placement, not by flag: the room folds `actor.actorType === "ai"`
   batches and nothing else; `applyManual` (the HUD's path) has no fold
   call at all. The superseded carve-out, so the invariant is honest: the
   reducer's automatic `superseded` marking is derived from an explicit
   later committed decision, not a rewrite of authored text — the protected
   thing is the authored field, not every piece of semantic state forever.
3. **Semantic uncertainty becomes a recommendation, not a merge.** When two
   AUTHORED keys are variants but persist as separate strings — the human
   wrote "Pricing Model" beside "Pricing" — `possibleDuplicateTopics`
   detects the pair; the HUD's topic field surfaces it live at authoring
   time with Accept/Keep. Accept sets the field and commits through the
   same `statementEditOps` → `applyManual` → validator path as any edit (an
   explicit user action); Keep dismisses for that value. Nothing
   auto-applies; no LLM is called.
4. **Recommendations need evidence.** Every duplicate hint carries the
   statement count of the existing key (the detector's pairs also carry
   meetings of origin, from provenance). Never "these look similar"
   without the why and the numbers. Each key joins at most one pair — a
   detector that fires on everything is the annoying reviewer the
   recommendation philosophy refuses to be.

The read-side payoff: the Ask digest's **statements-by-topic section** —
statements grouped by topic identity (canonicalize + the variant rule, the
same representative the fold chooses), authored spellings noted, capped
(20 topics / 8 per group). "What happened with pricing?" is one section
even when the board's authored keys disagree on spelling.

The generic `Recommendation { id, type, targets, proposedChange, reason,
evidence, status }` shape is the C6+ evolution, documented here and
deliberately not built: the merge-topic hint is its first instance, and the
engine (contradictions, stale objects, ownership conflicts, architecture
inconsistencies — the Stripe→Adyen and iOS-16 examples from the design
discussion) plus any pending-recommendation persistence is future work
with its own ADR.

## Consequences

- The philosophy line, for the record: **Lucent should be willing to
  disagree with the user, but never silently overrule the user.** AI can
  interpret and recommend; deterministic rules can normalize safe
  equivalents; the system enforces structural validity; the user retains
  final semantic authority.
- Nothing persisted: the canonical key is derived per read, the fold
  rewrites ops in flight, the detector computes on demand. ADR 0023's rule
  holds by construction — the day topics need durability, a new ADR says
  why.
- The fold is idempotent at every boundary: server sites fold after the
  client's fold, and a client that re-sends folded ops changes nothing
  (exact matches never rewrite). Convergence is stable, not eventual.
- `topicsAreVariants` is the one equivalence notion the whole system
  shares — the fold, the detector, the HUD hint, and the digest's grouping
  all call it. A change to the variant rule changes all five surfaces at
  once, deliberately.
- The subset rule generalizes honestly: launch-date folds to launch. The
  guard is the one-candidate rule and the machine-only placement — a human
  deliberately typing launch-date keeps it, grouped but untouched.
- Batch-internal collision resolution is deterministic (transitive
  closure; shortest-then-lexicographic representative) so the same batch
  folds the same way in any op order.
