# 19. The BPMN subset — what "Lucent supports BPMN" means

> **Status (2026-09-12):** the Phase 6 read-only lens definition (doc 18).
> Full BPMN 2.0 is far richer than Lucent's generic workspace model; this
> document fixes exactly which semantics survive the round trip, and the
> license conditions under which the lens may ship. Until this subset grows,
> no surface may claim "Lucent supports BPMN" beyond it.

## The license gate (reviewed 2026-09-12, before code)

- **bpmn-js** — the bpmn.io license (Camunda's modified MIT): standard MIT
  grant **plus a watermark condition**. The source displaying the bpmn.io
  watermark in rendered diagrams must not be removed or changed, and when
  the software runs in an application **the watermark must stay fully
  visible and not visually overlapped by other elements**. Conditions for
  Lucent, accepted as product decisions:
  1. The BPMN lens renders inside a contained surface whose bpmn.io
     watermark remains visible; Lucent UI may never draw over it.
  2. Exported renders keep the watermark (it rides the diagram).
  3. If a future commercial decision cannot accept the watermark, the BPMN
     lens stops — the workspace model is unaffected (the lens is derived).
- **elkjs / ELK** — EPL-2.0 (with a secondary GPL-3 option). Usable in a
  commercial product under standard EPL-2.0 obligations (source availability
  applies to ELK itself and modifications to it, not to Lucent). elkjs is
  version-pinned per ADR 0039.

## Supported subset (round-trips both ways)

| BPMN element | Lucent mapping | Notes |
| --- | --- | --- |
| `startEvent` | nodeType `entry` | one per region expected, not enforced |
| `endEvent` | nodeType `exit` | |
| `task` | nodeType `step` | labels carry over as `name` |
| `exclusiveGateway` | nodeType `choice` | the decision diamond |
| `sequenceFlow` | `Edge` (relationship `then`) | `sourceRef`/`targetRef` + DI waypoints |
| `lane` (in a `laneSet`) | plain `Group` (no kind) | membership via `flowNodeRef` → `Node.groupId` |

Unknown BPMN elements are **ignored on import** (recorded in the parse
result's `ignored` list), never guessed into Lucent semantics. Unknown
Lucent node types export as `task` — the honest fallback, not a silent
reinterpretation.

## Deferred explicitly (not in the subset)

Timer/message/signal/escalation/error events, event sub-processes,
compensation, transactions, ad-hoc processes, choreography and conversation
diagrams, data objects, associations, pools/collaborations (model-level
`participant` is deferred with them), multi-instance and loop markers,
boundary events, and conditional/default flows. Each needs either workspace
semantics Lucent does not have or a real user requirement — Option B
thinking is deliberately out of scope (ADR 0038).

## The derived-projection rule

BPMN XML is **output**, like `Edge.route`: recomputed from the canonical
workspace, persisted nowhere canonical, never part of the AI operation
contract (ADR 0038 clause 1). The adapter
(`packages/web/src/diagram/bpmn/bpmnAdapter.ts`) maps a laid-out process
region to BPMN 2.0 XML **including DI bounds derived from the layout** — the
same "engine owns geometry" split the graph families use. Import maps the
subset back to workspace semantics and drops geometry (the layout engine
owns where things go).

The bpmn-js **viewer** integration is the remaining Phase 6 piece: it is a
browser-surface component (the watermark clause above applies to exactly
that surface) and lands with live verification rather than headless tests.
