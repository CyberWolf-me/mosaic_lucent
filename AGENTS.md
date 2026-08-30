# AGENTS.md — Lucent

> AI-Native Voice Visual Workspace. A conversational canvas where users describe ideas by voice or text and an AI agent constructs editable, structured visuals (flowcharts, architecture diagrams, user journeys, wireframes, mind maps).
>
> **Status: well past the V1 slice.** An npm-workspaces monorepo under `packages/` — six packages (`core`, `ai`, `server`, `web`, `mcp`, `i18n`) — implements the conversational canvas plus realtime multiplayer, auth, a full manual board, work tracking, agent access over MCP, SAML SSO, SCIM provisioning, and meeting transcripts. See `docs/checklist.md` for audited feature status and `docs/10-getting-started.md` to run it. **Persistence is Postgres-backed when `LUCENT_DATABASE_URL` is set (accounts, boards, and the realtime op log survive a restart); in-memory otherwise. Assets upload through `POST /api/assets` to a configurable blob backend (memory / disk / S3-compatible); still deferred: a Postgres-backed asset _metadata_ store.**

## Build / test / run

- Install: `npm install` (installs all workspaces from the root).
- Typecheck everything: `npm run typecheck` (runs `--workspaces --if-present`)
- Test everything: `npm test` (vitest; core/ai/server/web/mcp)
- Run backend: `npm run start -w @lucent/server` (loopback :4387; uses MockProvider unless a provider key is set)
- Run frontend: `npm run dev -w @lucent/web` (Vite :5173, proxies `/api` to the backend)
- Web production build: `npm run build -w @lucent/web`
- MCP server (agent access): `npm run dev -w @lucent/mcp` from source, or `npm run start -w @lucent/mcp` to build and run `dist/main.js`. Bare `npx tsx packages/mcp/src/main.ts` resolves `@lucent/core` to `dist/` and fails on a clean clone - the `dev` script passes `--conditions=development`.
- Apply DB migrations: `npm run db:migrate -w @lucent/server` (needs `LUCENT_DATABASE_URL`)
- Regenerate migrations after a schema change: `npm run db:generate -w @lucent/server`, then commit the SQL under `packages/server/migrations/`

Always run `npm run typecheck` and `npm test` before presenting changes. The
Postgres store tests skip unless `LUCENT_TEST_DATABASE_URL` is set; CI provides
a `postgres:16` service so they run there.

## Packages and boundaries

- `@lucent/core` — semantic model, `zod` operation schema, validator, pure reducer, inverse operations, layout engine, history, tool-schema derivation. **No React/DOM/network deps.** This is the deterministic engine; keep it framework-agnostic.
- `@lucent/ai` — `LLMProvider` interface + prompt harness + `MockProvider` (offline), `AnthropicProvider`, and an OpenAI-compatible provider; plus an `ImageProvider`. The moat lives here as a model-independent harness, not a specific vendor.
- `@lucent/server` — framework-free HTTP + WebSocket server: `/api/generate`, `/api/image`, auth, boards, realtime rooms, usage limits, `/metrics`. Owns the API key, schema-parses input, validates AI operations before returning them. Never move key handling to the client.
- `@lucent/web` — React renders `core` through a **bespoke DOM + SVG canvas** (not tldraw or React Flow — neither is installed); `stt/` (three speech providers), `boardSync.ts` (realtime), `persistence.ts` (localStorage projects).
- `@lucent/mcp` — MCP stdio server exposing `apply_canvas_operations`, `get_board`, `reset_board`, derived from the same core Zod union so an agent can never send an operation the validator would reject.

## Read before changing design or architecture

The full product overview is split into `docs/` (start at [`docs/README.md`](./docs/README.md)). Read the relevant part before making architecture or product decisions:

- `docs/01-vision-and-strategy.md` — concept, users, positioning, moat, strategy.
- `docs/02-interface-and-interaction.md` — UI layout, inputs, voice pipeline, approval.
- `docs/03-semantic-canvas-and-data-model.md` — semantic model, action system, layout engine, data model.
- `docs/04-ai-architecture.md` — technical + AI-agent architecture, transformations, memory.
- `docs/05-features.md` — artifact types, collaboration, meeting mode, multimodal, code integration.
- `docs/06-tech-stack-and-security.md` — stack choices, collaboration architecture, security.
- `docs/07-mvp.md` — MVP scope and example session.
- `docs/08-business-model.md` — SaaS tiers.

## Core product principle

**The user describes; the AI constructs.** Manual editing stays available but is not the primary interaction. The differentiator is not voice transcription or the LLM — it is the _semantic canvas_: every object has meaning and structured relationships, and one underlying model renders into multiple representations (mind map → flowchart → architecture → wireframe → presentation).

## Non-negotiable architecture rules

These are load-bearing design decisions from the product spec. Preserve them when building:

