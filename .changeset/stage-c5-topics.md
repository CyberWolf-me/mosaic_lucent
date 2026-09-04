---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
---

Stage C5: topic entity resolution — normalize, group, and challenge; never silently overrule. One deterministic variant rule shared by the fold, the detector, the HUD hint, and the Ask grouping; nothing persisted (ADR 0025).

- **The fold (`@lucent/core`)**: `topicFold.ts` — canonicalizeTopic (morphology
  only), topicsAreVariants (segment sets equal or subset: pricing ≡
  pricing-model ≡ price ≡ prices; monetization and customer-acquisition stay
  apart by design), foldStatementTopics (converge on the board's existing
  authored key when exactly one candidate; novel and ambiguous untouched;
  deterministic batch-collision representatives; idempotent), and
  possibleDuplicateTopics — evidence-bearing pairs for the challenge layer.
- **Teaching (`@lucent/ai`, `@lucent/web`)**: visual-agent v5 and both
  meeting-extraction prompts teach topic reuse — the board's existing topics
  are the vocabulary. A mock reuse script + the golden
  topic-reuse-over-variant case pin the doctrine (offline gate stays at
  score 1).
- **Every machine-op boundary folds (`@lucent/server`, `@lucent/web`)**:
  generate (repaired re-emissions too), MCP ops, proposal approval, room
  commits with the ai actor, and the client's send/proposal paths. Human ops
  never fold — the room's user-actor batches and the HUD's applyManual are
  pinned untouched.
- **The challenge at authoring time (`@lucent/web`)**: the HUD topic field
  offers the board's authored keys and surfaces a possible-duplicate hint
  with statement-count evidence — Use adopts the existing key through the
  same validated edit path (an explicit user action), Keep dismisses.
- **The Ask payoff (`@lucent/server`)**: the digest's statements-by-topic
  section groups every spelling of a subject under one section, so "what
  happened with pricing?" reads as one answer even when authored keys
  disagree.
