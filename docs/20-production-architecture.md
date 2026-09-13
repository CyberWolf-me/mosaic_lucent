# 20. Production Architecture — the advisory, audited, and divided into phases

> **Status: plan, not shipped.** This document takes the 2026-09-13
> production-architecture advisory (39 numbered points) and divides it into
> implementable phases. Every claim about "already exists" below was audited
> against the code, not the advisory's guesses. The phases contain only real
> gaps — where the advisory asks for something the codebase already does, the
> audit row says so and costs nothing to build.
>
> **Freeze legality (docs/17).** Everything in P0–P6 is production safety,
> measurement, or infrastructure — docs/17's clause 1 — not new product
> features. One item (P4's async `/api/image`) changes a shipped contract;
> it is flagged for an owner decision when that phase opens, because it is
> the only place this plan touches user-visible behavior.

## 1. The verdict, and what it means here

The advisory's conclusion (§39): **a modular, server-authoritative monolith
with PostgreSQL as canonical durable state, WebSockets for realtime delivery,
`pg_notify` for cross-instance coordination, object storage for assets, a
durable job/worker layer for expensive asynchronous workloads, and
comprehensive observability.** No microservices, no Kafka, no CRDT, no
Redis-as-truth.

Lucent already **is** most of that. The audit below maps every advisory
section to the code that satisfies it. The actual work is concentrated in
four areas, and the phases follow them in dependency order:

1. **Groundwork** — the two architecture diagrams, the state taxonomy, one
   real Helm defect, and one unmade multi-instance decision.
2. **Async substrate** — correlation IDs, domain events, the transactional
   outbox, then the job system, scheduler, and worker process that the
   advisory's §7–§9 describe. The codebase already names this future:
   `email/http.ts` says _"a durable outbox is the right answer and belongs
   with the job runner, not here."_
3. **Multi-instance correctness** — the in-process rate limiter, the WS
   ticket store, and what two instances actually break.
4. **Observability completion** — the SLO burn alerts that exist as prose in
   `docs/reliability/slo.md` become PrometheusRule manifests wired to the
   runbooks that already exist.

## 2. Coverage audit — advisory section → code

| Advisory | What it asks | Status | Where |
| --- | --- | --- | --- |
| §1, §34, §39 | Modular monolith; the not-build list; split only on evidence | **Already the shape** | npm workspaces, six packages; ADR 0001 (no CRDT), 0004 (pg_notify over Redis); nothing on the not-build list is present |
| §2 | Canonical / derived / ephemeral state separation | **True in code, unwritten as doctrine** | Canonical = op log + snapshots (`store/pg-boards.ts`), meetings, ledger; derived = intelligence/search projections (ADR 0026, `retrieval.ts` — "the seam is `retrieve(query, corpus)`"); ephemeral = presence/cursors. The taxonomy itself has no ADR → P0 |
| §3–§5 | Operation protocol order (persist before broadcast); no CRDT/Kafka | **Shipped (Stage B)** | `room.ts` commit path; `boardSync.ts` resync-on-reconnect; ADRs 0001/0009/0016 |
| §4, §20 | Realtime in three layers; notify = `{boardId, seq}` not payloads | **Shipped (M3)** | `store/pg-fanout.ts` (LISTEN on a dedicated client, resync-on-reconnect, `FANOUT_MAX_PAYLOAD_BYTES` guard) — the message shape is exactly the advisory's |
| §6 | AI orchestrator boundary; model outside the mutation boundary | **Shipped** | `generate.ts` pipeline (context → provider → schema → semantic validation → repair); ops validated before commit; ADR 0005 |
| §7 | Expensive AI becomes a job | **Gap** | `/api/generate`, `/api/generate/stream`, `/api/image` all run on the request path → P3/P4 |
| §8 | Three worker families | **Gap** (nothing async exists yet) | → P3 (substrate) then P4 (families) |
| §9 | Sweeps leave the API process | **Gap** | `main.ts:551–807`: four `setInterval` arms (usage/limiter/ticket prune, Stripe sweep, execution-ledger sweep + link GC, webhook sweep, op-log prune) → P3 |
| §10, §11 | One Postgres, logical domains; scale order indexes→replicas | **Already so** | 38 distinct tables across exactly the advisory's identity/workspace/meetings/execution/integrations/platform domains; pool `max: 10` (`db/client.ts`); no premature sharding |
| §12 | Redis only on measured need | **Stance already held** | None installed. But the in-memory `Limiter`/`UsageTracker` are the honest multi-instance gap → P5 |
| §13 | FTS + pgvector before Elasticsearch, behind the seam | **Seam exists** | ADR 0024: one retrieval boundary; pgvector is an implementation detail behind it → P7 |
| §14 | Assets: bytes in object storage, metadata in Postgres | **Shipped (M7)** | `assets.ts` blob backend (memory/disk/S3) + `pg-assets.ts`; no blob columns in the DB |
| §15 | Identity → session → org → board → action authorization | **Shipped** | `routes/context.ts` `RouteServices` is designed around exactly this: guards are functions, not stores, so a route cannot re-derive authorization wrong |
| §16 | Tenant isolation as invariant, tested through every surface | **Mostly shipped** | `crossTenant.test.ts` (REST, WS, share links, members, deletes); audit arm: MCP/assets/exports/webhooks paths → P5 extends the test matrix |
| §17 | Provider factory + exactly-once ledger + human-gated inbound | **Shipped (D4–D8)** | `integrations/provider.ts`, `ledger.ts`, `inbound.ts`; ADRs 0030–0036 |
| §18, §19 | Domain events + transactional outbox | **Gap** | Only `telemetry.subscribe` (metrics) exists; no outbox anywhere → P2 |
| §21 | One correlation ID per request, domain IDs where applicable | **Partial** | `requestId` per request (`app.ts` `requestIdOf`, `x-request-id` echoed, in error bodies) but it does not flow into telemetry events, generate outcomes, or the ledger's `providerRequestId` → P1 |
| §22 | Mandatory metrics | **Mostly shipped** | `/metrics/prometheus`; generate outcome ledger, product counters, AI p50/p95 (`telemetry.ts`); missing only queue/worker metrics, which arrive with P3 |
| §23 | Alerts mapped to runbooks | **Prose only** | SLOs + burn alerts written in `docs/reliability/slo.md`; runbooks exist (`docs/runbooks/`); no PrometheusRule manifests in the chart → P6 |
| §24 | CI → image → registry → staging → smoke → prod | **Mostly shipped** | `ci.yml` (PG service, typecheck, tests, build), `codeql.yml`, scheduled k6 `load.yml`, `release.yml`, image pinned by sha, deploy/rollback runbooks. No staging definition → P6 |
| §25, §35 | Kubernetes as orchestrator; split criteria | **Stance held** | Helm chart, PDB, ServiceMonitor; replicaCount 2. One chart defect found in audit → P0 |
| §26 | Stateless API servers | **Partial** | Durable state is in PG ✓; rooms documented as live projections ✓; but in-memory `Limiter`, `UsageTracker`, `InMemoryTicketStore` are process-local → P5 (note: `gateMonthly` entitlements ARE Postgres-backed — only the sliding-window/day counters are not) |
| §27 | Room = live projection, resync on reconnect | **Shipped** | `realtime.ts`, `boardSync.ts` lastSeenSeq catch-up, fanout resync replay |
| §28 | Layout as its own subsystem, heavy layout off the main thread | **Shipped past the advisory** | `core/src/layout.ts` engines + `DiagramLayoutEngine` boundary; ELK in a nested Web Worker with respawn and fallback (ADRs 0038/0039) |
| §29 | MCP through the same backend, never a second one | **Shipped** | `packages/mcp` → `POST /api/boards/:id/ops` + `RemoteBoardSession`; same validator, same authorization |
| §30–§33 | Request/meeting/execution/inbound lifecycles | **Shipped** | §30 = generate pipeline end to end; §31 = meeting routes + transcripts + provenance; §32/§33 = ledger claim/recovery + human-gated inbound queue |
| §36 | Company-scale picture | Reference | Nothing to build; the P0 diagrams are its present-day form |
| §37 | The priority list (Now/Next/Later) | **The input to this doc** | P0–P7 below are its 18 items re-sequenced by dependency |
| §38 | One mutation path invariant | **True, unpinned** | Every surface converges on the validated op log. Deserves an ADR so it survives future contributors → P0 |
| §39 | Two diagrams: logical + runtime | **Gap** | §3 and §4 below close it |

## 3. Logical architecture (the first diagram)

```text
                    @lucent/core          @lucent/ai
                 semantic model + ops     provider harness
                        ▲                     ▲
                        │ validated ops      │ prompts/streams
                        │ (never canvas)     │
┌───────────────────────┴─────────────────────┴──────────────┐
│                     @lucent/server (monolith)              │
│                                                            │
│  HTTP routes ── WebSocket rooms ── MCP bridge               │
│       │              │                  │                   │
│       │        authn/authz guards (one shape: RouteServices)│
│       │              │                  │                   │
│       ▼              ▼                  ▼                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │            application services (P1 formalizes)      │   │
│  │  boards · meetings · integrations · assets · billing  │   │
│  │  search (one seam) · notifications · identity        │   │
│  └─────────────────────────────────────────────────────┘   │
│       │              │                                     │
│       ▼              ▼                                     │
│  op log (truth)   domain events + outbox (P2)               │
│       │              │                                     │
│       │              ▼                                     │
│       │        job system (P3) ── workers (P4)             │
└───────┼──────────────┼─────────────────────────────────────┘
        ▼              ▼
   PostgreSQL      Object storage (assets)
```

## 4. Runtime architecture (the second diagram)

```text
                      CDN / WAF
                          │
                    Load balancer ── sticky for /ws? (P0 decision)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
      lucent-api × N              lucent-worker × K   (P3; same
            │                           │              image, role
            │  HTTP + WS + MCP           │  claims jobs by family:
            │                           │  AI · media · integrations
            │                           │
            ├───────────┬───────────────┬┘
            ▼           ▼               ▼
       PostgreSQL   pg_notify      Object storage
        (truth)    (coordination)    (asset bytes)
            │
            └─ outbox → dispatcher → consumers (P2)
                              │
                    observability (logs/metrics/traces)
```

Today the right column does not exist: one process serves HTTP/WS and runs the
sweeps on timers. P3 splits the roles; everything else in this picture already
runs.

## 5. The phases

### P0 — Groundwork: diagrams, doctrine, one defect, one decision

No behavior change. Makes the target explicit so later phases have something
to diff against.

- [ ] This document (§3, §4) — the two diagrams the advisory's closing point
      asks for.
- [ ] **ADR 0040 — the state taxonomy.** Canonical: op log, snapshots,
      meeting transcripts + provenance, execution ledger, integration links,
      identity/org state. Derived: search corpus, intelligence projections,
      plan/execution views, metrics, rollups. Ephemeral: presence, cursors,
      in-memory caches, WS connection state. Rule: a cache never becomes
      truth; a projection never becomes a second database; a provider link
      never enters workspace semantics. (All three rules are already followed
      in code — ADRs 0024/0026/0033 — this ADR states the class invariant.)
- [ ] **ADR 0041 — one mutation path.** §38's invariant, pinned: user, AI,
      MCP, and inbound webhooks all converge on the same authenticate →
      authorize → validate → commit → persist → seq → broadcast path. The
      test that proves it already exists implicitly across suites; name it.
- [ ] **Fix the Helm chart autoscaling defect.** `deployment.yaml:7` gates
      `replicas` on `.Values.autoscaling.enabled`, but `values.yaml` defines
      no `autoscaling` block and no HPA template exists. Setting
      `autoscaling.enabled=true` in an overlay silently drops the deployment
      to **1 replica** (undefined → falsy). Either add the values block +
      `hpa.yaml` template, or remove the conditional. Acceptance:
      `helm template` with and without the flag renders the intended replica
      count; `helm lint` passes.
- [ ] **Decide the WebSocket routing model** (decision recorded, code in
      P5). `InMemoryTicketStore` is process-local **by design** —
      `two-instance.test.ts` pins that a ticket minted on A does not work on
      B. With two API instances behind the ingress (no session affinity
      configured, `ingress.yaml` carries no sticky annotation), a client that
      mints a ticket on A and whose WS upgrade lands on B is rejected ~50% of
      the time. Two options: (a) `PgTicketStore` — 60 s TTL, single-use,
      cheap, keeps the ingress stateless; (b) sticky routing on the ingress.
      Recommendation: (a); the store interface (`realtimeTicket.ts`) already
      admits a second implementation.

### P1 — Correlation IDs end to end (advisory §21)

`requestId` exists per HTTP request (`app.ts:1509`–`1580`: honored from
`x-request-id` or generated, echoed back, in error bodies and access logs).
It stops at the route.

- [ ] Thread `requestId` into `telemetry.record` events (the fixed vocabulary
      in `telemetry.ts` gains an optional `requestId` field, keeping the
      cardinality rule — it is a log field, not a metric label).
- [ ] Carry it through `handleGenerate`/`handleGenerateStream` so a
      generation outcome row names the request that caused it; same for
      `/api/image` and Ask.
- [ ] Map the advisory's domain IDs onto what already exists rather than
      inventing: `requestId` (everywhere), `boardId` + op `seq` (mutation
      path), meeting id (transcript rows), `lucentActionId` +
      `requestId` (execution ledger — already the idempotency key shape),
      `providerRequestId` (Stripe events). Gap: connect requestId → these
      records so one id follows browser → API → AI → op → PG → WS → provider.
- [ ] **Acceptance:** a single `/api/generate` request's id appears in the
      access log line, the telemetry generate event, and — on failure — the
      error record. Test: capture the echoed `x-request-id`, read
      `/metrics`, assert the same id in the outcome event.

### P2 — Domain events + transactional outbox (advisory §18, §19)

The substrate everything async in P3/P4 rides on. The advisory's problem
statement: DB transaction succeeds but event publish fails, or vice versa.

- [ ] Migration: `outbox_events` table — `id` (uuid), `type`, `board_id?`,
      `org_id?`, `payload` (jsonb, small — notification-shaped, never op
      payloads; the fanout payload-size rule applies), `created_at`,
      `dispatched_at?`, `attempts`, `last_error?`.
- [ ] Writes are **inside the transaction that changes state**:
      `BoardOperationCommitted` (with the op's seq, not the op),
      `MeetingEnded`, `ProposalApproved`, `ExternalTaskSynced`,
      `IntegrationSyncCompleted`, `StripeEventApplied`. Only commit points
      that already exist gain a row — no new mutation paths.
- [ ] Dispatcher: in-process poller (SELECT … WHERE dispatched_at IS NULL
      ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED — same
      first-wins/re-claim discipline the execution ledger uses,
      `store/pg-integrations.ts:432`), delivering to in-process subscribers.
      At-least-once; consumers idempotent by `event.id`.
- [ ] First consumers, chosen from what the code already wants:
      transactional email (the recorded hook in `email/http.ts` — the
      durable outbox it says belongs "with the job runner"), the search
      corpus invalidation hint, product counters (replacing direct
      `telemetry.record` calls where an event already carries the fact).
- [ ] In-memory dev path: the outbox degrades to a synchronous dispatcher
      when no `LUCENT_DATABASE_URL` — matching how every other store in the
      repo is optional (ADR 0006).
- [ ] **Acceptance:** (1) commit succeeds, process dies before dispatch →
      after restart the event still delivers (test kills the dispatcher
      between commit and delivery); (2) duplicate delivery is observable and
      harmless (consumer records `event.id` once); (3) an event row written
      outside a transaction is impossible in review (lint rule or convention
      note).

### P3 — Job system, scheduler, and the worker process (advisory §7, §9)

The advisory's §9: `setInterval` in the API process means N instances run N
sweeps. §37's "Now" list names moving the sweeps; this phase builds the
substrate and does that move.

- [ ] Migration: `jobs` table — `id`, `family` (`ai` | `media` |
      `integration` | `maintenance`), `type`, `payload` jsonb, `status`
      (`queued` | `claimed` | `done` | `failed`), `attempts`, `run_after`,
      `claimed_by?`, `claimed_at?`, `result?`, `created_at`. Claim =
      **generalize the existing ledger claim triad** (first-INSERT-wins on a
      unique key, status-guarded re-claim restating `isReclaimable` in the
      WHERE, stale window) — it is already proven in
      `integrations/ledger.ts` + `pg-integrations.ts`; do not invent a new
      concurrency model.
- [ ] Worker entrypoint: `src/worker.ts` in `@lucent/server` — same image,
      `LUCENT_ROLE=worker`, no HTTP listener, claims by family, graceful
      drain. One queue, Postgres-backed, no Redis (ADR 0004's stance holds
      until a measured need).
- [ ] Scheduler: `LUCENT_ROLE=scheduler` (or leader-election-free: the job
      claim itself dedupes) enqueues recurring jobs — sweep-stripe,
      sweep-execution, sweep-webhooks, link-gc, prune-history — on the
      intervals `main.ts:551–807` uses today. The `unref()`'d timers are
      deleted from the API process; single-process dev keeps working via
      `LUCENT_ROLE=all` (default), which runs scheduler+worker in-process —
      the compose file's one-server mode is unchanged.
- [ ] Move the sweeps (their bodies are already pure, testable functions —
      `sweepStripeEvents`, the ledger sweep, webhook sweep): each becomes a
      job handler registered against a family.
- [ ] docker-compose: add a `worker` service (same image, `LUCENT_ROLE=worker`)
      so dev/prod parity is visible locally.
- [ ] Metrics: queue depth per family, oldest queued job age, claim rate,
      attempt counts — the advisory §22 additions that only exist once a
      queue does.
- [ ] **Acceptance:** two API instances + one worker: exactly one sweeper
      claims each tick (race test mirroring `two-instance.test.ts`'s commit
      race); `LUCENT_ROLE=all` dev mode behaves as today; the API process
      has no `setInterval` sweeps.

### P4 — The three worker families (advisory §8)

Families, not microservices — same repo, same image, one process per family
when scaling demands it (`lucent-ai-worker × M` etc.).

- [ ] **AI worker** — the family with a real workload today:
  - [ ] `/api/image` becomes a job when the provider is not the mock:
      POST returns `{jobId}` + status endpoint; progress rides the P2 outbox
      → WS/notifications; result commits as an operation (image shape) or
      asset link, never a direct canvas write. **Owner-decision flag:** this
      changes a shipped synchronous contract — the freeze amendment records
      the justification (request-slot exhaustion is production safety, but
      the client change is user-visible).
  - [ ] Large `/api/generate` (node count over a measured threshold) opts
        into the same path; small generations stay streaming-sync — the
        advisory's §7 distinction, and the streaming UX depends on it.
  - [ ] Meeting finalize processing moves behind the family when the
        transcript is large (the extraction itself stays synchronous for
        now; the boundary is what this phase builds).
- [ ] **Media worker** — create the lane honestly empty: PDF parse, export
      rendering, SVG processing have no async workload in the codebase
      today. The family exists so the next one lands in the right place;
      the phase's deliverable is the claim path + one real handler
      (heavy export, if measured slow) or a documented empty registry.
- [ ] **Integration worker** — the P3 sweeps live here; add provider polling
      and reconciliation jobs (recovery-first retry already implemented in
      the sweep body — it moves, not changes).
- [ ] **Acceptance:** one expensive image job does not occupy an HTTP slot
      (load test: p95 of a concurrent small generate stays flat while a job
      runs); job results appear through the same operation protocol (no
      worker ever writes the canvas directly — §38's invariant holds).

### P5 — Multi-instance correctness: the real gaps (advisory §12, §26)

Everything durable already survives two instances (proven by
`two-instance.test.ts` + `scripts/deploy-rehearsal.ts`). Three process-local
states do not:

- [ ] **Rate limiting across instances.** `Limiter` (`limiter.ts`) and the
      `UsageTracker` sliding-window/day counters (`usage.ts`, in-memory by
      its own doc comment: "a shared store (Redis/Postgres) is the swap-in
      when multiple instances exist, behind this same interface") are
      per-process — 2 instances = 2× the limits, and the auth limiter too.
      Implement the Postgres fixed-window counter behind the existing
      interfaces (Redis stays out until a measured need, per ADR 0004 and
      advisory §12). Monthly entitlements are already PG-backed
      (`gateMonthly` → `pg-usage.ts`) and need nothing.
- [ ] **WS tickets** — execute P0's decision (recommended `PgTicketStore`:
      mint/consume as single SQL statements, 60 s TTL, single-use; the
      interface and the in-memory store's test shape carry over).
- [ ] **Ingress**: sticky annotation documented in `charts/lucent/README.md`
      if (b) was chosen; if (a), note that the ingress stays stateless.
- [ ] **Extend the rehearsal:** `deploy-rehearsal.ts` gains a third instance
      + a worker; assertions: rate limit enforced across instances (hit A
      and B alternately, total = limit), ticket mint on A / upgrade on B
      connects.
- [ ] **Tenant-isolation audit arm** (advisory §16): the crossTenant matrix
      (`crossTenant.test.ts` covers REST/WS/share/members/delete) extended
      to MCP ops, assets, exports, webhooks, and search — the surfaces that
      shipped after the suite was written.
- [ ] **Acceptance:** all rehearsal assertions green under
      `LUCENT_DATABASE_URL`; a second instance never grants
      `2 × perWindow`.

### P6 — Observability completion: alerts as code (advisory §22, §23)

The metrics exist; the SLOs and burn alerts are prose in
`docs/reliability/slo.md`; the runbooks exist in `docs/runbooks/`. What is
missing is the wiring.

- [ ] `charts/lucent/templates/prometheusrules.yaml` — the slo.md alerts as
      PrometheusRule: API error-rate burn, p95 latency, AI provider failure
      rate, WS reconnect spike, PG connection saturation, queue depth/age
      (from P3), webhook backlog, execution failure spike. Every rule's
      annotation names its runbook file — the advisory's "every alert must
      map to an action/runbook" made mechanical.
- [ ] Queue/worker dashboards once P3's metrics exist (Grafana dashboards
      optional; the rules + runbooks are the deliverable).
- [ ] Staging definition in the deploy runbook: the advisory's CI → staging →
      smoke → prod path, using the existing image pinning and rollback
      runbook.
- [ ] **Acceptance:** `helm template` emits the rules; each rule annotation
      resolves to an existing file under `docs/runbooks/`.

### P7 — Later, evidence-gated (advisory §11, §13, §36)

None of this is built until a measurement demands it — the advisory's own
stance, and docs/17's Gate D.

- [ ] pgvector behind the retrieval seam (ADR 0024 keeps it an
      implementation detail) when semantic search is asked for by evidence.
- [ ] Read replicas for history/metrics reads when the primary shows read
      pressure; partition/archive the op log when its size says so.
- [ ] Redis only where a measured need appears (distributed locks at real
      worker counts, ephemeral presence at scale).
- [ ] Regional infrastructure, specialized services — split only on the
      advisory's §35 criteria: independent scaling, independent deployment,
      failure isolation, team ownership, different runtime.

## 6. What this plan deliberately does not build

The advisory's §34, restated as this repo's stance (all already doctrine —
ADR 0001/0004, docs/06): no microservice split, no Kafka, no Redis as
primary state, no per-module databases, no CRDT rewrite, no AI service with
its own workspace state, no second MCP backend, no ELK as source of truth,
no Kubernetes-specific business logic. The P3/P4 workers are **processes
from the same image**, not services — the split the advisory describes
happens only on §35's evidence.

## 7. Sequencing and gates

```text
P0 (groundwork) ──► P1 (correlation) ──► P2 (outbox+events)
                                            │
                     ┌──────────────────────┘
                     ▼
              P3 (jobs+worker) ──► P4 (families) ──► P7 (evidence-gated)
                     │
                     ▼
       P5 (multi-instance gaps) ──► P6 (alerts as code)
```

P1 is independent of P2 and could run in parallel; P5's ticket decision
comes from P0 but its implementation only needs P0. Every phase ends the
way the repo's stages do: tests + typecheck green, a live verification note,
and an amendment in `docs/17`'s ledger. The freeze's clause 1 (production
safety) and clause 2 (measurement) cover P0–P3 and P5–P6 outright; P4's
`/api/image` contract change is the one owner decision this plan carries.
