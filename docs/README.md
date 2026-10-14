# Lucent — Documentation

AI-Native Voice Visual Workspace. A conversational canvas where users describe ideas by voice or text and an AI agent constructs editable, structured visuals.

**Promise:** _Think out loud. Build visually._

This documentation splits the original project overview into focused parts. Read in order, or jump to a section.

**Start here if you want current state, not original intent:**
[`checklist.md`](./checklist.md) is the audited feature-by-feature status
and the most accurate document in this folder. [`10-getting-started.md`](./10-getting-started.md)
tells you how to run it. Documents 1–8 are the original product overview and
describe intent; 9 is the original build plan and is explicitly superseded.

| #   | Document                                                                       | Covers (original sections)                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [01-vision-and-strategy.md](./01-vision-and-strategy.md)                       | Concept, problem, target users, philosophy, positioning, moat, long-term vision, identity, strategy (1–4, 32–37)                                                                                                                                          |
| 2   | [02-interface-and-interaction.md](./02-interface-and-interaction.md)           | Interface, AI interaction, voice mode, conversation+canvas, human approval (5–7, 13, 15)                                                                                                                                                                  |
| 3   | [03-semantic-canvas-and-data-model.md](./03-semantic-canvas-and-data-model.md) | Semantic canvas, vs image gen, action system, version history, layout engine, data model (8–9, 14, 16, 25–26)                                                                                                                                             |
| 4   | [04-ai-architecture.md](./04-ai-architecture.md)                               | Technical architecture, AI architecture, transformations, workspace memory (11–12, 21, 24)                                                                                                                                                                |
| 5   | [05-features.md](./05-features.md)                                             | Visual artifact types, collaboration, meeting mode, multimodal, code integration (10, 17–20)                                                                                                                                                              |
| 6   | [06-tech-stack-and-security.md](./06-tech-stack-and-security.md)               | Frontend, backend, collaboration architecture, security (22–23, 27–28)                                                                                                                                                                                    |
| 7   | [07-mvp.md](./07-mvp.md)                                                       | MVP scope, example MVP session (29–30)                                                                                                                                                                                                                    |
| 8   | [08-business-model.md](./08-business-model.md)                                 | SaaS tiers and pricing (31)                                                                                                                                                                                                                               |
| 9   | [09-build-plan.md](./09-build-plan.md)                                         | Original V1 build plan — **superseded**; kept for its reasoning                                                                                                                                                                                           |
| 10  | [10-getting-started.md](./10-getting-started.md)                               | How to install, run, and verify the implementation                                                                                                                                                                                                        |
| 11  | [11-reference-build-plan.md](./11-reference-build-plan.md)                     | Porting the `reference/` prototype into `@lucent/web`                                                                                                                                                                                                     |
| 12  | [12-collaboration-and-modes.md](./12-collaboration-and-modes.md)               | Collaboration, presence, presentation/focus/meeting modes                                                                                                                                                                                                 |
| 13  | [13-board-and-manual-editing.md](./13-board-and-manual-editing.md)             | The manual board: shapes, connectors, frames, inspector, tiers                                                                                                                                                                                            |
| 14  | [14-product-vision.md](./14-product-vision.md)                                 | Vision → implementation status map and strategic trade-offs                                                                                                                                                                                               |
| 15  | [15-execution-plan.md](./15-execution-plan.md)                                 | Phased execution plan (A–G) and the testing model                                                                                                                                                                                                         |
| 16  | [16-meeting-evaluation.md](./16-meeting-evaluation.md)                         | The meeting-intelligence scoresheet: metrics, fixtures, run protocol                                                                                                                                                                                      |
| 17  | [17-engineering-roadmap.md](./17-engineering-roadmap.md)                       | The feature freeze, the decision gates, the keep-list, and what reopens engineering                                                                                                                                                                       |
| 18  | [18-structured-visual-engine.md](./18-structured-visual-engine.md)             | The structured visual engine: phases, gates, the ELK comparison, the BPMN lens                                                                                                                                                                            |
| 19  | [19-bpmn-subset.md](./19-bpmn-subset.md)                                       | The BPMN subset: the license decision (no bpmn-js — XML interchange only), supported elements                                                                                                                                                             |
| 20  | [20-production-architecture.md](./20-production-architecture.md)               | Production architecture: the advisory audited, logical/runtime diagrams, phases P0–P7                                                                                                                                                                     |
| 21  | [21-p7-trigger-ledger.md](./21-p7-trigger-ledger.md)                           | P7's evidence gates: what measurement would justify pgvector, replicas, archival, Redis — and which of them are collectable today                                                                                                                         |
| 22  | [22-meeting-platform-architecture.md](./22-meeting-platform-architecture.md)   | The live-meeting advisory, audited: what of the speech-pipeline design already shipped (M1–M5) and what M6–M7 + external connectors cost                                                                                                                  |
| 23  | [23-enterprise-security.md](./23-enterprise-security.md)                       | The Figma/Miro-class security advisory, audited: shipped substrate (SSO/SCIM/TOTP/audit/MCP scoping) and the S0–S5 gaps (classification, org policy, provider policy, encryption/residency, retention)                                                    |
| 24  | [24-structural-change-plan.md](./24-structural-change-plan.md)                 | Implementation plan for the docs/22+23 audit gaps: phases A–H (classification → org policy → provider policy; meeting modes/connectors/diarization; encryption/residency; retention) with seams, gates, and sequencing                                    |
| 25  | [25-voice-platform.md](./25-voice-platform.md)                                 | The voice-model advisory, audited: production-paste disposition, TTS/response-policy/voice-loop gaps, the audio-egress security analysis, costed slices V1–V5 with gates                                                                                  |
| 26  | [26-the-connected-loop.md](./26-the-connected-loop.md)                         | **The plan (proposed 2026-09):** the product loop mapped onto the code — audit, fix-first defects, the seven joins, the visual engine v2 (icons, Vector Studio), meetings lifecycle, roadmap and open decisions                                           |
| 27  | [27-miro-granola-parity.md](./27-miro-granola-parity.md)                       | **Accepted 2026-09-24:** what Miro and Granola/Otter really do, and Lucent's answer — new diagram families as semantic kinds (timeline, matrix, state machine…), Mermaid and sticky clustering, and Granola-style meeting notes with cited AI enhancement |
| 28  | [28-meeting-screens.md](./28-meeting-screens.md)                               | **Proposed 2026-09-27:** the A3 meeting surfaces as twelve screens — every state (loading, empty, refused, degraded, failed), action and destination, what exists today, the defects the audit found (F13–F25), a build order and the decisions it needs  |
| 29  | [29-ai-native-platform-roadmap.md](./29-ai-native-platform-roadmap.md)         | **Approved:** AI-native platform evolution roadmap — slash commands, workspace architectural rules, canvas micro-actions, code/spec ingestion, production code export, model/thinking telemetry |
| 30  | [30-autonomous-repository-exploration-product-innovation-audit.md](./30-autonomous-repository-exploration-product-innovation-audit.md) | **Audit 2026-10-09:** Autonomous repository exploration, product innovation & engineering opportunity audit — verified architecture, P0/P1 defect analysis, 10 improvements, 10 feature ideas, unexpected directions, cross-cutting opportunities & roadmap |
| —   | [checklist.md](./checklist.md)                                                 | **Audited current status**, feature by feature. The source of truth.                                                                                                                                                                                      |

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
