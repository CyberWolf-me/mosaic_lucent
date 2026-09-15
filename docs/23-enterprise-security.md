# 23. Enterprise Security — the Figma/Miro-class advisory, audited

> **Status: the substrate is further along than the advisory assumes.** This
> document takes the 2026-09-15 security advisory (the four-part Figma/Miro
> comparison ending in "the production-grade security model I would build
> toward") and audits it against the code, docs/20-style: every claim checked
> against a file, existing capability costed at zero, real gaps turned into
> phases. The advisory's own references are Miro/Figma help-center pages; the
> competitive reality for Lucent is already recorded in docs/01's landscape
> audit (Miro AI controls, MCP admin scoping) — this doc maps those controls
> onto Lucent's actual surface.

## 1. What companies are protecting (the advisory's framing, accepted)

The advisory's question — _"Who can access which information, from where,
through what mechanism, and what can they do with it?"_ — is the right one,
and it is the shape Lucent's route layer already uses. Every board-scoped
route is org+board scoped at the store level (a leaked id is not a read:
`meetings.ts`'s `get(boardId, id)`, `pg-boards.ts` throughout), and the
authn/authz guards are functions over `RouteServices` (`routes/context.ts`)
precisely so a route cannot re-derive authorization wrong.

## 2. Coverage audit — advisory layer → code

| Advisory layer                                                   | What it asks                                      | Status                         | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity: email/password + OAuth                                 | Layer 1                                           | **Shipped**                    | `accounts.ts`, `oauth.ts` (ADR 0008: link by verified email, never by address guess)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Identity: SAML SSO                                               | Company IdP                                       | **Shipped**                    | `saml.ts`, ADR 0013 (verified in-house from the spec, no SAML framework; tested against a mock IdP)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Lifecycle: SCIM provisioning                                     | IdP-driven create/deactivate                      | **Shipped**                    | `scim.ts`, `/scim/v2/Users` create/list/PUT/PATCH (M6) + `pg-scim-identities.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Deactivate revokes sessions                                      | Employee-off → tokens dead                        | **Shipped**                    | `accountLifecycle.test.ts`, `sessions.ts` — account disable invalidates sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2FA                                                              | TOTP                                              | **Shipped**                    | `totp.ts` (hand-rolled RFC 6238), `totpStore.ts`, login flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Authorization: workspace/board roles                             | Viewer/editor/owner                               | **Shipped**                    | `roles.ts`; role-gated realtime commits (a viewer's edit is refused with `permission`, live-verified two-account)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Authorization: one shape, not per-route logic                    | Guards as functions                               | **Shipped**                    | `routes/context.ts` `RouteServices` (docs/20 §15: "a route cannot re-derive authorization wrong")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tenant isolation as invariant, tested per surface                | Org A cannot read Org B                           | **Shipped + extended (P5)**    | `crossTenant.test.ts` over REST/WS/share/members/delete + P5's added MCP/assets/exports/webhooks/search arms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| orgId in every access path                                       | `WHERE org_id = $1 AND board_id = $2`             | **Shipped**                    | Store layer scopes by org+board; `audit_log.org_id` is a real FK (ADR: stores carry org anchors)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Audit logs                                                       | Who did what, to what, when                       | **Shipped**                    | `orgs.ts` `audit()`/`auditFor()` + `audit_log` table; `GET /api/orgs/:id/audit` with keyset pagination + CSV export (audit-export, audit-store suites; the PG twin's silent-write defect was found and fixed by parity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Audit actors beyond the user                                     | AI agent / integration / system                   | **Shipped**                    | ADR 0017: every op-log entry carries user/ai/system + initiatedBy/approvedBy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| External actions recorded                                        | Execution ledger as security record               | **Shipped**                    | `integrations/ledger.ts` — exactly-once, recovery, the record of every external effect (ADR 0031)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Webhook signature verification                                   | No unsigned inbound                               | **Shipped**                    | `integrations/webhook.ts` — raw-bytes HMAC per provider (Linear 64-hex, etc.), dedupe, human review before any op (ADR 0033)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| MCP through the same backend, user-scoped                        | "AI permissions cannot exceed the user's"         | **Shipped**                    | `packages/mcp` → `POST /api/boards/:id/ops` with the user's session token; the server re-stamps actor identity; same validator, same authorization — no second backend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Integrations: scoped, not god-mode                               | Data minimization on outbound                     | **Shipped (payload level)**    | Adapters send the action's title/description + a `<!-- lucent-action:… -->` marker — never the board, never the transcript (`integrations/linear.ts` createTask shape)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AI provider controls                                             | Which provider processes content                  | **Partial (deployment + BYO)** | One operator-configured provider per deployment (`provider.ts`); per-request BYO key behind `LUCENT_ALLOW_BYO_KEYS=1`, refused-not-ignored when off (`modelRouter.ts`) — the key is used once, never stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| No-training answer for providers                                 | Default: content not used to train                | **Honest, not enforceable**    | docs/06's audited note: no cross-provider no-training header exists; the answer is provider terms until a per-workspace provider policy or a self-hosted model exists. The advisory's stronger ask (contract/self-hosted) is S3 below                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Content access ≠ AI access                                       | Read-board without send-to-AI as a separate grant | **Shipped (board-level)**      | A `restricted` board is readable by its members while AI, integrations, sharing, and agent reads are all refused — the split lives on the classification axis, not a second role system (docs/24 §10's one-shape rule). Per-user AI grants remain S2's policy plane (docs/24 Phase B)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Classification (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED)         | Policy depends on classification                  | **Shipped (board-level)**      | `boards.classification` (migration 0028), three tiers — PUBLIC dropped as a no-op label (docs/24 Phase A, freeze honesty rule). Every outbound boundary enforced server-side: AI (generate/stream/ask; in-process mock exempt), integrations (7 routes), sharing (link mint), agent (ops route + `x-lucent-client: mcp` reads); owner-only validated writes, fail-closed on an uninterpretable tier. Org floor + inheritance are S2 (docs/24 Phase B)                                                                                                                                                                                                                                    |
| Org-level policy engine (sharing, AI, MCP, recording, retention) | Admin policy above the board                      | **Shipped (policy plane)**     | `organizations.settings` jsonb (migration 0029) + `GET/PATCH /api/orgs/:id/settings` (owner floor, strict 400s, one audit row naming every changed key): the classification floor via `stricterOf` (inheritance read at decision time, not copy-on-write — a board created before the policy is governed by it, and no board label can lower it), `ai: "disabled"` (reaches even the in-process mock), and the sharing/agent/recording denials, all enforced by `checkOutboundFor` at Phase A's gates + `orgPolicy` at the capture routes (docs/24 Phase B). **Retention (S5) / residency (S4) stay evidence/infra-gated** — the settings plane is the mechanism, not those two policies |
| Data residency                                                   | Region-pinned orgs                                | **Not built**                  | Single-database deployment; residency is an infrastructure decision (docs/20 P7's "regional infrastructure, evidence-gated")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Encryption at rest                                               | PG/object/backups                                 | **Not built**                  | Deliberately unclaimed everywhere (checklist, docs/06); relies on the platform's disk encryption today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Independent retention (audio/transcript/intelligence)            | Per-class lifetimes                               | **Trivially satisfied**        | No audio is stored at all (docs/22 §2); transcript lifetime = board lifetime. A retention-policy engine is only needed once a class can outlive its board                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 3. The security model, as it actually stands

```text
ORGANIZATION (orgs.ts: members, roles, audit, SAML/SCIM identity)
   │  session cookies (httpOnly, ADR 0003) or bearer tokens; TOTP
   ▼
RouteServices guards (routes/context.ts) — authn → authz, one shape
   │
   ├── boards: owner-scoped REST, role-gated WS commits, share links
   ├── meetings: board-scoped transcripts (leaked id ≠ read)
   ├── integrations: proposal → approval → ledger → adapter (scoped payload)
   ├── MCP: same ops route, same validator, user's own token
   └── AI: operator provider or one-shot BYO key; usage-metered
   ▼
PostgreSQL (org_id FKs everywhere; audit_log; op log = the who-did-what)
   ▼
Object storage (asset bytes; metadata in PG — M7)
```

The advisory's §24 diagram (policy engine over workspace over AI/MCP/
integrations) is the _target_; the diagram above is today. The distance
between them is exactly four unbuilt surfaces, below.

## 4. The gaps, as phases

Ordered by docs/17's freeze clauses — security gaps are clause-1 (production
safety) work when they are vulnerabilities in shipped surfaces, and Gate C/D
work when they are new governance surfaces customers have not yet asked for.

### S0 — corrections this audit found (do first, cheap)

- **docs/06's security status note is stale.** It says audit logs, SSO, and
  data-retention controls are "not implemented" — SAML SSO, SCIM, TOTP, and
  the audit log (+viewer/export) all shipped since. Fix the doc so the repo's
  claims stay auditable. _(Done in the same commit as this doc.)_
- **Verify the entitlement surface covers exports** (it does:
  `entitlements.ts` `checkFormat` — export formats are plan-gated, so the
  "who exported what" story has a billing anchor).

### S1 — classification (the advisory's keystone ask)

> **Shipped 2026-09-16** as docs/24 Phase A: `src/classification.ts` +
> `boards.classification` (migration 0028), the four-boundary matrix
> (`internal`/`confidential`/`restricted` — PUBLIC dropped), and server-side
> enforcement on generate/stream/ask, the integration routes, share minting,
> and the agent surfaces (op-apply route + MCP-marked reads). Pinned by
> `classification.test.ts` (policy table + every boundary reached through its
> route + PG parity) and the crossTenant matrix's classification row. What
> remains is S2: the org-level floor the board tier feeds into.

- Add a classification field to boards/orgs (the four-tier set or its
  Lucent-appropriate subset — start from what users will actually set, per
  the freeze's honesty rule).
- Gate the **external boundaries** on it first — where the advisory's model
  and Lucent's existing seams meet:
  - BYO-key AI on a classified board (today: deployment-wide flag only)
  - external integrations (payload already minimized; add the "may leave at
    all" gate)
  - MCP access (Miro's own precedence)
- Ship as internal-only at first; enforcement over every outbound boundary is
  the deliverable, the tier labels are just the input.

### S2 — org-level policy (the admin plane)

> **Shipped 2026-09-16** as docs/24 Phase B: `organizations.settings` (jsonb,
> migration 0029) read through `effectiveSettings` — which resolves absence
> to the permissive default and an uninterpretable stored value to the
> restrictive one, the same fail-closed discipline Phase A set for tiers —
> enforced at every existing gate by `checkOutboundFor` (AI, sharing, agent,
> and the org floor for integration) and at the capture routes by
> `orgPolicy.recordingDisabled`. Owner-only `GET/PATCH
/api/orgs/:id/settings`, strict-validated (a typo is a 400, never a stored
> surprise), one audit row per change naming the changed keys with from→to.
> Inheritance is structural, not a batch: the gates read the org row at
> decision time. What the plane deliberately does NOT carry yet: per-org
> provider allowlist (S3/Phase C), retention (S5), residency (S4).

- The advisory's admin policy list — external sharing, public links, MCP,
  AI providers, retention — as org settings with server enforcement, not a
  client toggle. Boards inherit; org beats board.
- Audit every policy change (the audit stream already has the shape:
  `action` + actor + target).

### S3 — provider policy per org (the AI boundary)

- The advisory's "AI Data Policy Engine": per-org provider allowlist (or
  "private/self-hosted only"), keyed into the existing provider selection
  seam (`provider.ts` + `modelRouter.ts`) — which is already built to refuse
  rather than ignore, the right default.
- The no-training answer then becomes enforceable for self-hosted/
  contracted providers and honestly "depends on provider terms" otherwise
  (docs/06's current text, promoted to a per-org setting).

### S4 — encryption at rest + residency (clause-1 or infrastructure)

- Encryption at rest for PG/object storage/backups: today the platform's
  disk encryption carries it; an in-app layer is a real decision (key
  management, search implications — it fights the retrieval seam's
  substring queries; the advisory itself notes encryption is "only one
  layer"). Cost it before building.
- Data residency: an infrastructure/deployment decision (region-pinned
  databases), evidence-gated like docs/20 P7's regional item — same ledger.

### S5 — retention as policy (when a class outlives a board)

- Only needed once some class can outlive its board (archived intelligence,
  kept recordings). Audio never being stored keeps the strictest case free.
- When built: per-class lifetimes as org policy (S2's surface), enforced by
  the existing job/sweep substrate (P3/P4 families — retention sweeps are
  exactly the `maintenance` family's shape).

## 5. What this plan deliberately does not build

- **No separate "AI permissions" role zoo.** The advisory's content-access ≠
  AI-access split is real, but the implementation path is classification
  (S1) + the proposal boundary, not a second parallel permission system —
  one authorization shape is the repo's rule (routes/context.ts, docs/20 §15).
- **No resident audit of reads** (Miro-style access logging for every GET).
  The op log already records every mutation with full actor attribution; read
  auditing multiplies write volume for an enterprise ask that has not
  arrived. Gate C.
- **No encryption theater.** A bespoke at-rest layer that the retrieval seam
  then has to defeat (or that breaks substring search) is worse than the
  platform layer. Decide with S4's costing.
- **No biometric anything** (docs/22 §6 — same stance).
