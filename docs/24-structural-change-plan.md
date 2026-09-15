# 24. Structural Change Plan — implementing the docs/22 and docs/23 audits

> **Status: Phase A shipped (2026-09-16); B and C next in order.** This is the
> implementation plan for the two structural change sets the 2026-09 advisories
> produced and docs/22 / docs/23 audited: the **meeting platform** (M-series)
> and the **enterprise security model** (S-series). The audits established what
> already ships and costed the gaps; this document orders the real work by
> dependency, names the exact seam each phase touches, and states the gate that
> proves each phase done — the shape docs/15, docs/18, and docs/20 all use.

## 1. What is actually being built

The audits collapsed the four advisories into two genuine work sets, plus one
correction already done:

| Set                                  | Doc     | Real work                                                                           | Frozen?                                    |
| ------------------------------------ | ------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| Production architecture (advisory 1) | docs/20 | **None** — P0–P6 shipped, P7 evidence-gated                                         | n/a                                        |
| Meeting platform (advisories 2–3)    | docs/22 | M6–M7 voice path, connectors, modes, diarization                                    | Mostly frozen (docs/17 Gate C/D)           |
| Enterprise security (advisory 4)     | docs/23 | S1–S5: classification, org policy, provider policy, encryption/residency, retention | S0 done; S1–S3 mixed; S4–S5 evidence-gated |

The freeze rule (docs/17) governs the ordering below. A phase is one of:

- **Legal now** — a correctness gap in shipped behavior (clause 4) or
  production safety (clause 1).
- **Legal on evidence** — Gate C/D must open first (users name the wall).
- **Legal, infra-gated** — collectable only with a measurement or a named
  infrastructure decision.

## 2. The plan at a glance

```text
DONE ──► S0 (doc corrections)                    this commit's predecessor
     └─► A (classification + outbound gating)    2026-09-16, docs/17 amendment

LEGAL NOW (correctness / safety)
  A  Classification field + outbound gating      S1   ─┬─ AI boundary   DONE
  B  Org policy plane (admin settings)           S2   ─┤─ sharing/MCP/retention
  C  Per-org provider policy                     S3   ─┘─ honest no-training

EVIDENCE-GATED (Gate C/D)
  D  Meeting modes as behavior profiles          M-modes
  E  External meeting connectors                 M-ext
  F  Diarization for shared-mic capture          M-diar

INFRASTRUCTURE-GATED
  G  Encryption at rest / data residency         S4
  H  Retention-as-policy                         S5   (only once a class outlives its board)

NOT IN SCOPE
  Voice assistant (M6) / proactive participant (M7) — the largest new
  subsystem; needs its own advisory + owner decision, not this plan.
```

The ordering is deliberate: **classification (A) before policy (B) before
provider policy (C)**, because policy needs something to key on and the
provider gate is one of policy's outputs. Meeting work (D–F) is independent of
the security chain and can proceed in parallel once its gates open.

## 3. Phase A — Classification and outbound gating (S1) — **SHIPPED 2026-09-16**

> Executed as the docs/17 amendment of the same date. `PUBLIC` was dropped (a
> label that gates nothing is a lie), the `agent` boundary is enforced on both
> MCP surfaces (op-apply + `x-lucent-client: mcp` reads), and `stricterOf` is
> deliberately unwired — it is Phase B's org floor, not an unused helper. The
> web picker ships with B's admin API. Full suite green against real Postgres.

**Why first.** It is the keystone of the advisory's model: every "may this
leave the org" decision reads a classification. It is also the one phase with
a defensible legal-now claim — today a RESTRICTED board's content can be sent
to the operator's configured provider with no org-level way to say no, which
is a governance hole in a shipped surface.

**Touches:**

