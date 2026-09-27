# 26 — The connected loop: from a canvas to the whole product

- Status: **Accepted 2026-09-24** — decisions locked in §12; execution follows §11's order
- Date: 2026-09-24 · branch `lucent/atelier`
- Inputs: the product definition (42 sections) and the user-flow specification
  (139 flows) written by the founder; a code audit of this branch
  (2026-09-24, file-level, three passes: meetings/voice, canvas/diagrams/assets,
  workspace/search/governance).

This document maps the specification onto what exists, names the defects the
audit found, and sequences the work. Each phase ends in something a user can
do end-to-end, measured against the **golden flow** (§10).

---

## 1. What Lucent is

> **Lucent is a collaborative visual workspace that turns conversations into
> structured knowledge and execution, and keeps that knowledge connected to the
> canvas, meetings, decisions, and work over time.**

The loop, in one line: _work → communicate → visualize → meet → capture →
understand → decide → execute → synchronize → remember → retrieve → continue._

Four **surfaces** over one **semantic layer**:

| Surface      | What the user does there                               |
| ------------ | ------------------------------------------------------ |
| Canvas       | Think visually; the AI constructs, the user shapes     |
| Meeting      | Talk; Lucent listens, transcribes, understands         |
| Intelligence | See what the team knows: decisions, questions, risks … |
| Execution    | See what the team is doing, and why                    |

The semantic layer — typed statements with lifecycles, relationships,
provenance, the sequenced op log — is the product. Surfaces are lenses on it.
That is why most of this plan is about **joins** (§4), not new screens.

Three verbs stay distinct everywhere, in the UI and in routing:

| Verb        | Meaning                       | Example                            |
| ----------- | ----------------------------- | ---------------------------------- |
| **Search**  | Find what exists              | "Postgres"                         |
| **Ask**     | Reason over what exists       | "Why did we choose Postgres?"      |
| **Command** | Change something (a proposal) | "Add Postgres to the architecture" |

## 2. Ground rules

Carried forward unchanged: operations are the AI's only contract; the LLM
never owns geometry; diagrams stay semantic; every AI action is reversible;
spatial additivity (ADR 0015); one bad op costs itself (M1); one mutation path
for every writer (ADR 0041); server-authoritative sequenced log (ADR 0001).

Added by this plan:

1. **The trust ladder.** Every piece of workspace truth records how it got
   there: _human-created · AI-suggested · human-approved · human-edited ·
   system-derived_. AI output is a proposal until a human — or an explicit
   policy — promotes it.
2. **Evidence or silence.** Answers show evidence, source and confidence. No
   evidence → say so. Confidence is computed from evidence coverage, never a
   model's self-assessment.
3. **Honest capabilities.** An unsupported feature is absent or marked
   unsupported (external meeting adapters, integrations), never faked.
4. **No sample data in product surfaces** — the Atelier rule, stated in
   `packages/web/src/lucent.css` and `ui/kit.tsx`: real data or an honest
   empty state.
5. **Workspace boundaries are privacy boundaries.** Search, Ask, memory and AI
   context never cross personal ↔ team ↔ org without explicit permission.

## 3. Where we are

Legend: ✅ exists · 🟡 partial · ❌ missing. File references are in the audit
notes; the headline status per area:

| Spec area                  | Status | Reality in the code                                                                                                     |
| -------------------------- | :----: | ----------------------------------------------------------------------------------------------------------------------- |
| Orgs, personal org, roles  |   🟡   | Org → boards only. Roles owner/editor/viewer. No teams, projects, commenter, guests-as-type                             |
| Favorites, trash, activity |   ❌   | Board delete is hard and cascading; no favorites; no user activity feed                                                 |
| Infinite canvas            |   🟡   | Pan/zoom/fit/minimap/marquee/snap/align ✅; no rotate handle, lasso, back/forward, zoom-to-frame, system clipboard      |
| Object kinds               |   🟡   | 12 shape kinds; no tables, code, rich text, icons, **vector/SVG**                                                       |
| Diagram intelligence       |   ✅   | 8 kinds, regions, 4 layout strategies + ELK, sequence/ER lenses, statements, provenance, typed edges                    |
| AI copilot (generate/edit) |   ✅   | One prompt, 38 ops, validated; inspection ("find contradictions") only through free-form chat                           |
| AI conversation            |   🟡   | Chat is per board in localStorage, 8 turns; no threads, no scopes beyond the board                                      |
| Native meetings (A/V)      |   🟡   | LiveKit room works; no lobby preview, device choice, roles, chat, hands, captions, reconnect; **token route unguarded** |
| Voice                      |   🟡   | 4 STT providers, TTS, wake phrase, conversational lease ✅; barge-in mostly unreachable; hosted STT drops finals        |
| Transcript                 |   🟡   | Labels, search, jump ✅; no correction, confidence not stored, speakers not mapped to people                            |
| Meeting intelligence       |   🟡   | Live differential extraction + Meeting brief ✅; no end-of-meeting pass, summary, review step                           |
| Memory (cross-meeting)     |   🟡   | Within one board only (ADR 0023); nothing crosses boards                                                                |
| Search                     |   🟡   | One board, keyword; comments not searched; no workspace search                                                          |
| Ask                        |   🟡   | One shared board, verified citations ✅; no confidence, no scopes, not on local boards                                  |
| History                    |   🟡   | Server op log with actors ✅; no compare, AI model not recorded on changes                                              |
| Human review               |   🟡   | One pending proposal per board; external actions and inbound changes each have their own gate; no unified center        |
| Execution                  |   🟡   | Actions with issues, rollups, blockers, drives-chain ✅; no project/workstream entity                                   |
| Integrations               |   🟡   | Linear/GitHub/Jira out + human-gated; inbound status only; env-var credentials, no OAuth, no degraded state             |
| External meeting adapters  |   🟡   | Seam + mock only; capability model written but unused                                                                   |
| Collaboration              |   🟡   | Presence, comments, mentions ✅; **viewers can't comment**; no follow/spotlight across users                            |
| Templates                  |   🟡   | 4 board templates; no meeting templates; templates carry no extraction rules                                            |
| Lenses                     |   🟡   | Diagram, Kanban, Document, Wireframe, Sequence, ER; no timeline, dependency, decision lens                              |
| Semantic zoom              |   ✅   | Density ladder (§6.5): count+zoom presentation modes; regions auto-summarize into cards at scale                        |
| Files / assets             |   🟡   | Upload API exists but **no web client**; every image lives as a data URL in the op log                                  |
| AI images / vectors        |   🟡   | Raster image generation ✅; **no vector/SVG creation**; SVG import is a naive regex                                     |
| Notifications              |   🟡   | 7 kinds (invites/mentions/replies); none for approvals, meetings, decisions, blocked work                               |
| Command palette            |   🟡   | Navigation + a few actions; no canvas commands                                                                          |
| Mobile                     |   🟡   | Read-only board + comments; no approvals, meetings, Ask                                                                 |
| Security / classification  |   ✅   | Classification floors, provider policy, SSO/SAML/SCIM users/TOTP, sessions                                              |
| Audit                      |   🟡   | Append-only log ✅; invites, role changes, share links, approvals, integration connects **not audited**                 |
| AI governance              |   🟡   | Actor model ✅; which model/provider ran lives only in usage metering                                                   |
| Billing / usage            |   ✅   | 4 plans, Stripe, metering; analytics are usage-only                                                                     |
| Automation                 |   ❌   | Job queue ✅; outbox has **no consumers**; 3 job types are stubs; no user rules                                         |
| MCP / API                  |   🟡   | 4 MCP tools, one board, session token; no API tokens, no versioned API                                                  |

