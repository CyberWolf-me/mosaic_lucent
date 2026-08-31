# Lucent — Definition of Done

> **Status legend.** `[x]` verified working in the current codebase.
> `[~]` partially implemented — the gap is stated inline. `[ ]` not built.
> Audited against the code, not intent. Collaboration (Phase 2) is deliberately
> deferred: nothing multiplayer exists yet, and this file says so rather than
> pretending otherwise.

## 🟢 Phase 1 — Core Product

### Infinite Canvas

- [x] Infinite 2D canvas
- [x] Pan
- [x] Zoom in/out
- [x] Zoom-to-fit
- [x] Smooth canvas performance
- [x] Minimap — labelled "Overview", dismissible; no viewport rect / click-to-pan yet
- [x] Grid/dot background — dots / lines / off, all applied
- [x] Multi-select
- [x] Drag and drop
- [x] Copy/paste
- [x] Undo/redo — engine plus ⌘/Ctrl+Z, ⌘⇧Z, Ctrl+Y
- [x] Snap/alignment
- [x] Grouping
- [x] Frames/sections
- [x] Lock/unlock
- [x] Hide/show — hide, plus "Show hidden (n)" to bring them back
- [x] Layers/z-order

### Basic Objects

- [x] Select/move tool
- [x] Text objects
- [x] Rich text — bold, three sizes, alignment, colour (per-shape, not per-range)
- [x] Sticky notes
- [x] Rectangle
- [x] Rounded rectangle — via the corner-radius control
- [x] Circle/ellipse
- [x] Triangle
- [x] Diamond
- [x] Arrow
- [x] Connectors — straight / elbow / curved, live re-routing, labels
- [x] Pen/freehand drawing
- [x] Eraser
- [x] Images
- [~] File objects — dropped files become a named chip; file bytes are not stored

### Board Reliability

- [x] Autosave
- [x] Board persistence
- [x] Reloading a board restores state
- [x] No accidental object loss
- [x] Undo/redo survives normal editing
- [ ] Large boards remain usable — **corrected 2026-08.** This was previously
      marked `[x]` on the strength of the z-order/layout work, but an audit found no
      virtualization or culling anywhere: `CanvasView` renders every shape and node
      on every frame, and there is no 1k-object fixture or perf budget test. Untested
      at scale, so it can't be claimed.
- [x] Errors are surfaced clearly — messages name the layer that failed

---

## 🟢 Phase 2 — Collaboration

**Multiplayer is server-authoritative and live, and now wired into the app.** A
`Room` holds an append-only, validated operation log; the server sequences every
commit, rejects operations the author's role can't perform, and broadcasts each
sequenced entry over a `ws` socket. Clients (`BoardSync`) join, catch up from
their last-seen sequence, and dedupe by sequence number, so late joiners and
reconnects converge on the same board. Presence (cursors, names, selection)
rides the same socket. This is not a CRDT — the validator stays authoritative,
which matches the operation-based architecture and lets the log double as
workspace memory. Async collaboration (comments, replies, mentions, reactions)
continues to work as model operations that persist, undo, and are AI-readable.

> **Correction (2026-08).** These boxes were previously ticked while the client
> was not connected: `BoardSync` was never instantiated outside its own test, so
> two users of the shipped app could not see each other. The earlier "verified
> end-to-end with two live clients" exercised the server directly, not the app's
> path. That is now fixed — `Share → Publish & start collaborating` creates a
> server board (`POST /api/boards`), joins its room, applies broadcasts, and
> sends local commits; a `?board=<id>` link drops an invitee into the same room.
> Re-verified with two real accounts over REST + WebSocket: owner/viewer roles
> assigned, an op broadcast at seq 1, a viewer's edit refused with `permission`,
> presence cursor propagated, and the server board reflecting the edit.

### Multiplayer

- [x] Multiple users can open the same board — publish via Share, or open a `?board=<id>` link; joins a room by `boardId` and catches up from the log
- [x] Real-time object updates — sequenced commits broadcast to every peer
- [x] Live cursors — presence frames over the same socket
- [x] Cursor names — peers carry display name and a stable per-user colour
- [x] Presence indicators — avatar stack (`PresenceBar`) shows who is in the room
- [x] Selection indicators — selection travels in the presence frame
- [x] Simultaneous editing works — concurrent commits serialize through the room log
- [x] Conflict handling — server total-orders operations by sequence; clients dedupe and replay
- [x] Multiplayer undo behavior is predictable — `OperationHistory` is wired into `packages/web/src/workspace.tsx:12`; the inverse-operation log is what every undo/redo commits, the legacy snapshot `History` is no longer imported by the app

