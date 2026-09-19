# 0036 — The execution era's close: consolidation, the recovery contract, and the D-numbering's honest end

- Status: Accepted
- Date: 2026-09-08

## Context

D1 through D9 shipped the execution era: the action model (D1), the
plan fixture (D2), the dependency graph (D3), the adapter architecture
(D4), exactly-once external execution (D5), Linear as the first real
provider (D6), inbound sync (D7), GitHub + Jira + the capability
honesty layer (D8), and the narrowing agent (D9). The owner's D10 plan
review (9.4 → approved with the eight fixes folded in) defined the era's
close as consolidation, not extension: measurement completed, garbage
collection made safe, the era's contracts locked in one regression, and
the record made true. The freeze rule governed: no new features, no UI.

## Decision

**THE LINK-GC RECOVERY INVARIANT (the era's last lock)**: _link garbage
collection removes stale Lucent linkage, but must NEVER turn an existing
external task into an unrecognized task on the next synchronization._
The GC defines dead as **board missing OR node missing** (links are
sync state, not audit — a deleted board's links are as dead as a
deleted node's). The fix is on the CREATE side: both the sync route and
the approve executor, on an unlinked action node, call
**`recoverCreate(marker)` FIRST** — found → RELINK the existing
external task; not found → create. The marker is the FULL ANCHORED
comment `<!-- lucent-action:key -->` — the closing delimiter is
load-bearing: `ext_task-1` as a bare tail is a substring of
`ext_task-10`'s marker, and the anchor prevents that prefix collision.
The marker derives from the node id, so it is stable across node
recreation. A failed LOOKUP falls through to the create (the D6
contract's own not-found semantics) — the recovery is an optimization
toward the no-duplicate invariant, never a new failure mode. Pinned by
the review's exact scenario: create → sync → LIN-482 → delete node →
GC → recreate with the same id → sync → RELINKED, zero new wire
creates.

**THE COMPLETE TERMINAL SETS + THE PRUNE-REPLAY RULE**: webhook events
terminal = **processed | ignored | exhausted** (failed is RETRYABLE —
the claim ladder's semantics — and is never pruned by the terminal
arm); inbound changes terminal = **applied | dismissed | superseded**.
The 30-day prune is structurally safe: `WHERE status IN (terminal set)
AND the terminal-timestamp < cutoff` — the completion timestamp, never
createdAt. Pruning a dedupe record must never revive stale state: the
second barrier is SEMANTIC — the receiver's parse emits only the
payload's own state, the ingest's resolution-level dedupe (live board
value vs the mapped value) makes a stale replay a no-op, and the D7
sweeper's refetch-current-truth arm is the stale-state authority.
Pinned: a replayed webhook after the prune does not duplicate the queue
row when the board state is unchanged.

**THE EXECUTION-LEDGER RETENTION (Option B, recorded)**: D5 ledger
rows are retained **indefinitely** — they are the authoritative
idempotency + audit substrate, bounded by actions-per-board, not by
events. The revisit trigger: only if a board's ledger rows exceed a
production-observed bound does a snapshot-and-truncate design open; no
such bound has been observed.

**BOUNDED SWEEP BATCHING**: every sweeper arm iterates with a LIMIT —
link GC ≤500 links/org/run (the new `linksForOrg(orgId, limit)`), the
terminal prune ≤1000 rows/run for both webhook events and inbound
changes (`pruneTerminal(olderThan, limit)` on both the in-memory and
PG twins) — no arm ever loads an org's whole link set or an unbounded
table.

**THE TELEMETRY COMPLETION**: the D9 ai-propose event was emitted but
uncounted. D10 closes it: `aiPropose` in the snapshot's request
counts, a P50/P95 latency lane, and the Prometheus bridge
(`lucent_ai_propose_total` counter + `lucent_ai_propose_duration_
seconds` histogram) with **ZERO dynamic labels** — no provider, no
board, no org, no kind. The cardinality rule is pinned by test: the
series' label set is the fixed empty vocabulary.

**THE ERA REGRESSION**: one process, isolated stage harnesses — each
stage's own `createApp`, its spine assertion, teardown, then the next:
D1 persist/undo/redo → D3 cycle-refused/edge-accepted → D4 10 actions
→ 10 tasks → 10 links → D5 the failed-create retry names only the
failed node → D6 Linear creates land on a stubbed wire → D7 the inbound
route mounts + the queue's initial state → D8 one node, links for two
providers → D9 the narrowing selects 4 of 10, exactly 4 on the wire.
The SPINE, not a tenth copy of every assertion — the stageD\*.e2e files
remain the depth; no shared mutable world between stages.

**THE D-NUMBERING'S HONEST END**: D10 is the era's close, not a feature
stage. Each deferred thread is named for its own future milestone, and
none inherits "D11": the execution dashboard / plan view; OAuth +
multi-tenant credentials; Jira inbound webhooks; Figma/Slack adapters;
scope enforcement (the refusal stands). The freeze rule holds — the
era's close is the record, not an extension.

## Consequences

- The GC is now a no-duplicate primitive: the create-side recovery
  makes "collect the link" safe by construction, because the next
  sync finds the external task by its stable marker instead of
  creating an unlinked twin. The sweeper's logs distinguish
  board-missing from node-missing deaths.
- The approve executor's timeout race now starts FRESH per create
  (after the recovery), not before it — the recovery's poll budget no
  longer consumes the create's timeout. This was a real bug the era
  regression surfaced: the timeout promise was constructed before the
  recovery awaited, so any recovery slower than the timeout rejected
  the create that followed.
- The measurement surface is complete: every user-visible flow now has
  a counter and a latency lane, and the Prometheus series obey the
  cardinality rule by test, not by convention.
- The era regression is cheap to run and honest about isolation: eight
  `it()` blocks, eight fresh harnesses, one process — a spine drift
  anywhere in the era fails loudly there, while the stage e2es hold
  the depth.
- The record is true: AGENTS.md's three stale claims (the asset
  metadata "still deferred", the MCP tool list missing
  `list_external_links`, "Storage: none") are corrected with the
  code's actual state; docs/17 carries the era-closing amendment; the
  checklist's era ledger records what shipped, what was deferred, and
  where each deferral lives.
