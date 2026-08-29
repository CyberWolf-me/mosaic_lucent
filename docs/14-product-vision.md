# 14. Product Vision — Mosaic / Lucent

> **Mosaic** is the company. **Lucent** is the product. (Lattice = the separate
> system-understanding product referenced in §26.) Earlier drafts wrote "Lucem";
> that is a typo for Lucent.

This document records the full product vision (from the product overview) and
maps it against what the codebase implements today, so the roadmap reflects
reality rather than restating the pitch.

## Thesis (unchanged, reinforced)

Not "Miro with AI." Lucent is an **AI-native visual workspace where you don't
have to draw your ideas — you explain them**, and still keep the full
FigJam/Miro/Excalidraw manual toolbox when you want control.

    Human → voice/text → AI understands → canvas creates → human directs

## The bet we already won

The overview's sections 18–19 ("AI edits the board **semantically**, from a
**Board Graph**, not by regenerating") and 22 ("one idea → many artifacts") are
the single most important design idea — and they are the architecture we already
built: `@lucent/core` is a semantic model mutated by validated operations, with
one model rendering to flowchart / architecture / mind map / journey / wireframe.
So natural-language semantic editing, transforms, and "modify don't regenerate"
are working today, not aspirational.

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

## Recommended near-term order (given current state)

1. Round out **manual objects** the vision lists but we lack: more shape kinds,
   connector variants, copy/paste, PNG/PDF/JSON export. Pure client, no backend.
2. **Templates** as saved operation batches + a picker. High value, low cost.
3. **Sketch mode** toggle. Cheap, on-brand differentiation.
4. **Persistent AI agent** upgrade: keep conversation/context, ask clarifying
   questions, "explain/what's missing/bottlenecks" (§21 Understand). Reuses the
   existing provider; no new infra.
5. **Collaboration backend** (multiplayer + comments) — the big investment;
   schedule deliberately. Unlocks §10–13 and the remote modes from docs/12.
6. **AI-generated visuals / image input** — needs an image model + key; scope as
   media objects, preserving the semantic-diagram rule.

## Non-negotiables preserved from the spec

- AI emits validated operations; never manipulates the canvas directly.
- Diagrams are a semantic model, never a static image.
- Coordinates come from the layout engine, never the LLM.
- Every AI action is reversible; large ops gate behind human approval.
