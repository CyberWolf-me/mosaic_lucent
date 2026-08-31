# 14. Product Vision — Mosaic / Lucent

> **Mosaic** is the company. **Lucent** is the product. (Lattice = the separate
> system-understanding product referenced in §26.) Earlier drafts wrote "Lucem";
> that is a typo for Lucent.

This document records the full product vision (from the product overview) and
maps it against what the codebase implements today, so the roadmap reflects
reality rather than restating the pitch.

## Thesis (sharpened 2026-08 against the real market)

Not "Miro with AI." **Lucent turns messy human conversation into a shared,
evolving model of what the team is thinking, deciding, and building.**

    Human → voice/text → AI understands → canvas creates → human directs

The canvas is the visual surface. Voice is the input. AI is the interpreter.
The persistent workspace is the memory.

Three framing shifts this forces, post-competitive-audit (docs/01 has the
full landscape — Miro Talktrack, FigJam AI, Wavelength, SayCanvas, VoxeNova):

1. **"AI can make a diagram" is not the product.** Miro and FigJam both have
   it. The product is _conversation understanding_ — facts vs proposals vs
   decisions vs rejections — plus a workspace that remembers how thinking
   evolved and can prove where every AI-generated object came from.
2. **Don't think "generate a diagram every 45 seconds." Think "maintain a
   continuously evolving visual model of the conversation."** The differential
   loop (M2) is the mechanism; the mental model is maintenance, not batch jobs.
3. **The ultimate measure is not "how much can Lucent create?" but "how much
   complexity can Lucent remove?"** The failure mode of an AI canvas is not
   missing features — it is _producing information faster than a human can
   make sense of it_. Readability (M3) is a first-class product concern.

## The bet we already won

The overview's sections 18–19 ("AI edits the board **semantically**, from a
**Board Graph**, not by regenerating") and 22 ("one idea → many artifacts") are
the single most important design idea — and they are the architecture we already
built: `@lucent/core` is a semantic model mutated by validated operations, with
one model rendering to flowchart / architecture / mind map / journey / wireframe.
So natural-language semantic editing, transforms, and "modify don't regenerate"
are working today, not aspirational.

Two more bets landed since (M1/M2, ADR 0015), both verified live:

- **The canvas is trustworthy.** Connectors render fully at any length (the
  320px dash bug was the "disconnected midway" culprit, not the AI); one
  invalid operation costs itself, not the whole generation; large generations
  complete within the pipeline's real time budget.
- **The canvas is stable.** AI additions are spatially additive: a batch that
  touches one region relayouts only that region, at its origin. 22-node
  topic-A held pixel-identical through topic-B's live extraction; returning
  to Pricing updated it (5→7 members) instead of creating "Pricing #2".

## Status map (vision → implementation)

> **Re-audited 2026-08 against the code.** The table below was pessimistic by a
> wide margin — roughly a dozen rows marked ❌/🟡/⛔ have since shipped. Updated
> in place; `checklist.md` remains the finest-grained source of truth.

Legend: ✅ done · 🟡 partial · ❌ not started · ⛔ deferred (needs backend)

**Tier 1 — Core board**

- ✅ Infinite canvas, pan/zoom, zoom-to-fit (+ fit-to-selection)
- ✅ Select, multi-select, marquee (shapes _and_ nodes), drag, snapping with alignment guides
- ✅ Text, sticky notes, drawing (pen), eraser, images (paste + drop), embeds
- ✅ Shapes — rect/ellipse/diamond/triangle/star/text/sticky/frame; rounded via the corner-radius control. Polygon/custom still missing
- ✅ Connectors — bound links with straight/elbow/curved variants and optional double arrow; node edges carry labelled relationship verbs
- ✅ Frames/sections (drag-together), z-order, duplicate (incl. Alt-drag), lock, hide/show, align + distribute
- ✅ Undo/redo; export SVG/PNG/PDF/JSON/Markdown/CSV/Mermaid
- ✅ Multiplayer — live cursors, presence, live editing, role-gated commits over a sequenced server operation log. 🟡 multiplayer _undo_ still uses snapshot history
- ✅ Comments (threads, replies, @mentions, resolve, inbox) and reactions