### Collaboration

- [x] Comments — threads anchored to any node or shape, with pins on the board
- [x] Reply to comments — one level of replies per thread
- [x] @mentions — parsed from the body, highlighted, and collected into a feed
- [x] Resolve comments — resolve and reopen; resolved threads drop out of counts
- [x] Reactions — emoji reactions work today; single-user until presence exists
- [x] Basic notifications — a mentions feed listing open threads that name someone
- [~] Share board — real auth-gated boards exist (owner creates, others join by id); the share dialog copies the board URL, but there is no API to promote a joiner from viewer to editor yet
- [~] Board permissions — roles are enforced server-side (owner/editor/viewer; non-owners join as viewer and viewer commits are rejected), but there is no share/role-grant endpoint to change a user's role

---

## 🟢 Phase 3 — AI Foundation

### AI Input

- [x] Text prompt
- [x] Voice input — browser speech API or on-device Whisper
- [x] Image input — a selected image travels with the request as a vision
      attachment (OpenAI-compatible and Anthropic content blocks)
- [x] Document input — PDF, Markdown, and text files import onto the board, and a
      selected long note travels with the request as document context

### AI → Canvas

- [x] AI can create objects
- [x] AI can create sticky notes
- [x] AI can create shapes
- [x] AI can create connectors
- [x] AI can create text
- [x] AI can position objects intelligently — layout engine for nodes, grid guidance for shapes
- [x] AI can modify existing objects
- [x] AI can delete objects
- [x] AI can move objects — shapes only; node coordinates stay human-only by design
- [x] AI can group objects

### Natural-Language Editing

- [x] "Move this to the right"
- [x] "Group these"
- [x] "Make this simpler"
- [x] "Change this into cards"
- [x] "Connect these"
- [x] "Delete this section"
- [x] "Add three more ideas"
- [x] AI understands what "this", "these", and "that" refer to — selection plus recent turns

### Critical Requirement

- [x] AI modifies the existing board instead of blindly regenerating it

The operation contract is generated from one Zod schema, so every operation the
validator accepts is advertised to the model and vice versa. Batches over five
operations on a non-empty board surface as a reviewable diff.

---

## 🟢 Phase 4 — Board Intelligence

### Board Understanding

- [x] AI understands the entire board — nodes, edges, groups, shapes, connectors, wireframes
- [x] Objects have semantic relationships
- [x] Board context is available to AI
- [x] AI can identify sections — groups and frames are in the context
- [x] AI can identify diagrams
- [x] AI can understand relationships between objects
- [x] AI can answer questions about the board
- [x] AI can read workshop results — vote tallies and reaction counts are in the context

### AI Understanding Commands

- [x] "Explain this architecture"
- [x] "What are the bottlenecks?"
- [x] "What's missing?"
- [x] "Summarize this board"
- [x] "Group these ideas"
- [x] "Find duplicate ideas"

---

## 🟢 Phase 5 — Lucent's Killer Workflow

### Voice → Canvas

- [x] User clicks microphone
- [x] User speaks naturally
- [x] Speech is transcribed
- [x] Lucent understands intent
- [x] AI understands current board context
- [x] AI modifies the board
- [x] Changes appear naturally on the canvas
- [x] User can continue speaking
- [~] AI can ask clarification questions — it can answer in prose, but there is no
  turn-taking clarification loop

### Example

- [x] User: "Create an e-commerce architecture."
- [x] Lucent creates architecture
- [x] User: "Separate payments from checkout."
- [x] Lucent modifies the existing architecture
- [x] User: "Move Stripe underneath payments."
- [x] Lucent moves the correct object

### Text → Canvas

- [x] Same workflow works through text
- [x] Text and voice have equivalent capabilities — both call the same pipeline

---

## 🟢 Phase 6 — Visual Intelligence

### Diagramming

