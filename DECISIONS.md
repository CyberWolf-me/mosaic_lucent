# Lucent — Engineering Decision Index

> Append-only index of consequential decisions for the CTO-agent control
> plane. Formal rationale lives in `docs/adr/`; this file records the
> decision, context, alternatives, consequences, status, and owner.
> Statuses: proposed / accepted / superseded / rejected.

## D-001 — Control-plane state split: specs in git, runtime in SQLite

- Date: 2026-10-15. Owner: CTO agent. Status: accepted.
- Context: the CTO-agent system needs task specs (reviewed like code) and
  live execution state (concurrent claims, leases, events).
- Decision: `tasks.json` (versioned, validated) defines work;
  `.cto/state.sqlite` (gitignored, shared via git-common-dir) records
  status/leases/attempts/evidence/events. No second editable status source.
- Alternatives: JSON-as-database (rejected: no transactions for concurrent
  claims); server-backed state (rejected: local-first, no new services).
- Consequences: worktrees share one `.cto/`; SQLite via `node:sqlite`
  (zero new deps; experimental flag tracked as risk R-001).

## D-002 — SQLite via node:sqlite (no new dependency)

- Date: 2026-10-15. Owner: CTO agent. Status: accepted.
- Context: need transactional local state; repo pins deps carefully
  (shell-quote override precedent); CI runs Node 22, dev runs Node 24.
- Decision: use built-in `node:sqlite` (available ≥22.5; verified on dev
  Node v24.12.0). No `better-sqlite3` (native build) and no pg-backed
  control plane (needs infra).
- Alternatives: better-sqlite3 (rejected: native module weight);
  drizzle/pg reuse (rejected: requires a database server for a local tool).
- Consequences / risk R-001: `node:sqlite` still carries an
  ExperimentalWarning; API drift would require a store-layer patch, which
  is isolated in `scripts/cto/lib/store.js`.

## D-003 — run.boardId generations are validate-only (proposeOnly)

- Date: 2026-10-15. Owner: CTO agent. Status: accepted (implemented,
  merged in `e1ac5fc`, verified: server suite 179 files / 1598 tests).
- Context: `c24fa98` added a `run.boardId` fallback to `/api/generate`
  (+`/stream`), flipping advisory generate-then-client-commit flows into
  auto-commit; socket re-commit of the same ops was rejected
  (`trust-review`, `s6-ai-ask-presence` — 3 failures).
- Decision: `run.boardId`-sourced requests validate authoritatively but
  set `proposeOnly: true` (`app.ts:5133,5341`); only top-level `boardId`
  auto-commits through `commitBatch`. Verified against source + git
  history before recording.
- Alternatives: revert the fallback (rejected: collaborators need
  authoritative validation); make socket commits idempotent-replay the
  server commit (rejected: larger change, conflates two contracts).
- Consequences: the "generation is a run; client commits under it"
  contract holds; ENG-003 pins it with regression tests.

## D-004 — Integrity-convergence merge without push

- Date: 2026-10-15. Owner: CTO agent (founder directed). Status: accepted.
- Context: branch `feat/core-integrity-convergence` (B1–B5 fixes + proposal
  gating + edge-origin hardening) verified green with D-003 on top.
- Decision: merged locally as `e1ac5fc`; `main` is 8 ahead of
  `origin/main`. No push without explicit founder approval (ENG-007).
- Consequences: local `main` is the integration target for the
  control-plane build; remote release stays blocked.

## D-005 — Control-plane tests via node:test, outside vitest gates

- Date: 2026-10-15. Owner: CTO agent. Status: accepted.
- Context: `scripts/cto/` is dependency-free `.mjs`; wiring into per-
  package vitest configs would entangle existing CI gates.
- Decision: adversarial tests run with `node --test scripts/cto/test/`;
  invoked explicitly (`verify.mjs`, CI addition is a founder decision).
- Consequences: zero config, zero new deps; coverage floors unaffected.

## D-006 — Authority rides in roles, never identities

- Date: 2026-10-15. Owner: CTO agent. Status: accepted (surfaced by the
  control plane's own adversarial suite: `transition` with a worker
  identity as actor).
- Context: `transition()` took a single `actor` that callers filled with
  worker identities (`w1`), which the table then rejected — or worse,
  could have been mistaken for authority.
- Decision: `transition()` takes a ROLE (`worker|reviewer|integrator|cto|
  founder`) plus an identity in `by` for the event record. `task.mjs move`
  requires `--actor <role>` explicitly. Same-worker live reclaim is
  refused (release first) so attempts are never orphaned.
- Consequences: every CLI and test passes roles; identities appear only
  in `by`, leases, and attempts.

## D-007 — Review verdict on ENG-005 (first pass: CHANGES_REQUIRED)

- Date: 2026-10-15. Owner: review-agent (independent context). Status:
  accepted as the review record; fixes applied same session.
- Context: 16 findings; 9 verified holds, 7 required action (integrate
  abort/new-commit guards, same-worker reclaim, event-text sanitization,
  secret-pattern coverage, generated-file tracing, ENG-002 scope overlap,
  §11 traceability). Foreign-file scope risk acknowledged, handled by
  selective commit (R-002).
- Decision: fix all 7, add `docs/acceptance-mapping.md` (§11 → code →
  test rows), extend the adversarial suite (37 tests), re-verify, and
  seek a second review before integration.

## Open risks

- R-001: `node:sqlite` experimental status (see D-002).
- R-002: foreign writes observed 2026-10-15 ~21:32 (`teamHarness.ts`
  +35/−9) and later (`package.json` `load:all-modes` script,
  `s8-all-modes-heavy-load.test.ts` new file) — uncommitted, author
  unknown, parallel scenario-test worker suspected. Left untouched;
  ENG-005/006 commits select control-plane paths only, and
  `integrate.mjs` scope-checks the branch diff before merging.