**Tier 2 — Whiteboard parity**

- ✅ Diagramming — nine kinds: flowchart/architecture/mindmap/journey/decision-tree/process/org-chart, plus derived sequence and ER
- ✅ Presentation mode (guided walkthrough + spotlight), focus mode
- 🟡 Mind maps (kind + radial layout exist; no dedicated expand/collapse ops)
- ✅ Templates (nine, as operation batches), voting, timer, reactions, search (views + board content), minimap (with viewport rect + click-to-pan), outline (Document view), embeds, integrations (Mermaid round-trip)
- ✅ Work tracking — Jira-style issues on nodes (epic/story/task/subtask/bug, status, assignee, points) with a Kanban board view. _Not in the original vision; added 2026-08._

**Tier 3 — Differentiation (our focus)**

- ✅ Voice → canvas (Web Speech, on-device Whisper, LiveKit), Text → canvas
- ✅ Board → diagram, Board → wireframe, Board → presentation, Board → document
- ✅ Natural-language editing, semantic board understanding
- ✅ Image → canvas (vision attachments), AI-generated visuals (image model → `image` shape)
- ✅ Code/IaC → diagram (docker-compose, package.json). _Not in the original vision._
- ✅ Agent access via MCP (`packages/mcp`) — an external agent drives the board through the same validated operation contract. _Not in the original vision._
- 🟡 AI collaborative agent — conversation history is sent (8 turns), but there is no clarifying-question turn-taking loop
- ❌ Workspace memory as specced in docs/04 (goals, requirements, decisions, knowledge). Reference resolution is a context window, not memory — this is now the least-built moat
- ✅ **Rendering + operation reliability (M1)** — connectors draw fully at any length (pathLength normalization; the 320px dash bug was the "disconnected midway" report, not the AI); partial application applies the valid majority and reports the skips with a one-click "Fix these"; large generations fit the real token/time budget. _Live-gated: 40 nodes / 72 edges / 7 groups, 74/74 connectors solid, longest 1,922px._
- ✅ **Diagram regions** — multiple diagram kinds coexist on one board (ADR 0014), each region editable by text or voice
- ✅ **Spatial additivity (M2, ADR 0015)** — AI additions never rearrange committed work: a scoped batch relayouts only its region at its origin; growth overlaps push only the neighbours actually overlapped. _Live-gated: 22 nodes pixel-identical through a second topic's extraction._
- 🟡 **Live meeting loop (M2)** — differential extraction while recording (hybrid trigger, additive auto-apply, review gate for destructive ops, differential prompt that updates-not-duplicates and marks suggestions as proposals). The loop and policies ship; statement-kind classification (fact/proposal/decision/rejection — docs/05) is carried by prompt instruction only, not yet a structured field, and the Decisions/Questions/Actions/Risks panels are the next step
- 🟡 **Provenance (M2)** — meeting-extracted nodes carry their meeting id + quoted turns; the HUD ✦ shows the quote. Not yet: "jump to transcript" deep link, per-object createdAt/createdBy beyond meetings
- ❌ **Meeting lenses** — same model, re-projected (Brainstorm/Decision/Product/Engineering/Execution; "show me only what changed since last week"). Designed in docs/05; nothing built

## Strategic decisions this document forces

1. **Multiplayer + comments are Tier 1 in the vision but deferred in the build.**
   **Resolved 2026-08.** Both shipped. The sync layer is a server-authoritative
   sequenced operation log rather than the CRDT this doc and docs/06 assumed —
   the validator stays authoritative, which matches the operation architecture
   (see the reasoning in `packages/server/src/room.ts`). Remote modes
   (Follow/Spotlight) remain unbuilt; `focusOn` is the extension point.

2. **Templates (§9) from day one.** **Done** — nine templates ship as saved
   operation batches, exactly as this paragraph proposed (`web/src/templates.ts`).

