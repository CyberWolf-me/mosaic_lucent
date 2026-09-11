---
"@lucent/core": minor
"@lucent/web": minor
---

Visual Intelligence V4+V5: the layout benchmark and the routed layered engine. A permanent deterministic visual-quality harness (crossings, overlaps, edge length, per-node sprawl, layout ms over synthetic boards at 20–500 nodes), which isolated and closed the layered engine's crossings explosion: cycle-safe layering (return edges no longer collapse the layering), the deep-chain wrap gated to chains only, and long edges routed through the rows as polylines (Edge.route) — 10,871 → 902 crossings at 500 nodes, edge lengths 4–26× shorter. Renderers, exports, and the benchmark all draw the same routed geometry.