## 4. Fix first — defects the audit found (Phase 0)

These are wrong today, independent of any new feature. Ordered by severity.

| #   | Defect                                                                                                                                                                                                                           | Where                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Any signed-in user can get a LiveKit token for any room** — `board-<anyId>` joins another team's call                                                                                                                          | `server/src/app.ts` LiveKit token route                 | **Done:** board rooms need a role (viewer; `voice_` editor), board-less callers get a private `user-<id>` room, any other name is 403 (`agentGrant.ts resolveRoomAccess`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F2  | **The voice agent bypasses the governed pipeline** (no metering, approval, provider policy, mode gating) and **defaults to a hardcoded third-party LLM endpoint**                                                                | `packages/voice-agent/src/agent.ts`                     | **Done:** board-scoped `Agent` grant replaces the forwarded session token; edits recorded as actor `ai` initiated by the user; no default endpoint; agent + AI boundary checked at dispatch. **Left for the voice track:** large agent edits still apply directly instead of as a proposal                                                                                                                                                                                                                                                                                                                                                         |
| F3  | Hosted STT (default buffer-at-close) drops every final and the last chunk; tests mock an empty close                                                                                                                             | `web/src/stt/hosted.ts`                                 | **Done:** emits gate on a `disposed` flag (set only after the close flush), not on `stopped`, and `stop()` routes through the recorder's own stop → `onstop` closes only after the final chunk is flushed, so the last chunk and the close-response finals both surface; regression test with a non-empty close                                                                                                                                                                                                                                                                                                                                    |
| F4  | Finals are dropped while TTS plays → "Lucent, stop" can't fire and those turns vanish from the transcript                                                                                                                        | `MeetingView.tsx` `onFinal`, `stt/browser.ts`           | **Deferred (needs the V8 transport):** the browser recognizer is paused during TTS and both `onresult` and `MeetingView.onFinal` gate on `isTtsSpeaking()`, so during-TTS capture is off by design to avoid transcribing Lucent's own speech (echo). Re-enabling it is the "capture-start yield → true VAD barge-in" transport work the code already flags, not a Phase-0 guard flip; needs real mic/speaker verification before it ships                                                                                                                                                                                                          |
| F5  | Leaving the meeting view ends the call and leaves the transcript open; the call dock can never appear                                                                                                                            | `MeetingView.tsx` unmount cleanup                       | **Done:** unmount stops only the view-local STT capture and TTS playback; the room session lives in `MeetingSessionContext` and outlives the view, so the huddle dock appears and the call ends only on an explicit Leave                                                                                                                                                                                                                                                                                                                                                                                                                          |
| F6  | Your own tile shows twice in the native room; own speaking ring never lights                                                                                                                                                     | `meeting-room/NativeRoom.tsx`, `roomPeers.ts`           | **Done:** `remotePeers()` excludes the synthetic `local` peer (no double tile); the session maps the local participant's real identity to `local` in ActiveSpeakersChanged and `localSpeaking()` drives its ring; regression test                                                                                                                                                                                                                                                                                                                                                                                                                  |
| F7  | Sticky and inspector colours (`oklch(...)`, `var(...)`) are **refused** by the schema: the canvas silently discarded every new sticky, pen stroke in Ink, embed and most swatches, and a stored board holding one failed to load | `core/src/schemaPrimitives.ts` `CSS_COLOR`              | **Done:** grammar accepts numeric `oklch()/oklab()` (and `deg`); `var()` stays out, so Ink stores no stroke and swatches are literals; embeds derive iframe/image from `src` instead of `style.fill`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F8  | Viewers cannot comment — comments need editor                                                                                                                                                                                    | `server/src/room.ts`                                    | **Done:** a board-level `commenter` role (between viewer and editor; org roles unchanged) — members and share links can grant it ("Can comment"). The room lets a commenter send only conversation ops (`CONVERSATION_OPS` in core: comment, reply, resolve, react, vote) and delete only their own comments; the web mirrors it (`canComment`), shows the comment controls, and the inspector's Comment button no longer renders for a viewer, for whom it opened nothing. No migration (the role columns are text). Tests: `room.test.ts`; `scripts/meeting-roles-check.mjs` 10/10. Voting has no commenter UI entry yet (the server accepts it) |
| F9  | Invites, role changes, share links, proposal approvals, integration connects are not audited                                                                                                                                     | server routes                                           | **Done:** audit rows for share links (created, with a 6-character token prefix, never the token; revoked), joining through a link, board members added / role changed (from → to) / removed, proposals approved (operations, applied, seq, meeting) and rejected, org invites created / revoked / accepted, and integrations connected / disconnected (never the credential reference). `auditRow` takes optional metadata. Test: `server/test/audit-coverage.test.ts` drives every route and reads `GET /api/orgs/:id/audit`                                                                                                                      |
| F10 | Duplicating an image shape drops its `src`; exports omit connectors and rotation and include hidden shapes                                                                                                                       | `ShapeInspector.tsx`, `board/geometry.ts buildBoardSvg` | **Done:** one `cloneShapeOp` for every copy (carries `src`); export stacks by z, rotates, skips hidden shapes (and fit ignores them), draws shape links through geometry shared with the canvas                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F11 | Docs 22 and 25 are stale (say "native AV room not built"; omit the conversational lease)                                                                                                                                         | docs                                                    | **Done:** docs/22 and docs/25 now say the native room is built (LiveKit per board: camera, mic, screen share, the dock; lobby/roster/host powers are docs/28 S4–S5), docs/22 records the voice participant shipping in honest form, and docs/25 gains a row for the conversational lease                                                                                                                                                                                                                                                                                                                                                           |
| F12 | **Asset reads trusted `X-Lucent-Org-Id`**: GET and thumbnail never checked the caller belonged to the named org, so any signed-in user could read another org's images by id (found building the upload client)                  | `server/src/routes/assets.ts`                           | **Done:** reads resolve only among the caller's memberships (also fixes multi-org reads); regression test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 5. The joins — structural changes that make it one product

These seven changes are what turn five good modules into one loop. Each needs
an ADR before code.

### J1 · Meetings become workspace objects

Today a meeting is a transcript row owned by one board (`MeetingTranscript
{id, boardId, turns…}` — no title, participants, schedule or host).

- `Meeting { id, orgId, projectId?, title, status, startsAt?, durationMin?,
hostId, participants[], boards[] (0..n), templateId?, mode, classification }`
- Status lifecycle: `scheduled → live → ended → summarized → reviewed`.
- Turns gain `confidence`, provider `startMs`, and **corrections** (edited text
  with the original preserved and the editor recorded).
