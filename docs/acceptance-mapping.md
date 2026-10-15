# Lucent — Control-Plane Acceptance Mapping

> Traceability from the system spec's §11 acceptance conditions to the
> enforcing code and the adversarial test that pins it. A condition
> without a row here is uncovered by definition — add the row with the
> fix, never after it.

## Task integrity

| §11 condition | Enforced in | Pinned by |
|---|---|---|
| Specs validate; duplicates, bad deps, cycles rejected | `scripts/cto/lib/spec.js` (`validateTaskDocument`) | `test/spec-scope.test.mjs` → "task spec validation" (5 tests) |
| Illegal transitions fail | `lib/spec.js` (`TRANSITIONS` + `checkTransition`) | `test/spec-scope.test.mjs` → "central transition table" |
| No two active owners for one task | `lib/store.js` (`claim`, BEGIN IMMEDIATE) | `test/store.test.mjs` → "exclusive claims" (same + cross-connection) |
| Lease-expiry recovery destroys nothing | `claim` returns `recoveredFrom`; `worktree.mjs recover` is inspect-only | `test/store.test.mjs` → "expired lease reclaimable" |

## Worker execution

| §11 condition | Enforced in | Pinned by |
|---|---|---|
| Complete versioned contract | `context.mjs` (spec_rev pinned) | manual (contract content asserted in review) |
| Isolated worktree | `worktree.mjs create` (branch + worktree, collision checks) | manual (git-level; covered by policy + review) |
| Scope violations detected pre-integration | `lib/scope.js` + `integrate.mjs` step 3 | `test/spec-scope.test.mjs` → "scope enforcement" |
| Failures recorded truthfully | `verify.mjs` (timeout/fail recorded, never pass); `recordVerification` | `test/adapters.test.mjs` + `test/store.test.mjs` → "failed verification" |
| Bounded retries, then escalate | `tasks.json` `retry_policy` (max 2); attempts tracked | policy + `attempts` table (escalation is a CTO decision, recorded) |
| Adapters cannot bypass state | `lib/adapter.js` contract (no db handle); roles assigned by control plane | `test/store.test.mjs` → "identities carry no authority" |

## Verification and review

| §11 condition | Enforced in | Pinned by |
|---|---|---|
| Evidence binds revision + command | `verify.mjs` (branch/head/dirty_fp); `recordVerification` | `test/adapters.test.mjs` → parseCounts; records asserted in store tests |
| Fail/missing/skip/stale distinguished | `outcome` enum; `verificationIsStale` | `test/store.test.mjs` → "stale evidence detectable" |
| No self-approval | `recordReview` (reviewer ≠ worker) | `test/store.test.mjs` → "self-approval refused" |
| Integration requires ACCEPT | `integrate.mjs` pre-check + `store.js` guard | `test/store.test.mjs` → "integration requires ACCEPT" |
| Checks run against integrated source | `integrate.mjs` step 5 (`appliesToIntegrated`) | `test/store.test.mjs` → ACCEPT flow incl. verified gating |
| No final verification on missing evidence | `transition` to `verified` requires post-integration pass | `test/store.test.mjs` → verified refusal arms |

## Auditability

| §11 condition | Enforced in | Pinned by |
|---|---|---|
| Structured events with actor + task | `store.js` `event()` on every mutation | `test/store.test.mjs` → "event history" |
| Reports reflect stored records | `lib/report.js` pure functions of (tasks.json, rows) | `test/report.test.mjs` → determinism suite |
| No secrets in logs/reports | `sanitizeOutput` on command output + all event free-text + review/approval columns | `test/adapters.test.mjs` → "sanitizeOutput" |
| Deterministic generation; stale detected | footer `tasks.json#hash events<=seq`; `--check` re-renders and byte-compares | `test/report.test.mjs` → footer + byte-stability tests |
| Generated files trace to sources | footer provenance (current spec hash, no future watermark) in `integrate.mjs` step 4b; recency explicitly NOT gated there (integration appends events after the last report by construction — freshness is close-out regeneration + `--check`) | `test/report.test.mjs` → provenance arms |

## Integration and release control

| §11 condition | Enforced in | Pinned by |
|---|---|---|
| Explicit branch/worktree ownership | `claim` + `worktree.mjs create` | store claim tests |
| Shared-file conflicts deliberate | `docs/agent-policy.md` §1 + merge-base scope | policy (merge conflicts fail safe in `integrate.mjs` step 4) |
| Integration validates changed paths | `changedPaths` + `checkScope` | scope tests |
| Integration failure recoverable | abort-guard + return-to-review with reason | code path (adversarial git-state test deferred: requires fixture repo) |
| Push/deploy need founder approval | no push code path; `required_approvals` + single-use grants | `test/store.test.mjs` → "approvals gate done" |
| Final report names commit + risks | `renderFounderReport` (commit, push flag, failures, approvals) | `test/report.test.mjs` → founder report arms |

## Known gaps (not conditions, tracked)

- Git-level merge-conflict recovery has no fixture-repo test (row above).
  `worktree.mjs create/remove` flows are exercised manually, not in
  `node:test` — same reason. Both are candidates for a fixture-repo
  harness when the control plane gets its second worker.
