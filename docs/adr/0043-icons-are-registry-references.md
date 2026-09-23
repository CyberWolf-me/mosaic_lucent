# 0043 — A node's icon is a registry reference, never markup

- Status: Accepted
- Date: 2026-09-24

## Context

The visual track (docs/26 §6.2, decision 1) starts with readability: an
architecture board should show the real Postgres, Stripe and Kafka marks,
not 19 hand-drawn glyphs guessed from the label (`techMarks.tsx`). That
needs a vocabulary of thousands of icons that the AI can name and a person
can pick, without breaking any of the non-negotiables:

- the model never draws: it emits validated operations, and a model-written
  string must never reach an SVG sink as markup (M0.5);
- every change is an operation: validated, shared, reversible;
- presentation never moves geometry: the layout engine owns node size.

## Decision

**An icon is a reference into a bundled registry**:
`iconoir:<name>` (Iconoir, MIT, ~1,380 outline concepts) or `simple:<slug>`
(Simple Icons, CC0, ~3,460 brand marks).

- `Node.icon?: string`, set by `CREATE_NODE.icon` or the new
  `SET_NODE_ICON { id, icon | null }` (null clears). Both are AI-permitted,
  so the tool schema and the MCP surface pick them up from the union.
- **Core checks the grammar, not existence**:
  `^(iconoir|simple):[a-z0-9][a-z0-9_-]{0,63}$`. The registry is versioned
  data outside core; a reference it doesn't know renders the label's
  automatic icon instead of failing anything. The stored-board schema drops a
  malformed icon rather than refusing the board. `sanitizeRawOperations`
  repairs a model's near-miss (`SI:Stripe` → `simple:stripe`) and drops what
  it can't repair: an icon never costs the node.
- **The registry is generated path data**: `scripts/build-icons.mjs` reduces
  every icon to `d` strings at build time, into FNV-1a hash buckets (8 + 64)
  that load on demand. The browser renders React `<path>` elements; it never
  parses or injects SVG. A board pays for the buckets it shows.
- **Absent means automatic.** `icons/auto.ts` derives an icon from the label
  (brand first, then concept, longer phrase first, whole words only) and a
  few node types. Every target is pinned to exist by a test.
- **Presentation only.** The icon takes the meta row's slot, so node size and
  layout are untouched, and statement cards keep their statement glyph.
- **Trademarks.** Brand marks identify the product a node names, never
  Lucent. The inspector says so and links the owner's guidelines; the
  upstream licences ship beside the data (`icons/data/NOTICE.md`).

## Consequences

- The op union grows by one operation; the proposal panel and turn summary
  describe it; undo restores both a set and a clear, and undoing a delete
  restores the icon with the node.
- Several large vendors are absent from Simple Icons at their own request
  (AWS, Azure, Slack, OpenAI, Salesforce, Java). The prompt tells the model to
  use a concept icon for them; the auto table maps their names to concepts.
- Vector Studio (docs/26 §6.3) builds on this: "icon → vector" starts from a
  registry glyph's path data, and the same generator is the model for the
  sanitizing importer.
- The generated data (~5 MB raw, 74 files) is committed so builds and tests
  need no network; `npm run icons -w @lucent/web` regenerates it from the
  pinned devDependencies.
