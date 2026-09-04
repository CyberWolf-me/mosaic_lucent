---
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
"@lucent/i18n": minor
---

Stage C4: semantic search — one lexical retriever, two consumers (the ⌘K palette and Ask), one entitlement boundary. No new store; the corpus is computed per request from the same windowed reads every other surface uses.

- **The retriever (`@lucent/server`)**: `retrieve(query, corpus)` — weighted
  lexical scoring with the owner's field weights, plural/prefix/shared-stem
  normalization, deterministic ranking, top-20. Every hit carries the
  matched query tokens, so results explain themselves ("Matching: pricing,
  20"), never a similarity score. The signature is the seam an embeddings
  scorer later swaps into behind (ADR 0024).
- **Ask retrieves (`@lucent/ai`, `@lucent/server`)**: the answer request
  gains `retrieved` evidence — the unclassified transcript turns and
  over-cap content no digest section ever shows, enveloped as
  `<retrieved-hit>` data in the prompt; historian v4; the mock demonstrates
  a retrieval-grounded answer citing the turn's meeting and naming the
  turn index.
- **The search API (`@lucent/server`)**: `GET /api/boards/:id/search?q=` —
  viewer floor, the same history.depth window as the history and ask
  routes (matching content beyond the window is absent from the corpus, not
  filtered from results), with an honest `windowTruncated` disclosure.
- **⌘K (`@lucent/web`, `@lucent/i18n`)**: on a shared board the palette
  searches the server (debounced, aborted per keystroke) — grouped node/
  transcript/revision results navigating through the existing citation
  jumps (?reveal / ?meeting+?turn / ?rev). The Ask bridge turns a search
  into a question without retyping. Local boards keep the local scan;
  the palette's i18n keys are wired at last, plus the new ones (en + hu).
