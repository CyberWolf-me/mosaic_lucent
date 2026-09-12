# Lucent — Documentation

AI-Native Voice Visual Workspace. A conversational canvas where users describe ideas by voice or text and an AI agent constructs editable, structured visuals.

**Promise:** _Think out loud. Build visually._

This documentation splits the original project overview into focused parts. Read in order, or jump to a section.

**Start here if you want current state, not original intent:**
[`checklist.md`](./checklist.md) is the audited feature-by-feature status
and the most accurate document in this folder. [`10-getting-started.md`](./10-getting-started.md)
tells you how to run it. Documents 1–8 are the original product overview and
describe intent; 9 is the original build plan and is explicitly superseded.

| #   | Document                                                                       | Covers (original sections)                                                                                       |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1   | [01-vision-and-strategy.md](./01-vision-and-strategy.md)                       | Concept, problem, target users, philosophy, positioning, moat, long-term vision, identity, strategy (1–4, 32–37) |
| 2   | [02-interface-and-interaction.md](./02-interface-and-interaction.md)           | Interface, AI interaction, voice mode, conversation+canvas, human approval (5–7, 13, 15)                         |
| 3   | [03-semantic-canvas-and-data-model.md](./03-semantic-canvas-and-data-model.md) | Semantic canvas, vs image gen, action system, version history, layout engine, data model (8–9, 14, 16, 25–26)    |
| 4   | [04-ai-architecture.md](./04-ai-architecture.md)                               | Technical architecture, AI architecture, transformations, workspace memory (11–12, 21, 24)                       |
| 5   | [05-features.md](./05-features.md)                                             | Visual artifact types, collaboration, meeting mode, multimodal, code integration (10, 17–20)                     |
| 6   | [06-tech-stack-and-security.md](./06-tech-stack-and-security.md)               | Frontend, backend, collaboration architecture, security (22–23, 27–28)                                           |
| 7   | [07-mvp.md](./07-mvp.md)                                                       | MVP scope, example MVP session (29–30)                                                                           |
| 8   | [08-business-model.md](./08-business-model.md)                                 | SaaS tiers and pricing (31)                                                                                      |
| 9   | [09-build-plan.md](./09-build-plan.md)                                         | Original V1 build plan — **superseded**; kept for its reasoning                                                  |
| 10  | [10-getting-started.md](./10-getting-started.md)                               | How to install, run, and verify the implementation                                                               |
| 11  | [11-reference-build-plan.md](./11-reference-build-plan.md)                     | Porting the `reference/` prototype into `@lucent/web`                                                            |
| 12  | [12-collaboration-and-modes.md](./12-collaboration-and-modes.md)               | Collaboration, presence, presentation/focus/meeting modes                                                        |
| 13  | [13-board-and-manual-editing.md](./13-board-and-manual-editing.md)             | The manual board: shapes, connectors, frames, inspector, tiers                                                   |
| 14  | [14-product-vision.md](./14-product-vision.md)                                 | Vision → implementation status map and strategic trade-offs                                                      |
| 15  | [15-execution-plan.md](./15-execution-plan.md)                                 | Phased execution plan (A–G) and the testing model                                                                |
| 16  | [16-meeting-evaluation.md](./16-meeting-evaluation.md)                         | The meeting-intelligence scoresheet: metrics, fixtures, run protocol                                             |
| 17  | [17-engineering-roadmap.md](./17-engineering-roadmap.md)                       | The feature freeze, the decision gates, the keep-list, and what reopens engineering                              |
| 18  | [18-structured-visual-engine.md](./18-structured-visual-engine.md)             | The structured visual engine: phases, gates, the ELK comparison, the BPMN lens                                   |
| —   | [checklist.md](./checklist.md)                                                 | **Audited current status**, feature by feature. The source of truth.                                             |

### Decisions and operations

Two folders sit outside the numbered overview and are maintained as code, not prose:

- [`adr/`](./adr/) — architecture decision records. Why the op log is not a CRDT,
  why there is no HTTP framework, why sessions are cookies rather than bearer
  tokens, why fan-out goes through Postgres before Redis, why operations are the
  AI's only contract, and why Postgres is optional.
- [`runbooks/`](./runbooks/) — deploy, rollback, restore from backup, rotate
  secrets, incident response. Written for whoever is holding production at the
  time, including the parts of the deployment story that do not exist yet.

### A note on section numbers

Several docs cite `docs/16`, `docs/25`, `docs/33` and similar. Those are _section
numbers from the original single-file overview_, not files in this folder — the
mapping is the "Covers" column above.

### Packages the docs under-describe

- `packages/mcp` — an MCP stdio server exposing the same validated operation
  contract to external agents (Claude, Cursor, an IDE). Not covered by any doc
  above; see `packages/mcp/src/tools.ts`.
- Work tracking — Jira-style issue fields on nodes plus a Kanban board view.
  Covered only in `checklist.md` and the 14 status map.
- Code/IaC import — docker-compose and package.json become architecture
  diagrams (`packages/web/src/board/codeImport.ts`).
