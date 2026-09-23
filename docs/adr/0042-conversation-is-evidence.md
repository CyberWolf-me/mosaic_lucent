# 0042 — A conversation request is evidence, too

- Status: Accepted
- Date: 2026-09-23

## Context

Lucent's promise is that every AI-generated object can answer _who said
it, when, and in which words_ (docs/01). ADR 0022 made provenance a field
of the originating operation, and ADR 0028 added a second evidence family
(`createdFrom`, a plan's source statements). But the most common way a
board is built — someone describing it, by text or voice, in the board's
own conversation — carried **no evidence at all**. The provenance refine
required meeting evidence or source statements, so a chat-built board was
a board of orphans:

- "Why is this here?" on a node the model drew from "we take payments with
  Stripe" answered _No recorded source_ — and the old WhyThis panel went
  further and labelled every such node **"Created by human"**, which is
  false for exactly the nodes the AI made.
- The chat history that did hold the words lives only in the browser's
  local storage (8 turns reach the model); it never converges to peers, the
  server, or the op log, so it cannot be the answer either.

## Decision

**A request made to the board in conversation is the third evidence
family.** `ProvenanceFields` gains:

```ts
conversation?: { at: number; by?: string };
```

with the request's words in the existing `quote` (240 chars). The
at-least-one refine becomes _meeting OR createdFrom OR conversation_.

- **One writer, the existing helper.** The client's send path stamps it
  with `attachProvenance` — the same idempotent, fill-don't-overwrite
  helper ADR 0022 named — on every AI batch that is not a meeting extract
  (meeting evidence) and not a plan (createdFrom evidence, and a
  machine-written request). Because it rides the ops, it reaches undo,
  peers, the server's board and the op log with no new mechanism; a review
  proposal carries it because its ops were stamped before the gate.
- **The model never emits it.** Same rule as the other families: it cannot
  know who asked or when, and the prompt tells it never to emit
  provenance.
- **`at` is on the evidence — a deliberate, narrow exception to ADR
  0022's "no `extractedAt`".** That rule held because the op log's `at`
  already records creation time. For conversation evidence it does not
  hold: the op log is windowed by the `history.depth` entitlement (25 by
  default, ADR 0019), and local boards keep no timestamps at all
  (`OperationHistory.timeline()` reports 0). "When was this asked?" would
  become unanswerable after the 26th edit — exactly when a trail matters.
  Creation evidence is immutable (no operation rewrites it), so the
  second-source-of-truth drift 0022 feared cannot occur.
- **`by` is a display name, not an id**, capped at 80 characters, and
  optional (a signed-out local board records when and what, not who).
- The load schema (`workspaceSchema.ts`) restates the field — otherwise
  `parseWorkspace` would silently strip it from every persisted board.

## Consequences

- The node inspector answers "why is this here?" for chat-built nodes:
  _Lucent · from Sam's request · Sep 23, 14:12_ over the quoted words.
  Nodes with no evidence (hand-made, or built before this ADR) say
  **No recorded source** — never "created by human".
- A server running an older `@lucent/core` rejects conversation-only
  provenance (the old refine). Web and server deploy together from one
  build, so this only bites a hand-mixed local dev setup: rebuild core
  (`npm run build -w @lucent/core`) and restart the server.
- MCP agents and the server-side voice agent do not stamp conversation
  evidence yet; their changes remain evidence-less until they pass the
  requester through. That is the natural next writer, not a new mechanism.
- Test: `packages/core/test/conversation-provenance.test.ts` pins the
  refine, the caps, idempotent attach, no overwrite of meeting evidence,
  and survival through `parseWorkspace`.