3. **AI image generation (§7) vs. the "never generate static images" rule.**
   These are reconcilable, not contradictory: **diagrams stay semantic** (never a
   picture); **generated visuals are a distinct object type** — the same `image`
   shape we already have, produced by an image model. Keep the rule for diagrams;
   allow generated images as first-class _media objects_. Needs an image model +
   key; treat as its own object, never as a diagram renderer.
   **Done 2026-08** as described (`ai/src/image.ts`, `POST /api/image`).

4. **Excalidraw "Sketch" mode (§23)** is a global Clean/Sketch toggle (rough
   strokes, hand-drawn shapes, sketch connectors). It's a rendering theme over the
   existing model — achievable without model changes, mostly CSS/SVG filters +
   a font. Good, cheap differentiation.
   **Done 2026-08** as a CSS skin; geometry is unchanged, so strokes are not
   actually rough — a `[~]` in the checklist.

5. **Lattice integration (§26)** is company-strategy, far future; note and defer.

## Recommended near-term order (re-ordered 2026-08 post-M1/M2; items 1–6 of the previous order have shipped)

> The previous order (manual objects, templates, sketch mode, persistent agent,
> collaboration, image I/O) is **done**. What follows is the CEO-order roadmap
> given where the product actually is. Its spine is one brutally clear product
> experiment: **can Lucent turn a 30-minute messy product meeting into a
> useful, trustworthy workspace without making the board unreadable?**

**Now — trustworthy intelligence (finish the foundation)**

- **Proposal persistence** (small, known gap): a pending review batch currently
  lives only in React state — a reload drops the ops while the chat reply
  survives. Persist the proposal to the project record and rehydrate.
- **Statement kinds as data**, not just prompt instructions: fact / proposal /
  question / opinion / decision / rejection / action / constraint / risk
  (docs/05). This is the trust foundation — "maybe we launch in September" must
  never become a decided launch date, and _rejections_ must visibly supersede
  the proposals they replace. Deterministic where possible (the existing
  `classifyTurn` heuristic covers six kinds today), model-assisted where not.
- **Conversation evolution**: corrections and contradictions thread through
  time (proposal → concern → decision that supersedes), rather than landing as
  three unrelated nodes.

**Next — meeting intelligence (make listen → understand → visualize reliable)**

The loop ships (M2); make it _trustworthy at absorbing real meetings_. The
benchmark is a scripted meeting containing brainstorming, topic switching,
interruptions, corrections, disagreement, uncertainty, decisions, action items,
multiple speakers, and deliberate off-topic chatter, measured on:

- How many extracted items were correct? How many should NOT have been
  extracted (over-extraction)? How many important things were missed?
- Were contradictions resolved? Were duplicate regions created?
- How many decisions/actions carried provenance? How readable was the final board?

Those numbers — not opinions — decide what to build next.

**Then — visual intelligence (M3, small layers only)**

Solve "I have 200 things; help me understand them" _without_ rewriting the
canvas (docs/05 has the details): selection focus, connector visibility tiers,
region collapse. Test at 20 → 40 → 80 → 150 nodes against the question "can I
actually understand this?"; stop when the answer is yes. ELK/routing only if a
measured 150-node failure demands it.

**Then — meeting artifacts → execution**

The Decisions / Open Questions / Actions / Risks panels (docs/05), then
"create a plan from today's meeting," then the Linear/Jira/GitHub bridge.

**Company note — Lattice (§26)**

The two-product thesis: Lucent understands what teams _think_; Lattice
understands what teams _built_. The long-term loop — "let's add a discount
system" → proposed design overlaid on the system that actually exists → what
would have to change — is the company-level story neither product tells alone.

## Non-negotiables preserved from the spec

- AI emits validated operations; never manipulates the canvas directly.
- Diagrams are a semantic model, never a static image.
- Coordinates come from the layout engine, never the LLM.
- Every AI action is reversible; large ops gate behind human approval.
- **AI-generated additions are spatially additive by default; committed objects
  keep their positions unless the user explicitly transforms (ADR 0015).**
- **One bad operation costs itself, never the whole generation (M1).**
