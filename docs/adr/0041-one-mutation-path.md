# 0041 — One mutation path: every writer converges on the same commit

- Status: Accepted
- Date: 2026-09-14
- Drivers: docs/20 (the 2026-09 production-architecture advisory, §38)

## Context

Four very different actors can change a board: a human in the browser, the
AI generation pipeline, an external agent over MCP, and an inbound webhook
from Linear/GitHub/Jira (via the human-gated queue). Each arrives through
its own transport — WebSocket room, `POST /api/generate`, the MCP stdio
bridge, the inbound-change review flow — and it is architecturally tempting
for each to take a shortcut to "just apply the operations".

The advisory's §38 states the invariant this ADR pins: **one mutation
path**. Everything converges on the same authenticate → authorize → validate
→ commit → persist → seq → broadcast pipeline, and the model (or any
external system) stays outside the mutation boundary (ADR 0005).

## Decision

There is exactly one path from "someone wants the board changed" to "the
board changed":

```text
authenticate   (session / ticket / MCP session identity)
  → authorize  (org grant → board role → per-op capability)
  → validate   (Zod schema + core semantic validation against current state)
  → idempotent (requestId replay guard)
  → commit     (Room.commit — the room re-validates and sequences)
  → persist    (op log + snapshot; the store assigns seq)
  → broadcast  (WS room + pg_notify fanout)
  → ack        (the writer learns the seq)
```

Enforced facts, each already true in code, now pinned as one contract:

1. **No writer bypasses `validateOperations`.** The AI path validates before
   returning (generate.ts); the room re-validates at commit; MCP routes
   through `POST /api/boards/:id/ops` and `RemoteBoardSession` — the same
   validator, same authorization, same log (packages/mcp exists solely as a
   transport). An agent can never send an operation the validator would
   reject.
2. **No external system writes directly.** Inbound webhooks become queued
   `integration_inbound_changes` for human review (ADR 0033); approving one
   replays the canonical commit path as the acting user. Outbound execution
   is the ledger-gated provider path (ADR 0031). No direct AI → Linear, no
   direct browser → provider.
3. **Persist before broadcast.** A client can never observe state that is
   not durable (ADR 0009's ordering; the room's commit path).
4. **Undo and audit ride the same log.** Inverse operations, actor stamps,
   and provenance are log entries (ADRs 0017, 0022), not side channels.

The named test: `two-instance.test.ts` (the commit race), `crossTenant.test.ts`
(authorization on every surface), the MCP board-op suite (transport parity),
and the D7 inbound-queue suite (external → human → canonical) together pin
the invariant; a new writer that does not route through the pipeline is a
design regression, not a style choice.

## Consequences

- New mutation surfaces (a public API, a CLI, a future worker committing
  image-generation results) have one integration answer: call the pipeline,
  not the store. The worker families in docs/20 P4 commit through it.
- The operation schema stays the stable contract between every writer and
  the renderer (AGENTS.md's non-negotiable), because nothing else is
  allowed to mutate.
- Cost: an extra validation hop for internal callers that "already know"
  their operations are valid. That hop is what makes replay, authorization,
  and multi-instance safety free — the D6 live pass replayed a duplicate
  approval through the same ledger claim and it mattered.
