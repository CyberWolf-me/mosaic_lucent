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
