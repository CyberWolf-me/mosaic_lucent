# Lucent — Autonomous Repository Exploration, Product Innovation & Engineering Opportunity Audit

## Section A — What Lucent Actually Is Today

### 1. Repository & Snapshot State (`VERIFIED`)

The inspected repository (`mosaic_lucent-a59126e713f88459334072d593aa6771c9cfe214`, snapshot timestamp `2026-10-09`) is an npm-workspaces TypeScript monorepo containing **nine packages** under `packages/*` (`package.json:6-8`):

| Package | Role in the Actual Codebase | Key Entry Points |
| --- | --- | --- |
| **`@lucent/core`** | Deterministic semantic engine: 18 diagram families (`DIAGRAM_KINDS`), 38 Zod-validated operations, pure reducer, inverse-operation undo (`OperationHistory`), hand-written layout engines (`layered`, `radial`, `tree`, `swimlane`, `timeline`, `grid`, `storymap`), statement/issue/execution/trust models, Mermaid/OpenAPI/SQL/Docker-Compose importers, code exporters, and the intermediate `SemanticPlan` + compiler + topology quality gate | `packages/core/src/model.ts:25-55`, `operations.ts`, `validator.ts`, `reducer.ts`, `layout.ts`, `plan.ts`, `compiler.ts`, `qualityGate.ts` |
| **`@lucent/ai`** | Model-agnostic AI harness: `LLMProvider` (`AnthropicProvider`, `OpenAICompatibleProvider`, `MockProvider`), 6 versioned prompt templates (`visual-agent`, `board-historian`, `external-selector`, `meeting-notes`, `sticky-themes`, `vector-editor`), fast-path intent classifier (`classifyIntentFastPath`), `generateSemanticPlan`, LRU+TTL prompt-identity response cache, and golden eval suite | `packages/ai/src/provider.ts`, `prompt.ts`, `intent.ts:9-110`, `planGenerator.ts:10-97`, `providers/openai-compat.ts`, `providers/anthropic.ts` |
| **`@lucent/server`** | Framework-free `node:http` + `ws` backend (`ADR 0002`): auth (cookie sessions, OAuth, SAML 2.0, TOTP 2FA, SCIM 2.0, API tokens, short-lived `Agent` grants), sequenced WebSocket rooms (`Room` + `RealtimeServer`), Postgres (`drizzle-orm`, 48 migrations `0000`–`0046`) + in-memory twin stores (`ADR 0006`), `StatementIndexer`, transactional `OutboxDispatcher`, `JobRunner`, Deepgram/OpenAI STT & TTS proxies, LiveKit token/dispatch routes, and Linear/GitHub/Jira/Slack integrations | `packages/server/src/main.ts`, `app.ts:596`, `room.ts:180`, `realtime.ts:145`, `generate.ts:650`, `orchestrator.ts:58`, `db/schema.ts` |
| **`@lucent/web`** | React 18 + Vite SPA with a bespoke DOM + SVG semantic canvas renderer (`DiagramLayer.tsx`, `ui/atoms.tsx` — no tldraw or React Flow), opt-in Web Worker `elkjs` refinement (`diagram/layoutService.ts`), 6 canvas lenses (`diagram`, `kanban`, `document`, `wireframe`, `sequence`, `er`), 4 STT engines (`browser`, `whisper`, `hosted`, `livekit`), native WebRTC meeting room (`NativeRoom.tsx`), `IntelligenceView`, `ExecutionView`, `ReviewView`, `HistoryView`, and `CommandOverlay` (`⌘K`) | `packages/web/src/workspace.tsx:124`, `api.ts:401`, `boardSync.ts:96`, `meeting-voice.ts:39`, `views/CanvasView.tsx`, `views/MeetingView.tsx` |
| **`@lucent/mcp`** | Model Context Protocol stdio server exposing local (`BoardSession`) and live HTTP (`RemoteBoardSession` over `/api/v1`) tools: `apply_canvas_operations`, `construct_diagram`, `get_board`, `list_external_links`, `import_mermaid`, `export_mermaid`, `search_workspace`, `list_decisions`, `get_meeting`, `get_project`, `reset_board` | `packages/mcp/src/tools.ts:445`, `remote.ts:69-118` |
| **`@lucent/voice-agent`** | LiveKit Worker (`@livekit/agents` 1.9 + Silero VAD + Deepgram `nova-3` STT / `aura-asteria-en` TTS + OpenAI LLM plugin) that joins `voice_<boardId>` rooms with a board-scoped `Agent` grant and calls `construct_diagram`, `apply_canvas_operations`, and `get_board_summary` | `packages/voice-agent/src/agent.ts:175-457` |
| **`@lucent/i18n`** | Type-checked localization dictionary (`en` and `hu`) with placeholder parity validation | `packages/i18n/src/index.ts` |
| **`@lucent/load`** | k6 load-testing profiles (`editors-one-board.js`, `boards-1k.js`, `cold-open-5k.js`) | `packages/load/package.json` |
| **`@lucent/site`** | Static marketing site and status page | `packages/site/index.html`, `status.html` |

### 2. Compact Architecture Map of the Current System (`VERIFIED`)

