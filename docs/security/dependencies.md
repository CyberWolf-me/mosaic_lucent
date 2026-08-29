# Dependency posture

The one-page answer to "what are we running, and is any of it a problem?".
Read alongside `docs/security/threat-model.md`, which says what we defend
against; this says what we depend on while doing it.

## The gate

CI (`audit` job, `.github/workflows/ci.yml`) runs:

```
npm audit --package-lock-only --omit=dev -w @lucent/server --audit-level=high
```

— scoped to the tree the server image actually installs, high and critical
only. The same job prints the whole-tree audit (`--audit-level=low`) as
informational. The reasoning is written in the workflow file next to the
command: the gate must assert something true about the artifact that ships.

Secret scanning runs first, from gitleaks' own pinned image, before any
`node_modules` exists.

## The advisory that drove this file (resolved)

**GHSA-gpj5-g38j-94v9** — SQL injection through improperly escaped dynamic
identifiers in `drizzle-orm < 0.44.0`. Status: **fixed**. Both pins moved
together:

| Pin                                        | Was                                 | Now              |
| ------------------------------------------ | ----------------------------------- | ---------------- |
| root `package.json` devDep                 | `0.38.4` (exact, held the lockfile) | `0.45.2` (exact) |
| `packages/server/package.json` runtime dep | `^0.38.x`                           | `^0.45.2`        |
| `package-lock.json` resolved               | `0.38.4`                            | `0.45.2`         |

The upgrade was breaking (0.x), so it moved with a pass over the pg-\* store
suites rather than as a drive-by. The original triage note — that
`packages/server` is the only workspace importing drizzle-orm and no
`sql.identifier()`/`sql.raw()` call site exists, so the vulnerable path was
unreached — was re-checked during the bump and held.

That triage pattern is the reusable part: for a reachable-path question,
grep the codebase for the vulnerable API before deciding urgency. The
absence of the API is a fact; "we don't think we use it" is not.

## Pins and why

| Dependency                  | Pin / range    | Why pinned exactly or ranged                                                                                                                                         |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm` (root)        | `0.45.2` exact | The root devDep is what holds the lockfile; a caret here would let the lockfile and the runtime dep drift apart on the next `npm i`.                                 |
| `drizzle-orm` (server)      | `^0.45.2`      | Runtime dep; caret admits patches. The lockfile fixes the resolution.                                                                                                |
| `drizzle-kit`               | `^0.30.1`      | Dev-only; generate/migrate tooling. Not in the shipped image.                                                                                                        |
| `pg`                        | `^8.13.1`      | Runtime; `pg` has a conservative release history.                                                                                                                    |
| `ws`                        | `^8.21.3`      | Runtime; the realtime path.                                                                                                                                          |
| `zod`                       | `^3.25.0`      | Runtime, and **the AI contract**: `@lucent/core` derives the MCP tool schema and the validator from it. A major bump (v4) is a schema change, not a dependency bump. |
| `react` / `react-dom`       | `^18.3.1`      | Browser-only; never in the server image.                                                                                                                             |
| `livekit-client`            | `2.22.1` exact | Voice; pinned because LiveKit's server protocol versions matter client-side.                                                                                         |
| `@huggingface/transformers` | `^3.8.1`       | On-device Whisper (browser). Largest chunk in the web bundle; code-split.                                                                                            |

Tooling pins live in the workflows: gitleaks `v8.30.1`, k6 `v1.4.0`, Helm
`v3.16.2` — each with the same rule, stated in the workflow comments: **a
release of a detector or a measurer is a rule change, and a rule change
arrives as a commit here, not as a surprise red build.**

## What we deliberately do not run

- **No `npm audit` gate on the full tree.** It fails on Vite dev-server
  advisories that the shipped artifact never executes. Those are still
  printed, read, and fixed deliberately.
- **No Dependabot auto-merge.** Every bump runs the Postgres-backed suite
  first; the breaking drizzle bump is the case that justifies the manual
  step.
- **No vendored dependencies.** A lockfile with resolved URLs + integrity
  hashes is the reproducibility tool; a vendor directory would be a second
  copy to audit and a false sense of review.

## Reviewing an advisory, step by step

1. Is it in the server image's runtime tree? (The scoped audit answers
   this; if no → informational, fix on the next touch.)
2. Is the vulnerable API reachable? Grep for the symbols the advisory
   names. `docs/runbooks/incident.md` is the escalation path when the
   answer is "yes, and it's exploitable."
3. Is there a fixed version? Bump both pins (exact root + caret workspace),
   reinstall, run the pg-\* suites, then the full suite. If the fix is
   breaking, the pass over the affected suites is not optional.
4. If no fix exists: document the reachability finding here, in the
   table above, so the next person inherits the decision rather than
   re-deriving it.

## Related

- `docs/security/threat-model.md` — the adversary model this posture serves.
- `.github/workflows/ci.yml` (`audit` job) — where the gate lives, with the
  reasoning inline.
- `docs/runbooks/rotate-secrets.md` — what to do when a credential, not a
  dependency, is the problem.
