# 15. Execution Plan — Checklist → Phases (with tests)

Maps `checklist.md` (Definition of Done) onto an ordered, testable plan.
Status reflects the current codebase, so we build what's missing rather than
restating what exists. Each phase ends green on `npm run typecheck`, `npm test`,
`npm run build -w @lucent/web`, and lists the specific tests to add.

Legend: ✅ done · 🟡 partial · ❌ missing · ⛔ needs backend

## Current standing (audit)

> **This snapshot is stale (re-audited 2026-08).** It was accurate when written;
> most of the "Missing" items below have shipped. Corrected summary first, then
> the original for reference. `checklist.md` is the maintained status.
>
> **Shipped since this snapshot:** eraser, hide/show, `file` objects, rounded via
> corner-radius; realtime multiplayer + presence + comments + reactions +
> sharing; image and document input; the answer channel and all six
> understand-commands; sequence/ER/decision-tree/process/org-chart; board →
> presentation and → document; AI image generation and drag-drop upload; voting,
> on-canvas search, outline (Document view), Mermaid integration; Markdown/CSV
> export and PDF/SVG/CSV/doc import. Plus three things this plan never listed:
> a Jira-style issue/Kanban layer, code/IaC → diagram import, and an MCP server.
>
> **Still missing, and these are the real backlog:** S3 / image-asset
> persistence (Postgres is now the durable store for accounts, boards, and the
> op log); the large-board/perf pass — no virtualization or culling exists;
> Playwright E2E, which this plan promises and which the now-fixed
> unwired-presence bug shows is genuinely needed; the `resolveReferences`
> helper (reference resolution works via context, but has no unit test); retry
> on the Anthropic provider (only the OpenAI-compatible one
> retries); rotate handles; role granting.

- **Phase 1 Core board:** mostly ✅ — infinite canvas, pan/zoom/fit, minimap,
  grid, multi-select, marquee, copy/paste, undo/redo, snap/align, grouping,
  frames, lock, z-order, shapes (rect/ellipse/diamond/triangle/star), sticky,
  text (multi-line), pen, images, connectors. **Missing:** rounded-rectangle as
  its own kind, **eraser**, **hide/show**, "file" objects, explicit
  large-board/perf pass.
- **Phase 2 Collaboration:** ❌/⛔ — no multiplayer, presence, comments,
  reactions, share/permissions. Needs a sync backend (biggest rock).
- **Phase 3 AI foundation:** 🟡 — text + voice → canvas ✅, semantic edit ops ✅,
  AI create/modify/delete/move ✅. **Missing:** image input, document input,
  robust "this/these/that" reference resolution, AI grouping op.
- **Phase 4 Board intelligence:** 🟡 — workspace summary is sent to the AI.
  **Missing:** explain/what's-missing/bottlenecks/summarize/find-duplicates
  commands and an answer channel (AI replies vs. only emitting ops).
- **Phase 5 Killer workflow:** 🟡 — the loop works with the mock; needs a real
  provider + clarifying questions to be genuinely usable.
- **Phase 6 Visual intelligence:** 🟡 — flowchart/architecture/mindmap/journey +
  wireframe transform ✅. **Missing:** sequence/ER/decision-tree/process/org as
  real derived artifacts; board→presentation/document.
- **Phase 7 Media & generation:** 🟡 — image paste, embeds (GIF/video/web) ✅.
  **Missing:** upload/drag-drop, PDF/doc objects, AI image generation.
- **Phase 8 Pro features:** 🟡 — templates, timer, presentation, minimap,
  sketch mode, reactions-less. **Missing:** voting, search (on-canvas), outline,
  integrations.
- **Phase 9 Import/export:** 🟡 — SVG/PNG/PDF/JSON export, JSON/image import ✅.
  **Missing:** Markdown/CSV export, PDF/SVG/CSV/doc import.

## Testing model (applies to every phase)

- **Core (`@lucent/core`)** — pure logic: every new operation gets reducer +
  validator unit tests (vitest). This is the strongest safety net and must cover
  each op's happy path + rejection path.
- **Web pure helpers** — geometry/resolvers/transforms live in plain modules
  (`board/geometry.ts`, `embed.ts`, future `transform/*`) and get vitest tests;
  keep logic out of components so it stays testable.
