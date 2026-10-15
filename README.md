# Lucent

**AI-Native Voice Visual Workspace.** Describe an idea by voice or text and an AI agent constructs editable, structured visuals — flowcharts, architecture diagrams, user journeys, wireframes, mind maps. The canvas is semantic: every object has meaning and structured relationships, and one underlying model renders into many representations.

> Status: **well past the V1 slice.** This monorepo implements the conversational canvas plus realtime multiplayer (board membership, share links, WebSocket rooms with per-role permissions), Postgres persistence, the hardened security baseline, meeting capture with provenance, the statement lifecycle, execution sync to Linear/GitHub/Jira, SSO/SCIM, and an asset gateway with memory/disk/**S3-compatible** backends (`POST /api/assets`). See [`docs/checklist.md`](./docs/checklist.md) for the audited feature status and [`docs/10-getting-started.md`](./docs/10-getting-started.md) to run it.

---

## Quick start

Requires Node.js 22+ and npm 10+.

```bash
npm install                  # installs all workspaces
npm run dev                  # API on :4387, web on :5173 (Vite proxies /api + /ws)
```

Open <http://localhost:5173>. The browser talks to the Vite dev server; Vite forwards `/api/*` and `/ws` to the loopback Node server, so the API key never crosses a public origin.

## Production-style run

```bash
npm run build                # builds packages/web (Vite → packages/web/dist)
npm run start                # builds + boots the server with the static handler; one port, :4387
```

The server's static handler serves the built React app on the same origin with strict CSP and a permissions-policy that grants microphone access only to the same origin (for the Web Speech API).

## Docker

```bash
docker compose up            # starts Lucent + Postgres 16 on :4387 and :5432
```

The compose file wires a `postgres:16` service with a healthcheck, runs migrations on the Lucent container's boot, and persists data in a named volume.

## Environment

Copy `.env.example` to `.env` and fill in what you need. The full set of `LUCENT_*` keys is documented there. In production, `LUCENT_SESSION_SECRET` (>= 16 chars) and `LUCENT_DATABASE_URL` are the only required values.

## Workspaces

| Package               | What it is                                                                                                                                      | Boundary                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `@lucent/core`        | Semantic model, zod operation schema, validator, pure reducer, layout engines, statements/issues/provenance, history                            | No React/DOM/network deps — the deterministic engine     |
| `@lucent/ai`          | `LLMProvider` interface + prompt harness, `MockProvider` (offline), `AnthropicProvider`, `OpenAICompatibleProvider`                             | Model-independent harness, not tied to any vendor        |
| `@lucent/server`      | Framework-free HTTP + WebSocket server: auth (OAuth/SAML/SCIM), boards, sequenced rooms, proposals, Ask/search, meetings, integrations, billing | Owns the API key, validates AI ops before returning them |
| `@lucent/web`         | React app with a bespoke DOM + SVG canvas (no canvas library); lenses, STT providers, realtime sync                                             | The browser app                                          |
| `@lucent/mcp`         | MCP stdio server (local session + live remote session) exposing the validated op contract to external agents                                    | Same contract the app uses — never a side channel        |
| `@lucent/voice-agent` | LiveKit worker joining voice rooms with board-scoped grants                                                                                     | Speaks through `orchestrate`, like any agent             |
| `@lucent/i18n`        | Localisation dictionaries (en + hu) with parity checks                                                                                          | Type-checked strings only                                |
| `@lucent/load`        | k6 load-test profiles                                                                                                                           | Test tooling, not shipped                                |
| `@lucent/site`        | Static marketing site + status page                                                                                                             | No app code                                              |

## Commands

| Command                | What it does                                         |
| ---------------------- | ---------------------------------------------------- |
| `npm run build`        | Builds all workspaces                                |
| `npm run typecheck`    | `tsc --noEmit` across every workspace                |
| `npm test`             | Vitest run across every workspace                    |
| `npm run lint`         | ESLint 9 across every workspace                      |
| `npm run format`       | Prettier write, source and docs                      |
| `npm run format:check` | Prettier check — the CI gate                         |
| `npm run dev`          | API on :4387 + Vite on :5173 side-by-side            |
| `npm run start`        | Build the web app, then start the single-port server |

## Documentation

The full product overview is in [`docs/`](./docs/README.md). Start with [`docs/01-vision-and-strategy.md`](./docs/01-vision-and-strategy.md) for the concept, then [`docs/03-semantic-canvas-and-data-model.md`](./docs/03-semantic-canvas-and-data-model.md) for the data model. Architecture and security live under [`docs/06-tech-stack-and-security.md`](./docs/06-tech-stack-and-security.md).

## Core principle

**The user describes; the AI constructs.** Manual editing stays available but isn't the primary interaction. The differentiator isn't voice transcription or the LLM — it's the semantic canvas: every object has meaning, and one underlying model renders into multiple representations (mind map → flowchart → architecture → wireframe → presentation).

## Security

Report vulnerabilities privately — see [SECURITY.md](./SECURITY.md) for the channel, the response targets and what is in scope. The posture the code enforces today is documented in [`docs/06-tech-stack-and-security.md`](./docs/06-tech-stack-and-security.md).

## License

Proprietary — internal project. Not for redistribution.
