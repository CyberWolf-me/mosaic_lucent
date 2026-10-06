# 29. AI-Native Platform Evolution Roadmap

> **Status:** Approved for sequential execution.
> **Scope:** Elevates Lucent from a visual diagram generator to a full-featured, benchmark AI-native visual workspace.

## Executive Summary

Lucent's core architecture delivers a deterministic semantic canvas, multi-lens representations, WebSocket realtime sync, and human-gated tool execution. To achieve parity with leading modern AI products (Cursor, v0, Lovable, Claude Artifacts), six capabilities are scheduled for sequential implementation:

1. **Initiative 1: Slash Commands (`/`) & AI Presets** — Autocomplete `/` menu for `/decompose`, `/threat-model`, `/edge-cases`, `/sequence`, `/simplify`, `/translate`.
2. **Initiative 2: Workspace Architectural Rules & Durable Context** — Project custom instructions and technology stack constraints injected into system prompts.
3. **Initiative 3: In-Canvas AI Micro-Actions** — Direct manipulation floating sparkle menu on selected canvas nodes and groups.
4. **Initiative 4: Code & Specification Ingestion** — Direct conversion of OpenAPI 3.0, SQL DDL, and Docker Compose into semantic visual graphs.
5. **Initiative 5: Production Code Export** — Compiling the semantic model into XState v5 TypeScript, Docker Compose, and Prisma/Drizzle schemas.
6. **Initiative 6: Model Selection, Thinking (CoT) Accordion & Generation Telemetry** — Runtime model tiers, reasoning token streaming, and token/latency badges.

---

## Detailed Specifications

### Initiative 1: Slash Commands (`/`) in AIPill — `[COMPLETED]`

#### Problem
Users experience "blank canvas paralysis" when asked to type natural language descriptions without guidance.

#### Specification & Implementation
- **Trigger**: Pressing `/` at the start of input or clicking the `/` trigger button in `AIPill.tsx` opens an autocomplete popover.
- **Commands Catalog**:
  - `/decompose [node?]` — Expands a high-level component into 3–5 sub-process nodes with directed connectors (`architecture`).
  - `/threat-model [focus?]` — Conducts a security audit identifying unauthenticated edges, single points of failure, and missing rate-limits (`security`).
  - `/edge-cases [flow?]` — Discovers error states and timeouts, adding decision diamonds and retry branches (`refine`).
  - `/sequence [flow?]` — Converts current flowchart into an actor-to-actor sequence diagram (`transform`).
  - `/simplify [scope?]` — Consolidates redundant nodes into higher-level abstractions (`refine`).
  - `/translate [language]` — Translates all node labels and notes into the target language while preserving graph topology (`transform`).
- **Files Implemented**:
  - `packages/core/src/slashCommands.ts`: Catalog definition, prefix & full-text query filtering, command parser, and prompt expansion.
  - `packages/core/test/slashCommands.test.ts`: 15 unit tests covering parsing, filtering, and prompt expansion.
  - `packages/ai/src/prompt.ts`: Integration in `buildUserPrompt` expanding slash commands into precise architectural instructions.
  - `packages/ai/test/prompt-limits.test.ts`: Unit tests verifying prompt expansion across all commands.
  - `packages/web/src/ui/GrowTextarea.tsx`: Intercepts `onKeyDown` allowing `AIPill` to capture `ArrowUp`, `ArrowDown`, `Enter`, `Tab`, and `Escape`.
  - `packages/web/src/ui/AIPill.tsx`: Autocomplete menu, keyboard navigation, slash command badge, trigger button.
  - `packages/web/src/styles.css`: High-end typography, glassmorphism, category color tags, hover/selection states.
  - `packages/web/e2e/workflows/slash-commands.spec.ts`: End-to-end Playwright workflow test verifying catalog opening, filtering, keyboard navigation, dismissal, badge feedback, and visual canvas generation.
- **Verification**: 100% clean typecheck across all 7 packages, unit tests passing in `@lucent/core` and `@lucent/ai`, and Playwright E2E passing.

---

### Initiative 2: Workspace Architectural Rules & Durable Context

#### Problem
The AI lacks persistent knowledge of a team's specific tech stack and architectural conventions, forcing users to repeatedly type constraints.