- [x] Flowcharts
- [x] User flows
- [x] System architecture
- [x] Sequence diagrams
- [x] ER diagrams
- [x] Mind maps — radial layout, not a relabelled stack
- [x] Decision trees — tidy-tree layout: siblings side by side, parent centred over them
- [x] Process maps — swimlane layout, one lane per group, flow left to right
- [x] Organizational charts — same tree layout; reporting lines stack by level

### Transformations

- [x] Board → diagram
- [x] Board → mind map
- [x] Board → wireframe
- [x] Board → document
- [~] Board → presentation — a guided walkthrough mode, not a generated deck

---

## 🟢 Phase 7 — Media & Generation

### Media

- [x] Image upload — paste or drag onto the canvas
- [x] Drag/drop images
- [x] Paste screenshots
- [x] GIFs
- [x] Videos — YouTube / Vimeo embeds
- [~] PDFs — accepted as a named chip; not rendered
- [~] Documents — same
- [x] Web links
- [x] Embeds

### AI Generation

- [x] Generate images — a real OpenAI-compatible image backend behind the same
      interface; falls back to a placeholder generator when unconfigured
- [x] Generate illustrations — same path
- [x] Generate visual concepts — same path
- [x] Improve/polish diagrams — a Polish action asks the AI to review the board and
      fix labels, fill gaps, drop duplicates, and group related nodes
- [x] Place generated visuals directly on canvas

---

## 🟢 Phase 8 — Professional Whiteboard Features

- [x] Templates
- [x] Voting — model-backed rounds: start/stop, click to vote, live tally, reset
- [x] Timer
- [x] Presentation mode
- [x] Search — views plus board content (nodes and shape text)
- [x] Outline — the document view
- [x] Embeds
- [x] Reactions — emoji reactions on nodes and shapes, counts shown on the board
- [x] Advanced comments — board-wide inbox with open/resolved/all filters,
      threaded replies, mention highlighting, and a mentions feed
- [x] Basic integrations — Mermaid export, clipboard copy, and paste-to-import, so
      a board round-trips with GitHub, GitLab, and Notion

### Sketch Mode

- [x] Clean mode
- [x] Sketch mode
- [~] Hand-drawn shapes — a CSS skin (wobbly radii, handwriting font), not rough geometry
- [~] Hand-drawn arrows — round caps only
- [x] Handwritten-style text
- [~] Rough connectors — geometry is unchanged

---

## 🟢 Phase 9 — Import / Export

### Export

- [x] PNG
- [x] SVG
- [x] PDF — via the print dialog
- [x] JSON
- [x] Markdown
- [x] CSV

Images, embeds, and file chips now appear in SVG/PNG/PDF, and long sticky text
wraps instead of overflowing.

### Import

- [x] Images — drop or paste onto the canvas
- [x] PDF — text extracted from content streams into sticky notes; a compressed
      or scanned PDF says so instead of importing an empty board
- [x] SVG — becomes editable rect/ellipse/text/path shapes, not an embedded image
- [x] JSON
- [x] CSV
- [x] Screenshots
- [x] Documents — Markdown and plain text become a grid of notes

---

# 🔥 FINAL "LUCENT IS DONE" TEST

- [x] Create a board
- [x] Start with a blank canvas
- [x] Say what they want to build
- [x] Lucent understands them
- [x] Lucent creates the initial visual
- [x] User manually edits it
- [x] User asks Lucent to modify it
- [x] Lucent understands the existing canvas
- [x] Lucent changes only what is necessary
- [x] User can continue iterating through voice/text
- [x] Multiple people can collaborate — publish from Share, send the `?board=<id>` link; live cursors and role-gated editing over the WebSocket log
- [x] Everything saves reliably
- [x] The board can be exported
- [~] The experience feels faster than manually building the same thing — true for
  creating a diagram from scratch; a 20–35s model round trip still dominates
  small edits

# ⭐ The Ultimate Test

Give Lucent to someone who has never seen it.

> **"Build an architecture for an e-commerce application."**

> **"Move payments into its own service, add Stripe, and make checkout call the payment service."**

- [x] Lucent modifies the existing board without the user touching the canvas

Verified against the live provider: the model edits the board it is shown rather
than regenerating it, and can now emit sticky notes and shapes as well as nodes.

# 🚦Launch Criteria

## MVP / Private Beta

