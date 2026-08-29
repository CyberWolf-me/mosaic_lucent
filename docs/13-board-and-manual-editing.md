# 13. Board & Manual Editing

Lucent is "describe → AI constructs," but the board must also stand on its own:
people want to sketch, drop notes, draw connectors, and arrange things by hand
(FigJam / Miro / Excalidraw expectations). This document plans that manual layer.

> **Status (audited 2026-08): Tier 1 is done and the premise below is fixed.** > `DroppedShape` no longer exists — manual objects are first-class `Shape`s in the
> `Workspace`, mutated by validated operations, undoable, persisted, and readable
> by the AI. Tiers 2–3 are largely done too: snapping with alignment guides,
> marquee (shapes _and_ nodes), groups, frames that carry their contents, lock,
> hide/show with a recovery path, z-order, align + distribute, resize, pen,
> eraser, images, embeds, context menu, and the style inspector all ship.
>
> Still missing from this plan: **rotate handles** (the `rotation` field exists in
> the model and renders, but nothing sets it besides a sticky-note tilt), **frames
> that clip their contents** or act as presentation slides, three inspector
> controls that exist in `ShapeStyle` with no UI (`strokeWidth`, `opacity`, dashed
> stroke), and "promote sketch to diagram".
>
> The section immediately below describes the _pre-Tier-1_ world and is kept for
> the reasoning that motivated the change.

## The core problem to fix first (historical — resolved)

Today, dropped shapes (`DroppedShape[]`) live only in `CanvasView` React state.
They are **not** part of the `@lucent/core` `Workspace`. Consequences:

- they do **not** persist (save/load ignores them),
- they do **not** undo/redo,
- they are invisible to history, layout, and the AI.

AI nodes and hand-made shapes are two separate worlds. Every manual feature built
on the current `DroppedShape` state is throwaway. **Tier 1 makes manual content a
first-class citizen of the semantic model. Everything else depends on it.**

## Guiding principles (consistent with docs/03, docs/09)

- Manual elements live in the `Workspace`, mutated by validated **operations**,
  applied by the pure reducer, tracked by `History`. Same contract as AI ops.
- Manual elements carry their **own** position (unlike AI nodes, which the layout
  engine positions). So the model must allow "pinned" coordinates that the layout
  pass leaves alone.
- The AI can _read_ and _upgrade_ manual content — the Lucent-only payoff: sketch
  rough boxes, then "turn this into a flowchart" promotes them into real nodes.

## Data model additions (`@lucent/core`)

Add a `Shape` object type to `Workspace` (alongside nodes/edges/groups/wireframes):

```ts
interface Shape {
  id: string;
  kind: "rect" | "ellipse" | "diamond" | "sticky" | "text" | "draw" | "image";
  position: { x: number; y: number };
  size: { width: number; height: number };
  rotation?: number;
  text?: string;
  path?: string; // SVG path data for kind "draw"
  src?: string; // data URL for kind "image"
  style?: {
    // per-object styling
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    color?: string;
    fontSize?: number;
    opacity?: number;
    radius?: number;
  };
  z?: number; // explicit z-order
  groupId?: string; // manual grouping (distinct from node groups)
}
```

New operations (zod-validated, reducer-applied, reversible):
`CREATE_SHAPE`, `UPDATE_SHAPE` (position/size/rotation/text/style/z),
`DELETE_SHAPE`, `CONNECT_SHAPES` (manual connector as an edge variant that binds
to shape ids and re-routes), and `GROUP_SHAPES` / `UNGROUP_SHAPES`.

Layout: `computeLayout` must skip shapes with pinned positions so hand-placed
content is never moved by the auto-layout that governs AI nodes.

## Tiers

### Tier 1 — foundation (do first)

1. `Shape` model + `CREATE/UPDATE/DELETE_SHAPE` ops + reducer + validator + tests.
2. Migrate `CanvasView`'s `DroppedShape` state onto the workspace, through the
   context (`addShape`/`moveShape`/`relabelShape` become operations that commit to
   history). Persistence + undo/redo now cover manual content for free.
3. **Freehand pen**: capture pointer strokes → SVG path → `CREATE_SHAPE {kind:"draw"}`.
4. **Multi-select**: marquee drag + shift-click; move/delete the selection as a set.

### Tier 2 — expected editing

5. Manual **connectors/arrows** that bind two shapes and re-route on move.
6. **Styling panel**: color, stroke width/style, fill, opacity, font size, sticky
   color, corner radius — writes `UPDATE_SHAPE`.
7. **Z-order** (front/back), **duplicate** (Ctrl+D / alt-drag), **grouping**.
8. **Alignment + snapping**: snap to other objects and an optional grid;
   align/distribute for a multi-selection.

### Tier 3 — polish & parity

9. **Images**: paste/drop → `CREATE_SHAPE {kind:"image"}` (data URL in V1).
10. **Resize + rotate handles** on selection.
11. **Frames** as real containers (group + clip + act as slides/regions).
12. **Zoom-to-fit**, richer keyboard shortcuts, **export** PNG/SVG/JSON.

### Deferred (needs multiplayer, docs/12)

Live cursors, presence, comments, simultaneous editing.

## The Lucent-native bonus (after Tier 1)

- **"Promote sketch to diagram"**: an AI action that reads manual shapes and emits
  `CREATE_NODE`/`CONNECT_NODES` to convert a rough sketch into a semantic diagram.
- **Mixed canvas**: AI nodes and manual annotations coexist; the AI can reference
  a sticky ("address the note about SSO") because it is in the model.

## Verification per tier

Each tier ends green on `npm run typecheck`, `npm test` (new core unit tests for
every op), and `npm run build -w @lucent/web`. Live click-through in-browser when
the IAB attaches; until then, build + tests + API are the verification floor.