- **Integration** — `@lucent/server` handler tests for each new endpoint.
- **E2E (new)** — introduce Playwright against the dev server for the "Final
  Lucent Is Done" flows once Phase A lands, since IAB automation is unreliable.
- CI gate per phase: typecheck + unit tests + web build all green.

---

## Phase A — Finish Core Board (Phase 1 gaps) · small

Close the remaining Phase-1 checkboxes; all client-side, no backend.

1. **Rounded-rect** kind + **eraser** tool (stroke/shape delete on hover-drag).
2. **Hide/show**: add `hidden?` to `Shape`, `UPDATE_SHAPE` support, inspector +
   context-menu toggle, render skip.
3. **"File" object**: a file-chip shape (name + icon), drag-drop to create.
4. **Large-board pass**: virtualize off-screen shapes; measure with a 1k-shape
   fixture.
   Tests: core reducer/validator for `hidden` + file kind; geometry test for the
   eraser hit-test; a perf smoke test asserting layout stays under a time budget for
   N shapes.

## Phase B — Import/Export completion (Phase 9) · small

1. **Markdown export** (board outline → md), **CSV export** (tables/sticky grid).
2. **Import**: SVG (as image), CSV (→ sticky grid), screenshot/image drop,
   basic PDF (first page → image).
   Tests: pure serializer tests (workspace → md/csv strings), import-parser tests
   (csv/json → operations) with fixtures.

## Phase C — AI reliability + understanding (Phases 3–4) · medium

1. **Real provider** default when key present (Anthropic already wired); add a
   thin **retry/repair** layer when the model returns invalid ops.
2. **Reference resolution**: pass selection + recent-focus context so "this/these"
   maps to selected ids; add a `resolveReferences` pure helper.
3. **Answer channel**: let the provider return an explanation-only reply so
   "explain this / what's missing / bottlenecks / summarize / find duplicates"
   work without emitting ops; surface in the chat pane.
4. **AI grouping / positioning** ops already exist — add prompt coverage + mock
   scripts.
   Tests: `resolveReferences` unit tests; prompt-harness parse tests (valid/invalid
   model JSON → repaired ops); mock-provider scripts for each NL command; server
   handler test for the answer-only path.

## Phase D — Visual intelligence (Phase 6) · medium

1. Make **sequence, ER, decision-tree, process, org** real derived artifacts
   from the semantic graph (like wireframe already is), each behind a pure
   `transform/<kind>.ts`.
2. **Board → presentation** (frames → ordered slides, reuse Present mode) and
   **board → document** (outline → markdown doc view).
   Tests: one vitest per transform (`graph → artifact model`) with a fixture graph;
   snapshot the derived structure, not pixels.

## Phase E — AI generation + media finish (Phase 7) · medium

1. **Image upload / drag-drop / screenshot paste** → image shape (extends the
   paste flow already present).
2. **AI image generation**: new server route + `ImageProvider` interface (mock +
   one real vendor behind a key); result lands as an `image` shape — never as a
   diagram (preserves the "diagrams stay semantic" rule).
   Tests: `ImageProvider` mock returns a data URL → reducer places an image shape;
   server route test (schema-parse + provider error path); upload-parser test.

## Phase F — Collaboration backend (Phase 2) · LARGE, scoped separately

The biggest rock; unlocks multiplayer, presence, comments, reactions, share.

1. Sync server (WebSocket) + **operation-based** sync (send ops, not the board)
   reusing the existing operation schema; add a CRDT/Yjs layer for conflict-free
   merges.
2. Presence channel: live cursors, names, selection indicators (reuse
   `focusOn`/viewport primitives from docs/12).
3. **Comments** (per-object thread), replies, @mentions, resolve; **reactions**;
   **share + permissions** (needs auth).
4. **Auth + persistence**: move off localStorage to Postgres/S3 (docs/06);
   secure the currently-unauthenticated `/api/generate`.
   Tests: op-sync merge unit tests (two clients, concurrent ops → converged state);
   CRDT property tests; server auth/permission tests; comment thread reducer tests.

## Phase G — Launch hardening

Onboarding, billing/usage limits, analytics + error monitoring, AI latency
budget, large-board perf, e2e coverage of the "Final Lucent Is Done" and
"Ultimate Test" flows.
Tests: Playwright e2e for both acceptance scripts in the checklist; load test for
large boards; server rate-limit tests.