- [~] Phase 1 complete — everything except full file-object storage
- [x] Basic collaboration works — the app itself publishes a board, joins its room, and syncs; verified with two real accounts over the same REST + WebSocket path the client uses
- [x] Text → Canvas works
- [x] Voice → Canvas works
- [x] Semantic board editing works
- [x] Autosave is reliable
- [x] No critical data-loss bugs
- [~] Core UX feels polished — the meeting view is still a mockup

## Public Launch

- [ ] Everything above
- [x] Strong diagramming — nine types: flowchart, user flow, architecture,
      sequence, ER, mind map, decision tree, process map, org chart
- [x] Templates
- [x] Presentation mode
- [x] Import/export — export covers PNG/SVG/PDF/JSON/Markdown/CSV/Mermaid; import
      covers JSON, CSV, SVG, PDF, Markdown, text, and images (a scanned PDF is
      reported honestly rather than imported empty)
- [~] Comments/reactions — comments, replies, mentions, resolution, and reactions
  all work and now propagate to peers over the room log; they persist, undo, and
  are AI-readable
- [~] Production-grade multiplayer — live rooms, presence, and role enforcement
  work and are e2e-verified, and the store is now **Postgres-backed** when
  `LUCENT_DATABASE_URL` is set: accounts, boards, and the per-board operation
  log survive a restart, so a rejoining client's catchup is rebuilt from
  `op_log` rather than an empty in-process array. The web client now undoes
  via the inverse-operation `OperationHistory` rather than the snapshot
  `History`. Still missing: a share/role-grant endpoint (invitees are
  hard-coded `viewer`) and sticky sessions for multi-process deploys
  (presence and the hot `Room` are per-process)
- [x] AI reliability is high — transient gateway failures are retried
- [~] AI latency feels acceptable — 20–35s on the current model
- [ ] Large boards perform well — **corrected 2026-08.** No virtualization or
      culling exists; every object renders every frame, and there is no perf budget
      test or large-board fixture. Previously ticked without measurement.
- [~] Onboarding is clear
- [x] Billing/usage limits are implemented — per-client sliding-window rate limit
      plus a daily quota, with 429 + Retry-After and env-tunable limits
- [x] Analytics/error monitoring are implemented — request counts, latency
      percentiles, refusals, and a recent-error buffer on `/metrics`, kept local so
      board content never leaves the process

**Before public deployment:** `/api/generate` and `/api/image` are rate limited
and quota'd, and authentication now exists — signup/login issue HMAC-signed
session tokens, and setting `LUCENT_REQUIRE_AUTH` makes every generate/board/ws
call require a valid bearer token. Ship with that flag on so no one can reach the
port and spend your provider budget. Durable storage for users, boards, and the
operation log now exists via Postgres (`LUCENT_DATABASE_URL`); set
`LUCENT_SESSION_SECRET` too, or every restart invalidates every outstanding
token. Two gaps remain before a real deployment: **object storage for assets**
(S3 — image uploads have no durable home) and **sticky sessions** if you run
more than one server process.

## "This Is Actually Great"

- [x] AI understands the entire board
- [x] Voice interaction feels natural
- [x] AI edits rather than regenerates
- [x] Board → multiple artifacts works
- [~] AI-generated visuals are useful — a real image backend is wired and returns
  self-contained images; whether the output is _useful_ depends on the model you
  point it at, and that is a judgement no code change settles
- [~] Users prefer explaining ideas over manually drawing them
- [~] Lucent feels fundamentally different from Miro/FigJam — the semantic canvas
  is real and load-bearing; collaboration parity is not there yet

---

## Audit update (2026-08, later session)

Follow-ups against the phased plan (C2 billing, B2 OAuth, D reliability, E2 AI
hardening, H cross-cutting), each verified in code and tests:

- [x] **C2 Stripe finish line.** The webhook receiver, checkout and portal
      routes are wired (`app.ts` `/api/billing/*`; `pg-stripe-events.ts` fixed to
      the real `Db` handle) and the whole billing path is covered by tests for
      the first time: signature verification incl. rotation and replay windows,
      the claim/dupe/in-flight ledger contract over both in-memory and Postgres
      stores, lifecycle handlers (org resolution order, price→plan mapping,
      seat floors, sink isolation), the retry sweep, checkout/portal service,
      and the HTTP routes themselves (503/CSRF/owner-gating, session minting).
