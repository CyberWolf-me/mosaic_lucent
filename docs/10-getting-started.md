# 10. Getting Started (V1 implementation)

The V1 vertical slice from `09-build-plan.md` is implemented. This is how to run
and verify it.

## Layout

```
lucent/
├── packages/
│   ├── core/     @lucent/core   — semantic model, operations, validator, reducer, inverse, layout, history, tool schema
│   ├── ai/       @lucent/ai     — LLMProvider interface, MockProvider, AnthropicProvider, OpenAI-compatible provider, prompt harness, image provider
│   ├── server/   @lucent/server — HTTP + WebSocket server (holds the API key): generate, image, auth, boards, realtime rooms, usage limits, metrics
│   ├── web/      @lucent/web    — React canvas (bespoke DOM + SVG renderer), chat, voice, board sync, localStorage projects
│   └── mcp/      @lucent/mcp    — MCP stdio server exposing the same validated operation contract to external agents
├── package.json          # npm workspaces root
└── tsconfig.base.json
```

The canvas is a hand-written React + SVG renderer (`web/src/ui/atoms.tsx`,
`DiagramLayer.tsx`), not tldraw or React Flow — earlier drafts of docs 06/09/10
named those libraries; neither is installed.

## Prerequisites

- Node 20+ (developed on Node 24)
- npm 10+ (ships with Node 20+)

## Install

```
npm install
```

## Run the app (mock AI, no API key needed)

Two processes:

```
# terminal 1 — backend on 127.0.0.1:4387
npm run start -w @lucent/server

# terminal 2 — Vite dev server on http://localhost:5173 (proxies /api to the backend)
npm run dev -w @lucent/web
```

Open the web URL, type "build an e-commerce store", then "add authentication",
then "use google oauth" — the canvas builds and updates incrementally. Undo/redo
and project save/load work; the 🎙 button uses the browser Web Speech API where
available.

## Use a real LLM (when you have a key)

The server picks a provider from env; with no key it uses the offline
`MockProvider`.

```
# PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm run start -w @lucent/server
# bash
ANTHROPIC_API_KEY=sk-ant-... npm run start -w @lucent/server
```

Optional: `LUCENT_AI_PROVIDER=anthropic`, `LUCENT_AI_MODEL=...`.
The browser never sees the key — it only calls the server's `/api/generate`.

## Use a real image model (optional)

Image generation has its own provider, separate from the LLM. With no
configuration it uses a placeholder generator so the place-on-canvas flow still
works offline. Set **both** a key and an endpoint to switch to a real model:

```
LUCENT_IMAGE_KEY=sk-...
LUCENT_IMAGE_BASE_URL=https://api.openai.com/v1/images/generations
# optional
LUCENT_IMAGE_MODEL=gpt-image-1
```

Half a configuration (a key with no endpoint, or vice versa) stays on the
placeholder rather than sending requests somewhere unintended.

## Usage limits

The AI endpoints are rate limited and quota'd per client. Defaults are 20
requests/minute and 500/day; override with `LUCENT_RATE_PER_MINUTE`,
`LUCENT_RATE_WINDOW_MS`, and `LUCENT_QUOTA_PER_DAY`. A refused request answers
`429` with `Retry-After`.

`GET /metrics` reports request counts, latency percentiles, refusals, and the
most recent errors. It stays local — no telemetry leaves the process, because
board content is sensitive.

## Verify

```
npm run typecheck            # all five packages (core, ai, server, web, mcp)
npm test                     # core, ai, server, web, mcp unit tests
npm run build -w @lucent/web # production build
```

## Security note

`/api/generate` and `/api/image` are **open by default** and bind to loopback,
which is fine for local single-user dev. Auth exists: set
`LUCENT_REQUIRE_AUTH=1` to make a valid bearer token mandatory on generate,
board, and WebSocket calls — do that before exposing the port to anything but
localhost. Rate limiting and a daily quota are always on (see above).

Board REST routes are already owner-scoped, and realtime commits are role-gated;
HTTP routes check ownership directly rather than going through the role system.
Not implemented: encryption at rest, audit logs, data-retention controls, SSO.
See the status note in `docs/06`.

## Collaborating on a board

Boards are local to your browser until you publish them. In the app: **Share →
Publish & start collaborating** creates a server-side board (`POST /api/boards`)
and joins its realtime room. Send the `?board=<id>` link and the other person
lands in the same room, with live cursors and synced edits. Requires an account,
since a shared board needs an owner. Invitees currently join as **viewer** and
there is no endpoint to promote them to editor yet.

## Agent access (MCP)

`packages/mcp` runs an MCP server over stdio, exposing
`apply_canvas_operations`, `get_board`, and `reset_board` — the same validated
operation contract the app uses, derived from the same Zod schema:

```
npm run dev -w @lucent/mcp
```

Point an MCP client at that command to let an agent build Lucent boards
directly, or at the built entry point for anything long-lived:

```
npm run start -w @lucent/mcp   # builds @lucent/core and @lucent/mcp, then runs node dist/main.js
```

Running `src/main.ts` under bare `tsx` does not work: without
`--conditions=development` (which the `dev` script passes) `@lucent/core`
resolves to its built `dist/`, so a clean clone fails with
`ERR_MODULE_NOT_FOUND`.

## What is NOT in V1

`09-build-plan.md` §9 deferred a longer list, most of which has since shipped.
Genuinely still missing:

- **S3 / image-asset persistence.** The Postgres-backed store now covers
  accounts, boards, and the realtime op log. User-uploaded images still have
  no durable home; `addEmbed` accepts URLs but not uploads. S3 is the next
  storage step.
- **Role granting.** Non-owners join a shared board as viewer with no way to be
  promoted.
- **Large-board performance work.** No virtualization or culling.
- **Meeting mode.** The view is a labelled static preview; nothing is recorded.

### Postgres in dev

The server picks its store impls at boot:

- `LUCENT_DATABASE_URL` unset → in-memory `InMemoryUserStore` /
  `InMemoryBoardStore`. Single-process only; state is lost on restart. Used
  for the test suite and quick local runs.
- `LUCENT_DATABASE_URL=postgres://user:pass@host:5432/lucent` → Postgres-backed
  `PostgresUserStore` / `PostgresBoardStore`. Migrations apply on boot via
  `drizzle-kit`-generated SQL. CI runs `npm -w @lucent/server run db:migrate`
  before `npm test`.

Local Postgres with Docker:

```sh
docker run --name lucent-pg -e POSTGRES_USER=lucent -e POSTGRES_PASSWORD=lucent \
  -e POSTGRES_DB=lucent -p 5432:5432 -d postgres:16
LUCENT_DATABASE_URL=postgres://lucent:lucent@localhost:5432/lucent \
  npm run dev -w @lucent/server
```

The signing secret is also a restart hazard in dev: without
`LUCENT_SESSION_SECRET` set, tokens are signed with a random key generated at
boot, so existing tokens become invalid after every restart. Production
deployments must set this env var.

- **Workspace memory** as specced in `docs/04` (goals, requirements, decisions,
  knowledge). Reference resolution uses a rolling context window instead.