- **Never let the LLM manipulate the canvas directly.** The AI emits _structured operations_ (e.g. `CREATE_NODE`, `MOVE_NODE`, `CONNECT_NODES`, `TRANSFORM_DIAGRAM`) as JSON. The app validates each operation, then the canvas executes it. This keeps behavior deterministic.
- **Never generate static images for diagrams.** Maintain a structured semantic model (nodes, edges, groups, relationships, metadata). The renderer converts the model to visuals so everything stays editable.
- **Do not ask the LLM for x/y coordinates on nodes.** LLMs are poor at spatial
  layout. Flow: `LLM → semantic graph → layout engine → coordinates`. Use
  hierarchical / force-directed / DAG / tree layout algorithms. Shapes
  (sticky notes, frames, drawings) are manually placed and may carry positions
  the AI supplies — the rule is about the _semantic graph_, not the manual
  layer.
- **Every AI action must be reversible** (undo/redo, snapshots, action inspection). Treat canvas history as Git-like.
- **Gate major operations behind human approval.** Small ops (move a node) execute immediately; large ops (redesign architecture) present a diff/review before applying.
- **Persistent workspace memory.** Projects carry context (goals, users, requirements, decisions, entities, relationships, conversations, history) so the AI resolves references like "the login flow" against prior decisions.

## Actual tech stack (was "intended"; corrected 2026-08)

What is actually installed and used — the list below used to say "nothing is
installed yet" and named libraries that were never adopted:

- **Frontend:** React + TypeScript + Vite. The canvas is a **bespoke DOM + SVG
  renderer** (`web/src/ui/atoms.tsx`, `DiagramLayer.tsx`). **No tldraw, React
  Flow, Konva, or PixiJS** — don't add one; the semantic model + layout engine
  already own everything such a library would provide.
- **Layout:** hand-written engine in `core/src/layout.ts` — layered (with
  Sugiyama crossing reduction), radial, tidy-tree, swimlane. **No dagre/elkjs.**
- **Backend:** Node.js + TypeScript, framework-free `node:http` + `ws`.
- **Database:** Postgres when `LUCENT_DATABASE_URL` is set, in-memory otherwise.
  The Postgres path runs migrations on boot and persists accounts, boards, and
  the op log (`packages/server/src/store/pg-*`). Single-process in-memory is the
  fallback for offline dev.
- **Realtime/collab:** WebSockets with a **server-authoritative sequenced
  operation log**, deliberately _not_ a CRDT (reasoning in `server/src/room.ts`).
  Don't reintroduce Yjs/Liveblocks without revisiting that decision.
- **AI:** one provider call with one prompt and one derived tool — **not** the
  separate-agents-behind-an-orchestrator design docs/04 describes. Layout and
  validation are deterministic modules, which the non-negotiables require.
- **Speech:** three STT providers (Web Speech, on-device Whisper, LiveKit).
  Toggle-to-talk, and there is **no intent-detection stage** — transcripts go
  straight to the model.
- **Storage:** none; generated images are inlined as data URLs. S3 still planned.

Do not introduce Rust or other languages unless the user asks.

## Data model (center of the system)

`Workspace` contains: Nodes, Edges, Groups, Shapes, ShapeLinks, Wireframes,
Comments, Votes, Reactions. Nodes may carry Jira-style `issue` fields.

Two documented aspirations are **not** built, so don't assume them: there is no
`Knowledge` collection and no workspace-memory layer (goals/requirements/
decisions), and **no object carries `created_by`/`created_at`/`updated_at`** —
only comments have an author and timestamp. Reference resolution works by
re-sending a board summary plus recent turns, not by durable memory.

## MVP scope (keep V1 small)

- Canvas: infinite canvas, shapes, text, connectors, groups, sticky notes, pan/zoom.
- AI: text→diagram, voice→diagram, conversational modification, semantic canvas, undo/redo, AI explanation.
- Diagram types: flowchart, mind map, architecture diagram, user journey.
- Voice: push-to-talk, realtime transcription, command interpretation.
- Workspace: projects, save/load, history.

Resist scope creep (collaboration, meeting mode, code integration, presentations) until the core "talk → editable structured visual appears" loop feels magical.

## Security

Users will paste sensitive company info. Build in: workspace isolation, encryption in transit and at rest, role-based access, project permissions, audit logs, AI-provider data controls, and a clear answer to "is our data used to train the model?" (default: no). Any network-exposed endpoint or server must have authentication — flag it if it doesn't.

## Conventions

- Language: TypeScript across frontend and backend; prefer strict typing.
- Match surrounding code style; the codebase has settled idioms (ESM `.js` import specifiers, `type` imports, vitest colocated in `test/`).
- Keep AI-emitted canvas operations as a well-defined, validated schema — treat that schema as a stable contract between the AI layer and the renderer.