- [x] **B2 OAuth (Google + GitHub).** `oauth.ts` + `/api/auth/oauth/:provider/
start|callback`; linking is by **verified email only** (ADR 0008); OAuth
      accounts carry an unusable password hash; the state parameter is
      HMAC-signed _and_ mirrored in a short-lived cookie so a replayed callback
      fails before any network call; both user stores keep identities; the csrf
      response advertises configured providers and `AuthView` renders a button
      per configured provider (unconfigured ⇒ no button). 13 tests.
- [x] **D: durable allocator wired for real.** `Room.commit` was still counting
      `log.length + 1` locally — the allocator/fetcher options existed but were
      never called, and `RealtimeServer` persisted _after_ a local-seq commit.
      Commit is now async, queued, and routed through the store's `appendOp`
      with `expectedSeq`; on conflict the room absorbs the winner's entries via
      the fetcher, re-validates against the merged state, and retries once.
      The fanout receiving half now exists (`pullRemote` + per-board bus
      subscriptions serving both `op` and `resync`), which was previously
      publish-only. New two-instance e2e test proves racing commits converge
      with unique seqs (`test/two-instance.test.ts`).
- [x] **D3: missing k6 profiles.** `boards-1k.js` (seed + read paths over 1k
      boards across plan-gated orgs) and `cold-open-5k.js` (cold open of a
      5,000-node board vs a small baseline) — both referenced by
      `packages/load` scripts and previously absent.
- [x] **E2: bounded repair round.** A batch that fails validation is re-asked
      once with its own output and the validator's complaints (clamped to the
      message cap); the corrected batch takes the same filter/stamp/validate
      path; provider failure inside the round stays a 422, not a 502; metering
      sums both calls (ADR 0011; `test/generate-repair.test.ts`).
- [x] **E2: response cache + eval golden set.** `packages/ai/src/cache.ts`
      (LRU+TTL keyed on prompt identity and request, attachment-bearing
      requests uncacheable — ADR 0012) and `packages/ai/src/evals.ts` +
      `golden.ts` (subset-matching golden cases, runner, `npm run evals`
      CLI). The offline gate: `MockProvider` must score 1.0 on the golden set
      (`test/harness-cache.test.ts`).
- [x] **Defect #11** — server tests are typechecked again
      (`tsconfig.test.json`; `typecheck` runs over `src` + `test`), which
      surfaced and fixed 16 latent type errors in seven test files that had
      drifted from the src types (op-log `seq`, `GenerateRequest.message`,
      `StoredUser` fields, `AppHandle.base`, `migrate` import path).
- [x] **Defect #12** — drizzle-orm bumped 0.38.4 → 0.45.2 (both pins moved
      together per the recipe in `ci.yml`); install, typecheck, and the
      non-Postgres suites are green, so the audit job in CI should go green.
- [x] **H: lint gate green.** `npm run lint` was red across ~68 pre-existing
      and new-file problems; all fixed (unused imports/vars, type-only imports,
      control-regex disables with written justification where the regex _is_ the
      validation), and prettier formatting applied repo-wide.
- [x] **H: ADRs 0007–0012** written for the decisions the code had made
      without a record: Stripe idempotency ledger, OAuth linking policy,
      durable seq allocation, snapshots-over-log, bounded repair round, and
      the prompt-identity response cache.
- [x] **E1 streaming (M5)** — providers stream natively (OpenAI-compatible
      tool-call/prose lanes, Anthropic `input_json_delta`), the shared pipeline
      powers both the JSON route and `POST /api/generate/stream` (SSE;
      deltas are display-only, the `done` frame is the only applicable one),
      and the model router adds opt-in BYO keys (`LUCENT_ALLOW_BYO_KEYS=1`).
      The web client streams via `streamGenerate` with an activity-based
      timeout and a live receipt indicator.
- [x] **F1 SCIM 2.0 gateway (M6)** — `/scim/v2/Users` create/list/PUT/PATCH
      (deactivate = `tokenVersion` bump) and idempotent DELETE, single bearer
      token (raw or HMAC digest, timing-safe compare, fail-closed 404 when
      unconfigured), JIT-provisioned users get random unguessable passwords
      and verified emails; `scim_identities` maps `(idp, external_id) → user`
      (migration 0013, Postgres + in-memory stores, conformance tests).