---

## Recommended order & why

A → B → C → D → E deliver visible, testable single-user value with no infra risk,
and make the "Ultimate Test" (talk → architecture → semantic edit) genuinely
strong once C lands a real provider. **F (collaboration) is the gating
investment** for the MVP launch criteria and should be scheduled deliberately —
it's larger than everything before it combined. G is the pre-launch polish gate.

MVP/Private-Beta checklist maps to: A + C + a minimal slice of F (share + basic
presence) + reliable autosave (already ✅). Public launch needs D, B, and full F.

---

## Milestone 3 — Large-board readability (2026-08 direction; the next unit of work)

> Added post-M1/M2. The problem is precisely stated: _large AI-generated
> boards contain too much visual information._ The discipline (docs/01, docs/05):
> **improve readability without changing the workspace data model, the layout
> engine, or the AI pipeline.** Three small layers, each independently
> shippable, in this order.

### 3.1 Selection focus (small, do first)

Selecting a node makes it and its connections prominent; every other node and
connector fades slightly (opacity, no geometry). No data changes, no layout
changes, no AI changes — pure CSS over the existing render path. This alone
makes a 40-node board readable at a glance.

- Touch: `DiagramLayer` gets a `focusId` prop; non-adjacent nodes/edges render
  at reduced opacity (adjacency = share an edge with the selected node).
- Tests: pure helper (`focusSet(workspace, id) → Set`) unit tests; a render
  test asserting the opacity classes.

### 3.2 Connector visibility tiers (small)

Give edges a visual hierarchy — primary ━━━▶ / secondary ───▶ / contextual
·····▶ — with a user toggle: _Connections: All / Important / Off_. v1 ranking is
structural, not AI: edges inside the focused/selected region and edges with
labelled relationships rank above cross-region context edges. Nothing is
deleted from the model; the toggle only changes rendering.

- Touch: `scene.ts` gains a per-edge `tier` derivation; `DiagramLayer` filters
  by the toggle; a small segmented control on the bottom bar.
- Tests: tier-derivation unit tests (primary = within-region or
  relationship-labelled; contextual = cross-region unlabeled).

### 3.3 Region collapse (small)

A region renders as a summary card — `ARCHITECTURE · 24 nodes · 31 edges
[Expand]` — that expands to exactly today's diagram. The region's members stay
in the model untouched; collapse is a render-mode on the group, the same way
`kind` already is. Meeting-grown boards (five-plus regions) become navigable:
collapse everything, open the topic under discussion.

- Touch: `GroupRegion` gains a `collapsed` flag (render-local state keyed by
  group id, not a model change); collapsed regions draw the card and skip
  member nodes/edges in culling.
- Tests: collapse preserves member positions exactly (expand == before);
  culling respects collapsed regions.

### 3.4 Then STOP and measure

Use the real benchmark board (40 nodes / 72 edges / 7 groups / 1,922px longest
connector — not a hypothetical), then escalate: 20 → 40 → 80 → 150 nodes. The
question at each size: _"Can I actually understand this?"_

- If 80 is readable after 3.1–3.3: **ship; don't over-engineer.**
- Only a measured failure at 150 opens the investigation into ELK/routing —
  and even then it must beat the simpler alternative (more aggressive
  defaults for tiers, auto-collapse of low-relevance regions).

**Explicitly not in M3:** ELK/Dagre, edge bundling, a new layout engine,
semantic zoom, a new graph representation, region-system rewrites. The
existing architecture (LLM owns meaning; the engine owns state and geometry)
is correct; M3 adds _presentation_ layers on top of it.

### Companion fixes from the live passes (fold in opportunistically)

- **Proposal persistence** — a pending review batch is React-state only; a
  reload drops the ops. Persist + rehydrate the proposal into the project
  record (small; known gap from the M2 live gate).
- **AI ownership model** (future hook, not this pass): today `pinned` is the
  only "the user placed this" signal. The eventual richer model —
  `layout: { mode: "manual" | "ai" | "auto", locked }` — should distinguish
  AI-created vs user-created vs user-positioned so a hand-placed AI node is
  never moved again. Design kept open; not built.
