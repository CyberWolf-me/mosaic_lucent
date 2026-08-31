# ADR 0015: Spatial additivity and the live meeting loop

Date: 2026-08-31
Status: accepted

## Context

Two capabilities landed together because one is the precondition for the
other. Meetings make Lucent grow a board continuously, topic by topic; that
is only trustworthy if growing one topic never rearranges the topics the user
has already read. The live review put it as a product principle: the user
develops a spatial mental map of the board (left = product, center =
architecture, right = roadmap), and an AI that reshuffles it on every edit
destroys the map the product just helped them build.

## Decisions

**1. The invariant, stated as an ADR because it outranks implementation
convenience:**

> AI-generated additions must be spatially additive by default. Existing
> committed objects keep their positions unless the user explicitly requests
> a transformation or movement. User actions always outrank AI actions.

Enforcement is mechanical, not aspirational: `commit()` inspects which nodes
a batch touches; when they all sit inside one group, `relayoutRegion`
re-lays out only that group at its current origin and every other node is
returned pixel-identical. Unscoped batches (whole-board transforms, loose
nodes, cross-region edits) take the full pass — the invariant constrains
additive growth, not explicit user intent. `separateRegions` resolves the
one conflict additive growth can create — a growing region meeting its
right-hand neighbour — by shifting only the neighbours actually overlapped.

**2. The meeting differential loop.** While recording, new STT finals
accumulate and a hybrid trigger decides when to spend a model call: enough
new turns plus a speaking pause (the "speaker finished" signal), OR a burst
of turns, OR a wall-clock safety valve — debounced, one generation in
flight. The prompt is differential by construction: it names what the board
already shows, asks for only what is missing, updates-don't-duplicates on
refinement, treats casual suggestions as proposals rather than requirements,
and forbids DELETE. Auto-apply covers small additive batches; anything
destructive, oversized, or off-list routes to the review panel.

**3. One canonical operation simulator.** Partial application (M1) partitions
a batch with the same `validateOperations` that gates it — the applier cannot
disagree with the validator because it IS the validator, re-run per op
against the state that op will really apply to.

**4. Transcript durability is append-first.** A capture opens its server
transcript at recording start and appends a checkpoint after every
extraction, so a refresh mid-meeting loses nothing. Ended meetings are
immutable (no append) — "editing the minutes" is a new save.

## Consequences

- Provenance: meeting-extracted nodes carry `metadata.meeting`
  (id, quoted turns, timestamp); the node HUD shows a ✦ whose tooltip quotes
  the words that produced it. The board can always answer "why is this
  here?" — the audit trail for AI-generated content.
- Speaker identity flows from the STT seam: LiveKit segments carry the room
  identity the token minted; the browser provider gained segment mode
  (per-utterance finals instead of one blob at stop); whisper stays
  single-final and says so.
- Not built this pass: obstacle-routing for long connectors (M1 removed the
  broken-looking ones; routing is a future feature), ELK/dagre (against
  AGENTS.md — the hand-written engine owns geometry), diarisation beyond
  what LiveKit segments already carry.
