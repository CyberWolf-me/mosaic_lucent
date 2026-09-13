# Routing style per family — the measured table (doc 18, Phase 5, advisory V10)

> **Decision:** ortho for the four layered/routed families
> (`flowchart`, `architecture`, `journey`, `bpmn`) plus `process` (squared
> corners are the OMG/process convention); polyline as the inert default for
> the never-routing families (`mindmap`, `decisiontree`, `orgchart`); no
> family selects spline today. The policy lives in
> [`packages/core/src/routing.ts`](../../packages/core/src/routing.ts) — a
> pure function of the diagram kind, nothing persisted, nothing in the op
> contract. **Provisional on the human-half pass**, exactly as ADR 0039's
> engine verdict is: the mechanical half cannot see curvature, and part of
> ortho's crossing win rides on the metric's judgment that collinear overlap
> is not a failure (both caveats below).

**Sweep:** `npx tsx --conditions=development scripts/visual-benchmark.ts
--routing` (2026-09-13, built-in engine, layout fixed per board; the swept
style is the metric's explicit `routeStyleOverride` — the controlled
variable). Boards: the benchmark corpus families; scales 150/300/500;
median-of-3 not needed (geometry is fixed per board, so the numbers are
exact, not timed).

## The numbers (crossings; the decision metric)

| board | polyline | ortho | Δ |
| --- | ---: | ---: | ---: |
| layered 150 | 240 | 170 | −29% |
| layered 300 | 571 | 419 | −27% |
| layered 500 | 902 | 668 | **−26%** |
| dense 150 | 1340 | 615 | −54% |
| dense 300 | 4431 | 1930 | −56% |
| dense 500 | 8396 | 3739 | **−55%** |
| adversarial 150 | 620 | 357 | −42% |
| adversarial 300 | 1341 | 498 | −63% |
| adversarial 500 | 2377 | 1093 | **−54%** |
| long-edge 150 | 21 | 28 | +33% |
| long-edge 300 | 10 | 9 | −10% |
| long-edge 500 | 18 | 17 | tie |
| mixed-region 150–500 | 1–2 | 1–2 | tie |
| radial 150–500 | 0 | 0 | tie |
| tree 150–500 | 0 | 0 | tie |
| swimlane 150–500 | 0 | 0 | tie |

Ortho wins every routed fixture with real crossings at every scale; the
long-edge ladder (the deliberate far-target case) is a tie-to-noise
(21 vs 28 crossings at 150 on 830 edges — both under 0.03 per edge), and
the never-routing families never consult the policy at all (their edges
carry no route).

## The honest costs, recorded with the win

- **Bend mean ~2–2.5×.** 0.19→0.52 (layered 500), 1.20→2.45 (dense 500),
  0.75→0.89 (long-edge 150). The layered ladder stays under 0.55
  bends/edge; dense boards draw visibly more squared corners — the price
  of halving their crossings, and a question for the human pass (do the
  elbows read as structure or as noise?).
- **Through-node entries +16%.** Layered 500: 128→148. The vertical elbow
  drop passes more foreign boxes than the diagonal it replaces. Dense 500
  is unchanged (948→948); adversarial +5% (308→322).
- **eMean is per-SEGMENT and not comparable across styles.** More vertices
  mechanically shorten the mean segment length (369→281 on dense 500). The
  decision cites crossings and through-nodes only.

## Measured-truth caveats (why the verdict is provisional)

1. **Collinear overlap is not a crossing.** The crossing metric counts
   proper X-intersections only (`segmentsCross` uses strict signs; shared
   endpoints and collinear overlap are excluded). Orthogonal corridors
   share row/column lines, so part of ortho's win is crossings *converted
   into overlap* — visually busier, mechanically invisible. If the human
   pass reads ortho's overlapped corridors as noise, the verdict flips to
   polyline; this is precisely the judgment the mechanical half cannot make.
2. **Spline's skeleton is identical to polyline's.** `routedVertices`
   returns the same vertex list for both; curvature is the renderer's
   Catmull-Rom stroke. The sweep's "spline" rows are therefore polyline's
   numbers by construction — the table records this rather than claiming
   spline was measured. A spline verdict could only come from the human
   pass, and none is claimed here.

## The defect the first sweep caught (now pinned by tests)

The first corner rule took the NEXT vertex's coordinate on the incoming
axis; each bend doubled back past its waypoint and multiplied dense-board
crossings by 2.4×. The fixed rule travels the dominant axis first and
squares the corner at the elbow, inside the segment's own bounding box —
pinned by the routing tests' no-overshoot invariant
(`packages/core/test/routing-styles.test.ts`).

## What was deliberately not measured

- Curvature (spline's differentiator) — impossible mechanically, per
  caveat 2.
- Label placement interaction — the label rides the same vertex list, so
  its midpoint moves with the style; no read was taken.
- The ELK engine's geometry under each style — the policy is
  engine-agnostic (it post-processes whatever waypoints the layout pass
  produced), and re-sweeping ELK's routes would measure ELK's routing
  quality, not the style's. The sweep pins the built-in engine's routes.

## Where the verdict goes next

The human-half pass (the same batched pass that carries ADR 0039's
verdict) reads one ortho board and one polyline board at 300–500 nodes and
answers the collinear-overlap question. If it fails ortho, the policy table
flips to polyline — one line in `routing.ts`, zero geometry change (the
layout is fixed; only the drawn style moves).
