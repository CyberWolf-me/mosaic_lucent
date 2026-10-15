# Lucent — Product Definition

> Canonical product source for the CTO-agent control plane. Distills
> `docs/README.md`, `AGENTS.md`, `docs/14-product-vision.md`, and
> `docs/checklist.md`. Last verified against the repo 2026-10-15.
> Do not duplicate whole source docs here — cite them.

## 1. Product vision and user promise

**Promise:** _Think out loud. Build visually._ (`docs/README.md:5`)

Lucent is an AI-native voice visual workspace: users describe ideas by voice
or text and an AI agent constructs editable, structured visuals (flowcharts,
architecture diagrams, user journeys, wireframes, mind maps). The sharpened
thesis (`docs/14-product-vision.md:11-34`): not "Miro with AI" but
**conversation understanding** — facts vs proposals vs decisions vs rejections
— plus a workspace that remembers how thinking evolved and can prove where
every AI-generated object came from. Success metric: _how much complexity
Lucent removes_, not how much it creates.

## 2. Target users and core workflows

- Teams designing systems, planning launches, running meetings (system design
  sessions, launch planning, reviews).
- Core loop: speak/type → AI builds semantic canvas → human directs/edits by
  voice or hand → iterate → export or execute (Linear/GitHub/Jira sync).
- Killer workflow (`docs/checklist.md` Phase 5): voice→canvas with
  board-context-aware modification ("separate payments from checkout").

## 3. Non-negotiable product behaviors (`AGENTS.md`)

1. The LLM never manipulates the canvas directly — it emits validated
   structured operations; the app executes them.
2. Never static images for diagrams — always the editable semantic model.
3. Never ask the LLM for x/y coordinates — `LLM → semantic graph → layout
   engine → coordinates` (manual shapes excepted).
4. Every AI action reversible (undo/redo, snapshots, inspection).
5. Major operations gated behind human approval (diff/review before apply).
6. Workspace isolation, encryption, RBAC, audit logs; provider data controls
   (default: no training use).

## 4. Confirmed scope and deliberate exclusions

Shipped per `docs/checklist.md` (audited): infinite canvas + manual board,
text/voice→canvas, 9+ diagram families, realtime multiplayer (server-
authoritative op log), meeting capture with provenance, statements lifecycle
(C2–C6), execution sync to Linear/GitHub/Jira with human gates (D1–D10),
OAuth/SAML/SCIM, asset gateway, billing/quotas.

Deliberately deferred (checklist "Remaining" + docs/17 freeze rule):
Terraform packaging, offline licence check, per-org retention/legal-hold
artifacts, embeddings/pgvector (lexical seam suffices until misses are
demonstrated), MCP-over-HTTP and server-side SSE LiveKit transcription.

## 5. Technical constraints affecting product decisions

- AI latency 20–35 s per round trip dominates small edits (checklist).
- Board summary caps (200 nodes / 400 edges) bound prompt size; large-board
  slicing must preserve selection neighborhoods.
- Persistence is Postgres-backed only when `LUCENT_DATABASE_URL` is set,
  otherwise in-memory; assets need `LUCENT_ASSET_BACKEND=s3` for real deploys.
- Multi-process deploys require sticky sessions (rooms + presence are
  per-process; Helm chart pins `ClientIP` affinity).

## 6. Current priorities and known blockers

1. Merge + push the integrity-convergence work (local `main` 8 ahead of
   origin; push needs founder approval — ENG-007, currently blocked).
2. B6 remainder: two AI dialects + large-board blind spots (ENG-001).
3. Lint-gate timeout on dev machine (ENG-002).
4. Generation direct-write hardening evidence (ENG-003).
5. Documentation drift README/AGENTS/docs-26 (ENG-004).

## 7. Source references

- `docs/README.md`, `docs/checklist.md` (audited status — most accurate doc),
  `docs/14-product-vision.md`, `AGENTS.md`, `docs/17-engineering-roadmap.md`,
  `AUDIT.md` (2026-10-09 snapshot — informative, re-verify before trusting
  detail; see `ARCHITECTURE.md` §0).
