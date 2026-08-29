# 9. Build Plan (V1)

> **Status: built and superseded (audited 2026-08).** This document is the
> original plan, kept for the reasoning behind each decision. It is _not_ a
> description of the code. Five packages exist (`core`, `ai`, `server`, `web`,
> and an undocumented-until-now `mcp`), with ~580 passing tests and a working
> production build. Read `checklist.md` for current status; read
> `docs/10-getting-started.md` to run it.
>
> Where this plan and the code disagree, the code wins. The three biggest
> divergences, so nobody rebuilds shipped work:
>
> - **Canvas:** §2 names **tldraw**; the canvas is a bespoke React + SVG
>   renderer (`packages/web/src/ui/atoms.tsx`, `DiagramLayer.tsx`). No tldraw,
>   React Flow, Konva, or PixiJS is installed.
> - **Layout:** §2 names **dagre/elkjs**; `packages/core/src/layout.ts` is a
>   hand-written engine with four strategies (layered with Sugiyama crossing
>   reduction, radial, tidy-tree, swimlane). Neither library is a dependency.
> - **§9 "Deferred to full MVP" is largely done:** auth, realtime multiplayer,
>   multimodal upload, code/IaC import, wireframe + sequence artifacts, and
>   presentation mode all shipped. Only **PostgreSQL/S3 persistence** is still
>   genuinely deferred — every store is in-memory.
>
> Also built but not in this plan: a Jira-style issue/Kanban layer
> (`SET_ISSUE`/`UPDATE_ISSUE`, `views/BoardView.tsx`) and an MCP server
> (`packages/mcp`) that exposes the same validated operation contract to agents.

This document is the agreed build plan for the first working version, reflecting these decisions:

- **Scope:** frontend-first vertical slice of the "wow" loop; defer DB/auth/multiplayer.
- **LLM calls:** run server-side (never expose keys in the browser), even in the slice.
- **Provider:** provider-agnostic adapter; no self-trained model in V1 (see rationale below).
- **Keys:** none yet → build against a **mock AI adapter** returning canned operations so the canvas/layout/undo work is fully testable offline.

## 0. The LLM decision (why provider-agnostic, not a custom model)

The moat is the semantic canvas + workspace memory + the conversation→structure dataset — **not** the model (`docs/01`, `docs/33`). Consequences:

- The AI's job is to emit **structured operations** as JSON/tool-calls, not to draw. A deterministic layout engine computes coordinates (`docs/03`, `docs/25`). Frontier models already do structured tool-use well.
- Training a visualization-only model up front defends the wrong thing and needs a dataset that only exists _after_ the product ships. Fine-tuning is a **later** cost/latency optimization, not a V1 task.
- The real engineering asset is the **harness**: the operation schema + validator + system prompt. That is model-independent. Keep it behind an `LLMProvider` interface so Anthropic, OpenAI, or a future in-house model are swappable.

## 1. Target vertical slice

One magical loop, end to end:

> User types (voice later) a description → server AI call returns validated operations → layout engine assigns coordinates → tldraw renders editable nodes/edges → user issues a follow-up ("add authentication") → workspace updates incrementally → undo/redo works.

Diagram types for the slice: **flowchart + architecture diagram** (mind map and user journey follow; they reuse the same model).

## 2. Stack (V1 slice)

| Concern           | Choice                                                               | Notes                                                            |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Language          | TypeScript everywhere                                                | shared types between client and server                           |
| Build/dev         | Vite                                                                 | fast HMR                                                         |
| UI                | React + TypeScript                                                   | per `docs/06`                                                    |
| Canvas            | tldraw                                                               | investigate first per `docs/06`; renders from our semantic model |
| Layout            | `dagre` or `elkjs`                                                   | hierarchical/DAG layout; LLM never sets x/y                      |
| Server            | Node + TS (Vite API route / small Express/Fastify, or serverless fn) | holds the API key, proxies the LLM                               |
| AI SDK            | provider SDKs behind our own `LLMProvider` interface                 | plus a `MockProvider`                                            |
| State/persistence | in-memory + `localStorage` for V1                                    | PostgreSQL/S3 deferred to full MVP                               |
| Validation        | `zod`                                                                | validate every AI operation before execution                     |
| Tests             | `vitest`                                                             | schema, validator, reducer, layout are pure and unit-testable    |

Nothing above is installed yet; treat as the intended stack to scaffold.

## 3. Repository structure (proposed)