- [x] **Asset gateway (M7/M4)** — `POST /api/assets` (auth + CSRF + org role +
      byte cap) and fetch/thumb/delete; bytes in the body, disk or S3 blob
      backend behind `AssetService`, in-memory store for v1 with the Postgres
      table provisioned.
- [x] **Org analytics (M7)** — owner-gated `/api/analytics/:orgId/trend` over
      the same rollups the entitlement gate reads, plus an `AnalyticsView`
      wired into the app chrome; the dashboard cannot disagree with the paywall.
- [x] **Reliability docs (M6)** — `docs/reliability/slo.md` (tiered SLOs with
      measurements from the metrics already emitted) and oncall/upgrade
      runbooks.
- [x] **Migration journal repaired** — duplicate idx 12 removed, the
      `0014_should_be_noop` marker given its (empty) SQL file so the journal
      never names a migration that is not on disk; drizzle snapshots now exist
      for 0012 and 0013.

Still open, deliberately: SSE-side LiveKit transcription and MCP over HTTP
(E3, server-side), SAML/SSO sign-in on top of the SCIM gateway, Helm/Terraform
packaging, and the growth-surface items (marketing site, i18n, command
palette, mobile views).

## Remaining, deliberately deferred (2026-08-30)

Everything this pass committed to is built and tested. Three items remain
open with reasons, so the next person inherits a decision rather than a
mystery:

- **Terraform (`terraform/lucent-aws/`)** — the Helm chart covers the
  deployable surface; Terraform would duplicate it for one cloud. Revisit
  when a second cloud or a managed-database provisioning story exists.
- **Offline licence check** — a licence gate needs product decisions first
  (what does it gate? who signs? what does an expiry do to a running
  deployment?). Those are sales-conversation questions, not code.
- **Per-org retention, legal hold, `LUCENT_REGION`, DPA/subprocessor at
  `/legal/`** — retention exists on the op log (the sweep); generalising it
  per-org and the legal artifacts need counsel input. The deletion cascade
  (org → boards → op log) is tested; extending it to snapshots and object
  storage is the documented next step when retention ships.

What this pass DID land (so nobody re-audits it from scratch): MCP-to-real-
boards (`POST /api/boards/:id/ops` + `RemoteBoardSession`, 11 tests),
LiveKit token minting (`POST /api/livekit/token`, 7 tests), the meeting
transcript vertical (migration 0015, stores, routes, live capture in
MeetingView, 15 tests), SAML SSO (ADR 0013, migration 0016, `saml.ts`
verification with signature-wrapping defense, admin + ACS routes, 16 tests
against a mock IdP), audit CSV export + keyset pagination (3 tests), mobile
present mode, the changesets release workflow, the public status page, site
SEO, and the i18n package with Hungarian.

## Diagram regions — multiple kinds on one board (2026-08-31)

Landed, tested end to end: a `Group` with a `kind` is a _diagram region_ — its
members lay out under that kind's strategy while the rest of the board keeps
its board-wide kind. One board can now hold the checkout flowchart AND the
pricing mind map AND the team org chart, and each is individually editable by
text or voice ("change the pricing section to an org chart" → `SET_GROUP_KIND`,
only that region moves).

- [x] Core: `Group.kind?`, `SET_GROUP_KIND` op (null dissolves), reducer,
      inverse (undo restores the prior kind, delete+undo restores the kind),
      validator, workspace schema — 7 tests; tool-schema drift guard picked the
      new op up automatically.
- [x] Layout: region partition → per-region sub-workspace under its own
      strategy → packed band with gutters; pinned nodes keep hand-placed
      coordinates; explicit `strategy` suspends the split — 8 tests, all 29
      pre-region core tests byte-identical (308 total).
- [x] AI: summary carries each group's kind, prompt v3 teaches region
      targeting (add-kind-don't-transform, SET_GROUP_KIND, TRANSFORM is
      whole-board), mock scripts for both flows, golden cases
      `region-adds-second-kind` + `region-retarget-changes-one-region` — gate
      1.00.
