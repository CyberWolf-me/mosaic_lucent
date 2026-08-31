# 3. Semantic Canvas & Data Model

## The semantic canvas

This is probably the most important technical idea in the entire project.

**Do not make the AI generate a static image.** Instead, maintain an underlying structured representation. For example:

```json
{
  "type": "service",
  "id": "payment-service",
  "name": "Payment Service",
  "relationships": [
    { "target": "checkout", "type": "receives" },
    { "target": "stripe", "type": "calls" }
  ]
}
```

The canvas renderer converts this model into visual objects. Because the information is structured, the same underlying model can generate multiple visualizations:

```
        Semantic Model
              │
    ┌─────────┼─────────┐
    ↓         ↓         ↓
   Flow    Diagram   Wireframe
```

## Why this is different from AI image generation

An AI image generator might produce "a beautiful architecture diagram," but you can't reliably edit the individual semantic relationships. Lucent produces structured elements — Node, Node, Relationship, Node, Group, Constraint, Metadata — and then renders them. **This makes everything editable.**

## AI action system

The LLM should **not** directly manipulate the canvas. Instead, the AI produces structured operations that the application validates and then the canvas executes. This gives deterministic behavior.

Operation types include:

```
CREATE_NODE      DELETE_NODE       CREATE_GROUP      CHANGE_TEXT
MOVE_NODE        CONNECT_NODES     DELETE_GROUP      CREATE_DIAGRAM
                 DISCONNECT_NODES  CHANGE_NODE_TYPE  TRANSFORM_DIAGRAM
```

Example operation:

```json
{
  "operation": "CONNECT_NODES",
  "source": "checkout",
  "target": "payment",
  "relationship": "initiates"
}
```

Flow: **AI emits operation → application validates → canvas executes.**

## Version history

Every AI action must be reversible. The workspace keeps a Git-like timeline:

```
10:42  User added payment system
10:43  AI created architecture
10:45  User requested authentication
10:46  AI added OAuth
10:48  User reverted payment changes
```

Users can undo, redo, compare versions, restore snapshots, and inspect AI actions.

## Layout engine

LLMs are not great at calculating beautiful spatial layouts, so **do not** ask the LLM to "put these 37 objects at x/y coordinates." Instead:

```
LLM → Semantic graph → Layout engine → Coordinates
```

Use algorithms such as hierarchical layouts, force-directed layouts, DAG layouts, tree layouts, and graph clustering. This makes diagrams dramatically better.

## Data model

At the center is the `Workspace`, which contains:

```
Workspace
├── Nodes
├── Edges
├── Groups
├── Frames
├── Comments
├── Assets
├── Conversations
├── AI Actions
├── Versions
└── Knowledge
```

Every object should carry: `id`, `type`, `position`, `size`, `content`, `metadata`, `relationships`, `created_by`, `created_at`, `updated_at`.

## Diagram regions (multiple kinds on one board)

A board's `diagramKind` is its _board-wide_ rendering lens — but one board can
carry several diagrams at once. A **region** is a `Group` with an optional
`kind`: while set, the group's members are laid out by that kind's strategy in
their own sub-workspace and packed alongside the board's other regions. A
group without a `kind` stays a plain container (a swimlane's lane, an actor
boundary), so existing boards and the process-map flow are unchanged.

- **Create:** the AI emits `CREATE_GROUP` with a `kind` and puts the new
  diagram's nodes in it — "also add a mind map for the pricing ideas on this
  board" adds a radial region without touching the flowchart next to it.
- **Change:** `SET_GROUP_KIND { id, kind }` flips one region's lens — "change
  the pricing section to an org chart" moves only that region; the board kind
  and every other region keep their geometry. `kind: null` dissolves the
  region back into the board-wide layout. The same picker is behind the
  group's right-click menu, so a mouse-only user can flip a region too.
- **Every action is reversible:** SET_GROUP_KIND inverts to the prior kind,
  and a deleted region group restores with its kind intact.
- The kind is a rendering lens, never content: membership is ordinary group
  membership, so "one model, many representations" becomes _many simultaneous_
  representations on one board. See ADR 0014.
