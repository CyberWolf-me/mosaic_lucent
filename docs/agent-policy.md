# Lucent — Parallel-Work and Integration Policy

> Enforceable rules for concurrent agent work. Tooling:
> `scripts/cto/worktree.mjs` (isolation), `scripts/cto/integrate.mjs`
> (scope + review + merge gates). Prompt text alone enforces nothing.

## 1. Isolation (§6.1)

- Integration target is local `main`. Each implementation task gets its own
  branch `feat/<task-id>-<slug>` and its own worktree (sibling of the main
  checkout, never nested inside it).
- Parallel implementation is allowed only when contracts and file ownership
  do not overlap. Overlap → serialize, with explicit ordering recorded on
  the blocking task.
- Shared files (`packages/server/src/app.ts`, schemas, migrations) require
  CTO-coordinated ownership: one writer at a time, named in the task.
- A worktree is Git-level isolation, not a security sandbox. Untrusted
  workers get restricted credentials and environments — a separate setup
  decision, tracked per task.
- Cleanup of dirty or ambiguous work requires explicit approval. Lease
  expiry never deletes uncommitted work (recovery inspects first).

## 2. Dependencies (§6.2)

- Implementation starts only when every dependency is `done` (enforced in
  `store.js`; read-model mirrors it for planners).
- Interface contracts needed by parallel tasks are agreed and reviewed
  first. Work that depends on an unfinished interface stays `blocked` or
  is explicitly rescoped to interface-independent parts.

## 3. Scope enforcement (§6.3)

Before review and integration, tooling compares changed paths
(`merge-base` vs branch head) against the task scope:

- Matches `prohibited_paths` → reject.
- Outside `allowed_paths` → reject unless the scope change is approved and
  the spec revision is bumped (visible, never silent).
- Generated files must trace to their sources; unexplained files reject.
- Secrets/config (`.env*`, credentials, signing keys) outside scope
  reject unconditionally.

## 4. Integration (§6.4)

Only the designated integrator merges into local `main`, via
`integrate.mjs`, which in order: confirms ACCEPT review by a distinct
reviewer → confirms base revision currency → inspects full diff + scope →
merges (conflicts resolved explicitly, never auto-resolved silently) →
runs post-integration checks → records the integrated commit → marks
branch evidence stale. Never merge on green unit tests alone.

## 5. Founder approval gates (§6.5)

Explicit, separately-recorded approval is required before: pushing to any
remote; deploying anywhere; touching production infrastructure; running
production migrations; changing secrets/credentials; any destructive or
irreversible operation outside the local repo. Approval records name the
action AND the target; one approval never covers a different action.
`integrate.mjs` cannot push or deploy — no flag exists for it.