- Migration: every existing transcript becomes a meeting with `boards=[boardId]`,
  title derived from its start time. Board-scoped routes keep working.
- One workspace Meetings list; a board shows the meetings linked to it.

### J2 · Projects (the connective tissue)

`Project { id, orgId, name, objective, members[], boards[], meetings[], status }`.
Workstreams are **regions inside the project's plan board** (groups already
carry kinds; ADR 0014) — no second task table. Tasks stay **action nodes with
issues** (ADR 0027 "the action is executable work"): the chain
_meeting → decision → action → external issue_ already exists and is kept.

### J3 · The workspace intelligence index

A **derived, rebuildable projection** (ADR 0040: derived, never canonical) of
every statement across the boards a user can see:
`{ nodeId, boardId, projectId?, kind, status, topic, supersedes, assignee,
dueDate, provenance, updatedSeq }`, maintained on commit by an outbox consumer
(the outbox has none today). It powers workspace Home, workspace
Intelligence, notifications, Search and Ask — the same principle as ADR 0023
("memory is a projection"), widened from one board to the workspace.

### J4 · Scoped Search and Ask

- Scopes everywhere: _selection · frame · board · meeting · project ·
  workspace · time range_ ("everything from this week").
- Search: Postgres full-text over the index, transcripts, comments, board and
  meeting names. Keyword first; embeddings stay gated by docs/21's evidence
  rule (ADR 0024).
- Ask returns **answer → evidence → source → confidence**, where confidence is
  coverage (how many independent citations support each claim, whether any
  contradict). "No evidence" is a first-class answer.
- Ask works on local boards too (the request carries the board summary, as
  generate does).

### J5 · The Review center (trust ladder)

One queue for everything awaiting a human: AI canvas proposals, **extracted
statements as candidates**, external actions, inbound integration changes,
duplicate/contradiction recommendations. Actions: approve · edit · reject ·
merge · split · assign.

Model: statements gain a separate `trust` field
(`ai-suggested | human-approved | human-edited | human-created | system`)
rather than new lifecycle statuses — ADR 0021's freeze rule is about
lifecycles, and trust is orthogonal to them. Meeting extraction lands as
`ai-suggested`; a direct user request lands as `human-approved` (the user
asked for it); a promotion is an ordinary validated op.

### J6 · AI run records (governance)

`ai_runs { id, initiatedBy, surface (canvas|meeting|voice|mcp|automation),
provider, model, contextScope, tools, outputHash, proposalId?, opSeqs[],
approvedBy? }`. The op log and proposals reference the run. Answers "which
model, what context, who approved" for every AI change, and feeds the audit
log.

### J7 · One conversation model

Conversations move server-side as **threads** bound to a scope (board, meeting,
project, workspace). Text chat, Ask, and the voice lease write to the same
thread, so "What about PostgreSQL?" after a spoken answer continues the same
context in either medium. Replaces the 8-turn localStorage chat.

## 6. The visual engine, v2 — "not just one model"

### 6.1 A representation registry

Today the families are scattered (`DiagramKind`, lens code, prompt text,
templates). Make one table-driven registry: each family declares its semantic
kind, allowed ops, layout engine, lens renderer, prompt section and starter
template. The AI prompt's family list and the "convert to…" menu are
generated from it, so a new family is an additive change.

**Status (2026-09-25):** the registry itself is built —
`core/src/representations.ts` (`REPRESENTATIONS`) is the single table over
`DIAGRAM_KINDS` (now the one source of truth the operation and workspace Zod
enums derive from). Each entry declares label, summary, category, layout
strategy, route style, and the `aiCreatable`/`convertible` flags. Everything
that used to keep its own per-kind copy now derives from it: `layout.ts`
(`layoutStrategyFor` → `STRATEGY_FOR_KIND`), `routing.ts` (`routeStyleFor` →
`ROUTE_STYLE_FOR_KIND`), the web canvas labels (`DIAGRAM_LABELS`) and the
region-kind picker (`REGION_KIND_ORDER`, which had drifted to a hand-kept 7 of
11 — the four newer families were unreachable and, worse, a region set to one
wouldn't reload because `groupSchema.kind` refused it; both fixed by deriving
from `convertibleKinds()` and widening the schema to the full set). The AI
prompt injects a generated family catalog (`representationCatalogPrompt()`), and
a whole-board **"Convert board to…"** menu (the manual counterpart of
`TRANSFORM_DIAGRAM`, previously exposed as `selectDiagram` but wired to no UI)
now lets "turn this into a roadmap / state machine" work from any board.
Three graph/architecture variants were added as pure registry entries (2026-09-25):
**dependency graph**, **C4 model** and **network / infrastructure** — each lays
out `layered` and renders generically, and adding them touched only
`DIAGRAM_KINDS` + one registry entry each (two lingering hand-kept
`Record<DiagramKind,…>` maps — ELK's algorithm-per-kind and the dashboard's
board-label map — were folded into the registry at the same time, so they can't
fall behind again).
**Still to add — larger than one entry, each needs new geometry or an object
kind:** table (new object kind + renderer), data charts (CSV→chart data
binding), and promoting sequence/ER from derived lenses to AI-creatable kinds
(they need their own layout). BPMN is now wired into the prompt and picker.

**Starter templates (2026-09-25):** the registry entry now carries the last of
its four declared parts — a `starter(idPrefix)` that returns the operations
seeding a minimal, still-editable example of the family (`starterFor(kind,
prefix)`; core, framework-agnostic, id-prefixed so repeated inserts never
collide). Each is a _semantic_ seed — nodes, edges and groups, never fixed
geometry — so the layout engine positions it and the AI can keep building on it.
The "Convert board to…" menu uses it: on a blank board, picking a family now
seeds its starter rather than switching an empty kind, so "turn this into a
state machine / roadmap / C4" produces something to edit. Tests assert every
family's starter validates against the op contract, reduces to a board of the
right kind, and lays out.

**Table object kind (2026-09-25):** the first of the two new object kinds is
built — a `table` shape (core `table.ts`, mirroring how `vector` rides
`shape.vector`). It carries `{ columns, rows }` as plain strings (never markup),
with a delimited-text parser (`parseDelimited`, CSV/TSV with RFC-4180 quoting)
that doubles as the "extract structured data" input, plus `createTable` and
`tableToMarkdown`. The op contract (`CREATE_SHAPE`/`UPDATE_SHAPE.table`), the
reducer, the workspace schema (tolerant `.catch(undefined)` like vector), and
the inverse (undo) all carry it; `cloneShapeOp` now copies it (and `vector`,
which it had also been dropping). The web renders it as an HTML table on the
canvas and a drawn grid in the SVG/PNG/PDF export, with a toolbar tool that
drops a starter 3×2 grid. Remaining new-geometry work: data charts (bind a
table/CSV to a vector chart) and promoting sequence/ER to AI-creatable kinds.