- [x] Web: region boxes labelled with their kind, right-click kind picker on a
      region's members (same op, same undo), SVG/PNG/PDF exports draw labelled
      region boxes, proposal previews render regions under their own strategy —
      3 board tests (497 web total).
- [x] Server: summary schema accepts the kind, the validation rebuild carries
      it so SET_GROUP_KIND validates against a real region; a flip on a
      missing group still 422s — 3 generate tests.
- [x] Docs: ADR 0014, data-model section in docs/03, this entry.

Not built, deliberately: cross-region edges are allowed by the validator (a
region is a lens, not a wall — linking the pricing mind map to the checkout
flow is a legitimate "these relate" statement) but render across the region
band; a dedicated cross-region edge style is a design question, not a gap.

## Milestone 2: trustworthy canvas + live meeting boards (2026-08-31, ADR 0015)

The "connectors midway/disconnected" report ended in two milestones. M1
(found live, fixed, gated): the 320px dash CSS bug that drew long edges as
paint-gap-paint, partial application replacing the all-or-nothing 422,
repair-round starvation, output-token ceilings, and the 90s provider
timeout that was the real big-generation killer. M2 (this pass):

- [x] Spatial additivity as a hard invariant: commit() relayouts only the
      touched group; separateRegions pushes just the overlapped neighbours.
      Live gate: 22 topic-A nodes pixel-identical through topic-B's
      extraction; journey nodes placed additively to the right.
- [x] Differential meeting loop in MeetingView: hybrid trigger
      (configurable thresholds), additive auto-apply, review gate for
      destructive/oversized batches, differential prompt that
      updates-not-duplicates and marks casual suggestions as proposals.
- [x] Speaker identity through the STT seam (LiveKit participant identity;
      browser provider segment mode), provenance metadata on extracted
      nodes with a HUD ✦ quote, transcript checkpoint appends
      (POST /:mid/turns) + save-on-stop.
- [x] Live topic-switch gate: returning to Pricing UPDATED the existing
      region (5→7 members, exactly one region, no duplicate) — the
      review's hardest meeting scenario.

Not built (recorded in ADR 0015): obstacle routing for long connectors,
ELK/dagre, diarisation beyond LiveKit segments.

## Strategy notes from the 2026-08 advisory pass (docs updated, no code)

The post-milestone review added market and product-direction input. Taken as
notes into the docs — no behavior changed:

- **Competitive landscape re-audited** (docs/01): Miro (AI Innovation
  Workspace + Talktrack), FigJam AI, Wavelength (voice→process diagram),
  SayCanvas (voice-first workspace, early access), VoxeNova
  (meeting-intelligence), plus education-side convergence. Conclusion:
  "AI can make a diagram" is no longer the product; the defensible pitch
  is "Lucent is a visual workspace that understands conversations," and
  the moat is persistent, traceable team memory + conversation
  understanding — not voice input.
- **Statement kinds documented as the trust foundation** (docs/05):
  fact/proposal/question/opinion/decision/rejection/action/constraint/
  risk, conversation evolution (corrections supersede), and the
  visualize filter (novel + material + asserted) — "maybe we could…"
  must never become a decided date. Status: carried by prompt today;
  structured data is the "Now" roadmap item.
- **Meeting artifacts + lenses designed** (docs/05): the meeting produces
  Decisions / Open Questions / Actions / Risks panels (all provenance-
  traceable), and lenses (Brainstorm/Decision/Product/Engineering/
  Execution; "what changed since last week") re-project the same model.
  Not built; designed.
- **CEO roadmap re-ordered** (docs/14): Now = trustworthy intelligence
  (proposal persistence + statement kinds as data + conversation
  evolution); Next = meeting-intelligence reliability measured against a
  scripted messy-meeting benchmark with concrete metrics (extraction
  precision/recall, contradictions resolved, duplicates, provenance
  coverage, readability); Then = M3 readability; Then = meeting →
  execution. The spine: "How much complexity can Lucent remove?", not
  "how much can it create?"
- **Milestone 3 planned** (docs/15): selection focus → connector visibility
  tiers → region collapse, then STOP and measure at 20/40/80/150 nodes
  against the real benchmark board. No engine rewrites; ELK/routing only
  on a measured 150-node failure. Also recorded: proposal persistence
  fix and the future AI-ownership (`layout.mode`) hook.