```text
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENTS & AGENT SURFACES                                    │
│                                                                                               │
│  [@lucent/web (React + DOM/SVG Canvas)]        [@lucent/voice-agent]       [@lucent/mcp]      │
│   ├─ Canvas / Lenses / Slash Cmds / Rules       └─ LiveKit Worker           ├─ BoardSession   │
│   ├─ Voice Conversation & Meeting Capture          (Deepgram + Silero)      └─ RemoteSession  │
│   └─ BoardSync (WS) + streamGenerate (SSE)              │                         │           │
└──────────────┬──────────────────────┬───────────────────┼─────────────────────────┼───────────┘
               │ WSS /ws?ticket=      │ POST /api/generate│ POST /api/boards/:id/   │ POST /api/v1/
               │                      │ (/stream, /ask)   │   ops & /orchestrate    │   boards/:id/*
               ▼                      ▼                   ▼                         ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                              @lucent/server (node:http + ws)                                  │
│                                                                                               │
│  [Security & Governance Plane]                                                                │
│   ├─ Auth (Cookie/Bearer/OAuth/SAML/TOTP/SCIM/AgentGrant) + CSRF + AccessPolicy (2FA floor)   │
│   └─ Classification (internal/confidential/restricted) + OrgPolicy + ProviderGate + Metering  │
│                                                                                               │
│  [Divergent AI Generation Entry Points]  ◄── CRITICAL ARCHITECTURAL SEAM                      │
│   ├─ Path A (Web/Canvas/Meetings): generate.ts -> LLMProvider.generateOperations (38 ops)     │
│   │   └─ Returns ops to browser -> Browser commits via WS Room OR ServerProposal (>5 ops)     │
│   └─ Path B (Voice Agent / MCP): orchestrator.ts -> generateSemanticPlan -> compileSemanticPlan│
│       └─ evaluateTopologyQuality -> commitBatch -> Room.commit / BoardStore                   │
│                                                                                               │
│  [Canonical State, Projections & Async Execution]                                             │
│   ├─ RealtimeServer & Room (Sequenced Op Log, Snapshot Compaction, pg_notify Fanout)          │
│   ├─ StatementIndexer (Cross-Board Intelligence Index) + Lexical Retriever (Search / Ask)     │
│   ├─ OutboxDispatcher + JobRunner + Automations (Meeting Recap, Decision->Plan, Overdue)      │
│   └─ Execution Platform (ExecutionLedger + Linear / GitHub / Jira Outbound & Webhook Inbound) │
└──────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                               │
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                     @lucent/core (Pure Deterministic Semantic Engine)                         │
│  Workspace Model (18 DiagramKinds) · 38 Zod Operations · Validator · Pure Reducer · Inverse   │
│  Layout Engines (Layered/Sugiyama + Ortho Routing, Radial, Tree, Swimlane, StoryMap + ELK)    │
│  Semantic Lifecycles: Statement (6 kinds, 4 statuses, trust ladder) · Issue · Provenance      │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3. Status of the Unified Diagram-Understanding Pipeline (`VERIFIED`)

You asked specifically to verify whether the unified diagram-understanding pipeline—semantic planning contract, deterministic compiler, intent resolution, graph quality gate, orchestrator, and stable component-layout work—is present in the checked-out snapshot:

* **Present and unit-tested in `@lucent/core`, `@lucent/ai`, and `@lucent/server`**:
* **Semantic Planning Contract**: `packages/core/src/plan.ts:4-100` (`ExpectedTopologySchema`, `MutationScopeSchema`, `DiagramIntentSchema`, `SemanticPlanSchema`).
* **Deterministic Operation Compiler**: `packages/core/src/compiler.ts:31-192` (`compileSemanticPlan`), which maps symbolic refs (`n1`, `g1`) and unique existing node labels to canonical IDs and emits ordered `TRANSFORM_DIAGRAM`, `CREATE_GROUP`, `CREATE_NODE`, and `CONNECT_NODES` operations.
* **Intent Resolution**: `packages/ai/src/intent.ts:9-110` (`classifyIntentFastPath`) and `planToolSchema` (`intent.ts:116-218`).
* **Topology-Aware Graph Quality Gate**: `packages/core/src/qualityGate.ts:35-200` (`evaluateTopologyQuality`), checking `DISCONNECTED_FLOW`, `CYCLE_IN_DAG`, `CYCLE_IN_HIERARCHY`, `MULTIPLE_ROOTS`, and `ISOLATED_IN_NETWORK`.
* **Unified Orchestrator & Route**: `packages/server/src/orchestrator.ts:58-210` (`orchestrateGeneration`) and `POST /api/boards/:id/orchestrate` (`packages/server/src/routes/boardOps.ts:294-398`).
* **Stable Component & Incremental Region Layout**: `packages/core/src/layout.ts:1035-1207` (`extendRegionLayoutWithRoutes`, `mutationScope: "extend_region"`), verified in `packages/core/test/stableLayout.test.ts:162-278`.

* **Crucial Reality Check (`VERIFIED` Defect — Detailed in Section B)**:
While these modules exist and pass synthetic certification suites (`packages/server/test/certification/*`), **the pipeline is split-brained and non-functional on real LLM providers**:
1. `@lucent/web` (`CanvasView`, `AIPill`, `voiceConversation.ts`, `meeting-extract.ts`) **never calls `/api/boards/:id/orchestrate`**. It calls `/api/generate/stream` (`packages/server/src/generate.ts:780`), which only uses `classifyIntentFastPath` to pick `targetKind` on an empty board (`generate.ts:816-826`) and bypasses `SemanticPlan`, `compileSemanticPlan`, and `evaluateTopologyQuality` entirely.
2. Even worse, when `/api/boards/:id/orchestrate` *is* called by `@lucent/voice-agent` (`packages/voice-agent/src/agent.ts:268`) or `@lucent/mcp` (`packages/mcp/src/remote.ts:309`) against a real LLM provider (`AnthropicProvider` or `OpenAICompatibleProvider`), `generateSemanticPlan` (`packages/ai/src/planGenerator.ts:31-58`) calls `provider.generateOperations` using the raw `apply_canvas_operations` tool schema instead of `planToolSchema()`, tries to parse `res.explanation` (prose!) as `SemanticPlanSchema`, fails 100% of the time, and **silently falls back to `generateMockPlan`**—committing a hardcoded 3-node canned diagram (`Web Client -> API Gateway -> Database`) to the user's live board!

### 4. Documentation vs. Implementation Discrepancies (`VERIFIED`)

* **`README.md` is severely outdated**: `README.md:6,39` still claims "Status: V1 slice implemented... S3 asset storage is the remaining MVP concern" and claims `@lucent/web` is a "React + React Flow renderer of `core`; voice pipeline (`voice.ts`)". In reality, React Flow is not installed, S3 asset storage is implemented (`packages/server/src/assets.ts`), and 7 workspaces (plus `load` and `site`) exist.
* **`AGENTS.md` contradicts the shipped data model**: `AGENTS.md:97-101` states "there is no `Knowledge` collection and no workspace-memory layer (goals/requirements/decisions)". In reality, Stages C2–C6 and J3/J5 shipped first-class `statement` fields on nodes (`decision`, `proposal`, `question`, `action`, `requirement`, `risk`), a cross-board `StatementIndexer` (`packages/server/src/statementIndex.ts`), and server-assembled cross-board workspace memory (`packages/server/src/generateMemory.ts`).
* **`docs/26-the-connected-loop.md` §3 Status Table has stale `❌`/`🟡` entries**: Many items marked `❌` in `docs/26` §3 were subsequently built in later commits of the same branch (e.g., `favorites.ts`, `trash.ts`, `table.ts`, `chart.ts`, `vector.ts`, `apiTokens.ts`, `automation.ts`, `threads.ts`, `workspaceRules.ts`, `specImport.ts`, `codeExport.ts`).

### 5. What Is Surprisingly Good Already (`VERIFIED`)

1. **The Single-Node Multi-Faceted Semantic Spine (`packages/core/src/model.ts:68-110`)**: A single `Node` can simultaneously be an architecture component (`nodeType`, `groupId`, `details`), an epistemic claim (`statement` with `kind`, `status`, `topic`, `supersedes`, `trust`), an executable task (`issue` with `status`, `assignee`, `dueDate`, `blockedBy`/`atRiskBy` derived projections), and an evidence-backed artifact (`provenance` with `meetingId`, `turnRange`, `quote`, `createdFrom`, `prompt`).
2. **Trust Stamping at the Committer Boundary (`packages/core/src/trust.ts:26-93`, ADR 0047)**: `withoutTrust` strips any trust level the LLM attempts to claim, and `stampTrust` assigns `ai-suggested`, `human-approved`, `human-created`, or `system` strictly from the authenticated committer context.
3. **The Execution Safety & Honesty Layer (`packages/server/src/integrations/`, ADRs 0030–0036)**: The combination of `ExecutionLedger` (claim triad), `<!-- lucent-action:key -->` description markers with `recoverCreate` before retry, `capabilityWarnings` requiring explicit `acknowledgeWarnings: true` (`409` gate when pushing `dueDate` or `blocked` to GitHub), and symmetric human-gated inbound webhooks is production-grade engineering rarely seen even in mature SaaS tools.
4. **Meeting Conversational Lease & Speech Discipline (`packages/web/src/meeting-voice.ts:39-120`)**: Explicit vocative detection (`detectAddress` handling STT homophones like "loosened"/"lucid" while ignoring passive mentions like "Lucent is fast"), 15-second speaker-bound follow-up leases that suspend on teammate cross-talk, zero-cost polite dismissals (`detectDismissal`), and VAD barge-in cancellation.

---

## Section B — Most Important Findings

Findings are grouped by root cause and tagged with evidence confidence (`VERIFIED` from code/trace vs. `INFERENCE`).

### Finding B1 — P0 Confirmed Defect: `generateSemanticPlan` & `requestBoundedEdgeRepair` Silently Return Canned Mock Diagrams on Real LLM Providers (`VERIFIED`)

* **Category**: Category 1 (Confirmed Defect) · **Priority**: P0 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `packages/ai/src/planGenerator.ts:10-97`
* `packages/ai/src/intent.ts:116-218` (`planToolSchema` exported, 0 callers in repo)
* `packages/ai/src/providers/openai-compat.ts:273-286` and `anthropic.ts:173-179`
* `packages/server/src/orchestrator.ts:101-148`
* `packages/voice-agent/src/agent.ts:251-293` (`construct_diagram`)
* `packages/mcp/src/remote.ts:305-340` (`construct_diagram`)

* **Execution Path & How the Failure Arises**:
1. A user speaks to the LiveKit Voice Agent or an MCP agent invokes `construct_diagram`, which `POST`s `{ prompt }` to `/api/boards/:id/orchestrate` (`boardOps.ts:294`).
2. `orchestrateGeneration` (`orchestrator.ts:101`) calls `generateSemanticPlan(services.provider, board.workspace, req.prompt)`.
3. In `planGenerator.ts:19`, `if (provider.name === "mock" || !("apiKey" in provider))` evaluates to `false` for `AnthropicProvider` and `OpenAICompatibleProvider` (both attach `this.apiKey` in their constructors at `anthropic.ts:134` and `openai-compat.ts:224`).
4. Line 31 calls `await provider.generateOperations({ message: prompt, rules: systemInstructions, summary: ... })`.
5. `provider.generateOperations` forces the LLM to call the `apply_canvas_operations` tool (`TOOL_NAME`), which emits `{ operations: Operation[], explanation: "Constructed..." }`—**never** `planToolSchema()` (`intent`, `nodes`, `edges`, `groups`).
6. Lines 51–58 inspect `res.explanation`, run `parseModelJson(res.explanation)` and `SemanticPlanSchema.safeParse(parsed)`, which **always fails** because `res.explanation` is a prose sentence, not a JSON `SemanticPlan`.
7. Line 58 executes `return generateMockPlan(prompt, workspace, resolvedIntent)`—discarding the real LLM call (after paying full latency and tokens) and returning a hardcoded 3-node mock diagram (`Web Client -> API Gateway -> Database` or `Step 1 -> Step 2 -> Step 3`)!
8. Furthermore, if `evaluateTopologyQuality` returns `REPAIRABLE`, `orchestrator.ts:120` calls `requestBoundedEdgeRepair` (`planGenerator.ts:64-97`), which has `if (provider.name === "mock") { ... } return plan;`—a literal no-op on real providers, guaranteeing Pass 2 fails with `422 outcome: "unresolved"`.

* **Affected Workflows**: LiveKit duplex voice agent (`construct_diagram`), remote MCP `construct_diagram`, and any API caller of `/api/boards/:id/orchestrate`. (Notice why `test/certification/*` didn't catch this: those tests either use `MockProvider` or pass hand-written `SemanticPlan` objects directly to `compileSemanticPlan`!)
* **Recommended Solution**:
1. Add `generatePlan?(request): Promise<SemanticPlan>` (or wire `planToolSchema()` from `packages/ai/src/intent.ts:116`) into `LLMProvider`, or translate `res.operations` from `generateOperations` deterministically into a `SemanticPlan` instead of parsing `res.explanation`.
2. Never fall back to `generateMockPlan` when `provider.name !== "mock"`—a real provider parse failure must surface as an explicit error or repair round, never silently commit fake mock nodes (`Option A: PostgreSQL` / `Web Client`) onto a user's production board.
3. Implement the real provider call inside `requestBoundedEdgeRepair` (`planGenerator.ts:95`).

* **How to Verify**: Write a unit test in `packages/ai/test/` using `OpenAICompatibleProvider` + a scripted `fetchImpl` returning a real tool call, and assert `generateSemanticPlan` returns the model's actual nodes/edges and never `generateMockPlan` labels.

---

### Finding B2 — P0 Confirmed Defect: `commitBatch` + `RealtimeServer.commitForBoard` Clobber Live Room State and Drop Collaborator WebSocket Broadcasts (`VERIFIED`)

* **Category**: Category 1 (Confirmed Defect) · **Priority**: P0 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `packages/server/src/commitBatch.ts:21-75`
* `packages/server/src/realtime.ts:979-1014`
* `packages/server/src/routes/proposals.ts:233-275`
* `packages/server/src/integrations/applyInbound.ts:84-120`

* **Execution Path & How the Two Failures Arise**:
* **Failure Mode 1 (Stale Workspace Overwrite in `commitBatch.ts:43-44`)**:
1. When a room is live and the caller is in `room.roles`, `commitBatch` (`commitBatch.ts:34`) calls `s.commitForBoard(board.id, userId, operations, label, ...)`.
2. Inside `commitForBoard` (`realtime.ts:991-1005`), `room.commit` runs on the room's serialized queue, applies `operations` to `room.current()` (which includes any concurrent ops absorbed from peers), and persists `room.current()` to `boardStore.put` at `realtime.ts:1001`.
3. Control returns to `commitBatch.ts:43-44`, which immediately executes:
```ts
const updated = applyOperations(board.workspace, operations);
await s.boardStore.put({ ...board, workspace: updated, updatedAt: Date.now() });
```

Because `board` was fetched *before* `commitForBoard` ran, `board.workspace` does not contain any operations that were in `room.current()` ahead of the store or absorbed during `room.commit`. This second `boardStore.put` **overwrites the database workspace with stale state**! (Note that `proposals.ts:242-251` and `applyInbound.ts:88-95` do *not* do this redundant `boardStore.put`, confirming `commitBatch.ts:43-44` is a bug.)

* **Failure Mode 2 (Silent Split-Brain When Actor Has No Open WebSocket in `realtime.ts:990`)**:
1. `Room` initializes `this.roles` with only `ownerId -> "owner"` (`room.ts:227`) and only adds other users when they connect via WebSocket (`realtime.ts:328`).
2. If Collaborator B (or Viewer B) has the board open in a browser (so `this.rooms.get(boardId)` is live), and Collaborator A (an editor without an open WS tab, an MCP agent acting for Collaborator A, or an Automation/Inbound Sync where `decider.by === "system"` in `app.ts:2680` / `applyInbound.ts:84`) commits via HTTP (`POST /ops`, `/orchestrate`, `/proposals/:pid/approve`, `/review`, or inbound accept):
3. `commitForBoard` checks `if (room.roleOf(userId) === undefined) return null;` (`realtime.ts:990`). For `userId === "system"` or an offline editor `userA`, `room.roleOf` is `undefined`!
4. `commitForBoard` returns `null`, and the caller falls through to writing directly to `boardStore.appendOp` + `boardStore.put` **while the live `Room` is still in memory**!
5. Connected WebSocket peers (`Collaborator B`) **never receive the broadcast**, and the in-memory `Room` stays at the old `head` and old `workspace`!

* **Recommended Solution**:
1. Remove lines 43–44 from `packages/server/src/commitBatch.ts` (`commitForBoard` already persists `room.current()` at `realtime.ts:1001`).
2. In `RealtimeServer.commitForBoard` (`realtime.ts:988-991`), all HTTP callers (`boardOps`, `orchestrator`, `proposals`, `review`, `applyInbound`) have **already authorized** the caller at the route boundary. Instead of returning `null` when `room.roleOf(userId) === undefined`, seed `room.setRole(userId, "editor")` (or allow a trusted internal/system flag on `commitForBoard`) so that **every** HTTP mutation on a board with a live `Room` goes through `room.commit` and broadcasts to connected peers.

* **How to Verify**: Add an integration test in `packages/server/test/opProtocol.e2e.test.ts` where `owner` creates a board, `viewer` connects via WebSocket, and `editor` (not connected via WS) or `system` (inbound sync) submits an op via HTTP—assert `viewer`'s WebSocket receives the `{ type: "op" }` frame immediately and `room.current()` matches `boardStore.get()`.

---

### Finding B3 — P0 Confirmed Defect: `runGeneratePipeline` Ignores `app.ts`'s Authoritative Role Check and Writes Directly to `boardStore.put` Bypassing `op_log` and Live Rooms (`VERIFIED`)

* **Category**: Category 1 (Confirmed Defect) · **Priority**: P0 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `packages/server/src/app.ts:1788-1803` (`resolveAiContext`) and `5089-5100`, `5278-5282`
* `packages/server/src/generate.ts:806-815` and `1091-1118`
* `packages/server/src/app.ts:2618-2621` (`automations.generate`)

* **Execution Path & How the Failure Arises**:
1. In `app.ts:5089-5100`, the comment explicitly notes that checking `storedBoard.ownerId === auth.userId` was a bug that downgraded collaborators to non-authoritative summary validation, so `app.ts` calls `resolveAiContext(auth.userId, storedBoard)` (which checks `roleAtLeast(role, "editor")`) and passes `authoritative = { boardId: storedBoard.id, store: boardStore }` into `handleGenerate` / `handleGenerateStream`.
2. However, inside `runGeneratePipeline` (`packages/server/src/generate.ts:809-810`), the legacy check was never removed:
```ts
const authoritativeBoard =
  candidateBoard && userId === candidateBoard.ownerId ? candidateBoard : undefined;
```

Consequently, for **every non-owner editor** and **every automation run** (`app.ts:2618`, where `userId` is `undefined`), `authoritativeBoard` evaluates to `undefined`, silently downgrading validation from the stored board to the client's truncated `summary`!
3. Conversely, when `userId === candidateBoard.ownerId` *is* true and the caller passes top-level `boardId` to `/api/generate` or `/api/generate/stream`, `generate.ts:1096-1100` executes:
```ts
await authoritative.store.put({
  ...authoritativeBoard,
  workspace: updated,
  updatedAt: Date.now(),
});
```

This mutates `boardStore` directly **without appending to `op_log`, without going through `Room.commit`, without broadcasting to WebSocket peers, and without gating batches >5 ops behind a proposal**—violating ADR 0041 ("One mutation path") and ADR 0049!

* **Recommended Solution**:
1. In `generate.ts:809-810`, remove `&& userId === candidateBoard.ownerId` (`app.ts` already resolved `aiCtx.authoritative` via `roleAtLeast(role, "editor")`).
2. Separate **authoritative validation** (reading `candidateBoard.workspace` from `boardStore` so the LLM output is validated against real server state, including when `run.boardId` is supplied by the web client!) from **direct server mutation** (`store.put` in `generate.ts:1096` should never overwrite a board behind the back of `op_log` and `ProposalStore`).

* **How to Verify**: Test `/api/generate` with a non-owner `editor` passing `boardId` after another user deletes a node on the server; assert validation runs against the stored board and rejects edges targeting the deleted node.

---

### Finding B4 — P1 Confirmed Defect: MCP `construct_diagram` and `/api/boards/:id/orchestrate` Drop Caller-Supplied `SemanticPlan`s or Emit a 1-Node Stub (`VERIFIED`)

* **Category**: Category 1 (Confirmed Defect) · **Priority**: P1 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `packages/mcp/src/remote.ts:305-312`
* `packages/server/src/routes/boardOps.ts:329-361`
* `packages/mcp/src/tools.ts:445-469`

* **Execution Path & How the Failure Arises**:
1. In `packages/mcp/src/tools.ts:165-182`, the `construct_diagram` MCP tool schema advertises both `prompt` and optional `plan` (`SemanticPlan`).
2. When running in `RemoteBoardSession` (`packages/mcp/src/remote.ts:309-312`), `constructDiagram` sends `POST /api/boards/:id/orchestrate` with `{ prompt, ...(args.plan ? { plan: args.plan } : {}) }`.
3. However, `packages/server/src/routes/boardOps.ts:329-361` only reads `{ prompt, requestId, expectedSeq }` from the request body and **completely ignores `body.plan`**, passing only `prompt` to `orchestrateGeneration`!
4. Conversely, when running in local `BoardSession` (`packages/mcp/src/tools.ts:449-468`), if an MCP client calls `construct_diagram({ prompt })` *without* pre-building `args.plan`, `constructDiagram` synthesizes a degenerate 1-node stub: `nodes: [{ ref: "n1", label: prompt.slice(0, 40) }], edges: []`!

* **Recommended Solution**:
Accept optional `plan?: SemanticPlan` (validated via `SemanticPlanSchema.safeParse`) in `/api/boards/:id/orchestrate` and `orchestrateGeneration`: when a coding agent supplies a structured `SemanticPlan`, skip the server LLM call (`generateSemanticPlan`) and run `compileSemanticPlan` -> `evaluateTopologyQuality` -> `commitBatch` directly (zero server LLM spend, deterministic compilation!).

---

### Finding B5 — P1 Architectural & Security Risk: Hardcoded Production IP in Edge Proxies & Unbounded Multi-Worker Memory/Broadcast Divergences (`VERIFIED`)

* **Category**: Category 2 (Architectural & Operational Risk) · **Priority**: P1 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `functions/api/[[path]].ts:20`, `functions/ws.ts:3`, `packages/web/functions/api/[[path]].ts:20`, `packages/web/functions/ws.ts:3`
* `packages/server/src/realtime.ts:709, 724, 1025` (`spotlight`, `summon`, `broadcastProposal`)
* `packages/server/src/fanout.ts`

* **How the Risks Arise**:
1. **Hardcoded IP in Duplicate Edge Functions**: Both `functions/` and `packages/web/functions/` are byte-for-byte duplicate Cloudflare Pages Function directories that hardcode `https://161.33.167.15.sslip.io` as the upstream origin (`[[path]].ts:20`, `ws.ts:3`). Any deployment to a different environment silently proxies user traffic and cookies to that specific IP.
2. **Multi-Instance Fanout Drops Proposals, Spotlight, and Summon Events**: In a 4-worker PM2 cluster (`ecosystem.config.cjs`) or multi-pod Helm deployment, `fanout` (`pg_notify`) ONLY publishes `kind: "op"` and `kind: "resync"` (`realtime.ts:523, 899`). `broadcastProposal` (`proposal-created`, `proposal-decided`, `integrations-inbound` at `realtime.ts:1025`), `spotlight` (`realtime.ts:709`), and `summon` (`realtime.ts:724`) only broadcast to `this.connsByBoard` on the local Node worker! If User A and User B land on different PM2 cluster instances (or behind a load balancer without strict IP pinning, or across different NAT IPs), User B sees node operations via `pg_notify`, but **never receives proposal panels opening/closing, inbound sync badges, or "Bring everyone here" summons**.

* **Recommended Solution**:
1. Replace the hardcoded `161.33.167.15.sslip.io` URL with `context.env.LUCENT_ORIGIN` in `functions/` and remove the duplicate directory.
2. Extend `FanoutMessage` (`packages/server/src/fanout.ts`) with `proposal` and `ephemeral` (`spotlight`/`summon`) notifications so all 4 PM2 workers stay synchronized across every collaboration primitive.

---

### Finding B6 — P1 Systemic Product & Architectural Gap: Two Divergent AI Contracts & Truncated Blind Spots on Large Boards (`VERIFIED`)

* **Category**: Category 2 (Systemic Product & Architectural Risk) · **Priority**: P1 · **Confidence**: `VERIFIED`
* **Evidence & Paths**:
* `packages/ai/src/prompt.ts` (`REQUEST_LIMITS`: `nodes: 200`, `edges: 300`, `shapes: 200`, `comments: 100`)
* `packages/server/src/generate.ts:56-186` (`workspaceFromSummary`)
* `packages/core/src/compiler.ts:31-192` vs `packages/core/src/operations.ts`

* **How the Limitation Arises**:
1. **Two Incompatible AI Dialects**:
* The `SemanticPlan` compiler (`packages/core/src/compiler.ts`) prevents edge-ID hallucination by letting the model use symbolic refs (`n1`, `n2`) and resolving existing node labels automatically, **but it can only emit 4 of Lucent's 38 operations** (`TRANSFORM_DIAGRAM`, `CREATE_GROUP`, `CREATE_NODE`, `CONNECT_NODES`). It cannot emit `SET_STATEMENT`, `UPDATE_STATEMENT`, `SET_ISSUE`, `SET_NODE_DETAILS`, `SET_GROUP_KIND`, `CREATE_SHAPE`, or `CREATE_WIREFRAME`.
* Conversely, the direct operation pipeline (`packages/server/src/generate.ts`) exposes all 38 operations, **but requires the LLM to manage raw IDs directly**, which is why `generate.ts:502-638` needs three separate post-hoc LLM re-ask bandaids (`requestRepair`, `requestRicher`, `requestConnect`—up to 3 sequential LLM round-trips taking 30–60+ seconds on a single user prompt!).

2. **Silent Summary Truncation Breaks Incremental Edits on Boards >200 Nodes**:
When a board grows past `REQUEST_LIMITS.nodes` (200) or `edges` (300), `summarizeWorkspace` (`packages/ai/src/prompt.ts`) truncates the summary sent to `/api/generate`. Because `/api/generate` from the web client does not pass top-level `boardId`, `workspaceFromSummary` (`generate.ts:305`) reconstructs a **partial** workspace containing only the first 200 nodes. If the LLM creates a node whose ID collides with node #201 or references node #205, server validation disagrees with client state!

---

## Section C — The 10 Best Improvements to Existing Functionality

Every item below improves a capability that **already exists in the codebase**, grounded in exact file paths.

| # | Improvement | Priority & Effort | Evidence Confidence | Root Files Touched |
| --- | --- | --- | --- | --- |
| **1** | **Unify Symbolic Reference Resolution (`compileSemanticPlan`) into the Full 38-Op Pipeline** | **P0** · Medium | `VERIFIED` | `packages/core/src/compiler.ts`, `packages/core/src/repair.ts`, `packages/server/src/generate.ts` |
| **2** | **Replace Post-Hoc `requestConnect` LLM Re-Ask with Deterministic Topology Repair Where Unambiguous** | **P1** · Small | `VERIFIED` | `packages/server/src/generate.ts:556-581, 1025-1070`, `packages/core/src/qualityGate.ts` |
| **3** | **Wire Browser Image & File Drops to `AssetService` (`/api/assets`) Instead of Inlining Base64 Data URLs in `op_log`** | **P1** · Small | `VERIFIED` | `packages/web/src/board/images.ts`, `packages/web/src/assets.ts`, `packages/server/src/routes/assets.ts` |
| **4** | **Promote Large Voice-Agent & MCP Batches (>5 Ops) to Server Proposals Instead of Direct Commit** | **P1** · Small | `VERIFIED` | `packages/server/src/routes/boardOps.ts:223`, `packages/voice-agent/src/agent.ts:216`, `packages/server/src/proposals.ts` |
| **5** | **Cross-Board Semantic & Lexical Retrieval for `Ask` and `⌘K` (Closing the `embeddings` / Stemming Gap)** | **P1** · Medium | `VERIFIED` | `packages/server/src/retrieval.ts`, `packages/server/src/workspaceSearch.ts`, `packages/server/src/routes/scopedAsk.ts` |
| **6** | **Propagate Transcript Turn Corrections (`PATCH .../turns/:idx`) to Derived Board Nodes & Statements** | **P1** · Medium | `VERIFIED` | `packages/server/src/routes/meetings.ts`, `packages/web/src/views/MeetingView.tsx`, `packages/core/src/model.ts` |
| **7** | **Focus-Neighborhood Subgraph Context Slicing for Large Boards (>150 Nodes)** | **P1** · Medium | `VERIFIED` | `packages/ai/src/prompt.ts` (`summarizeWorkspace`), `packages/server/src/generateContext.ts` |
| **8** | **Optimistic Local Layout Preview + Streaming Skeleton Nodes During SSE `delta` Frames** | **P1** · Medium | `VERIFIED` | `packages/web/src/api.ts:577-581`, `packages/web/src/workspace.tsx`, `packages/web/src/ui/DiagramLayer.tsx` |
| **9** | **Unify the Four Disjoint Human Review Gates into One Inline Canvas Overlay + Review Shortcut** | **P2** · Medium | `VERIFIED` | `packages/web/src/views/ProposalPanel.tsx`, `ReviewView.tsx`, `IntegrationPanel.tsx`, `IntelligenceView.tsx` |
| **10** | **Bidirectional Field Sync & Custom Status Mapping UI for Jira/GitHub/Linear** | **P2** · Medium | `VERIFIED` | `packages/server/src/integrations/jira.ts`, `github.ts`, `inbound.ts`, `packages/web/src/views/IntegrationPanel.tsx` |

### Detailed Breakdown of the 10 Improvements

1. **Unify Symbolic Reference Resolution into the Full 38-Op Pipeline (`P0`, Medium)**
* *Current state*: `compileSemanticPlan` (`packages/core/src/compiler.ts:63-98`) has a great idea—resolving symbolic refs (`n1`) and unique case-insensitive node labels (`"Payment Service"` -> `node_abc`) so the LLM never hallucinates IDs—but it only supports 4 operations and is disconnected from `generate.ts`. Meanwhile, `repairOperations` (`packages/core/src/repair.ts`) reorders `CREATE_GROUP` / `CREATE_NODE` / `SET_STATEMENT`, but does **not** resolve label-as-ID references when an LLM emits `CONNECT_NODES: { source: "Checkout", target: "Stripe" }` instead of `{ source: "nd_1", target: "nd_2" }`.
* *Improvement*: Fold label-to-ID alias resolution and symbolic ref resolution directly into `repairOperations(ops, workspace)` in `@lucent/core`, and fix `generateSemanticPlan` (`packages/ai/src/planGenerator.ts`) to use the same unified pipeline. This eliminates the #1 cause of partial-application edge drops across text, voice, and MCP.

2. **Replace Post-Hoc `requestConnect` LLM Re-Ask with Deterministic or Targeted Repair (`P1`, Small)**
* *Current state*: In `packages/server/src/generate.ts:1031-1070`, when a batch creates $\ge 2$ nodes and leaves even one node floating, `runGeneratePipeline` fires a second full LLM call (`requestConnect`), adding 10–30s of latency and doubling token spend.
* *Improvement*: First check whether the floating node is a legitimate standalone role (`note`, `legend`, `actor`, or inside a `matrix`/`independent_clusters` group, matching `qualityGate.ts:140-155`). Second, if a node was left floating because its `CONNECT_NODES` op was dropped due to a label/ID mismatch, the alias resolution in Improvement #1 recovers the edge deterministically in `0ms` without a second LLM call!

3. **Wire Browser Image & File Drops to `AssetService` (`/api/assets`) (`P1`, Small)**
* *Current state*: As noted in `docs/26-the-connected-loop.md` §3 ("Upload API exists but no web client; every image lives as a data URL in the op log"), `packages/server/src/routes/assets.ts` implements authenticated, byte-capped, S3/disk/memory asset storage with `/api/assets/:id` and thumbnailing, and `@lucent/core` already supports `asset:<id>` references (`packages/core/test/asset-ref.test.ts`). Yet `packages/web/src/board/images.ts` still encodes dropped/pasted images as multi-megabyte `data:image/...;base64,...` strings inside `CREATE_SHAPE` operations, bloating `op_log`, WebSocket broadcasts, and `localStorage`!
* *Improvement*: Upload dropped/pasted images via `POST /api/assets` in `packages/web/src/assets.ts` when on a shared/authenticated board and emit `src: "asset:<id>"` in `CREATE_SHAPE`.

4. **Promote Large Voice-Agent & MCP Batches (>5 Ops) to Server Proposals (`P1`, Small)**
* *Current state*: Invariant 4 ("Human intent takes precedence over AI actions; gate major operations behind human approval") is enforced on the web client (`proposalThreshold` in `packages/web/src/workspaceHelpers.ts`), and `docs/26` F2 explicitly noted: *"Left for the voice track: large agent edits still apply directly instead of as a proposal."* Currently, `POST /api/boards/:id/ops` (`boardOps.ts:223`) and `POST /api/boards/:id/orchestrate` (`orchestrator.ts:180`) commit 30-operation batches from `@lucent/voice-agent` or `@lucent/mcp` directly to the board without creating a `ServerProposal`!
* *Improvement*: In `boardOps.ts` and `orchestrator.ts`, when `viaAgent || viaMcp` (or `actor.actorType === "ai"`) and the batch exceeds the proposal threshold (e.g., $>5$ ops on a non-empty board, or contains destructive `DELETE_NODE` ops), store a pending `ServerProposal` via `services.proposals.create(...)` and broadcast `proposal-created` over WebSocket so the human sees the live diff preview on the canvas and can say *"Approve that"* or click Approve!

5. **Enrich Lexical Retrieval with Synonym/Concept Expansion & Statement-Graph Traversal (`P1`, Medium)**
* *Current state*: `packages/server/src/retrieval.ts` uses pure morphological stem/prefix matching (`canonicalizeTopic` / token folding). As `ADR 0025` notes, `monetization` and `pricing` never match, and `auth` does not match `login` or `SSO`.
* *Improvement*: Before introducing external vector DB dependencies (preserving Invariant 10), augment `retrieval.ts` with (a) 1-hop graph expansion over `workspace.edges` and `statement.supersedes` (so searching `"Stripe"` also retrieves connected `"Checkout"` nodes and superseded payment proposals) and (b) a lightweight domain-synonym expansion table + board-topic co-occurrence index.

6. **Propagate Transcript Turn Corrections to Derived Board Objects (`P1`, Medium)**
* *Current state*: `packages/server/src/meetings.ts` (`correctedTurns`) and `routes/meetings.ts` allow users to correct a misheard transcript turn (e.g., changing `"$15/month"` to `"$50/month"` or fixing speaker attribution), and `writeMeetingRecap` (`app.ts:2267`) reads `correctedTurns`. However, nodes and statements already extracted onto the board during live capture whose `provenance.turnRange` includes that turn **retain the old misheard label and old `provenance.quote`**!
* *Improvement*: When a turn is corrected in `MeetingView`, scan the board's nodes whose `provenance.meetingId === meetingId` and `turnRange` overlaps `turnIndex` (reusing `turnObjects` in `packages/web/src/meetings.ts`), update their `provenance.quote`, and surface a 1-click **"Update N linked board objects"** proposal!

7. **Focus-Neighborhood Subgraph Slicing for Large Boards (`P1`, Medium)**
* *Current state*: `summarizeWorkspace` (`packages/ai/src/prompt.ts`) slices the first 200 nodes in insertion order (`Object.values(workspace.nodes).slice(0, 200)`). On a 300-node board, if the user selects node #280 and says *"Decompose this service"*, the selected node's 1-hop and 2-hop neighbors may be cut off if they were created after node #200!
* *Improvement*: Prioritize `selection` -> 1-hop and 2-hop incident neighbors -> same `groupId` region members -> open `statement` nodes -> most recently modified nodes when building the 200-node summary window, and always validate against `storedBoard.workspace` on the server when `run.boardId` is present.

8. **Streaming Incremental Ghost Preview on Canvas During SSE `delta` Frames (`P1`, Medium)**
* *Current state*: `POST /api/generate/stream` streams raw token deltas (`api.ts:577`), and `AIPill` shows phase text (`"Parsing intent..."`, `"Designing architecture..."`), but the canvas remains static for 6–35 seconds until the `done` frame arrives.
* *Improvement*: Extract completed `CREATE_NODE` / `CONNECT_NODES` objects incrementally from the streaming JSON buffer in `streamGenerate` and render them as translucent "constructing" ghost cards on `DiagramLayer` (using the same preview styling as `ProposalPanel`), replaced atomically when the validated `done` frame lands.

9. **Unify the Disjoint Review Surfaces into Context-Aware Canvas Chips (`P2`, Medium)**
* *Current state*: A user currently faces four separate places where human approval waits: (1) `ProposalPanel` on the canvas (for $>5$-op AI batches), (2) `ReviewView` in the left rail (for `ai-suggested` statements), (3) `IntegrationPanel` (for outbound Linear/GitHub/Jira sync previews), and (4) `IntelligenceView`'s "External changes" & "Recommendation inbox" (for inbound webhooks and duplicate topics).
* *Improvement*: Surface `ai-suggested` trust badges and pending inbound-drift badges directly on the affected canvas nodes with inline **Approve / Edit / Dismiss** micro-actions in `NodeAiToolbar` (`packages/web/src/ui/NodeAiToolbar.tsx`), while keeping `ReviewView` as the org-wide batch inbox.

10. **Configurable Status & Field Mapping for Jira/GitHub/Linear (`P2`, Medium)**
* *Current state*: `packages/server/src/integrations/jira.ts` (`mapStatus`) only maps well-known default Jira statuses; custom company-managed workflow states return `undefined` and produce un-acceptable warning rows in the inbound queue (`ADR 0033`/`0034`).
* *Improvement*: Allow `connection.config` to store an optional `statusMap: Record<string, ExecutionStatus>` populated from the provider's discovered workflow states during connection setup, turning warning-only rows into actionable syncs without hardcoding vendor states in `@lucent/core`.

---

## Section D — The 10 Most Promising New Feature Ideas

Each feature below is designed specifically around Lucent's core thesis—**conversation, semantic graph, meeting intelligence, and execution operating on one shared model**—and verified not to exist in the current repository.

### Feature D1: Live Architecture Contradiction & Decision-Drift Detector ("Semantic Linter")

1. **Concise Name**: Semantic Architecture & Decision Drift Linter
2. **Concrete User Interaction**: During a system design session, the team has an approved decision node `[Decision · resolved] Use AWS Lambda only — no long-running containers` (`topic: compute-runtime`) and `WorkspaceRules` (`prohibitedPatterns: "No persistent EC2/ECS containers"`). Later, a teammate or coding agent adds a node `Order Worker (ECS Fargate)` connected to `Kafka Cluster`. A subtle amber badge `⚡ Contradicts Decision #4` appears on `Order Worker`. Clicking it shows the exact quote from last Tuesday's meeting where the serverless decision was made, offering: **(A) Supersede prior decision**, **(B) Refactor node to AWS Lambda**, or **(C) Mark as approved exception**.
3. **Lucent Behavior**: Combines deterministic graph rules (checking node labels/details/types against `WorkspaceRules` and active `decision`/`requirement` statements sharing a topic or connected via `drives`/region membership) with an on-demand or post-commit verification pass that emits structured `Recommendation` items (extending `ADR 0025`'s `Recommendation` shape).
4. **Real Problem Solved**: Teams routinely draw architectures that violate their own agreed constraints or decisions made two meetings ago; conventional whiteboards treat boxes as dumb rectangles with zero awareness of team decisions or `.cursorrules`.
5. **Existing Systems Reused**: `WorkspaceRules` (`packages/core/src/workspaceRules.ts`), `StatementFields` & `supersedes` (`packages/core/src/model.ts`), `Recommendation` inbox in `IntelligenceView` (`packages/web/src/intelligence.ts`), and `AttentionPanel` (`packages/core/src/attention.ts`).
6. **New Implementation Required**: A pure `detectSemanticContradictions(workspace, rules)` analyzer in `@lucent/core` + an optional `/verify` slash command (`packages/core/src/slashCommands.ts`) that emits structured conflict annotations with provenance links.
7. **Main Risks & Trade-Offs**: False positives create alert fatigue if triggered on every keystroke; must only flag high-confidence conflicts against `resolved` decisions and explicit `prohibitedPatterns`, and never block a human commit.
8. **Testable Success Metric**: $\ge 85\%$ precision on a 20-board seeded contradiction benchmark; zero false alerts on existing golden fixtures.
9. **Preliminary Effort**: Medium (1–2 weeks).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D2: Visual Scenario Branching & Side-by-Side Architecture Diff ("What-If Forks")

1. **Concise Name**: Ephemeral Scenario Forks & Visual Architecture Diff
2. **Concrete User Interaction**: While discussing whether to use Stripe Billing or build an in-house ledger, a user selects the `Checkout` region and says: *"Lucent, fork this region into Option A: Stripe Billing and Option B: In-House Ledger, and compare their failure modes and dependencies."* Lucent creates two linked speculative proposals/branches without mutating the accepted board, renders a split or overlay diff badge (`+3 nodes, -1 DB, 2 new risks`), and lets the team vote or click **"Adopt Option A (Supersede Option B)"**, which commits Option A and records Option B as a `rejected` proposal statement with full provenance!
3. **Lucent Behavior**: Uses `OperationHistory` and `ServerProposal` to hold 2–3 named candidate operation batches (`scenarios`) against a base `seq`, computes a semantic graph diff (`addedNodes`, `removedNodes`, `changedEdges`, `riskDelta`, `cost/complexity delta`), and on adoption commits the winning batch while automatically creating a `rejected` statement node for the declined alternative so future `Ask` queries (*"Why didn't we build an in-house ledger?"*) have the complete visual and conversational record.
4. **Real Problem Solved**: Exploring an alternative design on a shared canvas today either destroys the accepted diagram or forces messy copy-pasting of duplicate nodes that confuses AI context and inflates board counts.
5. **Existing Systems Reused**: `ServerProposal` (`packages/server/src/proposals.ts`), `applyOperations` / `reviewWorkspace` (`packages/web/src/workspaceHelpers.ts`), `Voting` (`ADD_VOTE`), and `SET_STATEMENT` (`status: "rejected"`, `supersedes`).
6. **New Implementation Required**: Multi-proposal scenario group (`scenarioGroupId` on `proposals`), semantic diff calculator (`diffWorkspaces(base, branchA, branchB)` in `@lucent/core`), and an "Adopt & Archive Rejected" commit handler.
7. **Main Risks & Trade-Offs**: Base board moving while scenarios are open; mitigated by `applyValidOperations` partial rebase (already used in `proposals.ts:215`).
8. **Testable Success Metric**: Users can compare two AI-generated architecture alternatives side-by-side and adopt one in 1 click, with `Ask Lucent` accurately answering why the rejected option was declined.
9. **Preliminary Effort**: Medium (2 weeks).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D3: Conversational Canvas Lenses ("Show Me Only...")

1. **Concise Name**: Ephemeral Semantic Filter & Blast-Radius Lens
2. **Concrete User Interaction**: On a 120-node architecture board, a user says or types in `AIPill`: *"Show me only the payment flow and what breaks if Redis goes down"* or *"Show me what changed since the September 10 review."* Without deleting or moving a single node in the canonical model, the canvas dims unrelated regions (`focusOpacity`), highlights the upstream/downstream transitive path (`Payment -> Checkout -> Redis`), overlays red impact rings on services with a `calls` or `depends_on` path to `Redis`, and displays a floating pill: `Lens: Blast Radius of Redis (9 nodes) · [Reset View] · [Save as Region]`.
3. **Lucent Behavior**: Introduces a client-local ephemeral `ViewFilter` projection over `Workspace` driven by deterministic graph queries in `@lucent/core`:
* **Flow path filter**: directed reachability between node A and node B.
* **Blast-radius / change-impact filter**: reverse transitive closure over `calls`, `reads_writes`, `depends_on`, and `drives` edges.
* **Temporal diff filter**: nodes/edges touched in `op_log` since `seq` or `meetingId` (using `HistoryView`'s revision `touchedIds`).
* **Epistemic uncertainty filter**: *"Show me what we still don't know"* -> highlights all `question` (open), `proposal` (open), `risk` (open), and `ai-suggested` nodes plus their 1-hop neighbors.

4. **Real Problem Solved**: Large boards become visually overwhelming during meetings; users want to interrogate the visual model conversationally without mutating shared state for everyone else (unless Spotlit).
5. **Existing Systems Reused**: Selection focus opacity (`packages/web/src/board/focus.ts`), `dependsOnGraph` / `decisionDriveGraph` (`packages/core/src/projectExecution.ts`), `HistoryView` revision metadata, and `Spotlight` (`packages/server/src/room.ts`).
6. **New Implementation Required**: `computeSemanticLens(workspace, querySpec, historyLog)` in `@lucent/core` + wiring into `focus.ts` and `AIPill` (as a zero-mutation view command).
7. **Main Risks & Trade-Offs**: Users might think dimmed nodes were deleted; clear top-center pill banner with `Esc to clear filter` prevents confusion.
8. **Testable Success Metric**: `< 5ms` client-side filter computation on a 500-node board; zero `op_log` writes.
9. **Preliminary Effort**: Small–Medium (1 week).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D4: "Show Me What You Inferred" — Epistemic Gap & Missing-Link Proposal Mode

1. **Concise Name**: Inferred Relationship & Missing-Subsystem Discovery
2. **Concrete User Interaction**: A team sketches or imports 12 services onto a board. Several services (`Billing Worker`, `Notification Service`, `Audit Logger`) have partial connections or implicit dependencies. The user clicks `/infer-links` or says *"Add the missing relationships and failure paths, but show me what you inferred."* Lucent analyzes the graph topology and node roles, and renders dashed amber **Inferred Edges & Ghost Nodes** on the canvas, each carrying a 1-line rationale tooltip (*"Inferred: Checkout likely publishes to Notification Service after payment success"*), with per-edge `[✓ Accept]` / `[✕ Dismiss]` buttons on hover.
3. **Lucent Behavior**: Combines `evaluateTopologyQuality` (`packages/core/src/qualityGate.ts`) and role heuristics (`service` with no database/queue, `API Gateway` with unrouted backend services, `decision` diamond with only one outgoing branch) with a targeted AI proposal where each operation in the `Proposal` is selectable individually (`partialAccept(proposalId, selectedOpIndices)`).
4. **Real Problem Solved**: Today, proposals in `ProposalPanel.tsx` are **all-or-nothing** (`Approve` applies the entire batch; `Reject` drops the entire batch). When the AI infers 8 connections and 6 are brilliant while 2 are wrong, the user either rejects all 8 or approves all 8 and manually deletes 2.
5. **Existing Systems Reused**: `ProposalPanel.tsx`, `ServerProposal`, `applyValidOperations` (`packages/core/src/validator.ts`), and `qualityGate.ts`.
6. **New Implementation Required**: Per-operation/per-entity checkboxes in `ProposalPanel` and on-canvas ghost previews (`approveProposal(id, { includeIndices })`), plus `/infer-links` slash command.
7. **Main Risks & Trade-Offs**: Cherry-picking a `CONNECT_NODES` op while unchecking its `CREATE_NODE` endpoint would fail validation; `applyValidOperations` already handles dependency checking, and the UI can auto-select prerequisite `CREATE_NODE`s when an edge is checked.
8. **Testable Success Metric**: Proposal acceptance rate increases when users can deselect 1–2 unwanted ops instead of rejecting the entire batch.
9. **Preliminary Effort**: Small–Medium (1 week).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D5: Live Meeting "Pre-Flight & Delta Brief" (Continuous Context Across Meetings)

1. **Concise Name**: Cross-Meeting Context Opener & Unresolved Blocker Brief
2. **Concrete User Interaction**: When a team opens a scheduled follow-up meeting (`MeetingView` / `UpcomingMeeting.tsx`) on a board a week later, Lucent doesn't open a blank transcript pane. Before recording starts, the meeting dock presents an interactive **"Since Last Meeting" Brief**:
* **3 External Tracker Updates**: e.g., `LIN-42 (Auth Service) moved to Done`, `GH-108 (Webhook Retry) is Blocked`.
* **2 Open Questions & 1 Unresolved Risk** from the previous meeting on this board, with 1-click **"Pin to Today's Agenda & Spotlight on Canvas"**.
* **1 Stale Assumption**: A decision whose linked action is overdue by 5 days.

3. **Lucent Behavior**: Joins `meetingBrief.ts` / `meetingFollowUp.ts` with `HistoryView` revisions since `lastMeeting.endedAt`, `inbound_changes` / `task_links` from `integrations`, and `attention.ts` signals (`overdue`, `blocked`, `open questions`), rendering an interactive pre-meeting launchpad connected to `Spotlight`.
4. **Real Problem Solved**: Fulfills the final step of Lucent's flagship loop (*"At the next meeting, the workspace can provide the relevant context"*). Currently `meetingBrief.ts` summarizes static board statements, but does not compute the **temporal delta** since the last meeting ended!
5. **Existing Systems Reused**: `packages/web/src/meetingBrief.ts`, `packages/server/src/routes/meetingFollowUp.ts`, `HistoryView` (`historyWindow.ts`), `attention.ts`, and `Spotlight`.
6. **New Implementation Required**: A `sinceSeq` / `sinceTimestamp` delta projection in `meetingBrief.ts` + agenda-pinning that triggers `summon`/`spotlight` on the canvas as each agenda item is discussed.
7. **Main Risks & Trade-Offs**: Noisy delta if many cosmetic edits occurred; filter delta strictly to semantic changes (`SET_STATEMENT`, `UPDATE_STATEMENT`, `SET_ISSUE`, `CREATE_NODE`, `DELETE_NODE`).
8. **Testable Success Metric**: Time to first productive decision in follow-up meetings; 100% accuracy in listing state changes between `Meeting N.endedAt` and `Meeting N+1.startedAt`.
9. **Preliminary Effort**: Small–Medium (1 week).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D6: Live Disagreement & Premature-Consensus Guard in Meetings

1. **Concise Name**: Dialectic Tension & Unresolved Disagreement Tracker
2. **Concrete User Interaction**: During a live meeting capture, Alice says *"We should use Kafka for order events"* and Bob says *"Kafka is overkill for our volume; Postgres `LISTEN/NOTIFY` or SQS is much simpler."* Then the conversation drifts to another topic without resolving the choice. Instead of either ignoring the exchange or falsely recording one as a decision, Lucent creates a paired **Contested Proposal Cluster** on the board (`Proposal A: Kafka [Alice]` $\leftrightarrow$ `contradicts` $\leftrightarrow$ `Proposal B: SQS/PG Notify [Bob]`) under an open `Question: Order Event Bus Selection`, and adds an item to the live Participant/Assistant open-questions tray: *"Unresolved trade-off on `event-bus` between Alice (Kafka) and Bob (SQS)."*
3. **Lucent Behavior**: Extends statement relationships in `@lucent/core` (`competes_with` / `contradicts` edge or `alternatives: string[]` on `question` statements) and updates `meetingPrompt.ts` + `classifyTurn` (`packages/web/src/meetings.ts`) to recognize counter-proposals on the same `topic` within a turn window without collapsing them into a premature decision.
4. **Real Problem Solved**: Standard AI meeting notetakers hallucinate consensus ("The team decided to use Kafka") whenever one speaker sounds confident, erasing minority technical objections that later prove critical.
5. **Existing Systems Reused**: `classifyTurn` (`packages/ai/src/meetingPrompt.ts`), `topicFold.ts` (`packages/core/src/topicFold.ts`), `StatementFields` (`proposal` + `question`), and the open-questions panel in `MeetingView.tsx`.
6. **New Implementation Required**: Teach `meetingPrompt.ts` to emit linked `proposal` nodes under a parent `question` node sharing a folded `topic` when opposing proposals appear in a capture window; render a visual `VS` / trade-off badge on `competes_with` edges.
7. **Main Risks & Trade-Offs**: Normal brainstorming shouldn't look like a fight; frame the UI neutrally as **"Open Options / Trade-Offs"** rather than "Conflict".
8. **Testable Success Metric**: Evaluated against the `brainstorm-disagreement` fixture in `packages/web/test/meeting-eval.test.ts`: 100% capture of both competing options with 0 false `decision` promotions.
9. **Preliminary Effort**: Small (4–5 days).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D7: Bi-Directional Codebase <-> Architecture Drift Sync via MCP ("Living Architecture")

1. **Concise Name**: Repository Evidence Anchors & Code-to-Canvas Drift Detection
2. **Concrete User Interaction**: A developer working in Cursor/Claude Code with `@lucent/mcp` connects their repo to a Lucent architecture board. Nodes on the board carry `codeRefs: ["packages/server/src/billing/stripe.ts", "packages/server/src/integrations/linear.ts"]` (in `node.metadata.codeRefs` or a dedicated field). When the coding agent adds a new `SlackProvider` or modifies `billing/webhook.ts` to call `notifications`, the agent invokes a new MCP tool `propose_architecture_sync` (or `verify_code_alignment`). Lucent diffs the codebase's actual imports/routes/schemas against the board's semantic graph and opens a human-gated **Code Drift Proposal** on the board: *"Codebase added `SlackProvider` (`integrations/slack.ts`) not shown on the architecture board, and `Checkout` now calls `NotificationService`."*
3. **Lucent Behavior**: Extends `@lucent/mcp` with two high-leverage tools:
* `link_code_artifacts`: attaches file paths, OpenAPI routes, or Drizzle table names to existing semantic `Node`s.
* `check_architecture_drift`: accepts a lightweight structural manifest extracted by the coding agent (or parsed by `@lucent/core`'s `specImport.ts` from `docker-compose.yml` / OpenAPI / SQL DDL / module graph) and computes missing nodes, undocumented edges, and violated `decision`/`requirement` statements on the board!

4. **Real Problem Solved**: Every architecture diagram in software engineering rots within 48 hours of code being written. Because Lucent already has `@lucent/mcp`, `specImport.ts` (OpenAPI/SQL/Docker Compose parsers), and `ServerProposal`, it can keep architecture diagrams alive as coding agents write code!
5. **Existing Systems Reused**: `@lucent/mcp` (`packages/mcp/src/tools.ts`, `remote.ts`), `packages/core/src/specImport.ts`, `WorkspaceRules` (`packages/core/src/workspaceRules.ts`), and `ServerProposal` (`packages/server/src/proposals.ts`).
6. **New Implementation Required**: Add `codeRefs?: string[]` to `Node` (or `metadata`), build `diffSpecAgainstWorkspace(workspace, parsedSpec)` in `packages/core/src/specImport.ts`, and expose `propose_architecture_sync` in `@lucent/mcp`.
7. **Main Risks & Trade-Offs**: Coding agents shouldn't flood the board with low-level helper files; scope `codeRefs` strictly to service/module/table/endpoint granularity matching `Node.nodeType`.
8. **Testable Success Metric**: Modifying a `docker-compose.yml` or OpenAPI spec and re-running `propose_architecture_sync` updates only the changed nodes/edges (preserving pinned coordinates and existing statement provenance on unchanged nodes).
9. **Preliminary Effort**: Medium (1.5–2 weeks).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D8: Unstructured Brainstorm -> Structured Semantic Model Compiler (Zero-Loss Promotion)

1. **Concise Name**: Sticky-Note Cluster to Semantic Graph Promotion with Provenance
2. **Concrete User Interaction**: During a workshop, 6 teammates drop 40 manual `sticky` shapes onto the canvas, vote on them (`ADD_VOTE`), and group them into themes (`themes.ts`). Currently, manual `Shape`s (`workspace.shapes`) and semantic `Node`s (`workspace.nodes`) live in two separate worlds—manual stickies cannot carry `statement` lifecycles, `issue` fields, `drives` edges, or layout-engine geometry! With this feature, a user selects a cluster of voted stickies and clicks **`✨ Promote to Semantic Model (Flowchart / Story Map / Decisions)`**. Lucent converts the sticky notes into semantic `Node`s (preserving vote counts, comments, authorship, and linking `provenance.createdFrom` to the original shape IDs) while archiving or hiding the raw stickies cleanly.
3. **Lucent Behavior**: Bridges the chasm between the manual whiteboard layer (`workspace.shapes`) and the semantic graph layer (`workspace.nodes`). Votes and comment threads (`targetId`) migrate or link to the promoted semantic nodes, and undo (`OperationHistory`) restores the exact manual sticky positions in one step.
4. **Real Problem Solved**: Right now in `@lucent/core`, if a team brainstorms with sticky notes (`Shape`) and votes on them, those stickies cannot participate in `IntelligenceView`, `ExecutionView`, dependency graphs, or layout engines unless re-created from scratch as `Node`s (losing their comment threads and vote tallies, which are keyed by `targetId`!).
5. **Existing Systems Reused**: `themes.ts` (`packages/ai/src/themes.ts`), `Shape` & `Node` (`packages/core/src/model.ts`), `provenance.createdFrom` (`ADR 0028`), and `OperationHistory`.
6. **New Implementation Required**: A `PROMOTE_SHAPES_TO_NODES` batch helper (or `retargetAnnotations` reducer support when `CREATE_NODE` carries `createdFrom: [shapeId]`) so comments, votes, and reactions transfer seamlessly to the semantic node.
7. **Main Risks & Trade-Offs**: Users might want to keep the original sticky wall as a historical artifact; offer "Promote in place" vs. "Create new Diagram Region from stickies".
8. **Testable Success Metric**: 40 voted/commented sticky notes convert into a structured `storymap` or `flowchart` region with 100% of votes and comments preserved and reversible in a single `Undo`.
9. **Preliminary Effort**: Small–Medium (1 week).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D9: Live "Explain & Sketch As You Speak" Presentation / Walkthrough Mode

1. **Concise Name**: Conversational Progressive Reveal & Live Architecture Walkthrough
2. **Concrete User Interaction**: An architect opens `PresentMode.tsx` on a complex 80-node board to onboard a new teammate or walk executives through a design. Instead of static slide stepping (`board/slides.ts`), they toggle **"Follow My Voice"** (or ask Lucent to narrate the walkthrough). As the presenter speaks (*"First, requests hit the CDN and API Gateway... then for checkout, we call the Payment Service which talks to Stripe..."*), Lucent matches the presenter's live speech stream against node labels/topics on the board, automatically pans/zooms the spotlight camera, progressively illuminates the mentioned nodes and animated connector paths in real time, and pops up the `✦` decision provenance card when a contested component is mentioned!
3. **Lucent Behavior**: Combines the low-latency STT `interim`/`final` stream (`packages/web/src/stt/events.ts`), lexical/phonetic matcher (`retrieval.ts` token matching in-browser), `focusSet` opacity dimming (`packages/web/src/board/focus.ts`), and `Spotlight` (`room.ts`) to turn any semantic board into a voice-driven interactive visual story—with zero LLM calls required for camera/highlight tracking!
4. **Real Problem Solved**: `docs/checklist.md` notes `[~] Board -> presentation — a guided walkthrough mode, not a generated deck`. Presenting a large architecture diagram today requires frantic manual zooming and pointing.
5. **Existing Systems Reused**: `PresentMode.tsx` (`packages/web/src/views/PresentMode.tsx`), `stt/events.ts`, `focus.ts`, and `Spotlight` (`useFollow.ts`).
6. **New Implementation Required**: Client-side real-time utterance-to-node lexical matcher (`matchSpokenNodes(transcriptChunk, workspace)`) driving `PresentMode` focus and `Spotlight` viewport transitions.
7. **Main Risks & Trade-Offs**: Rapidly jumping camera on false-positive word matches; use a hysteresis dwell timer (1.5s) and prioritize nodes connected to the currently focused node (1-hop locality bias).
8. **Testable Success Metric**: `< 150ms` highlight response time from spoken node name to canvas spotlight; zero LLM token spend during presenter mode.
9. **Preliminary Effort**: Small (4–5 days).
10. **Horizon**: **Near-term opportunity**.

---

### Feature D10: Cross-Board Project Topology & Dependency Rollup ("System of Systems")

1. **Concise Name**: Multi-Board Project Graph & Cross-Board Blocker Propagation
2. **Concrete User Interaction**: An engineering org has a `Project` (`packages/server/src/projects.ts`) linking three boards: `Product Discovery Board`, `Backend Architecture Board`, and `Q4 Launch Execution Board`. A decision on the `Backend Architecture Board` (`[Decision] Migrate Auth to OIDC`) drives an action on the `Q4 Launch Execution Board`, or an action on Board A is blocked by an action on Board B. Today, `StatementIndexer` (`packages/server/src/statementIndex.ts`) indexes statements across boards in a project (`ADR 0046`), and `projectExecution.ts` (`packages/core/src/projectExecution.ts`) aggregates counts, **but edges and supersessions cannot cross board boundaries**. With this feature, `ProjectsView.tsx` renders a live **Project Map** showing how boards in a project connect—which decisions on the Architecture Board drive actions on the Execution Board, and which cross-board blockers are holding up the release.
3. **Lucent Behavior**: Allows `provenance.createdFrom` and `statement.supersedes` (or a lightweight `CrossBoardLink` in `ProjectStore`) to reference `brd_<id>:nd_<id>`, and extends `StatementIndexer` to project cross-board `drives` and `blockedBy` chains in `ProjectsView.tsx`.
4. **Real Problem Solved**: `docs/26` §3 explicitly flags: *"Memory (cross-meeting): Within one board only (ADR 0023); nothing crosses boards"* and *"Dependencies: intra-board only"*. Real teams split discovery, architecture, and sprint execution across 2–4 boards within a project.
5. **Existing Systems Reused**: `ProjectStore` (`packages/server/src/projects.ts`), `StatementIndexer` (`packages/server/src/statementIndex.ts`), `projectExecution.ts` (`packages/core/src/projectExecution.ts`), and `ProjectsView.tsx`.
6. **New Implementation Required**: Qualified `boardId:nodeId` reference resolution in `StatementIndexer` and a visual Project Graph header in `ProjectsView.tsx`.
7. **Main Risks & Trade-Offs**: Must respect board access boundaries (`readableBoards` in `app.ts:2472`)—if a user can read Board A but not Restricted Board B, cross-board links to Board B show as redacted `(restricted board)` rather than leaking labels.
8. **Testable Success Metric**: Blocking an upstream action on Board A surfaces a cross-board blocker warning on the dependent action in Board B's `ExecutionView` (when the viewer has access to both).
9. **Preliminary Effort**: Large (2–3 weeks).
10. **Horizon**: **Longer-term bet**.

---

## Section E — The Unexpected Ideas

These four ideas go beyond standard roadmap items and emerge directly from combining capabilities that **already exist in Lucent's codebase** in novel ways.

### Idea E1: Counterfactual Cascade ("Ripple Undo" Across Decisions, Architecture, and External Work)

1. **What a user would do**: A team realizes in Week 3 that an earlier assumption failed—for example, *"Stripe Connect isn't supported in our target region; we have to reverse our Stripe decision."* The user clicks the `[Decision · resolved] Use Stripe Connect` node on the canvas and selects **`⚡ Simulate / Reverse Decision Impact`**.
2. **What Lucent would do in response**:
Because Lucent's semantic model already tracks:
* `statement.supersedes` chains (`ADR 0021`),
* `provenance.createdFrom` plan derivation links (`ADR 0028`),
* `drives` causal edges from Decisions to Actions (`ADR 0037`),
* `depends_on` / `blocks` execution edges (`ADR 0029`), and
* `IntegrationStore` external task links to Linear/GitHub/Jira (`ADR 0030`),
Lucent immediately computes and highlights the **exact causal cone** of that decision on the canvas:
* **2 Architecture Nodes** created in the same provenance batch (`Stripe Webhook Handler`, `Connect Onboarding Flow`),
* **4 Action Nodes** driven by that decision (`drives` edges + `createdFrom`),
* **3 Downstream Tasks** transitively depending on those actions (`depends_on`), and
* **3 Live Linear/GitHub Issues** (`LIN-14`, `LIN-15`, `GH-88`) already synced externally!
Lucent then generates a single coordinated **Decision Reversal Proposal**: it marks the Stripe decision `superseded` by the new decision, proposes deprecating/replacing the 2 architecture nodes, marks the 4 obsolete actions `cancelled`, flags the 3 downstream actions for re-planning, and drafts a human-gated **External Sync Proposal** to close `LIN-14`, `LIN-15`, and `GH-88` in Linear/GitHub with an explanation comment citing the new decision!

3. **Which existing subsystem enables it**: `decisionDriveGraph` (`packages/core/src/projectExecution.ts`), `dependsOnGraph`, `provenance.createdFrom`, `StatementFields.supersedes`, `ProposalStore`, and `IntegrationActionStore`.
4. **What new capability is required**: A pure graph walker `computeDecisionCausalCone(workspace, decisionNodeId, externalLinks)` in `@lucent/core` + a "Supersede & Cascade" workflow in `NodeAiToolbar` / `IntelligenceView`.
5. **Why the result would be valuable**: In real engineering teams, reversing an architectural decision leaves zombie tickets in Linear/Jira, orphaned boxes on architecture diagrams, and stale downstream tasks. Lucent can clean up the diagram, the decision log, and the issue tracker in one atomic, human-gated cascade.
6. **Why a conventional tool struggles to reproduce it**: Miro has no semantic causal graph or issue-link ledger; Linear/Jira have no architecture topology or meeting-decision provenance; Granola/Otter have no editable graph or execution state. Only Lucent holds the full `Transcript Turn -> Decision Node -> Architecture Component -> Action Node -> External Issue` chain in one model.
7. **What needs to be tested**: Verify on a seeded board (1 decision driving 3 actions linked to 3 mock Linear issues + 2 architecture nodes) that `computeDecisionCausalCone` isolates 100% of causally dependent items and 0 unrelated items, and that rejecting the cascade mutates nothing.

---

### Idea E2: "Live Architecture Courtroom" — Adversarial Stress-Testing Using Real Failure & Load Topologies

1. **What a user would do**: While designing a system architecture on the canvas, the team turns on **"Chaos / Stress-Test Mode"** (or runs `/stress-test "Black Friday 10x checkout spike + Redis primary failover"`) and speaks with Lucent over voice.
2. **What Lucent would do in response**:
Instead of just adding static sticky notes, Lucent treats the semantic graph (`nodes`, `edges` with `calls`/`reads_writes`/`produces`/`consumes`, and `NodeDetails` compartments) as an **executable causal topology**:
* It traces synchronous `calls` chains vs. asynchronous `produces`/`consumes` queues,
* Identifies single points of failure (nodes with in-degree $\ge 3$ on `calls` edges and no replica/fallback group, or synchronous chains $\ge 4$ hops deep violating `WorkspaceRules`),
* Visually animates the failure cascade step-by-step on the canvas (highlighting `Redis` in red $\rightarrow$ `Session Middleware` stalling $\rightarrow$ `API Gateway` 503ing),
* Creates `risk` and `question` statement nodes anchored directly to the vulnerable edges, and
* Offers a 1-click **"Propose Resilience Refactor"** (e.g., inserting a circuit-breaker fallback or dead-letter queue into the semantic graph).

3. **Which existing subsystem enables it**: `PlanRelationKindSchema` (`calls`, `reads_writes`, `produces`, `consumes` in `packages/core/src/plan.ts:48-58`), `WorkspaceRules` (`packages/core/src/workspaceRules.ts`), `/threat-model` and `/edge-cases` slash commands (`packages/core/src/slashCommands.ts`), and `StatementFields` (`kind: "risk"`).
4. **What new capability is required**: Deterministic structural graph analyzers in `@lucent/core` (synchronous hop-depth detector, fan-in SPOF detector, unbuffered producer-consumer detector, unauthenticated boundary detector) that feed structured topology facts into the prompt and drive an interactive step-by-step canvas highlight sequence.
5. **Why the result would be valuable**: Turns architecture review meetings from passive box-staring into active, visual failure-mode discovery where risks automatically become tracked `risk` statements and engineering `action` items.
6. **Why a conventional tool struggles to reproduce it**: Conventional diagramming tools don't know the difference between a synchronous `calls` edge, an async `produces` edge, and a `database` node, nor can they turn discovered vulnerabilities into tracked project risks and Linear tasks.
7. **What needs to be tested**: Run the deterministic SPOF and sync-chain analyzers against 10 real-world architecture diagrams; verify that synchronous chains $>3$ hops and unbuffered fan-in bottlenecks are identified deterministically in `< 2ms`.

---

### Idea E3: "Cognitive Rewind" — Audible + Visual Time-Travel Playback of How a Design Evolved

1. **What a user would do**: A new engineer joins the project (or a VP opens a board before an architecture sign-off) and clicks **`▶ Replay Evolution (90 sec)`** in `HistoryView` or on a specific complex region.
2. **What Lucent would do in response**:
Because Lucent stores:
* Every sequenced operation batch in `op_log` (`packages/server/src/room.ts`),
* The merged chronology of revisions, meeting markers, and statement events (`packages/web/src/historyTimeline.ts`),
* Exact `provenance.quote` and `turnRange` on meeting-created nodes (`ADR 0022`), and
* Server/browser TTS (`packages/web/src/tts.ts` / `/api/tts/speak`),
Lucent plays back the **visual construction of the board over time** (stepping forward through `OperationHistory` / `op_log` keyframes with smooth layout transitions) while **narrating the key inflection points using the actual meeting quotes and decision supersessions** (*"In the Sept 12 kickoff, Alice proposed a monolith... On Sept 15, after load testing, Bob superseded the monolith decision with a split Checkout Service..."*)!

3. **Which existing subsystem enables it**: `OperationHistory` (`packages/core/src/operationHistory.ts`), `historyTimeline.ts` (`mergeChronology`), `provenance.quote` / `statement.supersedes`, and `tts.ts`.
4. **What new capability is required**: A keyframe scrubber/player in `HistoryView.tsx` that folds consecutive minor ops into semantic milestones (commits containing `SET_STATEMENT`, `UPDATE_STATEMENT`, `CREATE_GROUP`, or $\ge 3$ `CREATE_NODE`s) and synchronizes canvas state projection with optional TTS narration of the milestone digest.
5. **Why the result would be valuable**: Reading a 200-node final diagram tells you *what* the architecture is, never *why* it looks that way or what dead ends were already ruled out. A 60-second visual + spoken time-lapse transfers weeks of architectural context in one minute.
6. **Why a conventional tool struggles to reproduce it**: Git commit history has no visual topology; Miro's version history is a flat list of pixel snapshots with no knowledge of which meeting quote or decision caused a change; Loom videos go stale the moment the diagram is edited. Lucent's playback is **generated live from canonical state and provenance**, so it is never stale!
7. **What needs to be tested**: Verify that scrubbing across 50 `op_log` revisions reconstructs valid intermediate `Workspace` projections in `< 10ms` per keyframe without mutating the live room state.

---

### Idea E4: Conversational Contract Between Humans and Coding Agents ("Visual PR / Architecture Gate")

1. **What a user would do**: Before an external coding agent (Claude Code, Cursor, or Devin connected via `@lucent/mcp`) implements a multi-file feature, the developer tells the coding agent: *"Propose your implementation plan and architecture changes on our Lucent board first."*
2. **What Lucent would do in response**:
The coding agent calls a dedicated MCP tool `propose_agent_change_set` with a `SemanticPlan` + `rationale` + `affectedFiles`. Instead of mutating the board silently (`boardOps.ts`), Lucent opens an **Interactive Visual PR** on the canvas:
* Proposed new services/tables/flows appear as badged ghost nodes (`🤖 Proposed by Claude Code`),
* Each proposed node/edge displays the agent's rationale and target file path,
* The human can **drag, rename, rewire, or comment on the proposed nodes directly on the canvas** (or say *"No, don't put a new table in Auth—connect it to the existing UserProfile table instead"*),
* When the human clicks **`Approve Visual Spec`**, the MCP tool call resolves (or a new MCP resource `get_approved_spec` updates), handing the coding agent the **human-corrected semantic graph, `WorkspaceRules`, and Drizzle/OpenAPI/XState scaffold (`codeExport.ts`)** to execute!

3. **Which existing subsystem enables it**: `@lucent/mcp` (`packages/mcp/src/remote.ts`), `ServerProposal` (`packages/server/src/proposals.ts`), `WorkspaceRules` (`packages/core/src/workspaceRules.ts`), and `codeExport.ts` (`packages/core/src/codeExport.ts`).
4. **What new capability is required**: Route MCP mutations through `ProposalStore` when `mode: "propose"` (or $>5$ ops), and add an MCP tool `await_proposal_decision` / `get_proposal_feedback` that returns the human's canvas edits/rejections as structured diffs to the coding agent.
5. **Why the result would be valuable**: Today, reviewing a coding agent's 40-file plan in a wall of terminal Markdown text is exhausting and error-prone. Reviewing and steering a coding agent's plan visually on a shared architecture canvas—where human corrections compile directly back into agent constraints—makes Lucent the visual control plane for agentic software engineering.
6. **Why a conventional tool struggles to reproduce it**: IDEs only have text diffs and static Mermaid previews that humans cannot interactively edit and hand back as structured diffs; whiteboards have no MCP bidirectional state loop with coding agents.
7. **What needs to be tested**: End-to-end test in `packages/mcp/test/remote.test.ts`: MCP client submits a proposal $\rightarrow$ human modifies 1 node label and approves $\rightarrow$ MCP client reads back the approved diff and exported code scaffold.

---

## Section F — Cross-Cutting Architectural Opportunities

Rather than patching symptoms in individual packages, five cross-cutting architectural consolidations will eliminate multiple classes of bugs simultaneously:

| Opportunity | Root Problem Eliminated | Packages & Files Consolidated | Findings / Features Unlocked |
| --- | --- | --- | --- |
| **F1. Single Canonical AI Generation & Compilation Pipeline** | Eliminates the split-brain between `generate.ts` (38 ops, raw IDs, 3 post-hoc LLM re-asks) and `orchestrator.ts` + `planGenerator.ts` (4 ops, broken on real LLMs) | `packages/core/src/compiler.ts`, `repair.ts`, `qualityGate.ts`; `packages/ai/src/planGenerator.ts`; `packages/server/src/generate.ts`, `orchestrator.ts` | Fixes **B1**, **B4**, **B6**; cuts multi-round LLM repair latency by 50–70%; unifies Web, Voice Agent, and MCP generation |
| **F2. True Single-Writer Room Authority (`Room-Always` Mutation Seam)** | Eliminates split-brain when HTTP routes (`boardOps`, `proposals`, `review`, `applyInbound`, `generate`) write to `boardStore` while a `Room` is live, or when `commitBatch` overwrites `room.current()` | `packages/server/src/commitBatch.ts:34-55`, `realtime.ts:979-1014`, `generate.ts:1091-1100`, `fanout.ts` | Fixes **B2**, **B3**, **B5**; guarantees every WebSocket peer sees every HTTP/MCP/Voice-Agent/Automation commit in real time |
| **F3. First-Class Graph Query & Impact Engine in `@lucent/core`** | Eliminates ad-hoc graph walks scattered across `qualityGate.ts`, `projectExecution.ts`, `intelligence.ts`, and `focus.ts` | `packages/core/src/projectExecution.ts`, `qualityGate.ts`, `attention.ts` | Unlocks **D1** (Contradiction Linter), **D3** (Conversational Lenses), **E1** (Counterfactual Cascade), **E2** (Stress-Test Mode), and **Improvement #7** (Subgraph Slicing) |
| **F4. Granular & Interactive Proposal Protocol** | Eliminates the all-or-nothing batch approval wall AND unifies the 4 separate review queues (canvas proposals, voice-agent batches, statement trust review, integration syncs) | `packages/server/src/proposals.ts`, `routes/proposals.ts`, `packages/web/src/views/ProposalPanel.tsx` | Unlocks **D2** (Scenario Forks), **D4** (Per-Op Cherry-Pick), **E4** (Visual PR for Coding Agents), and **Improvement #4 & #9** |
| **F5. Unified Provenance & Reverse-Dependency Index** | Connects transcript turns, shapes, statements, architecture nodes, actions, and code refs bidirectionally | `packages/core/src/model.ts` (`ProvenanceFields`), `packages/server/src/statementIndex.ts` | Unlocks **Improvement #6** (Transcript Correction Propagation), **D7** (Code Drift), **D8** (Sticky Promotion), and **E3** (Cognitive Rewind) |

### Deep Dive on Opportunity F1 (How to Unify the Two Generation Pipelines Without Losing Expressiveness)

Right now, `packages/server/src/generate.ts` and `packages/server/src/orchestrator.ts` represent two competing philosophies:

* `generate.ts` trusts the LLM to emit raw `Operation[]` (all 38 ops) and uses `repairOperations` + `applyValidOperations` + up to 3 LLM re-asks when the LLM hallucinates node IDs or forgets edges.
* `orchestrator.ts` asks for a symbolic `SemanticPlan` (`n1`, `n2`, `g1`) and compiles it deterministically (`compileSemanticPlan`), which prevents ID hallucination by construction—but `SemanticPlan` only knows 4 operations (`TRANSFORM_DIAGRAM`, `CREATE_GROUP`, `CREATE_NODE`, `CONNECT_NODES`) and `generateSemanticPlan` is broken on real providers.

**The Architectural Synthesis**:
Upgrade `repairOperations(ops, workspace)` in `@lucent/core/src/repair.ts` with `compileSemanticPlan`'s deterministic symbol & label-alias resolution table, and run `evaluateTopologyQuality` (`packages/core/src/qualityGate.ts`) inside `runGeneratePipeline` (`packages/server/src/generate.ts`)!

* When an LLM emits `CREATE_NODE { id: "n1", label: "Payment Service" }` followed by `CONNECT_NODES { source: "Checkout", target: "Payment Service" }` (using human labels or symbolic IDs instead of `nd_8f9a`), the deterministic compiler/repair pass resolves `"Checkout"` to its existing canonical node ID on the board and `"Payment Service"` to `"n1"` **in 0ms with 0 extra LLM calls**!
* Then `/api/boards/:id/orchestrate` simply delegates to the unified `runGeneratePipeline` + `commitBatch` (or proposal gate), eliminating the broken `planGenerator.ts` path completely while preserving all 38 operations (`SET_STATEMENT`, `SET_ISSUE`, `SET_NODE_DETAILS`, `CREATE_WIREFRAME`, etc.) across Web, Voice Agent, and MCP!

---

## Section G — Experiments Before Building

Before committing engineering weeks to the highest-uncertainty bets, run these five low-cost, high-signal experiments using existing infrastructure:

| Experiment | Hypothesis | Test Scenario & Reused Capabilities | Evidence to Collect | Pass / Fail Criterion | Effort |
| --- | --- | --- | --- | --- | --- |
| **Exp 1: Deterministic Label/Alias Resolution vs. `requestRepair` / `requestConnect` LLM Re-Asks** | >70% of validation failures and floating nodes in `/api/generate` are caused by the LLM using node *labels* or symbolic refs in `CONNECT_NODES`/`SET_STATEMENT` instead of exact `id`s, and can be repaired deterministically in `<1ms` without a second LLM call. | Replay 50 real-provider prompts from `packages/ai/src/golden.ts` and `test/certification/*` through `repairOperations` enhanced with `compileSemanticPlan`'s unique-label resolver (`compiler.ts:78-94`) with `requestRepair` disabled. | % of failed/floating batches recovered deterministically; P50/P95 generation latency reduction; token savings. | **Pass**: $\ge 60\%$ reduction in secondary LLM repair/connect calls with 0 false-positive edges. **Stop**: $< 20\%$ of failures are ID/label mismatches. | **0.5 days** |
| **Exp 2: Per-Operation Cherry-Picking vs. Whole-Batch Proposal Approval** | Allowing users to toggle individual operations/nodes inside `ProposalPanel.tsx` converts rejected $>5$-op batches into accepted partial batches. | Extend `ProposalPanel.tsx` (`packages/web/src/views/ProposalPanel.tsx`) with checkboxes per node/edge group, filtering `proposal.operations` through `applyValidOperations` (`packages/core/src/validator.ts`) on Approve. Test on the 6 messy-meeting fixtures (`packages/web/src/meeting-fixtures.ts`). | Ratio of batches approved with 1–2 items unchecked vs. rejected wholesale; resulting graph validity (`validateOperations`). | **Pass**: 100% of cherry-picked subsets produce valid, layout-stable boards via `applyValidOperations`. | **1 day** |
| **Exp 3: Semantic Contradiction Detection Precision** | A hybrid rule + prompt pass can detect when a newly added node/decision contradicts an existing `resolved` decision or `WorkspaceRules.prohibitedPatterns` with $< 15\%$ false-positive noise. | Seed 15 boards with explicit `WorkspaceRules` (`packages/core/src/workspaceRules.ts`) and 5 `resolved` decisions each; inject 15 violating edits and 15 benign edits. Run a prototype detector in `packages/core/test/`. | Precision, recall, and latency of contradiction detection. | **Pass**: Precision $\ge 85\%$, Recall $\ge 75\%$. **Stop/Pivot**: Precision $< 70\%$ (restrict to explicit `topic`-matched supersession prompts only). | **1.5 days** |
| **Exp 4: Utterance-to-Node Live Highlighting in `PresentMode`** | Pure lexical/phonetic token matching (`retrieval.ts` normalization) against `workspace.nodes` can drive live voice-followed spotlighting during presentations without LLM calls or disorienting camera jumps. | Feed timestamped transcript streams from `meeting-fixtures.ts` into a client-side matcher with a 1.5s hysteresis window and 1-hop graph locality bonus, driving `focusSet` (`packages/web/src/board/focus.ts`). | Frame time (`ms`), highlight accuracy against ground-truth discussed nodes, and camera switch frequency (switches/minute). | **Pass**: $\ge 80\%$ node match accuracy, $< 10$ camera pans/min, $0$ LLM calls. | **1 day** |
| **Exp 5: Coding-Agent MCP "Visual PR" Round-Trip** | A coding agent using `@lucent/mcp` produces higher-adherence code when its proposed architecture diff is reviewed/tweaked by a human on the Lucent canvas and exported back via `codeExport.ts` + `WorkspaceRules`. | Use `packages/mcp` (`RemoteBoardSession`) + `ProposalStore` + `codeExport.ts`: have an agent propose a 6-node microservice change, modify 2 nodes on the canvas, approve, and inspect the returned context payload. | End-to-end round-trip time and structural fidelity of exported Drizzle/Docker-Compose/XState scaffold after human canvas edits. | **Pass**: Human canvas edits (renames, rewired edges, rule constraints) appear deterministically in the agent's post-approval MCP payload. | **1.5 days** |

---

## Section H — Recommended Roadmap

### Horizon 1 — Immediate (Days 1–7): Critical Correctness Fixes & Pipeline Convergence

*Can be completed independently with zero new infrastructure or product risk.*

1. **[P0] Fix `generateSemanticPlan` & `requestBoundedEdgeRepair` on Real Providers (`Finding B1`)**:
* *Files*: `packages/ai/src/planGenerator.ts:10-97`, `packages/server/src/orchestrator.ts`, `packages/server/src/routes/boardOps.ts:329-361`.
* *Action*: Stop calling `generateMockPlan` when `provider.name !== "mock"`; accept caller-supplied `plan` in `/api/boards/:id/orchestrate` (**Finding B4**); route server-side prompt orchestration through the unified validated pipeline (**Opportunity F1**).

2. **[P0] Fix `commitBatch` Stale Overwrite & `commitForBoard` Collaborator Split-Brain (`Finding B2`)**:
* *Files*: `packages/server/src/commitBatch.ts:34-55`, `packages/server/src/realtime.ts:979-1014`.
* *Action*: Remove the redundant `boardStore.put` in `commitBatch.ts:43-44` that clobbers `room.current()`; allow pre-authorized HTTP routes (`boardOps`, `proposals`, `review`, `applyInbound`) to commit through `commitForBoard` even when the acting user/system has no open WebSocket tab (**Opportunity F2**).

3. **[P0] Fix Authoritative Validation Gate in `runGeneratePipeline` (`Finding B3`)**:
* *Files*: `packages/server/src/generate.ts:806-815, 1091-1100`.
* *Action*: Remove `&& userId === candidateBoard.ownerId` at `generate.ts:810` so non-owner editors and automations validate against the authoritative stored board; ensure `run.boardId` also triggers authoritative validation without bypassing `op_log`.

4. **[P1] Remove Hardcoded Production IP in Edge Functions & Complete Multi-Worker Fanout (`Finding B5`)**:
* *Files*: `functions/api/[[path]].ts`, `functions/ws.ts`, `packages/web/functions/*`, `packages/server/src/fanout.ts`, `packages/server/src/realtime.ts`.
* *Action*: Read upstream URL from env; publish `proposal`, `spotlight`, and `summon` events over `fanout` so PM2 cluster workers stay in sync.

### Horizon 2 — Next Milestone (Weeks 2–4): Strengthening Lucent's Core Loop

*Depends on Horizon 1's unified pipeline (`F1`) and room authority (`F2`).*

1. **Unify Symbolic/Label Alias Resolution into `repairOperations` (`Improvement #1` + `Exp 1`)** — Eliminates ID-hallucination edge drops and most post-hoc `requestConnect`/`requestRepair` LLM round-trips.
2. **Gate Large Voice-Agent & MCP Batches (>5 Ops) Behind `ServerProposal` + Per-Op Cherry-Picking (`Improvement #4`, `Feature D4`, `Exp 2`)** — Restores Invariant 4 across voice and agent surfaces and lets users approve partial AI batches.
3. **Conversational Canvas Lenses: Flow, Blast-Radius, Uncertainty & Temporal Diff (`Feature D3`)** — Zero-mutation graph projections (`"Show me only the payment flow"`, `"What breaks if Redis fails?"`, `"What changed since last review?"`).
4. **Live Meeting "Since Last Meeting" Delta Brief & Disagreement Tracker (`Feature D5` & `Feature D6`)** — Connects Meeting $N$ to Meeting $N+1$ and prevents premature consensus on contested proposals.
5. **Propagate Transcript Turn Corrections to Board Objects (`Improvement #6`) & Wire Web Image Drops to `/api/assets` (`Improvement #3`)**.

### Horizon 3 — Longer Term (Weeks 5–10): Differentiated Category-Defining Capabilities

*Depends on Horizon 2's graph query engine (`F3`), granular proposals (`F4`), and provenance index (`F5`).*

1. **Semantic Architecture & Decision-Drift Linter (`Feature D1` & `Exp 3`)** — Continuous checking of architecture nodes/edges against `resolved` decisions and `WorkspaceRules`.
2. **Counterfactual Decision Cascade ("Ripple Undo" Across Board & Issue Trackers, `Idea E1`)** — Reversing a decision automatically computes affected architecture nodes, downstream actions, and linked Linear/GitHub/Jira issues.
3. **Ephemeral Scenario Forks & Side-by-Side Architecture Comparison (`Feature D2`)** — Explore Option A vs. Option B visually and archive the rejected branch as a provenance-backed statement.
4. **Coding-Agent "Visual PR" & Repo-to-Canvas Drift Sync via MCP (`Feature D7`, `Idea E4`, `Exp 5`)** — Turn Lucent into the visual architecture control plane for coding agents.
5. **"Cognitive Rewind" Visual + Spoken Evolution Playback (`Idea E3`)** & **Sticky-Wall to Semantic Graph Promotion (`Feature D8`)**.

```text
DEPENDENCY ORDER:
[H1: B1/B2/B3/B4/B5 Fixes + F1/F2 Unified Pipeline & Room Authority]
       │
       ├──► [H2: Alias Repair (#1) + Agent Proposal Gate (#4) + Per-Op Cherry-Pick (D4)]
       │           │
       │           └──► [H3: Scenario Forks (D2) + Coding-Agent Visual PR & Drift Sync (D7, E4)]
       │
       └──► [H2: Core Graph Query Engine (F3) + Conversational Lenses (D3) + Meeting Delta Brief (D5/D6)]
                   │
                   └──► [H3: Semantic Linter (D1) + Counterfactual Cascade (E1) + Cognitive Rewind (E3)]
```

### "Do Not Build Yet" List (Deliberately Rejected or Postponed)

1. **Do NOT replace the Sequenced Op Log with a CRDT (Yjs / Automerge)** (`ADR 0001`, Invariant 3 & 10):
* *Why reject*: CRDTs merge concurrent structural mutations blindly, which can create dependency cycles (`A depends_on B` + `B depends_on A`), dangling supersession chains, or duplicate region kinds that violate `@lucent/core`'s semantic invariants. Server-sequenced validation in `Room.commit` is load-bearing for semantic integrity.

2. **Do NOT build an Autonomous Multi-Agent Swarm (Separate Planner / Researcher / Critic / Layout Agents Chatting in a Loop)** (Invariant 1, 9, 10):
* *Why reject*: A single generation already takes 6–35s on cloud LLM gateways. Chaining 3–4 autonomous agent turns per prompt would push latency past 60–120s, multiply token costs 4×, and make failures opaque. Deterministic compilation (`compileSemanticPlan` / `repairOperations`) and deterministic quality gates (`evaluateTopologyQuality`) are 1,000× faster and 100% predictable.

3. **Do NOT build Unprompted Proactive Voice Interjections in Meetings (`docs/25` V9 Gated)** (Invariant 4):
* *Why reject*: Having an AI interrupt humans unprompted during a live meeting destroys conversational flow and trust. Keep unsolicited intelligence in the quiet visual `Open Questions / Contradictions` tray (`MeetingView`) and speak aloud **only** when explicitly addressed (`detectAddress`) or within an active 15s speaker-bound lease (`meeting-voice.ts`).

4. **Do NOT add a Vector Database (`pgvector` / Pinecone / Qdrant) Yet** (`ADR 0024`, Invariant 10):
* *Why reject*: As `ADR 0024` notes, `retrieve(query, corpus)` in `packages/server/src/retrieval.ts` is already isolated behind a single function seam. Adding 1-hop semantic graph expansion and domain synonym folding (Improvement #5) solves lexical misses without operational infra bloat or cross-tenant vector index leakage risks.

5. **Do NOT build a Full-Fledged Bezier/Pen Vector Illustration Suite (Figma/Illustrator Competitor)** (Invariant 5):
* *Why reject*: `packages/core/src/vector.ts` and `packages/web/src/vector/` already provide structured SVG icon/vector paths. Expanding into complex boolean path editing distracts directly from Lucent's core moat: turning conversations into living semantic models.

---

## Section I — Final Recommendations

### 1. The Five Most Important Actions Recommended

1. **Fix `generateSemanticPlan` (`packages/ai/src/planGenerator.ts:10-97`) and unify it with `runGeneratePipeline` (`packages/server/src/generate.ts`)** so that `/api/boards/:id/orchestrate`, the LiveKit Voice Agent (`construct_diagram`), and MCP (`construct_diagram`) never silently overwrite a user's board with a 3-node canned mock diagram (**Finding B1 & B4**).
2. **Fix `commitBatch.ts:43-44` and `RealtimeServer.commitForBoard` (`packages/server/src/realtime.ts:990`)** so HTTP mutations (MCP, Voice Agent, Proposal Approvals, Review Center, Inbound Tracker Syncs) never clobber in-memory room state and always broadcast to connected WebSocket collaborators (**Finding B2**).
3. **Fix the `userId === candidateBoard.ownerId` check in `packages/server/src/generate.ts:810` and enable authoritative server-state validation whenever `run.boardId` is present** so editors and automations validate against the real stored board rather than a truncated 200-node client summary (**Finding B3 & B6**).
4. **Fold deterministic label-alias & symbolic-ref resolution (`compileSemanticPlan`) into `repairOperations` (`packages/core/src/repair.ts`)** to eliminate ID-hallucination edge drops and cut slow post-hoc LLM repair round-trips (**Improvement #1**).
5. **Enforce the $>5$-operation `ServerProposal` human review gate on Voice-Agent and MCP mutations (`boardOps.ts`, `orchestrator.ts`) and add per-operation cherry-picking to `ProposalPanel.tsx`** so human authority (Invariant 4) holds uniformly across every entry point (**Improvement #4 & Feature D4**).

### 2. The Three Features with the Highest Potential User Value

1. **Counterfactual Decision Cascade ("Ripple Undo", `Idea E1`)** — Because it connects every layer of Lucent (Meeting Provenance $\rightarrow$ Decision Statement $\rightarrow$ Architecture Nodes $\rightarrow$ Action Items $\rightarrow$ External Linear/GitHub/Jira Issues) into a single, unmistakable superpower when a team changes its mind.
2. **Conversational Canvas Lenses ("Show Me Only...", `Feature D3`)** — Because it turns a dense 150-node board into an interactive, queryable model (*"Show me only the payment flow"*, *"What breaks if Redis goes down?"*, *"Show me what we still don't know"*) with zero mutation risk and `<5ms` deterministic execution.
3. **Semantic Architecture & Decision-Drift Linter (`Feature D1`) + Coding-Agent "Visual PR" (`Idea E4`)** — Because it transforms the board from a passive drawing into an active architectural contract that checks both human designs and coding-agent proposals against the team's settled decisions and `WorkspaceRules`.

### 3. The Single Most Important Unresolved Architectural Question

> **How should Lucent unify its two competing AI generation models—the symbolic intermediate representation (`SemanticPlan` $\rightarrow$ `compileSemanticPlan` in `packages/core/src/compiler.ts`) vs. the direct 38-operation union (`apply_canvas_operations` in `packages/core/src/operations.ts`)—without sacrificing either reference safety or semantic richness?**

Right now, `SemanticPlan` guarantees zero hallucinated node/edge IDs because the compiler owns ID allocation and label resolution, but it cannot express statements (`SET_STATEMENT`), work tracking (`SET_ISSUE`), compartments (`SET_NODE_DETAILS`), regions (`SET_GROUP_KIND`), or wireframes. Conversely, `apply_canvas_operations` expresses the full workspace vocabulary, but forces the LLM to juggle raw opaque IDs (`nd_...`), causing broken edges and expensive multi-turn repair calls. **Answer**: Keep the single 38-operation union as the universal contract, but allow **symbolic IDs and existing node labels** inside `apply_canvas_operations` and resolve them deterministically in a pre-validation compiler pass (`repairOperations` + `compileSemanticPlan`).

### 4. The Biggest Opportunity the Team May Be Overlooking

**Lucent has already built all the primitives to be the "Visual Control Plane for Coding Agents," not just a meeting whiteboard for humans.**
Look at what is already sitting in `packages/core` and `packages/mcp`:

* `WorkspaceRules` (`.cursorrules`-style cloud stack, patterns, naming conventions, prohibited patterns in `packages/core/src/workspaceRules.ts`),
* `specImport.ts` (OpenAPI 3.0, SQL DDL, and Docker Compose parsers in `packages/core/src/specImport.ts`),
* `codeExport.ts` (XState v5 TypeScript, Drizzle/Prisma schema, and Docker Compose compilers in `packages/core/src/codeExport.ts`),
* `StatementIndexer` (cross-board decisions, requirements, and risks in `packages/server/src/statementIndex.ts`), and
* `@lucent/mcp` (`RemoteBoardSession` over `/api/v1` in `packages/mcp/src/remote.ts`).

Today, those features are treated as isolated import/export modals in the UI. Connected together (**Feature D7** + **Idea E4**), they solve the biggest pain point in modern AI software engineering: **coding agents write code fast, but humans lose architectural visibility and control.** Letting coding agents propose architectural changes as visual diffs on the Lucent canvas—checked against team decisions from meetings—bridges human product meetings and agentic code execution in a way no IDE or whiteboard can match.

### 5. The Most Tempting Idea to Deliberately Reject or Postpone

**Proactive, unprompted voice interjections by Lucent during live multi-person meetings.**
It is tempting to make the AI feel "alive" by having it chime in with spoken advice or corrections whenever it detects a flaw during a meeting. In practice, an AI voice interrupting two engineers mid-thought in a live call is socially jarring, breaks human flow, and causes teams to mute or kick the bot immediately. Lucent's current design in `packages/web/src/meeting-voice.ts`—speaking **only** when explicitly addressed (`"Lucent, ..."`) or within a 15-second single-speaker follow-up lease, while surfacing unprompted insights silently as visual cards and canvas proposals—is the exact right product instinct. Preserve it strictly.

### 6. What I Would Work On First If Responsible for Lucent's Technical & Product Direction

**Week 1 would be dedicated to closing the "Split-Brain Seam" (Horizon 1: Findings B1, B2, B3, B4 + Opportunity F1 & F2).**
Why? Because Lucent's architectural foundations—the single-node multi-faceted data model (`Node` + `Statement` + `Issue` + `Provenance` + `Trust`), the hybrid layout engine (`core/layout.ts` + Web Worker `elkjs`), and the human-gated execution ledger (`integrations/ledger.ts`)—are genuinely best-in-class. However, right now the system has two disconnected brains:

1. The Voice Agent and MCP `construct_diagram` paths hit `/api/boards/:id/orchestrate`, which silently discards real LLM responses and commits a 3-node mock diagram (`Finding B1`), and
2. HTTP mutations from agents, proposals, and automations can bypass or overwrite live WebSocket rooms (`Finding B2` & `B3`).

Fixing those three seams takes less than a week, requires zero new abstractions, makes every surface (Web Canvas, Live Voice, Meetings, and MCP Agents) converge on one rock-solid, symbolically compiled, room-sequenced pipeline, and immediately clears the runway for **Conversational Canvas Lenses (`D3`)**, **Semantic Contradiction Linting (`D1`)**, and **Counterfactual Decision Cascades (`E1`)**.