**Data charts (2026-09-25):** the second new object kind is built — a `chart`
shape (core `chart.ts`) carrying `{ type, title?, labels, series }` for bar,
line and pie. `chartFromTable` binds tabular data (first column → labels, each
numeric column → a series), so "CSV/table → chart" works, and `parseNumericCell`
tolerates currency/percent/thousands. The DRAWN TRUTH is one pure function,
`chartGeometry(data, w, h)`, returning flat primitives (rects, lines, polylines,
pie-slice paths, text); the canvas `ChartView` and the SVG export both build
from it, so they can never diverge. Wired through the same points as `table`
(op contract, reducer, tolerant schema, inverse, `cloneShapeOp`) with a toolbar
tool that drops a sample bar chart. Only sequence/ER-as-creatable-kinds now
remains of the V4 family list.

**Sequence & ER as creatable kinds (2026-09-25):** the last family-list item.
`sequence` and `er` are now registry kinds (with starters), so the AI's catalog
names them, `CREATE_DIAGRAM`/`TRANSFORM_DIAGRAM` accept them, and the "Convert
board to…" menu offers them. They keep their existing derived presentation —
`board/sequence.ts` → `SequenceView`, and `ErView` — rather than a new core
layout: converting a board to sequence/ER also switches the canvas lens to
match (and converting away from one returns to the visual lens), so the choice
shows the diagram immediately. **This closes the V4 family list; every row in
the §6.1 table is now ✅ or a deliberate follow-up (expand/collapse ops, C4
level nesting) beyond the "create/convert works" bar.**

| Family                          | Today | Plan                                                                         |
| ------------------------------- | :---: | ---------------------------------------------------------------------------- |
| Flowchart, process, swimlane    |  ✅   | —                                                                            |
| Architecture                    |  ✅   | + C4 levels (context/container/component) and icons                          |
| Mind map, org chart, tree       |  ✅   | + expand/collapse ops                                                        |
| Journey, decision tree          |  ✅   | —                                                                            |
| BPMN                            |  ✅   | Wired into the AI prompt and the convert/region picker (registry)            |
| Sequence, ER                    |  ✅   | Creatable kinds (registry); presented through the sequence/ER lenses         |
| State machine                   |  ✅   | Registered: states, transitions, guards (layered)                            |
| Timeline / roadmap              |  ✅   | Registered: time-axis layout; links to actions' due dates                    |
| Dependency graph                |  ✅   | Registered family (layered) over `depends_on/blocks/drives`                  |
| Matrix (2×2, SWOT, RACI)        |  ✅   | Registered: grid layout                                                      |
| Table                           |  ✅   | New object kind (`table` shape, table.ts): CSV/TSV import, HTML + SVG render |
| Charts (bar/line/pie from data) |  ✅   | New object kind (`chart` shape, chart.ts): table/CSV-bound bar/line/pie      |
| Wireframe                       |  ✅   | + icons, vector assets in elements                                           |
| Presentation layout             |  🟡   | Present mode exists → frame-ordered slides, export PDF                       |
| Network / infrastructure        |  ✅   | Registered architecture variant (group nodes into zones)                     |

### 6.2 Icons everywhere

- Bundle **Iconoir** (MIT, ~1,670 outline icons) and **Simple Icons** (CC0
  paths, ~3,000 brand marks) as an icon registry: searchable by name and tags,
  lazy-loaded, tree-shaken.
- `node.icon` becomes a validated field: the AI names an icon from the
  registry (`"iconoir:database"`, `"simple:postgresql"`), never emits markup.
  Architecture boards get real Postgres, Stripe, Kafka marks instead of the 19
  hand-drawn glyphs in `techMarks.tsx`.
- An **icon shape** on the canvas: recolour, resize, use in wireframes.
- Licensing: ship Iconoir's MIT notice. Simple Icons' paths are CC0 but the
  logos remain their owners' trademarks — used only to identify the named
  product, never as Lucent branding; the picker links each brand's guidelines.

**Status (2026-09-24):** built — the generated registry (Iconoir 7.12 +
Simple Icons 16.32, hash-bucketed, loaded on demand), `node.icon` with
`CREATE_NODE.icon` and `SET_NODE_ICON`, automatic icons from labels (replacing
`techMarks.tsx`), the inspector's icon picker, prompt v13, and icons in the
SVG/PNG/PDF export and the mobile board (ADR 0043). The standalone icon shape
folds into V2: "icon → vector" makes a registry glyph an editable `vector`
shape, so there is one recolourable vector object, not two.

### 6.3 Vector Studio — SVG as a first-class, editable object

**Model.** A new shape kind `vector` holding **structured paths, not markup**:
`{ viewBox, paths: [{ d, fill, stroke, strokeWidth, fillRule, opacity }],
gradients: [...] }`. Every path passes the SVG path grammar (extended for
exponents, with a normalizer that rounds and splits long paths); every colour
passes the colour grammar (with F7's `oklch`). Nothing is ever inserted as raw
SVG into the DOM; rendering is React `<path>` elements, like the `draw` shape.
Provenance on the shape: `{ generator, model, prompt, sourceAssetId }`.

**One sanitizing importer**, shared by every path in: parse → keep an allowlist
(`path rect circle ellipse line polyline polygon g linearGradient
radialGradient stop`) → flatten groups, transforms and viewBox → structured
paths. Scripts, `foreignObject`, event handlers, external references and CSS
are dropped. It replaces today's regex `svgToOps`.

**Status (2026-09-24, V2):** built (ADR 0044) — the `vector` shape kind, the
core importer, paste/drop/board-import of SVG, icon → vector, local tracing
in a worker (flat-art and detailed presets), pen strokes → smooth vector, the
inspector's palette recolour, ink, stroke weight and SVG download, and
vectors in exports. Not yet: split into parts, simplify, gradients.

**Status (2026-09-24, V3):** built — the `VectorProvider` seam in `@lucent/ai`
(Recraft `recraftv4_1_vector` via `b64_json`, and an offline mock); `POST
/api/vector` (editor of the board, the board's AI boundary, the AI allowance, a
`vector.generation` line item) sanitizes every vendor document through the core
importer and strips the backdrop, so the client only ever receives structured
paths; the Generate tab (style, three variations, click to place, "More" from
the inspector); a brand guard that offers the real mark from the library instead
of generating another company's logo (Recraft's terms forbid it); prompt v14
lets the visual agent draw a small pictogram itself as the free fallback.
Verified against the live API (one call, 80 units). Not yet: AI edit of an
existing vector (image-to-image), QuiverAI.

**Image-generation fixes (2026-09-25):** two defects noticed during testing,
now closed. (1) A generated raster image is no longer inlined into the op log
as a ~2.6 MB data URL: on a shared board `generateImageShape` runs the result
through `uploadGeneratedImage` → `POST /api/assets`, so the shape carries a
20-byte `asset:` reference (local boards and upload failures still fall back to
the data URL, and the SVG mock stays inline since the asset store refuses SVG).
(2) `OpenAIImageProvider` had no request timeout — a stalled gateway hung the
call forever; it now uses `AbortSignal.timeout` (default 120 s, override via
`LUCENT_IMAGE_TIMEOUT_MS`/`LUCENT_AI_TIMEOUT_MS`), matching every other outbound
provider.

