# Lucent — Architecture

> Canonical architecture source for the CTO-agent control plane. Describes
> the system as built (verified against the checkout 2026-10-15), not as
> originally intended. `docs/adr/` owns per-decision rationale — linked,
> not duplicated. `AUDIT.md` is a 2026-10-09 snapshot: useful orientation,
> re-verify any detail before relying on it.

## 0. Preflight note

`AUDIT.md` §A describes nine packages and a split-brain generation pipeline.
Verified still true on 2026-10-15: `packages/` contains `ai, core, i18n,
load, mcp, server, site, voice-agent, web` (9 dirs); `planGenerator.ts`
now routes real providers through `provider.generatePlan` (no mock
fallback); `run.boardId` generations validate authoritatively without
auto-committing (`app.ts:5133,5341`). Treat all other audit detail as
leads, not facts.

## 1. Workspace / package map

| Package | Responsibility | Key entry |
|---|---|---|
| `@lucent/core` | Deterministic semantic engine: model, 38 Zod ops, validator, reducer, inverse undo, layout engines, statement/issue/provenance/trust, importers/exporters, SemanticPlan compiler, quality gate | `packages/core/src/model.ts`, `operations.ts`, `reducer.ts`, `layout.ts`, `compiler.ts`, `qualityGate.ts` |
| `@lucent/ai` | Provider harness: `LLMProvider` (Mock/Anthropic/OpenAI-compat), versioned prompts, intent fast-path, plan generation, response cache, golden evals | `packages/ai/src/provider.ts`, `prompt.ts`, `planGenerator.ts` |
| `@lucent/server` | Framework-free `node:http` + `ws` API: auth, boards, sequenced rooms, proposals, Ask/search, meetings, integrations, billing/meters | `packages/server/src/app.ts`, `room.ts`, `realtime.ts`, `generate.ts`, `orchestrator.ts` |
| `@lucent/web` | React + Vite SPA, bespoke DOM+SVG canvas (no canvas library), lenses, STT providers, realtime sync | `packages/web/src/workspace.tsx`, `boardSync.ts`, `views/` |
| `@lucent/mcp` | MCP stdio server exposing the validated op contract to external agents | `packages/mcp/src/tools.ts`, `remote.ts` |
| `@lucent/voice-agent` | LiveKit worker joining voice rooms with board-scoped grants | `packages/voice-agent/src/agent.ts` |
| `@lucent/i18n` | en/hu dictionaries with parity validation | `packages/i18n/src/index.ts` |
| `@lucent/load` | k6 load profiles | `packages/load/` |
| `@lucent/site` | Static marketing + status page | `packages/site/` |

Dependency direction: `web/mcp/voice-agent → server → ai → core`. `core`
has no React/DOM/network deps (framework-agnostic by rule).

## 2. Runtime and data flows

- **Canvas path:** `web` calls `POST /api/generate` (`app.ts`) →
  `runGeneratePipeline` (`generate.ts`) validates model ops against the
  workspace, returns them; the browser commits via WebSocket room or opens
  a server proposal for large batches. `POST /api/boards/:id/orchestrate`
  runs the plan→compile→quality-gate→commit pipeline (`orchestrator.ts`).
- **Realtime:** `Room` holds the sequenced, validated op log per board;
  `RealtimeServer` persists through it, broadcasts `op` frames, and fans
  out `op/presence/resync/proposal/spotlight/summon` across instances
  (`fanout.ts`; Postgres `LISTEN/NOTIFY` in multi-instance).
- **Persistence:** Postgres when `LUCENT_DATABASE_URL` is set (48
  migrations `0000`–`0046` under `packages/server/migrations/`), in-memory
  twins otherwise (ADR 0006). Assets via `POST /api/assets` to
  memory/disk/S3 blob backends.
- **Ask/search:** windowed reads (`history.depth` as read boundary, ADR
  0019) over op log + meetings; lexical retriever (`retrieval.ts`), no
  vector store.

## 3. Canonical mutation and authorization boundaries

- **One mutation path** (ADR 0041): HTTP commits go room-first via
  `commitBatch` (`server/src/commitBatch.ts`); the room re-validates,
  broadcasts, and persists. Direct `boardStore.put` behind the log's back
  is a defect class (see ENG-003).
- **Auth:** cookie sessions + bearer, OAuth (Google/GitHub), SAML 2.0,
  TOTP 2FA, SCIM 2.0, API tokens, short-lived Agent grants; CSRF + org
  policy + provider gates; roles owner/editor/viewer (+commenter),
  enforced server-side (`room.roleOf`, `memberRole`).
- **AI contract:** operations are the model's only interface (ADR 0005);
  tool schema derived from the same Zod union the validator accepts.
  Trust is stamped at the committer boundary (ADR 0047); `proposeOnly`
  marks validate-without-commit generations.

## 4. AI planning / semantic compilation boundaries

- `SemanticPlan` (`core/src/plan.ts`) → `compileSemanticPlan`
  (symbolic refs + unique-label alias resolution) →
  `evaluateTopologyQuality` → bounded repair → commit (`orchestrator.ts`).
- `repairOperations` (`core/src/repair.ts:152+`) resolves symbolic
  (`n1`) and unique-label references in the direct-op pipeline.
- Summaries are capped (`SUMMARY_LIMITS`: 200 nodes / 400 edges) with
  selection→neighbors→statements→issues prioritization (`ai/src/
  provider.ts` `summarizeWorkspace`).

## 5. Operational conventions

- TypeScript ESM with `.js` import specifiers, `type` imports; vitest
  colocated in `test/`; `npm run typecheck` + `npm test` before presenting
  changes; prettier repo-wide; changesets release workflow.
- CI (`ci.yml`): typecheck → db:migrate → test (with `postgres:16`
  service) → coverage floors (core/ai/mcp/i18n) → web build → eval gate;
  separate `lint` job (`npm run lint`) + Helm lint + audit jobs.
- Migrations: `npm run db:generate -w @lucent/server`, commit SQL under
  `packages/server/migrations/`.

## 6. Relevant ADRs (index, not content)

0001 op log over CRDT · 0002 framework-free HTTP · 0004 Postgres fanout
over Redis · 0005 operations as AI contract · 0006 optional Postgres ·
0010 snapshots over op log · 0016 op protocol idempotency · 0017 actor
model · 0018 proposals as server records · 0019 history depth as read
boundary · 0041 one mutation path · 0047 trust stamped at committer ·
0049 automations propose-or-reversible. Full list: `docs/adr/README.md`.
