# The 2026-09 advisory review's roadmap, executed (2026-09-11, branch persist-test-measure)

The review's four phases, run to completion with the repo's own gates at
every step: fix → test → live check → commit. Eleven commits, tag
`review-phases-complete`, every phase's acceptance met by measurement
rather than assertion. The full inventory lives in the checklist and the
per-batch commits; this record is the run summary and the honest
deviations.

## What landed

- **Phase 0** (`572180f`, tag `p0-live-pass-fixes`): the live-pass fix
  batch — strict op contract on both agent entry points, room-first ops
  writes, the history-window fallback, the retry affordance — with the
  7/7 live seam smoke (`scripts/p0-smoke.ts`).
- **Phase 1** (`e0fc09d`…`3a183d0`): the visual benchmark (deterministic
  metrics over synthetic boards, 20→500, 33 invariant tests), the routed
  layered engine (cycle-safe layering, the wrap gate, `Edge.route`
  polylines — crossings 10,871→902 at 500 nodes, edge lengths 4–26×
  shorter), the zoom-density tiers (far out, only primary flow draws —
  verified live: corridors hide at 25%), and the composition derivation
  (main story → the AI summary). Live checks: routed polylines confirmed
  in the rendered SVG of the real app; short edges byte-identical.
- **Phase 2** (`4a4b21e`, `a6b4345`, `1dab3d6`): the generation outcome
  ledger (attempts = success + provider + validation + other, repairs
  separate; five label-free series — "is Lucent unreliable or the
  provider?" is a counter query now), the promote-endpoint truth fix
  (it shipped in M2.6; the stale checklist claim was the finding), the
  two-instance deployment rehearsal script (PG-conditional — CI runs the
  arms; local skips honestly), and the prompt-injection fixture (the
  human gate holds even when the selector worst-cases into the injected
  node).
- **Phase 3** (`53c5943`, `bdb5f92`): the attention layer — "What needs my
  attention?" on the execution dashboard, four signals, each a reveal
  jump, live-verified with a seeded blocked/overdue/decision board — and
  the §10 product analytics (board_created, share_link_created, and the
  activation distribution: signup → first board, observed once per org).

## Gates

Full suite green at every batch; final combined tree: core 513 /
web 678 / i18n 17 / server 1074 / ai 210 / mcp 28 — 2,520 passing,
typecheck 0 across six workspaces. Three live browser checks passed
(routed geometry in the SVG, zoom-density fade, the attention surface).

## Honest deviations

- **Postgres unavailable locally** (the known standing deviation): the
  rehearsal script's arms run in CI; locally it prints its skip line.
  The 91 PG-gated test skips remain CI-trust.
- **The host's C: drive reached 0 bytes mid-run**, breaking npm's fetch
  path and the dev servers once. Tests ran via the direct vitest/tsc
  binaries; the servers were restarted. System-level cleanup belongs to
  the operator.
- **Concurrent working-tree work appeared mid-run** — a coherent
  "UX-1/UX-2" feature set across 27 files, none of it this run's. It was
  left entirely untouched; it composes cleanly with the committed work
  (the combined tree is the one gated above), but its owner must decide
  its commit path — a blanket `git add` would mix workstreams.

## What this sets up

- The ELK question has its decision procedure (same fixtures, same table).
- The next live pass scores the human half (comprehension, cleanup time)
  against the benchmark baseline.
- The §10 counters are the instrument panel for Phase 3's real question —
  do teams activate, return, and execute — which needs the teams
  themselves. That is the roadmap's only remaining phase, and it is
  human-gated by design.