- `core/src/workspaceSchema.ts` — a `classification` field on the board
  document (the four-tier set the advisory names, minus tiers nobody will set
  — start with the ones users actually choose; the freeze's honesty rule).
- `server/src/boards.ts` + `store/pg-boards.ts` — persist it; migration
  `00NN_classification.sql`; the InMemory twin is the spec, the PG pair
  matches (the repo's store convention).
- `server/src/routes/boardOps.ts` — the gate. Read classification before any
  outbound call; refuse with the existing 409/403 vocabulary, never
  silently degrade.
- `server/src/modelRouter.ts` — the BYO-key path and the operator provider
  both consult the gate (the seam already refuses-not-ignores; keep that
  shape).
- `server/src/integrations/integrations.ts` — the proposal path gains the
  "may leave at all" check on top of the existing payload minimization.
- `packages/mcp` — the ops route already carries the user's token; the gate
  is server-side, so MCP inherits it with no client change (that is the
  point of one mutation path).

**Acceptance:**

- A board classified RESTRICTED refuses external AI and external integration
  proposals with a named reason; an INTERNAL board is unaffected.
- Both stores (InMemory + PG) enforce it identically — a parity test, not two
  tests.
- `crossTenant.test.ts`'s matrix gains a classification row (org A's
  RESTRICTED board is not reachable by org B at any tier).
- Prettier/typecheck/full suite green; PG-gated suites run with
  `LUCENT_TEST_DATABASE_URL` set.

## 4. Phase B — The org policy plane (S2)

**Why second.** Policy is what makes classification useful at scale: an admin
sets the default once, boards inherit it, and the board-level field is an
override only where the policy allows one.

**Touches:**

- `server/src/orgs.ts` — `StoredOrg` grows a `settings` object (the interface
  is currently `{id, name, createdAt}` at orgs.ts:21); the `OrgStore` gains
  `setSettings`/`getSettings` with the audit hook every other mutation has.
- `db/schema.ts` + migration — a `settings` jsonb column (or a small typed
  table if any field needs an index; decide per field, not up front).
- `server/src/routes/*` — enforcement points, not new surfaces: sharing
  policy at the share/role-grant route, MCP policy at the ops route, AI
  policy at the generate route, recording policy at the meetings route.
- `server/src/app.ts` — the admin API (`GET/PATCH /api/orgs/:id/settings`)
  behind the existing org-admin authorization shape.

**Acceptance:**

- An org-level "external sharing disabled" makes every board's share link
  refuse, including boards created before the policy (inheritance, not
  copy-on-write).
- Every settings change writes an audit row naming actor, action, and the
  changed key.
- Policy beats board: a board-level override cannot loosen an org-level
  restriction (the direction matters and needs a named test).

## 5. Phase C — Per-org provider policy (S3)

**Why third.** It is the AI-policy output of Phase B made concrete, and it is
what turns docs/06's honest "depends on your provider's terms" into an
enforceable setting.

**Touches:**

- `server/src/provider.ts` + `modelRouter.ts` — resolve the provider through
  the org policy: an allowlist, or "operator provider only", or "self-hosted
  only"; the existing BYO refusal path is the precedent for how a disallowed
  request dies.
- `web/src/ui/Settings.tsx` — the current no-training text becomes a
  per-org setting the admin sets and every member sees.
- docs/06's note is updated to point at the setting rather than the caveat.

**Acceptance:**

- An org set to "self-hosted only" refuses a BYO cloud key with a named
  reason even when `LUCENT_ALLOW_BYO_KEYS=1` (org policy beats deployment
  flag — the opposite direction from Phase B's rule, and deliberately so:
  policy may restrict, never widen).
- The refusal is observable in telemetry as a policy refusal, distinct from
  a rate-limit refusal.

## 6. Phases D–F — Meeting work (evidence-gated)

These stay frozen until Gate C names the wall (docs/17). Recorded here so the
plan is complete; each is scoped enough to cost on demand.

- **D — Meeting modes as behavior profiles.** `MeetingView` today always
  runs extraction. A profile split (Record / Intelligence / Assistant /
  Participant) touches `meeting-extract.ts`'s trigger policy, the view's
  state, and the transcript store's `kind` field becoming optional-by-profile.
  Legal-now sub-case: if a user reports that a Record-only meeting still
  burned generations, that is clause 4 (shipped behavior wrong), not the
  feature.
- **E — External meeting connectors.** Zoom/Meet/Teams → turns. Lands on
  `integrations/provider.ts` (a new adapter family), reuses the exactly-once
  ledger and the human-gated inbound queue, and emits turns into the same
  `MeetingStore`. The convergence rule is already structural: a connector's
  only job is turns.
- **F — Diarization for shared-mic capture.** A fourth STT provider slot in
  `web/src/stt/` with `FinalMeta.speaker` filled from diarization labels, plus
  the advisory's identity-mapping step (announcement, not biometrics).
  Legal-now sub-case: a shared-mic meeting today attributes every turn to
  "You" — a correctness gap, not a feature, once anyone actually hits it.

## 7. Phases G–H — Infrastructure-gated

- **G — Encryption at rest / data residency.** Both are infrastructure
  decisions with real costs. Encryption-at-rest in-app fights the retrieval
  seam's substring queries (ADR 0024) — cost it honestly before choosing;
  platform disk encryption may be the right answer. Residency is a
  region-pinned deployment, same ledger as docs/20 P7's regional item.
- **H — Retention-as-policy.** Only needed once a class can outlive its
  board. Today audio is never stored and transcripts die with the board, so
  the strictest case is already free. When it is needed, the sweep belongs in
  the P3/P4 `maintenance` job family, not a new timer.

## 8. Gates and the commit register

Every phase ends the way the repo's stages do:

1. `npm run typecheck` + `npm test` green, plus the PG-gated suites with
   `LUCENT_TEST_DATABASE_URL` set (they skip silently otherwise).
2. A live verification note for anything with a runtime path (the P-series
   pattern: real Postgres, real routes, exact observed behavior).
3. One bisectable commit per phase, body naming mechanism + verification
   counts + anything found live. Migration + schema + store twins in the same
   commit as the code that needs them.
4. A row in docs/17's freeze ledger recording which clause the phase shipped
   under.
5. Update docs/23's coverage table rows from "Not built" to shipped — the
   audit table is the status source of truth, so it moves with the code.

## 9. Sequencing

```text
S0 (done) ──► A (classification) ──► B (org policy) ──► C (provider policy)
                                        │
                                        ├──► G (encryption/residency)   infra-gated
                                        └──► H (retention)              evidence-gated

D (modes) ──► E (connectors) ──► F (diarization)      independent chain, Gate C
```

A, B, C ship in order. D–F wait for evidence and can run in parallel with the
security chain once their gate opens. G and H wait for a measurement or a
named infrastructure decision, exactly as docs/20 P7 and docs/21's ledger
require. M6/M7 (voice assistant, proactive participant) are explicitly out of
this plan — they need their own advisory.

## 10. What this plan does not do

- **No service split.** docs/20's stance holds: same image, `LUCENT_ROLE`
  processes, no microservices.
- **No new authorization system.** Classification and policy feed the
  existing `RouteServices` guard shape; a second parallel permission model
  would violate the one-shape rule (ADR 0041's one mutation path, docs/20
  §15).
- **No read auditing, no biometrics, no encryption theater** — docs/23 §5's
  exclusions stand.
- **No implementation of frozen features.** Phases D–H are scoped, not
  started; starting one requires the gate to open first, and the gate is
  user evidence, not this plan's existence.
