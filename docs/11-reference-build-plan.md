# 11. Reference Build Plan — Premium UI on the real engine

The `reference/` folder is a no-build React+Babel **design prototype**: 10 screens, hardcoded data, navigation via `window.__lucentGo`, node coordinates baked in. This plan ports that design into the real `@lucent/web` app, wired to the actual deterministic engine (`@lucent/core`) and AI proxy (`@lucent/server`) already built in `docs/10`.

## Principle kept intact

The prototype bakes x/y into its mock nodes. The product rule (`docs/03`, `docs/25`) is **LLM → semantic graph → layout engine → coordinates**. So we keep the reference's _visuals_ (node card with meta/dot/sub, amber connectors, frames) but positions come from `@lucent/core`'s `computeLayout`, not the model. Node `meta` label and `dot` color are derived from `nodeType`.

## Architecture of the real web app

- **Design system:** port `reference/styles.css` verbatim into `packages/web/src/styles.css` (OKLCH tokens, dark/light themes, 5 accent palettes, all component classes). It is framework-agnostic.
- **State:** a `WorkspaceProvider` (React context) holding the real `@lucent/core` `Workspace` + `History`, the conversation, and actions (`generate`, `applyProposal`, `undo`/`redo`, `newProject`, `openProject`). Replaces every `window.__lucentGo` global with real nav + context.
- **Settings store:** ported `settingsStore` + `useSettings` + `ThemeRoot` (theme/accent/grid/motion), persisted to localStorage.
- **Navigation:** a real view router `dashboard | canvas | history | meeting | wireframe | sequence`. The canvas view derives its sub-state from actual data: **empty** (no nodes) → **generating** (awaiting server) → **main** (nodes present) → **proposing** (a pending large op batch) → **voice** (listening).
- **Persistence:** localStorage projects (already in `persistence.ts`), extended to store the semantic workspace + chat.

## Components to port (window-globals → typed React)

- `icons.tsx` — `Ico` + `ToolIco` SVG sets.
- `atoms.tsx` — `CanvasBackdrop`, `NodeCard`, `makePath`, `ConnectorDefs`, `CanvasViewport` (pan/zoom via React state, no window bus).
- `chrome.tsx` — `TopBar`, `LeftRail`, `CommandOverlay` (⌘K), `ZoomBadge`, `StatusBadge`, `ShareDialog`.
- `ai_pill.tsx` — `AIPill` + `ConvoTurn`, wired to the real generate action and Web Speech voice.
- `settings.tsx` — `SettingsModal`, `ProfileMenu`, `ShapeToolbar`, `ShapeElement`.

## Screens (wired vs. designed)

Real, engine-backed:

- **Empty** — hero prompt → calls `generate`, transitions to generating.
- **Canvas (main)** — renders the live `Workspace` through `computeLayout`; node selection HUD; shape toolbar drops sticky/shapes.
- **Generating** — progressive reveal animation while the server call is in flight (and replays the returned ops one-by-one).
- **Proposing** — when a batch is large, hold it as a pending proposal; panel lists add/mod/del/move ops; Apply commits via the reducer + history (`docs/15`).
- **Voice** — Web Speech push-to-talk; live transcript bubble; feeds the same `generate`.
- **Dashboard** — localStorage projects grid with per-kind mini previews; New/open/search/filter.
- **History** — real `History.timeline()` entries with a version preview.

Faithful designed artifact views (data-driven where feasible, else high-fidelity like the reference, since these are derived artifacts):

- **Sequence**, **Wireframe**, **Meeting**.

## Verification

`npm run typecheck` (all packages) and `npm run build -w @lucent/web` must pass. Server loop already verified in `docs/10`. Browser control is off-limits, so UI is verified by typecheck + production build + the proven `/api/generate` path.
