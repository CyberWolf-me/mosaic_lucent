# Lucent — Concurrency, Complex Workflow, and Stress-Test Plan

## 1. System Architecture Reconnaissance

### 1.1 App Entry Points and Routing

- **Server**: Framework-free `node:http` server mounted in [`packages/server/src/app.ts`](file:///d:/lucent/packages/server/src/app.ts) and [`packages/server/src/main.ts`](file:///d:/lucent/packages/server/src/main.ts).
- **Routes**:
  - Auth: `POST /api/auth/signup`, `POST /api/auth/signin`, `POST /api/auth/csrf`, `POST /api/auth/signout`.
  - Realtime Ticket: `POST /api/realtime/ticket` (mints short-lived one-time ticket consumed during WebSocket upgrade).
  - Boards: `POST /api/boards`, `GET /api/boards`, `GET /api/boards/:id`, `PATCH /api/boards/:id`, `DELETE /api/boards/:id`.
  - Board Sharing: `POST /api/boards/:id/share` (generates invite tokens), `POST /api/boards/:id/join` (redeems invite tokens).
  - Board Members: `GET /api/boards/:id/members`, `PATCH /api/boards/:id/members/:userId` (role update), `DELETE /api/boards/:id/members/:userId` (revocation).
  - Operations REST API: `POST /api/boards/:id/ops` (single-writer HTTP batch submission, actor stamping, and server sequence assignment).
  - AI Generation: `POST /api/generate` and `POST /api/generate/stream`.
  - Asset Management: `POST /api/assets`, `GET /api/assets/:id`, `DELETE /api/assets/:id`.
  - Board Export: `GET /api/boards/:id/export?format=json|png|svg|markdown`.

### 1.2 Realtime Collaboration Transport & Consistency Model

- **Transport**: WebSocket endpoint at `/ws?ticket=<ticket>` handled by [`RealtimeServer`](file:///d:/lucent/packages/server/src/realtime.ts#L145).
- **Consistency Model**: **Server-authoritative sequenced operation log** (`op_log`), deliberately **NOT** a CRDT / Yjs (see architectural decision records ADR 0010 and ADR 0012).
- **Wire Protocol**:
  - Client -> Server:
    - `{ type: "join", boardId, fromSeq }`
    - `{ type: "op", requestId, label, ops: [...] }`
    - `{ type: "presence", cursor: { x, y }, selection: [...] }`
    - `{ type: "ping" }`
  - Server -> Client:
    - `{ type: "welcome", boardId, version, role, catchup: [...], peers, spotlight }`
    - `{ type: "resync", workspace, version, role, peers }` (when client is behind snapshot floor)
    - `{ type: "op", entry: { seq, ops, by, label, timestamp, operationId, requestId, actor } }` (broadcast)
    - `{ type: "op-ack", seq, operationId, requestId }` (directed acknowledgment to submitter)
    - `{ type: "op-rejected", error, detail, requestId, head }`
    - `{ type: "peer-joined", presence }` / `{ type: "peer-left", userId }`
    - `{ type: "pong" }`
- **Operation Validation & State Reducer**:
  - Operations are schema-validated with Zod (`safeParseProgrammaticOperations`) in [`packages/core/src/schema.ts`](file:///d:/lucent/packages/core/src/schema.ts).
  - State transformation is executed deterministically by pure reducer `applyValidOperations(workspace, ops)` in [`packages/core/src/reducer.ts`](file:///d:/lucent/packages/core/src/reducer.ts).
  - Conflict resolution: Last-write-wins (LWW) per property across monotonically sequenced batches in `op_log`.

### 1.3 Authentication & Authorization

- **Session Auth**: HTTP-only cookie `lucent_session` + double-submit CSRF token (`x-csrf-token` header matching `lucent_csrf` cookie).
- **API / Programmatic Auth**: Bearer token via `Authorization: Bearer <token>` (`api_tokens` table) or user session token.
- **Roles**: `owner`, `editor`, `commenter`, `viewer`. Role enforcement is checked on every HTTP endpoint (`requireBoardRole`) and before every op commit in [`Room.commit`](file:///d:/lucent/packages/server/src/room.ts#L150).

### 1.4 Persistence Path

- **PostgreSQL Store**: Active when `LUCENT_DATABASE_URL` is set (e.g., Supabase pooler in staging/production).
  - `public.users` (accounts and credentials)
  - `public.boards` (board metadata and snapshot workspace `jsonb`)
  - `public.board_members` (explicit role grants)
  - `public.op_log` (append-only sequenced operation log `jsonb`)
- **In-Memory Store**: Fallback when no database is configured (dev/test single process).

### 1.5 AI Pipeline

- Managed by [`@lucent/ai`](file:///d:/lucent/packages/ai/src/index.ts).
- Provider harness supports:
  - `MockProvider` ([`packages/ai/src/providers/mock.ts`](file:///d:/lucent/packages/ai/src/providers/mock.ts)): Deterministic, repeatable, offline, zero-cost.
  - Real vendor providers: Anthropic Claude, OpenAI-compatible (DeepSeek, etc.).
- **Guardrail**: Load testing defaults to deterministic mock operations and zero-cost mock AI payloads unless explicitly configured with live credentials.

---

## 2. Feature-to-Scenario Mapping (LT-01 through LT-18)

| Scenario ID | Name                                                 | Lucent Feature & Code Reference                          | Status                  | Notes / Prerequisites                                                                                                       |
| :---------- | :--------------------------------------------------- | :------------------------------------------------------- | :---------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **LT-01**   | 50-user normal working day across multiple boards    | `POST /api/boards`, `join`, `/ws`, `Room.commit`         | **READY**               | 50 accounts (`U001`..`U050`), 10 boards (`B01`..`B10`), 5 users/board, mixed ops & reloads.                                 |
| **LT-02**   | 50-user single "live workshop" board (`B-HOT`)       | `Room.commit`, broadcast fan-out, presence               | **READY**               | 50 concurrent sockets on `B-HOT`, unique node IDs, burst batches, convergence check.                                        |
| **LT-03**   | Hot-object contention & conflicting edits            | Pure reducer in `core`, monotonic seq ordering           | **READY**               | 20-50 users concurrently mutating the exact same `nodeId` label/position; verify deterministic LWW and no state corruption. |
| **LT-04**   | AI generation storm while editing                    | `POST /api/generate`, `Room.commit`                      | **READY**               | 10 concurrent diagram generations via deterministic mock provider + 40 editing users.                                       |
| **LT-05**   | AI output edited before generation finishes          | `/api/generate/stream` & concurrent `op` commits         | **READY**               | Manual edits submitted concurrently with AI generation stream; verify human edits are not overwritten.                      |
| **LT-06**   | 5 breakout groups consolidated to synthesis board    | Multi-board isolation & node transfer batch              | **READY**               | 5 breakout boards (10 users each) -> transfer key findings to 6th synthesis board via sequenced ops.                        |
| **LT-07**   | Large board scale test (5,000 objects)               | Core workspace capacity & serialized payload limits      | **READY**               | Synthetic 5,000-object board seeded; concurrent reads, updates, and navigation measured.                                    |
| **LT-08**   | Presence and rapid churn                             | Ephemeral presence in `Room`, heartbeat, cursor fan-out  | **READY**               | Rapid connect/disconnect churn of 10 users while 40 active users stream cursor moves.                                       |
| **LT-09**   | Network partition & synchronized reconnect storm     | `join` with `fromSeq` catchup replay                     | **READY**               | Disconnect 15 users for 30s while 35 continue editing; synchronized reconnect & catchup verification.                       |
| **LT-10**   | Live permission change during active sessions        | `PATCH /api/boards/:id/members/:userId` & `Room.setRole` | **READY**               | Revoke editor -> viewer on active socket; verify subsequent op is rejected with `forbidden`.                                |
| **LT-11**   | Tenant / workspace isolation under concurrent use    | `requireBoardRole`, org boundaries (`orgId`)             | **READY**               | 5 separate orgs (`W01`..`W05`); verify cross-org access attempts return 403/404 and WS join is rejected.                    |
| **LT-12**   | Undo/redo and history with interleaved collaborators | `OperationHistory` inverse ops & `op_log` ordering       | **READY**               | Interleaved concurrent user edits followed by user inverse ops; verify peer edits remain intact.                            |
| **LT-13**   | Board creation, duplication & navigation burst       | `POST /api/boards`, `GET /api/boards`, clone workflow    | **READY**               | 30 users creating boards concurrently + 10 duplicating source board; verify no ID collision.                                |
| **LT-14**   | Upload / export workload concurrency                 | `POST /api/assets`, `GET /api/boards/:id/export`         | **READY**               | Concurrent asset upload and JSON/PNG export while canvas edits are being committed.                                         |
| **LT-15**   | Service restart and persistence recovery             | Server restart, DB `op_log` reload                       | **REQUIRES OPT-IN**     | Guarded by `ALLOW_DESTRUCTIVE_TESTS=true`. Verified against local dev server process restart.                               |
| **LT-16**   | Long soak & resource leak detection                  | Connection tracking, heap sampling                       | **READY** (abbreviated) | Scaled soak test profile monitoring memory and latency stability over sustained activity.                                   |
| **LT-17**   | Load spike & controlled saturation                   | Connection ramping (10 -> 25 -> 50 -> 75 -> 100)         | **READY**               | Progressive ramp to determine latency knee and recovery.                                                                    |
| **LT-18**   | Multi-tab & repeated-session edge cases              | Ephemeral presence deduplication                         | **READY**               | 25 distinct user identities running 2 concurrent tabs/sockets each (50 total connections).                                  |

---

## 3. Test Harness Design (`scripts/load-test/`)

### 3.1 Modules

- [`scripts/load-test/config.mjs`](file:///d:/lucent/scripts/load-test/config.mjs): Target URLs, run ID generator (`LT-<timestamp>-`), timeouts, credentials.
- [`scripts/load-test/client.mjs`](file:///d:/lucent/scripts/load-test/client.mjs): High-concurrency client managing:
  - CSRF retrieval & session caching
  - Account signup & authentication (`LT-U001`..`LT-U050`)
  - Board creation, invite issuance & redemption
  - Realtime ticket acquisition and WebSocket lifecycle
  - Sequenced op dispatch with unique `requestId` and timestamps
  - Incoming frame tracking (`welcome`, `op`, `op-ack`, `op-rejected`, `presence`)
- [`scripts/load-test/metrics.mjs`](file:///d:/lucent/scripts/load-test/metrics.mjs):
  - Operation latency measurement (p50, p90, p95, p99)
  - End-to-end fan-out latency (sender dispatch -> observer receipt)
  - Throughput (ops/sec) and error rates
  - Acknowledged writes vs. Persisted state ledger audit
- [`scripts/load-test/scenarios.mjs`](file:///d:/lucent/scripts/load-test/scenarios.mjs): Concrete scenario execution handlers for LT-01 through LT-18.
- [`scripts/load-test/runner.mjs`](file:///d:/lucent/scripts/load-test/runner.mjs): CLI entry point supporting profiles:
  - `smoke`: 3–5 users, 1–2 minutes validation
  - `baseline`: 10 users, low-load reference
  - `target`: 50 users across multiple boards (LT-01)
  - `hot-board`: 50 users on single board + contention (LT-02 & LT-03)
  - `ai-storm`: 10 concurrent AI requests + 40 editing (LT-04 & LT-05)
  - `resilience`: Churn, reconnect storm, permissions, and multi-tab (LT-08, LT-09, LT-10, LT-18)
  - `all`: Complete regression suite execution

### 3.2 Guardrails & Safety Mechanisms

1. **Prefixing**: Every created user, board, node, edge, and asset is prefixed with `LT-<runId>-`.
2. **AI Cost Protection**: Defaults to deterministic synthetic diagram generation / mock provider; paid provider requires `ALLOW_PAID_AI=true`.
3. **Non-Destructive Target Verification**: Destructive tests (service restart in LT-15) only run against `localhost` or explicitly configured disposable staging with `ALLOW_DESTRUCTIVE_TESTS=true`.
4. **Idempotent Teardown**: Teardown routinely purges created test boards, deletes test assets, and terminates sockets.

---

## 4. Execution Commands

```bash
# 1. Run quick smoke profile (3-5 users)
node scripts/load-test/runner.mjs --profile=smoke

# 2. Run baseline profile (10 users)
node scripts/load-test/runner.mjs --profile=baseline

# 3. Run primary 50-user target profile (LT-01 multi-board)
node scripts/load-test/runner.mjs --profile=target

# 4. Run hot board & contention profile (LT-02 & LT-03)
node scripts/load-test/runner.mjs --profile=hot-board

# 5. Run AI storm profile (LT-04 & LT-05)
node scripts/load-test/runner.mjs --profile=ai-storm

# 6. Run resilience profile (LT-08 churn, LT-09 reconnect storm, LT-10 permission revocation, LT-18 multi-tab)
node scripts/load-test/runner.mjs --profile=resilience

# 7. Run specific individual scenario
node scripts/load-test/runner.mjs --scenario=LT-02
```
