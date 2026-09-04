---
"@lucent/web": minor
"@lucent/i18n": minor
---

Stage C6: the Intelligence view — the current semantic workspace, surfaced as a projection (ADR 0026). All six statement kinds first-class in one sectioned view; the recommendation inbox closes C5's loop.

- **The projection (`@lucent/web`, `intelligence.ts`)**: six sections in
  fixed order — decisions, proposals, questions, actions, requirements,
  risks — open statements prominent, settled ones dimmed (visible, never
  deleted). Rows carry the authored topic, supersedes, and the ✦ meeting
  evidence; the assignee appears when the node also carries work tracking
  (the Board bridge, made visible). Topic grouping reuses C5's own variant
  rule. Pure, node-tested — the view only renders what these functions
  decide.
- **The view**: collapsible sections with always-visible counts and
  per-kind glyphs; the uniform evidence contract — label click reveals the
  node, ✦ jumps to the meeting at the exact turn. Pure client-side over
  the workspace the client already holds: zero fetches, identical for
  shared and local boards.
- **The recommendation inbox**: possible duplicate topics with their
  evidence (statement counts per side, meetings of origin). Merge previews
  exactly what will update ("nothing will be deleted") and commits
  UPDATE_STATEMENT ops through the same validated, undoable path as any
  human edit — only the explicit click applies a recommendation. Keep
  dismisses change-aware-ephemerally: an unchanged pair stays suppressed
  for the session; any statement change re-arms the question.
- **Spec (`@lucent/i18n`)**: the full intel.* string family, en + hu.
