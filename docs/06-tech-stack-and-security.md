# 6. Tech Stack & Security

## Frontend

Strongly consider **React + TypeScript** for canvas, collaboration, UI, AI interaction, and realtime updates.

Canvas technology options:

- **tldraw** — investigate first for V1; it already provides many primitives needed for a collaborative infinite canvas.
- React Flow
- Konva
- PixiJS
- Custom WebGL/canvas layer

## Backend

Two candidate directions:

- **TypeScript / Node.js** — good for AI integrations, realtime APIs, collaboration, and rapid development.
- **Rust** — good for high-performance canvas infrastructure, realtime systems, a local/offline engine, and an eventual desktop application.

Don't introduce Rust everywhere initially.

## Reasonable MVP stack

| Layer    | Choice                                               | Status                                      |
| -------- | ---------------------------------------------------- | ------------------------------------------- |
| Frontend | React + TypeScript                                   | shipped                                     |
| Backend  | Node.js + TypeScript                                 | shipped                                     |
| Database | PostgreSQL (Drizzle ORM, committed SQL migrations)   | shipped — `LUCENT_DATABASE_URL`             |
| Realtime | WebSockets (server-authoritative op log, not a CRDT) | shipped                                     |
| AI       | LLM API                                              | shipped                                     |
| Speech   | Realtime STT provider                                | shipped (browser / Whisper / LiveKit)       |
| Storage  | S3-compatible object storage                         | **not built** — no durable home for uploads |

### Persistence

The server selects its stores at boot:

- **`LUCENT_DATABASE_URL` set** → `PostgresUserStore` + `PostgresBoardStore`.
  Migrations under `packages/server/migrations/` are applied idempotently on
  startup (and by `npm run db:migrate -w @lucent/server`). Accounts, boards,
  and the per-board operation log all survive a restart; a redeploy no longer
  drops a live collaboration session, because a rejoining client's catchup is
  rebuilt from `op_log` rather than from an empty in-process array.
- **unset** → `InMemoryUserStore` + `InMemoryBoardStore`. Correct for
  single-process dev and the test suite; nothing survives a restart.

Two caveats that are real and not yet solved:

- **Sticky sessions are required for multi-process deploys.** Presence and the
  hot `Room` are per-process. Two processes serving the same board would each
  hold their own live room and split presence, even though both persist to the
  same tables. Route a board's sockets to one process (or move presence into
  the database) before scaling horizontally.
- **`LUCENT_SESSION_SECRET` must be set in production.** Without it the signing
  key is randomly generated per boot, so every restart invalidates every
  outstanding token — users get silently logged out.

## Collaboration architecture

For realtime collaboration, use an **operation-based model** instead of constantly sending the entire canvas:

```
User A → Operation → Collaboration Server → User B
```

Technologies worth evaluating: CRDT, Yjs, Liveblocks, WebSockets, WebRTC. This allows multiple users and AI agents to modify the workspace simultaneously.

## Security

Because users may put sensitive company information into the canvas, security matters. Requirements:

- Workspace isolation
- Encryption in transit
- Encryption at rest
- Role-based access
- Project permissions
- Audit logs
- AI provider controls
- Data retention controls
- Enterprise SSO (eventually)

For enterprise customers, a major question will be: **"Is our data used to train the model?"** The answer should be clearly controlled (default: no).

**Implementation status (audited 2026-08; updated 2026-09, see docs/23).** Not
enforced in code, and the UI no longer claims it is. Lucent trains no models
of its own, but a prompt's retention is governed entirely by whichever
provider `LUCENT_AI_BASE_URL` points at — no cross-provider no-training
header exists to send. Until a per-org provider policy exists (docs/23 S3),
the honest answer is "it depends on your configured provider's terms", which
is what Settings → Account now says. Anything stronger needs a provider
contract or a self-hosted model.

Since the 2026-08 audit, the list above has partially shipped — the
authoritative, audited status lives in **docs/23** (the security coverage
table). In short: role-based access is enforced on the realtime path and
owner-scoped on REST; audit logs (+viewer with keyset pagination and CSV
export), SAML SSO, SCIM provisioning, and TOTP two-factor are implemented
and tested; per-board classification, org-level policy, data residency, and
at-rest encryption beyond the platform's disk layer are **not implemented** —
docs/23 phases S1–S5 are the gaps. Treat this section as the target; treat
docs/23 as the description.
