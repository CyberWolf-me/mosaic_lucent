---
"@lucent/ai": minor
"@lucent/web": minor
"@lucent/core": minor
"@lucent/server": minor
---

Stage A: the evidence-named fixes from the real-provider gate, plus the feature freeze.

- **Provider retry parity (`@lucent/ai`)**: the stream-restart contract — a
  failed attempt restarts the entire generation and discards the incomplete
  stream, never appends. A stream missing `message_stop` is classified as
  truncation in transit (retryable with backoff); a parse failure after it is
  the model answering badly (not retried). The named case is pinned: partial
  stream → retry → complete response → exactly one commit.
- **Semantic attribution rule (`@lucent/ai`, `@lucent/web`)**: genuine
  commitment or explicit tasking creates the action and its assignee in any
  meeting style; hedged or speculative mentions create no assignee and often
  no action. Both polarities are golden cases ("I'll think about it" → no
  task; "we should probably ask Sarah" → no assignee).
- **Provenance stable references (`@lucent/web`)**: `turnRange`/`turnKinds`
  stored as the stable reference (the quote is presentation); the selection
  HUD ✦ jumps to the Meeting view with the source meeting selected.
- **Storage data-loss guard (`@lucent/server`)**: in-memory + auth +
  production refuses to boot; dev warns loudly.
- **Non-destructive load (`@lucent/core`)**: dangling edges are retained on
  parse (render-layer skip is the belt) instead of silently deleted —
  load→drop→save no longer permanently removes them.
- **Live-gate CSS fixes (`@lucent/web`)**: regions are now collapsible with a
  real pointer (pointer-events on the region box and the bounds frame), and
  entrance animations no longer pin their final frame at animation
  precedence — which silently disabled the selection-focus grades, the
  spotlight dim, the hover lift, the presentation caption's centering, and
  disabled-item dimming.
- **The freeze (`docs/17`)**: no new features until a decision gate opens on
  user evidence; production safety, benchmarks, and fixes to shipped
  behavior stay legal. Decision gates: A (understand meetings) PASS; B
  (repeat usage), C (adoption blocker) need user data; D (which investment)
  is data-driven.
