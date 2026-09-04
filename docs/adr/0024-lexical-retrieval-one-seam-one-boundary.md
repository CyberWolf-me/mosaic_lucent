# 0024 — Lexical retrieval: one seam, one boundary

- Status: Accepted
- Date: 2026-09-04

## Context

Stage C's fourth item. By the end of C3 Lucent had accumulated boards,
meetings, transcripts, statements, provenance, and a revision window —
and exactly one way to reach any of it backwards: ask the model a question.
The owner framed the gap as two different capabilities users now need:
**Search** ("find the pricing discussion") and **Ask** ("what changed about
pricing?") — and chose to build both in C4, sharing one retriever, rather
than force a user who already knows what they are looking for to ask an AI
question about it.

Two owner decisions shaped the stage:

1. **Scope**: search + Ask retrieval — a `GET /api/boards/:id/search` route,
   the ⌘K palette on top of it, AND retrieval inside the Ask pipeline.
   Deliberately small: ⌘K → query → ranked results → navigate, plus an
   "Ask Lucent about these results" bridge. No advanced syntax, filters,
   saved searches, or a search page.
2. **Scorer**: weighted lexical, not embeddings. The corpus is structured
   (labels, topics, statements, quotes, turns, revision labels) — structured
   enough that term matching is strong — and lexical is deterministic,
   cheap, explainable, testable offline, and adds no provider dependency or
   infrastructure. The owner's rule for embeddings: add them only when real
   usage shows lexical failing ("how do we make money?" vs "monetization
   strategy"), not before.

The C4 recon found the load-bearing facts. The ask route already loads the
entire searchable corpus (windowed meetings, windowed op log, full
workspace) — so retrieval is pure computation over data already fetched:
no new store, no index, no migrations, nothing persisted (ADR 0023's
derived-disposable rule). The entitlement floor — not the digest caps —
is the trust boundary: citation validation already accepts anything inside
the window, so retrieval widens recall inside a boundary it cannot widen
itself. And the corpus the digest hides is real: unclassified turns are
projected nowhere (the C1 askContext comment explicitly named them search's
corpus), meetings past the 10-meeting cap and nodes past the 200-node cap
are similarly invisible.

## Decision

**One seam, one boundary, two consumers.**

1. **The seam**: `retrieve(query, corpus)` in `packages/server/src/retrieval.ts`,
   with `buildSearchCorpus` assembling from caller-provided inputs. The
   scorer is weighted lexical: node label 5, statement topic 4, statement
   kind/status and nodeType 3, provenance quote and revision label 2,
   transcript turn text 1. Normalization is the owner's list and nothing
   more: NFKD + case fold, punctuation split (digits survive — `$15` is the
   token `15`), a single symmetric plural fold, ≥3-char prefix match, and a
   shared-stem rule (≥4 common prefix, short tails). Query tokens dedupe by
   folded form and cap at 12. Ranking is score-desc with a deterministic
   tie-break (node → turn → revision, then key), capped at 20. Every hit
   carries `matched` — the query tokens that fired — so results explain
   themselves ("Matching: pricing, 20"), never a similarity score. An
   embeddings scorer later swaps in behind the same signature without
   touching Search or Ask; if it needs durability (stored vectors), it gets
   its own ADR first, per ADR 0023's rule.
2. **The boundary**: the corpus contract. `buildSearchCorpus` receives only
   what the caller already windowed — the same `loadVisibleLog` +
   `visibleMeetings` arithmetic the history and ask routes use (the filter
   moved to `meetingsWindow.ts` so ask and search share one floor). A Free
   caller's revision 26 is not filtered out of results; it was never in
   the corpus. Search sees exactly what Ask sees — the acceptance
   criterion, tested in both the route suite and the definition e2e.
   Search is viewer-floor, no CSRF (a GET), no meter: pure computation over
   reads the caller is already entitled to.
3. **Two consumers, no coupling**: the search route returns ranked hits
   for the palette; the ask route runs the same retriever over its own
   context and passes up to 8 hits as `AnswerRequest.retrieved` (the
   "Retrieved evidence" prompt section, historian v4, each hit enveloped
   as data). The Ask bridge in the palette does NOT send the result list
   as context — it submits the question and Ask's own retrieval surfaces
   the same evidence. Search results are not Ask context; both are
   projections of the same window.
4. **Navigation rides C1**: every hit maps onto the existing citation
   contract — node → `?reveal`, turn → `?meeting` + `?turn`, revision →
   `?rev` — through `searchHitTarget`. Search invents no fourth navigation;
   each target view's flash/highlight comes for free. Turn hits cite the
   meeting (the three-kind rule) and name the turn index in hint text, the
   same coordinates turnRange and the transcript jump use.
5. **Honest windows extend to search**: the response carries
   `windowTruncated` — older content exists beyond the entitlement and was
   NOT searched — and the palette shows the disclosure line, so "no
   results" never reads as "nothing else exists."

**Deliberately not built**: embeddings, pgvector, any vector store (the
seam exists precisely so they can wait for the evidence); a palette
"Boards" section (cross-board search needs client-side orgId plumbing that
exists nowhere in the web app — the Dashboard is local-projects only; a
batch-sized addition once a session-me/orgId surface exists); shapes in
the server corpus (the local palette scan keeps covering them; the server
corpus is the content the local scan cannot see — the transcript and the
log); pagination (fixed top-20); an MCP search tool; advanced syntax,
saved searches, analytics, cross-org search.

## Consequences

- Unclassified turns are reachable at last: the corpus the digest never
  shows is fully searchable, inside the entitlement window. This closes
  the promise the C1 askContext comment made when it chose to project only
  classified turns.
- The Ask answer can now cite evidence it was never shown before — an
  unclassified turn's meeting, an over-cap node — without any change to
  citation validation, because the validator already accepts the whole
  window. Retrieval cannot widen access by construction.
- The envelope family gained `retrieved-hit` (HARNESS_TAG_PATTERN), caught
  by a test the same hour the section was written: a hit body containing a
  literal `</retrieved-hit>` would otherwise have broken the envelope —
  the "envelope is theatre" failure mode the pattern's comment names. Any
  future envelope tag joins the family.
- The local palette scan survives unchanged for local boards; server
  search is additive, gated on a shared board being open.
- Weights and folds are tuning knobs, not architecture. What must hold:
   the seam signature, the corpus contract (caller-windowed only), the
   three-kind citation mapping, and the deterministic ranking (the offline
   eval and the golden gate depend on reproducibility).
- `matched` tokens are part of the public hit shape: the palette renders
  them, so changing the normalization rules changes what users see on
  every row — the explainability contract.