#### Specification
- Project/Board metadata extended with `rules?: string`.
- Standardized rule fields:
  - Tech Stack (e.g., GCP, Cloud Run, PostgreSQL, Redis, TypeScript).
  - Architectural Standards (e.g., event-driven pub/sub, mTLS, zero-trust network).
  - Naming & Entity Conventions (e.g., PascalCase services, snake_case DB tables).
- System Prompt injection:
  - `buildSystemPrompt` and `buildUserPrompt` include `<workspace_rules>` tags containing active project constraints.
- Files:
  - `packages/server/src/projects.ts`
  - `packages/ai/src/prompt.ts`
  - `packages/web/src/ui/WorkspaceRulesModal.tsx`

---

### Initiative 3: In-Canvas AI Micro-Actions

#### Problem
All AI interactions require typing into the bottom dock. Tweaking a single node requires typing a full sentence.

#### Specification
- Selecting any node renders a floating sparkle action bar pinned above the node card.
- Actions:
  - `✨ Elaborate` (decomposes the node into children).
  - `✨ Add Error Handling` (attaches fallback decision branch).
  - `✨ Convert Type` (switches node semantic role/type).
  - `✨ Explain Component` (provides contextual analysis in chat).
- Execution:
  - Scoped to the selected node ID via `summarizeWorkspace(workspace, [selectedId])`.
- Files:
  - `packages/web/src/ui/DiagramLayer.tsx`
  - `packages/web/src/ui/atoms.tsx`
  - `packages/web/src/workspace.tsx`

---

### Initiative 4: Code & Specification Ingestion

#### Problem
Engineers have existing specifications (OpenAPI, SQL DDL, Docker Compose) and cannot import them directly without manual re-drawing.

#### Specification
- Drag-and-drop or paste dialog in TopBar:
  - **OpenAPI 3.0 / Swagger**: Parses paths, methods, request/response bodies into service nodes and HTTP action edges.
  - **SQL DDL / Prisma**: Parses `CREATE TABLE` and foreign keys into ER diagram nodes with field attributes and relational edges.
  - **Docker Compose**: Parses services, environment, and networks into container architecture nodes.
- Files:
  - `packages/core/src/ingest/openapi.ts`
  - `packages/core/src/ingest/sqlddl.ts`
  - `packages/core/src/ingest/dockercompose.ts`
  - `packages/web/src/ui/ImportModal.tsx`

---

### Initiative 5: Production Code Export

#### Problem
Visual diagrams do not compile into executable code, creating a dead end after design.

#### Specification
- Code generation modules:
  - **XState v5 TypeScript**: Compiles flowchart states, transitions, and guards into a runnable state machine.
  - **Docker Compose / Terraform**: Compiles service architecture into runnable deployment files.
  - **Prisma Schema / Drizzle ORM**: Compiles ER diagrams into database schema definitions.
- Export modal with code highlighting, copy button, and file download.
- Files:
  - `packages/core/src/export/xstate.ts`
  - `packages/core/src/export/prisma.ts`
  - `packages/core/src/export/compose.ts`
  - `packages/web/src/ui/TopBar.tsx`

---

### Initiative 6: Model Selection, Thinking (CoT) Accordion & Generation Telemetry

#### Problem
Users cannot switch between fast and deep reasoning models, cannot see reasoning traces, and have no visibility into token costs.

#### Specification
- Model tier selector in UI:
  - ⚡ *Fast Mode* (low-latency generation).
  - 🧠 *Reasoning Mode* (deep thinking models like Claude 3.7 Sonnet / DeepSeek R1).
- Collapsible Thinking Accordion in the chat drawer displaying `<think>` / reasoning streams.
- Telemetry badge per turn displaying latency, model name, and prompt/completion tokens.
- Files:
  - `packages/ai/src/providers/openai-compat.ts`
  - `packages/web/src/ui/AIPill.tsx`
  - `packages/server/src/provider.ts`

---

## Non-Negotiable Invariants

1. **Deterministic Layout**: The LLM never authors x/y coordinates.
2. **Reversibility**: Every operation must have an inverse operation.
3. **Pure Reducer**: Canvas mutations flow through `applyOperations` in `@lucent/core`.
4. **Hermetic Testability**: All additions must pass typecheck and maintain 100% test pass rates across both mock and live providers.
