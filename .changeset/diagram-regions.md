---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
---

Diagram regions: multiple diagram kinds on one board, each editable by text or voice.

- `Group` gains an optional `kind`; a group carrying one is a _diagram region_ laid out under that kind's strategy while the rest of the board keeps its board-wide kind. Existing boards and swimlane lane groups are unchanged (ADR 0014).
- New `SET_GROUP_KIND` operation changes or dissolves one region — "change the pricing section to an org chart" re-lays only that region, with full undo. `CREATE_GROUP` accepts the `kind` so the AI can add a second diagram kind to a populated board without transforming it.
- The layout engine partitions regions into sub-workspaces, each under its own strategy, and packs them in a band with gutters; pinned nodes keep their hand-placed coordinates.
- The AI summary and prompt (v3) carry and teach region targeting; the mock provider and golden evals cover both the "add a mind map region" and "retarget one region" flows. MCP agents get the new operation automatically via the derived tool schema.
- Web: region boxes show their kind, the group context menu offers the same kind picker as the board, and SVG exports label region boxes.