```
lucent/
├── docs/                      # existing design docs
├── packages/
│   ├── core/                  # framework-agnostic, no React/DOM
│   │   ├── model/             # Workspace, Node, Edge, Group types (docs/26)
│   │   ├── operations/        # operation schema (zod) + types (docs/14)
│   │   ├── validator/         # validate ops against current workspace state
│   │   ├── reducer/           # applyOperation(state, op) -> state (pure)
│   │   ├── layout/            # semantic graph -> coordinates (dagre/elk)
│   │   └── history/           # undo/redo stack, snapshots (docs/16)
│   ├── ai/                    # LLMProvider interface, prompt harness
│   │   ├── provider.ts        # interface: generateOperations(context) -> Op[]
│   │   ├── providers/         # anthropic.ts, openai.ts, mock.ts
│   │   └── prompt/            # system prompt + operation tool schema
│   ├── server/                # thin API: POST /api/generate -> Op[]
│   └── web/                   # React + tldraw app; renders core model
└── package.json               # workspace root (npm/pnpm workspaces)
```

Boundary rule: `core` has **no** React/DOM/network deps; `web` renders `core`; `server` owns keys and calls `ai`. This keeps the semantic engine testable and reusable across future renderers.

## 4. The contract: operation schema

The single most important artifact. Everything hinges on a stable, validated schema between AI and canvas (`docs/14`). Sketch:

```ts
type Operation =
  | { op: "CREATE_NODE"; id: string; nodeType: string; label: string; groupId?: string }
  | { op: "MOVE_NODE"; id: string /* layout may override */ }
  | { op: "DELETE_NODE"; id: string }
  | { op: "CONNECT_NODES"; source: string; target: string; relationship: string }
  | { op: "DISCONNECT_NODES"; source: string; target: string }
  | { op: "CREATE_GROUP"; id: string; label: string; children: string[] }
  | { op: "CHANGE_TEXT"; id: string; text: string }
  | { op: "CHANGE_NODE_TYPE"; id: string; nodeType: string }
  | { op: "CREATE_DIAGRAM"; kind: "flowchart" | "architecture" | "mindmap" | "journey" }
  | { op: "TRANSFORM_DIAGRAM"; from: string; to: string };
```

- Defined once with `zod`; both the server (parse AI output) and client validate.
- The AI proposes ids/relationships; **coordinates are never trusted from the AI** — the layout engine assigns them.
- Every operation is reversible so the history stack can undo it.

## 5. Data flow

```
web (chat input)
  → POST /api/generate { message, workspaceSummary }
    → server → ai.provider.generateOperations(context)   // Mock in V1
    → returns Operation[]
  → validator.validate(ops, currentState)                // reject/repair invalid
  → reducer.apply(ops) → new semantic state
  → layout.compute(state) → coordinates
  → tldraw renders; history.push(ops)
```

`workspaceSummary` is the persistent-memory hook (`docs/12`): send a compact description of existing nodes/decisions so follow-ups resolve references.

## 6. Milestones

1. **M0 — Scaffold:** workspace repo, packages, tooling, CI-less local build + vitest running.
2. **M1 — Core model + reducer + validator:** pure functions, fully unit-tested, no UI.
3. **M2 — Layout engine:** semantic graph → coordinates for flowchart + architecture.
4. **M3 — Render:** tldraw renders the model; manual node editing writes back to the model.
5. **M4 — Mock AI loop:** `/api/generate` with `MockProvider`; type a message → canned ops → canvas updates. **First end-to-end demo, no keys needed.**
6. **M5 — Real provider:** implement one real `LLMProvider` + prompt harness; swap in when keys exist. Verify the same loop with live generation.
7. **M6 — History + follow-ups:** undo/redo, incremental modification ("add authentication"), workspace summary in context.
8. **M7 — Voice (optional in V1):** push-to-talk → STT → same text pipeline.

M0–M6 deliver the wow moment (`docs/07`) without a single API key committed anywhere.

## 7. Testing without keys

- `MockProvider` returns deterministic `Operation[]` for a few scripted prompts → the whole pipeline is demoable and CI-testable offline.
- Pure units (schema, validator, reducer, layout, history) need no network and no key.
- When keys arrive, add a small set of live-provider integration tests behind an env flag.

## 8. Security notes (even for the slice)

- API key stays server-side; the browser only calls `/api/generate`.
- Validate/parse all AI output with `zod` before it touches state — never `eval` or trust raw model JSON.
- Full workspace isolation, auth, encryption, and data-retention controls come with the full MVP stack (`docs/06`), not the slice — but don't ship the slice publicly with an unauthenticated generate endpoint without at least rate-limiting.

## 9. Deferred to full MVP (not in the slice)

PostgreSQL persistence, S3 assets, real auth/permissions, multiplayer (CRDT/Yjs, `docs/27`), meeting mode, multimodal upload, code-repo import, wireframe/sequence artifact types, presentations.