**Five ways to make a vector:**

| Path               | How                                                                                                                                                         | Runs where                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Import / paste SVG | The sanitizing importer                                                                                                                                     | Browser                          |
| Icon → vector      | Registry icon becomes an editable vector                                                                                                                    | Browser                          |
| Text → SVG         | `VectorProvider` seam: **QuiverAI Arrow** (API), **Recraft V4 Vector** (API or OpenRouter), or a baseline where the configured LLM authors structured paths | Server (provider policy applies) |
| Raster → vector    | **VTracer** (MIT, WebAssembly) in a worker — free and private, allowed on restricted boards; optional **Vectorizer.AI** API for best quality                | Browser worker / server          |
| Sketch → vector    | Pen strokes → simplify and smooth → vector                                                                                                                  | Browser                          |

**Editing:** recolour (board palette), stroke width, fill on/off, simplify,
split into parts (each path selectable), "edit with AI" ("make it flat,
two colours") through providers that support SVG editing, and "give me three
directions" (variations side by side). Export a single asset as SVG/PNG.

**Where vectors land:** on the canvas, as a node's icon, inside a wireframe
element, on a slide.

**Governance:** vector generation is media, not a diagram (docs/14 decision 3
holds: diagrams stay semantic). Provider policy and classification apply —
restricted boards only use local vectorizing and the org-approved LLM. New
metered kind `vector.generation`. Small vectors live in the workspace; large
ones as assets (the asset store refuses raw SVG by design — it stores the
structured JSON instead).

### 6.4 Canvas editor gaps to close

Rotate handle and numeric inspector (x, y, w, h, rotation, opacity, stroke
width); 8-handle resize with aspect lock; one-step z-order; system clipboard
(copy/paste across boards and from other apps, incl. SVG and images); copy and
paste nodes; zoom-to-frame; camera back/forward; lasso; highlighter; tables;
code blocks; minimal rich text; node ↔ shape links; canvas commands in ⌘K
(align, group, convert, auto-layout, zoom); the asset upload client (images
stop living in the op log).

**Status (2026-09-24):** built — rotate handle (Shift snaps 15°), numeric
inspector (x, y, w, h, rotation, opacity, stroke width), one-step z-order
(⌘] / ⌘[) with a stacking model that fixes Send to back, the system
clipboard (Lucent payload between boards and tabs; images, SVG, links and
text from other apps; schema-gated), zoom to frame, camera back/forward,
⌘K canvas commands (fit, zoom to selection, camera, go to frame), and the
asset upload client (shared boards store `asset:` references; exports inline
the bytes). Fill-aware shape text fixes dark-mode legibility. Still open:
8-handle resize with aspect lock, lasso, highlighter, tables, code blocks,
rich text, node ↔ shape links, and align/group/convert in ⌘K.

### 6.5 Semantic zoom ladder

The spec's density ladder, on top of today's three tiers and region collapse:
1–30 objects full detail · 30–80 grouping · 80–150 regions · 150–300 overview ·
300+ semantic overview (each region as a summary card: kind, counts, open
decisions and risks). Measured against the 40/80/150-node benchmark boards.

**Status (2026-09-25, V5):** built. The ladder is one pure, tested function in
core — `presentationMode(nodeCount, zoom)` (`semanticZoom.ts`) — returning the
more-summarized of the count floor (the existing `densityBand` rungs:
≤30 detail · ≤80 grouped · ≤150 regions · ≤300 overview · >300 summary cards)
and the zoom rung, so a large board never shows full detail zoomed out and any
board summarizes as it zooms out. At the summary-cards rung — a 300+ board, or
any board zoomed far out — the canvas auto-collapses every region into a summary
card carrying its kind, node/edge counts and **open decisions, risks and
questions** (`regionSummary`); the reader expands a region (double-click, or the
card's button) or simply zooms in to reveal its members, and zooming back out
re-summarizes. Manual collapse still works below that rung. Auto and manual use
separate render-local sets so neither reinterprets the other. Verified on the
40/80/150/300-node benchmark boards (core tests) plus the full web suite.

## 7. Meetings and voice — the full lifecycle

Screen by screen, with every state and the defects found on the way
(F13–F25): [docs/28](./28-meeting-screens.md).

| Stage            | Plan                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schedule         | Title, time, participants, project/boards, template, AI mode. Email invites with an `.ics`; calendar integrations later                                                |
| Lobby            | Camera preview, mic test with level meter, device pickers, AI settings, permission errors explained                                                                    |
| Room             | Roster, screen share with permissions, chat, raise hand, reactions, live captions (interim), host/co-host (LiveKit grants + RoomService), reconnect with token refresh |
| Board in meeting | Board side by side; follow presenter, spotlight, "bring everyone here" (presence carries viewport + focus)                                                             |
| Transcription    | **Per participant** — each client transcribes its own mic under its identity (today only the recorder's mic is captured)                                               |
| Voice            | Keep the conversational lease; fix barge-in (F4); device switching; "AI listening" toggle alongside "AI speaking"                                                      |
| End              | Finalize transcript → end-of-meeting extraction pass → LLM summary with citations → candidates into the Review center                                                  |
| Follow-up        | Approve/edit candidates, create tasks, schedule the next meeting, notify owners, add a board section                                                                   |
| Next meeting     | Loads context: previous decisions, open actions, unresolved questions, risks from the project                                                                          |
| External         | Capability model surfaced in the UI; transcript import first; Zoom/Meet/Teams adapters later (vendor apps needed)                                                      |
| Templates        | A meeting template = agenda + extraction rules + recommended questions (e.g. retro, design review, incident, interview)                                                |

## 8. Execution, integrations, automation

- **Project dashboard:** objective, progress, workstreams, blockers with the
  full _why_ chain (blocker → dependency → owner → decision → meeting turn).
- **Integrations:** OAuth connect flows; connection states
  `active · degraded · needs-reauth · revoked`; inbound sync beyond status
  (assignee, due date); Slack outbound (meeting summaries, decision digests).
- **Automation v1:** rules over outbox events, each automated change still
  passing the review policy. First rules: _meeting ended → extract → review_,
  _decision approved → propose plan_, _action overdue → notify owner_,
  _external issue closed → action completed_.

## 9. Workspace, collaboration, administration

Teams inside an org (and SCIM Groups); routes to change a member's role and
remove a member; a **commenter** role; guests as a type with scoped access;
favorites; trash with a 30-day window (boards, meetings, projects); a personal
activity feed; org-wide 2FA requirement; scoped **API tokens** and a versioned
API; MCP tools over the index (`search_workspace`, `get_meeting`,
`list_decisions`, `get_project`); notification kinds for approvals, meeting
summaries, assignments, blocked work, superseded decisions.

## 10. The golden flow — the acceptance spine

Every phase is judged by how much of this runs end-to-end, on a real
Postgres deployment, with two real users.

| Steps (spec §137)                                          | Made real by        |
| ---------------------------------------------------------- | ------------------- |
| 1–4 open Lucent, open a project, open a board, edit it     | A1                  |
| 5–6 invite a teammate, they join                           | A6 (exists in part) |
| 7–11 start a meeting: camera, mic, screen share, board     | A3                  |
| 12–13 Lucent captures speech, live transcript              | Phase 0, A3         |
| 14–17 "Lucent, summarize…" → voice answer → follow-up      | Phase 0, A4         |
| 18–21 meeting ends → intelligence generated                | A3                  |
| 22–24 review and approve decisions and actions             | A2                  |
| 25–28 decision drives work → plan → tasks → Linear/Jira    | A5                  |
| 29–31 external work changes → Lucent updates               | A5                  |
| 32–36 "Why are we doing this?" → decision, meeting, turn   | A4                  |
| 37–38 jump to canvas, highlight affected architecture      | A4, V-track         |
| 39–41 edit, history records it, next meeting loads context | A1–A3               |

## 11. Roadmap

Two tracks run in parallel; they share only the kit and the op contract.

**Phase 0 — Fix first** (§4). Small, mostly independent; F1 and F2 before
anything ships.

**Track A — the loop**

| Phase | Name                   | Scope                                                                                        | Ends when                                                           |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A1    | Workspace spine        | J1 meeting objects, J2 projects, J3 intelligence index, workspace Home/Intelligence/Meetings | A user sees every decision, meeting and open question across boards |
| A2    | Trust                  | J5 Review center + trust field, J6 AI runs, audit coverage, new notification kinds           | Nothing AI-extracted becomes trusted without a visible human step   |
| A3    | Meeting lifecycle      | §7: schedule, lobby, room controls, per-participant transcription, end → summary → review    | Golden steps 7–21 run with two people                               |
| A4    | Ask everywhere         | J4 scoped Search/Ask with confidence, J7 threads, Ask → canvas views, MCP v2                 | "Why are we doing this?" answers with decision → meeting → turn     |
| A5    | Execution & automation | Project dashboard, OAuth integrations, inbound beyond status, automation v1                  | Golden steps 25–31 run against a real Linear/Jira                   |
| A6    | Enterprise & sharing   | Teams, commenter, guests, trash, favorites, API tokens, 2FA policy                           | An org can onboard a team and a client guest safely                 |

**Track V — the visual engine**

| Phase | Name                      | Scope                                                                                                                                                      | Ends when                                                               |
| ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| V1    | Icons & editor            | §6.2 icon registry + `node.icon`, §6.4 editor gaps, asset upload client, export fixes                                                                      | An architecture board shows real brand marks; shapes rotate and export  |
| V2    | Vector Studio, local      | `vector` kind, sanitizing importer, icon → vector, VTracer raster → vector, sketch → vector, editing                                                       | Paste a logo PNG → an editable, recolourable vector, no external calls  |
| V3    | Vector Studio, generative | `VectorProvider` seam: LLM baseline + QuiverAI and/or Recraft, variations, AI edit                                                                         | "Three icon directions for our four services" lands as editable vectors |
| V4    | Representation registry   | §6.1 registry ✅ + starters ✅; every family wired: state machine/timeline/matrix, dependency/C4/network, table + chart object kinds, BPMN, sequence/ER ✅ | "Turn this into a roadmap/state machine/C4" works from any board ✅     |
| V5    | Semantic zoom ladder      | §6.5, measured on 80/150/300-object boards ✅                                                                                                              | A 300-object board is readable at every zoom ✅                         |

**Locked order (2026-09-24, see §12):** the visual track leads the next
milestone. Security defects F1–F2 and the colour contract F7 go first
because they are defects, not features; the meeting/voice defects (F3–F6)
move into the meeting/voice step.

```text
0. Security + colour fixes        F1, F2, F7
1. Visual track                   V1 readability & icons → V2 Vector Studio (local)
                                  → V3 Recraft + generation UX → V4 representation registry
                                  → V5 semantic zoom at scale
2. Meeting / voice productization A3 + F3–F6: native room, conversation flow,
                                  follow-ups, barge-in, meeting UX, scheduling
3. Intelligence refinement        A2 + A4: assumptions, constraints, trust/review, Ask
4. Execution                      A1's projects + A5: planning, integrations
5. Platform / enterprise          A6
```

"Visual lead" means making the existing semantic and layout machinery produce
a much better product — not rewriting the layout engine.

### Status

- **A1 — done (2026-09-27), per ADR 0046.** J1 shipped as docs/28 A3.1/A3.4
  (the meeting is its record, listed across the workspace).
  - _J2, projects._ `projects` + `project_boards` (migration 0036): an org
    record with a name, objective, status (active / paused / done), lead,
    members and linked boards, many to many. A project grants nothing — its
    boards, meetings and statements come back only where the caller can read
    the board, and an outside collaborator sees a project only through a
    board shared with them. Org editors create, edit, archive and link;
    every change is audited. A project's meetings are its boards' meetings.
    The Projects view (rail and ⌘K) lists them with what needs attention in
    each; a project's page shows its counts, boards (add and remove), meetings
    and every statement on its boards, each one click from its node.
  - _J3, the intelligence index._ One derivation in core
    (`statementRows`) now feeds both a board's own Intelligence view and a
    server index of every board's statements (`statement_index`, with
    `statement_index_state` recording the board revision each board's rows
    came from). It is maintained by wrapping `BoardStore` so every `put`
    re-derives that board (debounced), and it is repaired on read: any board
    newer than its rows is re-derived before answering. The owner can drop and
    rebuild it. `GET /api/orgs/:id/intelligence` answers from the boards the
    caller can read, by kind, status, project, board and assignee ("me").
  - _Home and Intelligence._ Home's pulse now counts every server board from
    the index instead of only the boards this browser had loaded, lists the
    workspace's meetings (live, upcoming, recent) instead of the open board's,
    and names the active projects. Intelligence gains a Workspace scope beside
    This board, with open-only, assigned-to-me and project filters.
  - Evidence: `server/test/workspace-spine.test.ts` (10: the scopes, the
    project matrix, the indexer's put/delete/repair), `pg-workspace-spine`
    (the Postgres stores against their twins), core `statement-index.test.ts`,
    web `pulse.test.ts` (indexed boards), and
    `scripts/workspace-spine-check.mjs` in the running app (9/9).
  - Found on the way: two migrations shared the id 0031, so a fresh database
    couldn't migrate and production would have skipped the notes table once
    this branch merged (fixed in 538a9f4; the notes migration is 0031a).
  - Not yet: projects on the board itself (a chip in the top bar — the route
    `GET /api/boards/:id/projects` is there), member management beyond the
    lead, a project dashboard with plans and integrations (A5), and search and
    scoped Ask over the index (A4).
- **A2 — done (2026-09-27), per ADR 0047.** Nothing AI-extracted is trusted
  without a person's step.
  - _J5, trust._ Statements carry `trust` (ai-suggested · human-approved ·
    human-edited · human-created · system), stamped by whoever commits: the
    model's output never carries it (stripped at generate); what a person
    asked for is theirs, except what a meeting's extraction states, which
    stays a suggestion even after "Apply all"; the voice agent's and MCP's
    writes are suggestions whatever they claim, and they can't promote; a
    person's own statement is human-created, and relabelling a suggestion
    makes it human-edited. Promotion is an ordinary `UPDATE_STATEMENT` —
    logged, undoable. The index stores trust (migration 0037).
  - _The Review center_ (rail, ⌘K): every suggestion, pending proposal,
    outgoing external action and inbound change on the boards you can read.
    Suggestions are grouped by board and meeting; approve (one or all),
    reword, assign (owner and due date), or reject (removed; undo restores),
    each composed into operations on the server and committed as the person
    who decided (`POST /api/boards/:id/review`, audited). Proposals and
    inbound changes are decided inline; an external action opens on its board,
    where its preview and warnings are. Intelligence rows mark suggestions.
  - _J6, AI runs._ `ai_runs` records every model call and agent write:
    canvas, meeting and spoken requests, Ask, notes, the meeting summary, the
    voice agent and MCP — who started it, provider, model, context, a hash of
    the output. Generation returns a `runId`; the browser commits the output
    under it, so the op log records AI asked for and approved by the person
    (canvas AI batches used to be logged as the user's own), and the run
    learns its seqs; a proposal carries its run, so approving it records the
    approver. A run id is honoured only for its own user and board. The admin
    page lists the workspace's runs (owner).
  - _Notifications:_ work that names you (`work.assigned`, matched exactly
    to one member by name or email) and your work becoming blocked, from the
    index's per-board diff; a meeting's summary to whoever recorded it;
    suggestions waiting on your board, at most hourly.
  - The ops route's commit is now one helper (`commitBatch`), shared with the
    review actions; MCP writes are logged as an AI actor.
  - Evidence: core `trust.test.ts` (10), server `trust-review.test.ts` (the
    stamping on every path, the Review center matrix, a run committed over
    the WebSocket, an index notification) and `pg-trust.test.ts` (the stores
    against Postgres), and `scripts/review-check.mjs` in the running app
    (8/8: an agent's claims overridden, the owner told, approve/reword/reject
    through the UI, the canvas run on record as approved by its asker).
  - Not yet: `decision.superseded` (statements have no author to tell),
    per-item review of the end-of-meeting candidates (the recap still writes
    a summary, not candidates), and trust on nodes that aren't statements.
- **A4 — done (2026-09-27), per ADR 0048.** "Why are we doing this?" answers
  with its evidence, from wherever it is asked.
  - _J4, scoped reads._ Every workspace read resolves a scope — workspace,
    project, board, meeting, `since`/`until` — through the boards the caller
    can open. Search (`GET /api/orgs/:id/search`) runs the board retriever
    over the whole scope: statements and nodes, meeting titles and turns (as
    corrected), comments, board names — each hit carrying its board. Ask
    (`POST /api/orgs/:id/ask`) builds the same answer request from the index,
    the scope's meetings (windowed by history depth, per board) and those
    hits, cites `board:node`, and leaves any board whose policy keeps content
    from AI out of the prompt, named as excluded. A board in the browser can
    be asked too (`POST /api/ask/local`) — it used to be refused.
  - _Confidence._ Every answer — board, scoped, local — carries it, counted
    from the citations that survived: none (shown as "No evidence"), low,
    medium, high; a cited statement since superseded caps it at low.
  - _J7, threads._ One private thread per person per scope (`threads`,
    `thread_messages`, migration 0038, RLS). A shared board's chat loads from
    and appends to its thread; the meeting's spoken and typed questions share
    the meeting's thread (they used to send no history, so a spoken
    follow-up lost its context); Home and project Ask write to theirs.
  - _Where it shows._ Home's composer asks the whole workspace and answers in
    place; a project page asks its boards; ⌘K adds "Elsewhere in your
    workspace"; an answer's evidence shows together on the canvas ("Show all
    N"), selected and framed.
  - _MCP v2._ `search_workspace`, `list_decisions`, `get_meeting`,
    `get_project`, over the same routes. Workspace reads from an MCP client
    leave out boards whose policy refuses agents — the board read's boundary,
    now on every workspace read.
  - Evidence: server `scoped-ask.test.ts` (confidence, search across boards
    and time, scoped and local Ask, threads' privacy) and `pg-threads`
    (Postgres), MCP `remote.test.ts` (the four tools, and a restricted board
    kept out of an agent's search), and `scripts/ask-everywhere-check.mjs` in
    the running app (11/11).
  - Not yet: embeddings (keyword first, per ADR 0024), a Postgres full-text
    index (not needed at today's sizes), and "Ask → canvas views" beyond
    selection (a generated view of the cited architecture).
- **A5 — built (2026-09-27); the live tracker run is what's left.**
  Execution and automation.

  - _The project dashboard (§8)._ A project's page shows its execution across
    the boards the caller can read (`GET /api/orgs/:id/projects/:pid/execution`,
    core `projectExecution`):

    - progress: done, blocked (by hand or waiting on blocked work), late;
    - each workstream (a board's groups, or the board);
    - every blocker told as a story: what it waits on and who owns each
      step, the decision that drove it, the meeting and turn where that was
      decided;
    - late work.

    Each piece opens where it lives: a node selected on its board, a meeting
    at its turn.

  - _Automation v1, per ADR 0049._ Four org rules (Admin → Automation):

    - a meeting ends → the turns nobody extracted are proposed;
    - a decision approved in Review → its plan (plan-gated) is proposed;
    - work past its due date → its owner is told once (on by default);
    - a tracker marks linked work done → the board completes it as the
      integration (off by default; op-logged, audited, undoable).

    The proposal rules never displace a person's pending proposal. Each rule
    is read when its job runs, and a model call passes a person's gates.

  - _Connections (A5.3)._ Admin → Integrations connects Linear, Jira and
    GitHub: the key's server variable (never the key) and the provider's
    settings. Saving checks the connection with one read-only call. Each
    connection shows its state, derived from how it has been answering:
    Connected, Failing (5xx, 429 or network errors since the last success),
    Needs a new key (401/403 or an unset variable, until a call succeeds or
    it's reconnected) or Disconnected. Only the connection's own failures
    count: a refused item says nothing about it. The Sync button says so too.
    Reconnecting a disconnected integration now makes it active again; it
    used to stay disabled whatever was saved.
  - _Inbound beyond status (A5.3)._
    - A tracker's owner and due date reach the board the way its status
      does, as changes a person accepts or dismisses in Review ("Linear
      gives it to Bo", "…moved its due date to Oct 15"). Linear updates and
      GitHub assign/unassign events carry them.
    - Each is news only once: a link now records what the provider said for
      each field at the last sync, accept or dismiss, and a value the board
      already holds is never asked about.
    - That fixed a spurious question: a tracker's update about the owner
      carries the unchanged state, and used to queue "mark it open" too.
  - _The poll._ `integration.poll` (every 10 minutes) reads each active
    connection's linked tasks (up to 100 a run) and queues what moved there.
    It is how Jira's changes arrive at all (Jira has no webhook scheme), and
    a net under missed deliveries. It records the connection's health.
  - _Why, in the tracker._ A task created on approve carries the action's
    description and the decisions that drive it ("Why (decided in
    Lucent): …"). Updates leave a description edited there alone.
  - Found on the way: the live meeting loop's prompt is ~3.5k characters of
    instructions, and the message cap was 4k. A batch with more than about
    500 characters of speech was refused whole, so the busiest stretches of
    a meeting never reached the board. The cap is now 12k, and the prompt is
    shared from `@lucent/ai`.
  - Evidence:
    - core `project-execution.test.ts`;
    - server `project-execution-route.test.ts` and `automation.test.ts` (the
      settings, each rule on and off, busy and covered, the gates, the
      message cap);
    - `scripts/project-execution-check.mjs` (9/9) and
      `scripts/automation-check.mjs` (8/8: a rule turned on in Admin, a
      decision approved in Review, its plan a pending proposal from the job
      runner, the owner told), `scripts/integrations-check.mjs` (6/6) and
      `scripts/inbound-fields-check.mjs` (5/5: a signed tracker webhook
      reassigns and reschedules a synced task; Review asks in words; accepting
      the owner moves only the owner) and `scripts/oauth-connect-check.mjs`
      (5/5, Linear's page intercepted) in the running app;
    - server `integration-health.test.ts`, `inbound-fields.test.ts`,
      `slack.test.ts`, `integration-oauth.test.ts` (against a stub provider)
      and `pg-integrations` (health, the link baseline, sealed credentials).
  - _Slack, outbound (A5.4)._ Connect Slack in Admin with a server variable
    holding an incoming-webhook URL (only https on hooks.slack.com is
    accepted). Checking says hello in the channel. Every written meeting
    summary is posted there: the title linking to the meeting, the first
    lines of each section, the board. A board whose tier keeps content in
    Lucent posts nothing. A webhook Slack refuses (403/404/410) marks the
    connection as needing a new one. Slack is a channel, not a tracker, so
    it never appears as a Sync target.
  - _OAuth connect (A5.4), per ADR 0050._ "Connect with Linear" and
    "Connect with Jira" in Admin, when the server has an app for them and a
    token key.
    - The state is signed and completes only for the owner who started it;
      Linear gets PKCE.
    - Tokens are sealed at rest (AES-256-GCM, bound to their org) and
      refreshed before they expire; a refused refresh needs re-auth.
    - A Jira connection finds its site from the token.
    - Disconnect forgets the token.
  - Not yet: the live run of golden steps 25–31 against real Linear and Jira
    (it needs their OAuth apps or keys); revoking tokens at the provider on
    disconnect.

- **A6 — in progress (2026-09-27).** Enterprise and sharing.

  - _Members._ An owner changes a member's role and removes members from
    Admin; anyone can leave. An org always keeps an owner: the last one
    can't be demoted, removed or leave, and a personal workspace stays its
    owner's.

    Removing someone ends their access at once: the membership, their
    direct grants on the org's boards, and any board they have open (the
    socket is detached with "access removed"). All of it is audited.

    Membership writes go to both stores that keep them (one table in
    Postgres, two in memory, where an invited member used to be missing
    from the list). The Share dialog names members instead of showing ids.

  - _Guests._ Someone outside the workspace can be given a board, and only
    that board. Share by email in the Share dialog: a teammate gets it at
    once; anyone else comes in as a guest. An existing account is granted
    straight away; an address with no account is mailed a link. The answer
    is the same either way, so it never reveals who uses Lucent. A workspace
    that keeps boards inside (or a confidential board) refuses guests.

    A guest finds their boards under "Shared with me" (a new cross-workspace
    list, `GET /api/boards/shared-with-me`) and is marked Guest in the
    Share dialog. They still can't read the workspace: the member list and
    its board list refuse them, and every workspace read is scoped to the
    boards they can open (ADR 0046).

    Admin → Guests lists everyone outside with a board and which boards.
    "End access" removes every grant at once and detaches any open socket.

  - Evidence: server `org-members.test.ts` (3), `guests.test.ts` (4);
    `scripts/guests-check.mjs` (6/6); `scripts/org-members-check.mjs`
    in the running app (6/6, with `LUCENT_DEV_PLAN=team` — a free workspace
    has one seat).

## 12. Decisions (locked 2026-09-24)

| #   | Decision              | Locked answer                                                                                                                                                                                                                         |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Order                 | The visual track leads the next milestone (§11)                                                                                                                                                                                       |
| 2   | Paid vector providers | **Recraft first.** QuiverAI later, only if a benchmark (logo, icon, illustration, diagram-like, text→SVG, image→SVG) justifies it. Vectorizer.AI is not core                                                                          |
| 3   | Projects              | Real first-class objects with identity, objective, members, status, timeline, intelligence, execution state and integrations — not folders                                                                                            |
| 4   | Meetings              | First-class objects; relationships, not ownership: a meeting links to many boards and a project, a board to many meetings                                                                                                             |
| 5   | Meeting extraction    | Capture automatically (transcript, topics, candidate artifacts). Promotion of decisions, requirements, constraints, assumptions, risks and consequential actions into trusted state needs a human. External execution is always gated |
| 6   | Scheduling            | Lightweight native scheduling with email + ICS first; Google/Outlook sync next. Lucent owns meetings, not calendars — no calendar replacement                                                                                         |
| 7   | Semantic types        | Assumption (provisional → confirmed / invalidated) and constraint (active → relaxed / removed) become first-class kinds. Ideas stay notes. Facts become evidence-backed objects later (source, provenance, confidence)                |
| 8   | Storage               | In-memory is development-only. A durable local store (SQLite) for a single-user local product later. PostgreSQL for shared, team and company use                                                                                      |

The resulting foundation is four first-class entities — **Project, Meeting,
Board, Intelligence** — related, not nested, with Execution hanging off
intelligence.

The `VectorProvider` seam (§6.3) therefore ships as
`Local` (importer, icons, tracing) · `FreeFallback` (the configured LLM authors
structured paths) · `Recraft` · `QuiverAI` (later, after the benchmark).

## 13. Risks

- **Scope.** The spec is 41 areas. The golden flow is the spine; anything that
  doesn't move a golden step waits.
- **Production migrations.** J1 and J2 change stored shapes on the live
  Postgres (main auto-deploys). Every migration ships with a backfill and a
  reversible path, and lands on a branch deploy first.
- **Third-party data egress.** Vector and STT providers see prompts, images or
  audio. Provider policy and classification must gate every call (F2 shows the
  current gap).
- **Cost.** Paid vector APIs are per-call; meter them and cap per plan.
- **Generated SVG quality.** The LLM baseline is a fallback; the product
  promise rests on the dedicated vector models or on import/vectorize.
- **Trademarks.** Brand marks identify products, never imply endorsement.
