# 1. Executive UX Assessment

**Lucent has many of the necessary capabilities, but it does not yet present them as one continuous workflow. This is not primarily an onboarding problem.** A user can start work in one view, lose navigation in another, and have the result, approval, or error appear somewhere else.

**Overall diagnostic score: 4/10.** This is an expert assessment of workflow coherence and trust, not a usability-study result, a visual-design grade, or an average of feature completeness. The strongest product foundations are substantially better than this score; the handoffs between them are not.

**Three strongest aspects**

1. The core is genuinely editable and semantic: validated operations, deterministic layout, local inverse-operation history, typed statements, and multiple representations—not a static image generator.
2. Useful contextual navigation already exists. In the live sample, searching “pricing” found the correct objects and returned to the selected canvas node. Execution attention items also returned to their canvas objects.
3. Trust infrastructure exists: generation phases/cancellation, durable proposals, citations, provenance views, external previews, human approval, and per-item execution outcomes. The task is to connect and correct these systems, not invent them.

**Three biggest weaknesses**

1. **Workflow continuity:** Intelligence and Execution omit the shared navigation shell. Plan generation and meeting proposals lack an in-place path through progress, review, and completion.
2. **Intent and consent consistency:** Ask, Build, voice, selection, proposal review, and external approval do not always share the same behavioral contract.
3. **Identity and durability:** switching local/shared boards can retain the previous live session; meeting capture durability depends on extraction; Projects does not expose the shared-board system coherently.

**One-sentence diagnosis:** Lucent is organized around implemented capabilities rather than around a user's continuing task, board identity, and next decision.

### Evidence and scope

Audit date: **2026-09-12**. Target: current working tree at `D:/lucent`, including pre-existing uncommitted layout/benchmark changes. No product source, dependencies, configuration, or existing board content was edited by this audit.

Evidence labels throughout:

- **LIVE:** observed in the running interface through its rendered accessibility tree, DOM, or rule-engine result.
- **CODE:** implementation trace; not necessarily reproduced at runtime.
- **HISTORICAL:** an existing dated evaluation, not a new measurement.
- **UNTESTED:** a requested case not completed; never counted as a pass.

Live sample: signup and session entry, empty hero/tour, failed first generation and recovery, selected three-node canvas, empty Intelligence, populated Execution, attention-to-canvas navigation, Meeting ready state, shared History, Search→object, Why→provenance dialog, and the populated canvas at 1440/1280/1024/768/390 CSS-pixel widths. Desktop/tablet height was 900 for responsive sampling; initial first-use sampling was 1280×720. Two states received in-page axe scans.

**Coverage limitation:** this is a broad source-led audit with sampled live interaction evidence, not a completed exhaustive visual acceptance pass. Screenshot capture succeeded, but this session's image transport omitted the image from the model, so visual appearance was not judged. All requested large-board sizes were not rendered live. Actual microphone capture, provider-backed generation quality, two-user collaboration, external writes, all error combinations, all translations, and assistive-technology use were not tested. Those omissions are not evidence of failure or success.

The first-generation request on `127.0.0.1:5173` failed with `csrf rejected`. The configured default allowed frontend origin is `localhost:5173`; the origin mismatch explains this test failure and is **not** evidence that generation generally fails. The product finding is that the persisted error/retry disappeared behind the hero. On `localhost`, an existing workspace was found and was inspected without editing its content, sending AI prompts, recording audio, or publishing work. A separate disposable audit account/project was used on the first origin.

Full typecheck and unit tests were not run: no product implementation was changed. The canvas research validated 56 fixture factory/size combinations in memory for schema/count/position integrity; that is not a rendered readability test.

# 2. Product UX Architecture

### Current mental model

The implementation has three competing organizing systems:

1. **Artifact representation:** Canvas, Kanban, Document, Wireframe, Sequence, ER.
2. **Knowledge/work lifecycle:** Meeting, History, Intelligence, Execution.
3. **Container and administration:** local projects, shared boards, organization membership, billing, integration connections.

Each system is legitimate. Their presentation at the same navigation level, together with inconsistent identity and handoffs, is the problem. A view switch sometimes means “show the same model differently,” sometimes “enter a different activity,” and sometimes “lose the controls needed to continue.”

### Current navigation model

Authentication uses real paths (`/login`, `/signup`, `/reset`, `/verify`, `/invite`). Workspace views are React state reflected into `?view=` and `?lens=` using `replaceState`; the query initializes the view on mount rather than representing a browsable journey. Most views own their own header/rail instead of inheriting a stable shell. Intelligence and Execution do not mount that shell.

Evidence: [App.tsx:53–137](D:/lucent/packages/web/src/App.tsx), [routes.ts:180–207](D:/lucent/packages/web/src/routes.ts), [workspace.tsx:500–538](D:/lucent/packages/web/src/workspace.tsx).

**LIVE:** entering empty Intelligence produced only “Intelligence,” “0 statements,” explanatory text, and “Recommendations.” No navigation buttons remained. Browser Back changed the URL to `/` while the Intelligence content remained. This is a concrete workflow dead end, not merely an icon-discoverability concern.

### What works

- One semantic workspace can support different representations without duplicating its underlying meaning.
- Search and attention can focus relevant objects instead of forcing users to find them manually.
- Meeting evidence, revision history, semantic statements, and task status are represented separately in the model.
- Existing Board Tools and the contextual HUD already provide places for progressive disclosure.

### What is confusing

- “Board” can mean project container, visual canvas, or Kanban representation.
- The top-bar **Present** enters Meeting, while the canvas **Present** starts a walkthrough. Mobile presentation uses frames; desktop walkthrough uses nodes.
- “Ask Lucent” labels a composer that defaults to Build; voice bypasses its Ask choice.
- “Open” can describe a semantic action statement even when the associated work is blocked or in progress.
- Shared-board history is an audit timeline; local history is a restore surface. Their common label conceals different promises.
- “Personal” is hardcoded in important chrome while different subsystems choose organization context differently.
- Shared boards unlock Ask and durable meetings, yet Projects primarily lists localStorage projects.

### Recommended conceptual model

**Keep the board as the persistent context, not as one sibling tool among many.** Every surface should retain the board identity and a reliable return to its current work.

- **Board:** current editable model. Its representations are views of that model, not new destinations with separate composers.
- **Meeting:** captured source evidence and its extraction/review state.
- **History:** what changed, by whom, and when; identify whether a particular entry is inspectable or reversible.
- **Intelligence:** current interpreted statements, uncertainty, and their evidence—not a second board or a generic analytics page.
- **Search:** find an object, source, or command without silently changing the board.
- **Ask:** explain the current context, read-only unless the user explicitly changes intent.
- **Execution:** act on accepted work, inspect blockers and delivery, and review external changes. Kanban is a representation of this work.
- **Integrations:** configuration and delivery destinations; not another unexplained status vocabulary.

The intended user progression is **describe/capture → inspect result → resolve uncertainty → choose work → review consequences → track outcome**. It must be possible to enter or leave at any stage; this is not a forced wizard.

**Primary-job hierarchy:** current work first; next relevant decision second; advanced tools and administrative detail on demand. Preserve evidence and review alongside the task that created them.

# 3. Screen Inventory

### Reading the inventory

Scores are provisional primary-job/workflow scores. They are not visual preference scores. `—` means insufficient evidence for a useful independent score. **KEEP** retains a distinct task; **MERGE** consolidates presentation/entry points, not data loss; **SIMPLIFY** retains the capability with clearer scope; **HIDE** applies to misleading/inert controls, not working features.

For each entry below: purpose/primary action, entry and exit, secondary tasks, important states/dependencies, and disposition are recorded. Missing explicit states are identified rather than invented. State abbreviations: E empty, L loading, X error, S success, P permission, O offline/reconnecting.

### Entry and identity screens

| Screen                       | Primary job and CTA; secondary tasks                    | Entry/exit and state coverage                                                                                          | Score / disposition            |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Session boot                 | Establish session; no user CTA                          | Startup→auth/app; L explicit; network failure falls back to cached auth or anonymous, not a distinct recovery screen   | 6 / KEEP                       |
| Sign in / Signup             | Authenticate/Create account; reset and configured OAuth | Real paths; busy, field/server errors, success→app; OAuth conditional                                                  | 7 / KEEP                       |
| Two-factor challenge         | Verify code; use recovery code/different account        | Login step; busy/invalid/reset states; no enrollment here                                                              | 6 / KEEP                       |
| Reset request / confirmation | Request link / set password                             | Token paths; validation, working, sent/success/error; return to sign in                                                | 7 / KEEP                       |
| Verification                 | Redeem token                                            | Automatic L/S/X/missing token; recovery mentions a resend path absent from Account                                     | 4 / SIMPLIFY recovery          |
| Organization invitation      | Join organization, then Open Lucent                     | Sign-in dependency; joining/S/X/missing token; signup detour risks continuation; destination promises shared boards    | 4 / KEEP, repair continuation  |
| Projects                     | Open project / New workspace; filter/search/import      | Logo/rail/palette→Canvas; local-only list; E conflates no projects/no filter matches; Shared/Templates misleading      | 4 / SIMPLIFY                   |
| Import                       | Import a file as a fresh project                        | Dashboard chooser→Canvas; parse/unsupported failures via toast; no persistent importing state; socket-isolation hazard | 4 / KEEP after identity repair |

Sources: [AuthView.tsx:141–638](D:/lucent/packages/web/src/views/AuthView.tsx), [session.ts:374–387](D:/lucent/packages/web/src/session.ts), [DashboardView.tsx:39–233](D:/lucent/packages/web/src/views/DashboardView.tsx).

Projects also contains hardcoded “Alex,” a fixed Recents count, kind-based decorative previews rather than actual board thumbnails, and clickable cards without keyboard semantics. Shared does not fetch server boards; Templates returns an empty set despite a working picker elsewhere. These are information-honesty problems, not reasons to create a new dashboard.

### Core screens and representations

| Screen                | Primary job and CTA; secondary tasks           | Entry/exit and states/dependencies                                                                      | Score / disposition                   |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Empty canvas          | Describe→Begin; Speak, examples, blank board   | Auth/new project; prompt cleared on send; failed-generation recovery absent from hero; Attach is a stub | 5 / KEEP, simplify                    |
| Tour                  | Explain describe→appear→refine                 | Hero, once per browser; Next/Back/Skip; no replay                                                       | 6 / SIMPLIFY; not the main remedy     |
| Visual canvas         | Construct/edit current model                   | Main work surface; E/generating/voice/proposal/editor/viewer/O; many concurrent control clusters        | 6 / KEEP central                      |
| Composer/conversation | Build or Ask; voice/retry/fix/citations        | Canvas bottom; messages collapsed; quota/error/retry tied to this mount; viewer Ask hidden              | 4 / MERGE submission contracts        |
| Meeting               | Capture and save evidence                      | Rail/top Present; READY/recording/saved/toast X; leaving stops mic; review lives elsewhere              | 4 / KEEP, repair handoffs             |
| Intelligence          | Review current statements; Plan from selection | Rail/palette/query; E/categories/settled/recommendations; no shell/back/progress/review                 | 3 / KEEP, repair first                |
| Execution             | Understand work, blockers, delivery            | Rail/query; E instruction cannot be acted on; connection/link L/X largely hidden; no shell/back         | 3 / MERGE navigation with work/Kanban |
| Local History         | Inspect version→Restore; undo/redo             | Rail; E/timeline/preview; Compare stub; history rebuilt on project load                                 | 5 / KEEP with explicit scope          |
| Shared History        | Inspect authoritative revisions→object/source  | Same entry; initial L resembles E; error/reopen, depth limits; no local-style restore                   | 6 / KEEP, distinguish promises        |
| Kanban                | Move issues through work status                | Lens; drag/arrows; E guide; no card details/reveal; viewer affordance remains until downstream refusal  | 5 / MERGE with Execution journey      |
| Document              | Read derived board outline                     | Lens; E guide; no direct edit; “question” composer dispatches Build and leaves lens                     | 5 / KEEP as representation            |
| Wireframe             | Read/refine structured wireframe               | Lens; only first wireframe displayed; E examples; send returns to visual canvas                         | 4 / KEEP, repair return target        |
| Sequence              | Read derived actors/messages                   | Lens; E/sample clearly labeled; changes via prompt leave lens                                           | 5 / KEEP as representation            |
| ER                    | Read entities/attributes/relations             | Lens; E guide; no direct editor; prompt leaves lens                                                     | 5 / KEEP as representation            |

Sources: [CanvasView.tsx:1640–2233](D:/lucent/packages/web/src/views/CanvasView.tsx), [AIPill.tsx:89–500](D:/lucent/packages/web/src/ui/AIPill.tsx), [MeetingView.tsx:78–827](D:/lucent/packages/web/src/views/MeetingView.tsx), [IntelligenceView.tsx:58–762](D:/lucent/packages/web/src/views/IntelligenceView.tsx), [ExecutionView.tsx:62–486](D:/lucent/packages/web/src/views/ExecutionView.tsx), [HistoryView.tsx:118–724](D:/lucent/packages/web/src/views/HistoryView.tsx), [BoardView.tsx:24–268](D:/lucent/packages/web/src/views/BoardView.tsx), [DocumentView.tsx:11–114](D:/lucent/packages/web/src/views/DocumentView.tsx), [WireframeView.tsx:18–179](D:/lucent/packages/web/src/views/WireframeView.tsx), [SequenceView.tsx:13–200](D:/lucent/packages/web/src/views/SequenceView.tsx), [ErView.tsx:10–103](D:/lucent/packages/web/src/views/ErView.tsx).

A completely empty workspace shows the hero even after selecting a different lens. Lens-specific empty instructions are therefore not always reachable. Lens composers also omit the main composer's mode, voice, busy, citation, and read-only contracts.

### Panels, overlays, navigation, and utilities

| Surface                    | Job / main action                    | Entry, exit, states and issues                                                                       | Disposition                     |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| Top bar                    | Orient/share/present                 | Logo→Projects; static Personal/A-01; top Present→Meeting; Admin/Analytics always exposed             | SIMPLIFY                        |
| Navigation rail            | Switch activity/representation       | Changes side between hero/lenses and populated canvas; 13 entries; absent in two key views           | SIMPLIFY, stabilize             |
| New-workspace confirmation | Keep working / New workspace         | Rail with content; safe initial focus; other New entries differ; does not guarantee session teardown | KEEP consistently               |
| Command/Search             | Find object/source/command           | Rail/shortcut; Esc; shared async search; no-match Enter builds; Ask bridge can hide answer           | SIMPLIFY intent boundaries      |
| Shape toolbar              | Arm manual tool                      | Populated editor canvas; 16 actions; viewer hidden; media uses native prompts                        | KEEP secondary                  |
| Node HUD                   | Explain/transform/expand/comment/why | Selected node; trailing inert unnamed button; node-local Transform changes board kind                | SIMPLIFY scope                  |
| Statement editor           | Set kind/status/topic/supersession   | HUD popover; duplicate choice; validation refusal lacks local explanation                            | KEEP shared pattern             |
| Why this?                  | Explain origin→source                | Node HUD; Close/Copy quote/Undo; false manual-origin fallback and global Undo scope                  | KEEP, correct trust             |
| Shape inspector            | Style/order/duplicate/group/lock     | Selection; multi-select variants; selection change exits                                             | KEEP                            |
| Connector inspector        | Route style/arrows/delete            | Selected manual connector, not semantic edges; deselect exits                                        | KEEP                            |
| Context menu               | Shape edit/order/visibility/delete   | Right-click; arrows/Esc/outside; disabled by selection scope                                         | KEEP                            |
| Board Tools                | Polish/templates/timer/voting        | Menu; busy/empty disabling; good consolidation already                                               | KEEP                            |
| Template gallery           | Choose and insert template           | Tools, not dashboard Templates; team L/X/E; no matching save-template UI                             | MERGE entries                   |
| Proposal panel             | Review→Apply all/Cancel              | Canvas-only; op list/partial preview; no durable local busy/error completion state                   | KEEP, repair                    |
| Needs attention            | Choose next relevant item            | Canvas count→drawer; pending/skipped/blocked/offline; inbound review not fed into same queue         | MERGE attention access          |
| Topic recommendations      | Review duplicate→merge/keep          | Intelligence; preview/X/empty; Keep separate session-local                                           | KEEP                            |
| External-change queue      | Accept remote / Keep ours            | Intelligence; statuses, busy, source link; decision errors/refresh incomplete                        | MERGE with work attention       |
| External-send panel        | Preview→approve/reject               | Provider buttons; frozen proposal, loss acknowledgment, partial results; setup not self-service UI   | KEEP; repair payload fidelity   |
| Share                      | Publish/copy editor/viewer link      | Top bar; local/publishing/live/connecting/O; owner roles/revoke; raw IDs, silent list failures       | KEEP                            |
| Presence/sync              | Know collaborators/connectivity      | Passive canvas overlays; no Follow; selection conflict banner                                        | KEEP                            |
| Comment thread             | Read/reply/resolve                   | Pin/HUD/inbox; drafts survive failure; viewer thread mounting incorrectly tied to editability        | KEEP, separate read/write       |
| All comments / Mentions    | Find feedback                        | Separate canvas lists/popups; empty/count/resolved states; account notifications separate            | MERGE framing, retain scope     |
| Account notifications      | Read/mark/follow activity            | Bell; L/X/retry/E/pagination/rollback; following reloads app                                         | KEEP; reuse state pattern       |
| Voting/reactions           | Workshop prioritization              | Tools/selection; active/results/reset; mode local, votes persisted                                   | KEEP secondary                  |
| Timer                      | Start/pause/reset                    | Tools; local presets/countdown/done; navigation loses timer                                          | KEEP with honest scope          |
| Edit/Focus/Present         | Change manipulation/attention mode   | Canvas; keyboard walkthrough/exit; not top-bar Meeting                                               | MERGE Present language          |
| Zoom / Minimap             | Navigate spatial model               | Corners; fit/reset/drag; bounds-dependent and suppressed in some states                              | KEEP                            |
| Export / Mermaid           | Save representation/import text      | Hover menu/native prompts/print; no equivalent click/focus menu opening                              | KEEP, accessible menu           |
| Voice overlay              | Show interim capture                 | Composer-driven; no independent task exit                                                            | KEEP                            |
| Toast / allowance          | Status/recovery/upgrade              | Toast expires ~2.6s; allowance requires composer; cannot be sole failure channel                     | KEEP, persist actionable errors |

Evidence anchors: [Chrome.tsx:39–789](D:/lucent/packages/web/src/ui/Chrome.tsx), [CommandOverlay.tsx:73–311](D:/lucent/packages/web/src/ui/CommandOverlay.tsx), [ShapeToolbar.tsx:61–162](D:/lucent/packages/web/src/ui/ShapeToolbar.tsx), [CanvasView.tsx:1801–2233](D:/lucent/packages/web/src/views/CanvasView.tsx), [WhyThis.tsx:10–117](D:/lucent/packages/web/src/views/WhyThis.tsx), [ShapeInspector.tsx:158–313](D:/lucent/packages/web/src/views/ShapeInspector.tsx), [LinkInspector.tsx:19–61](D:/lucent/packages/web/src/views/LinkInspector.tsx), [ContextMenu.tsx:27–165](D:/lucent/packages/web/src/views/ContextMenu.tsx), [TemplatePicker.tsx:18–181](D:/lucent/packages/web/src/views/TemplatePicker.tsx), [ProposalPanel.tsx:7–109](D:/lucent/packages/web/src/views/ProposalPanel.tsx), [AttentionPanel.tsx:26–95](D:/lucent/packages/web/src/views/AttentionPanel.tsx), [IntegrationPanel.tsx:79–473](D:/lucent/packages/web/src/views/IntegrationPanel.tsx), [Comments.tsx:54–385](D:/lucent/packages/web/src/views/Comments.tsx), [NotificationTray.tsx:58–295](D:/lucent/packages/web/src/ui/NotificationTray.tsx), [Engagement.tsx:27–139](D:/lucent/packages/web/src/views/Engagement.tsx), [TimerWidget.tsx:9–80](D:/lucent/packages/web/src/views/TimerWidget.tsx), [PresentMode.tsx:28–103](D:/lucent/packages/web/src/views/PresentMode.tsx), [Minimap.tsx:27–144](D:/lucent/packages/web/src/views/Minimap.tsx), [Toast.tsx:25–49](D:/lucent/packages/web/src/ui/Toast.tsx).

### Settings, organization, mobile, and auxiliary surfaces

| Surface             | Primary job / CTA and relevant states | Main problem / disposition                                                                                                |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Profile menu        | Identity/preferences/plan/sign out    | Shortcuts inert; legacy inline auth duplicates routed auth; sign-out lifetime issue / SIMPLIFY                            |
| Account             | Inspect/edit identity                 | Display-name edit has no save; resend recovery absent / SIMPLIFY                                                          |
| Appearance          | Theme/accent/reduced motion           | Real local settings; system theme change subscription missing / KEEP                                                      |
| Canvas preferences  | Grid/style/autosave                   | Activity toggle lacks consumer / KEEP real settings, HIDE inert                                                           |
| AI & voice          | Provider/privacy/approval settings    | Real provider options; language buttons and sound setting inert; Always review promise mismatches gate / SIMPLIFY         |
| Shortcuts           | Learn commands                        | Scope differs from “global” presentation / KEEP accurate reference                                                        |
| Team                | Invite/manage people                  | Hardcoded people; Send invite inert / HIDE placeholder, MERGE real org management                                         |
| Plan & usage        | Understand plan, usage, billing       | Useful L/X/unconfigured states; pane-local org selection; upgrade may return to same pane / KEEP                          |
| Support             | Copy diagnostics                      | Calls workspace context outside provider / KEEP after crash repair                                                        |
| Admin               | Inspect roster/audit                  | First membership selected; 25 events; permission failure may resemble no activity; missing advertised settings / SIMPLIFY |
| Analytics           | Read usage trends                     | Org selection differs; unavailable can resemble zero; secondary to core work / MERGE under administration                 |
| Mobile board        | Read/comment/present                  | Populated <720px gate removes Build/Ask/navigation/lenses; first-30 comment targets / SIMPLIFY explicitly                 |
| Mobile presentation | Read frame slides                     | Different presentation unit from desktop / MERGE semantics                                                                |
| Marketing site      | Explain value/install                 | Separate static site, not app route; demo CTA scrolls to commands; claims need implementation alignment / SIMPLIFY        |
| Status page         | Read service status                   | Human-maintained, not live telemetry / KEEP with freshness disclosure                                                     |
| Reference prototype | Historical design exploration         | Hardcoded examples, not deployed feature evidence / exclude from product workflow claims                                  |

Sources: [ProfileMenu.tsx:19–233](D:/lucent/packages/web/src/ui/ProfileMenu.tsx), [Settings.tsx:118–979](D:/lucent/packages/web/src/ui/Settings.tsx), [settings.ts:99–118](D:/lucent/packages/web/src/settings.ts), [AdminView.tsx:51–181](D:/lucent/packages/web/src/views/AdminView.tsx), [AnalyticsView.tsx:35–180](D:/lucent/packages/web/src/views/AnalyticsView.tsx), [MobileBoardView.tsx:28–352](D:/lucent/packages/web/src/views/MobileBoardView.tsx), [site/index.html:32–191](D:/lucent/packages/site/index.html), [site/status.html:11–37](D:/lucent/packages/site/status.html), [reference/components/app.jsx:3–119](D:/lucent/reference/components/app.jsx).

No usage analytics were collected. “Rarely used” is therefore not asserted. No working primary screen warrants removal merely because its current implementation is weak. **UX-IA-001** applies most directly to the misleading Team placeholder and to Execution's unresolved relationship with Kanban—not to the underlying jobs of understanding knowledge or tracking work.

### Screen scorecard

All numeric dimensions are provisional expert judgments based on CODE/LIVE evidence. **VH is not rated** because rendered images could not be inspected. Accessibility numbers express observed/source interaction readiness, not WCAG conformance. “Load” means ease under cognitive load: higher is better. Final is a holistic primary-job score, not an average that hides blockers.

| Screen            | Clarity |  VH | Discovery | Interaction | Consistency | Load | A11y | States | Navigation | Product fit | Final |
| ----------------- | ------: | --: | --------: | ----------: | ----------: | ---: | ---: | -----: | ---------: | ----------: | ----: |
| Auth/reset        |       8 |   — |         7 |           7 |           7 |    8 |    6 |      7 |          7 |           7 |     7 |
| Projects          |       4 |   — |         5 |           4 |           4 |    5 |    3 |      4 |          5 |           6 |     4 |
| Empty board       |       8 |   — |         7 |           5 |           5 |    7 |    5 |      2 |          6 |           9 |     5 |
| Canvas            |       6 |   — |         5 |           6 |           5 |    4 |    3 |      5 |          6 |          10 |     6 |
| AI Build/Ask      |       4 |   — |         6 |           4 |           3 |    5 |    4 |      4 |          4 |          10 |     4 |
| Meeting           |       6 |   — |         6 |           4 |           4 |    5 |    5 |      3 |          5 |           9 |     4 |
| Intelligence      |       5 |   — |         4 |           3 |           3 |    4 |    4 |      3 |          1 |           8 |     3 |
| Execution         |       5 |   — |         4 |           3 |           3 |    5 |    4 |      3 |          1 |           8 |     3 |
| History           |       6 |   — |         6 |           5 |           4 |    6 |    5 |      4 |          6 |           8 |     5 |
| Search            |       6 |   — |         6 |           6 |           4 |    6 |    5 |      4 |          7 |           8 |     6 |
| Kanban            |       6 |   — |         5 |           5 |           4 |    6 |    5 |      4 |          5 |           8 |     5 |
| Document          |       7 |   — |         5 |           5 |           4 |    7 |    5 |      5 |          5 |           8 |     5 |
| Wireframe         |       5 |   — |         5 |           4 |           4 |    6 |    4 |      4 |          4 |           8 |     4 |
| Sequence / ER     |       6 |   — |         5 |           5 |           4 |    6 |    4 |      5 |          5 |           8 |     5 |
| External review   |       6 |   — |         3 |           4 |           4 |    5 |    4 |      5 |          4 |           8 |     4 |
| Share/comments    |       6 |   — |         6 |           5 |           5 |    6 |    4 |      5 |          6 |           8 |     5 |
| Preferences       |       4 |   — |         6 |           3 |           4 |    5 |    3 |      4 |          5 |           6 |     4 |
| Admin / Analytics |       5 |   — |         6 |           4 |           4 |    6 |    4 |      4 |          6 |           5 |     4 |
| Populated mobile  |       4 |   — |         3 |           3 |           3 |    6 |    3 |      4 |          1 |           4 |     3 |

The low scores are justified by concrete handoff failures: shell-less views, hidden first-error recovery, mode mismatch, broken source selection, inaccessible widgets, and missing scope continuity. Higher product-fit scores acknowledge the value of the underlying capabilities.

# 4. Critical Findings

Only P0/P1 findings appear here. Complexity: S localized, M several components, L cross-layer/state-lifecycle change. Confidence refers to the identified mechanism, not user-study validation. No live destructive or external-write experiment was performed.

### P0-CO-001 — New/open/import can retain the previous shared-board session

- **Screen/flow:** shared board→New workspace/open local project/import/build on new board.
- **Observation / evidence:** CODE. New/open clear displayed board ID and saved pointer but not `syncRef`; import/new-board generation retain still more context. `commitAndShare` continues to submit through that ref. Disconnect occurs on connection replacement or provider teardown. [workspace.tsx:615–616, 808–818, 1541–1575, 1595–1617, 1640–1698](D:/lucent/packages/web/src/workspace.tsx).
- **Affected user / impact:** collaborators switching boards may believe an edit is local while a previous shared session remains active. Potential wrong-board writes are dangerous enough to block release until verified.
- **Principles:** Nielsen error prevention, system-status visibility; Shneiderman locus of control.
- **Root cause:** visual project identity and transport/session identity have different lifetimes.
- **Direction / benefit:** one atomic board-context transition, including socket, permissions, pending work, URL and current organization. Users can trust which board they are changing.
- **Severity / confidence / complexity:** P0 release-blocking risk; high confidence in retained-state mechanism, runtime write outcome untested; L.

### P1-IA-001 — Intelligence and Execution interrupt navigation and task completion

- **Evidence:** LIVE empty Intelligence has zero navigation controls; browser Back does not restore the previous workspace view. CODE both views omit shell; query uses replaceState. [App.tsx:85–114](D:/lucent/packages/web/src/App.tsx), [IntelligenceView.tsx:173–228](D:/lucent/packages/web/src/views/IntelligenceView.tsx), [ExecutionView.tsx:112–145](D:/lucent/packages/web/src/views/ExecutionView.tsx).
- **User / impact:** everyone inspecting knowledge or work; empty views strand them, Plan results appear elsewhere.
- **Principles:** IA contextual navigation, Nielsen control/recognition/status, Shneiderman closure.
- **Root:** each view owns its shell and task feedback independently.
- **Direction / benefit:** persistent board navigation plus in-place progress→review→result; reliable return from every state.
- **Severity / confidence / complexity:** P1; high LIVE+CODE; M.

### P1-RF-001 — A failed first generation hides its own recovery

- **Evidence:** LIVE Begin→Understanding→hero with cleared input; opening blank board and message history reveals `Generation failed: csrf rejected` and Try again. The origin mismatch caused this test error; the disappearance is the UX defect. [CanvasView.tsx:1644–1684,2146–2167](D:/lucent/packages/web/src/views/CanvasView.tsx), [workspace.tsx:1164–1195](D:/lucent/packages/web/src/workspace.tsx).
- **User / impact:** first-time creators cannot tell whether input was lost, rejected, or completed.
- **Principles:** Nielsen visibility/error recovery; Shneiderman informative feedback/closure.
- **Root:** empty content selects the welcome screen even after an attempted task.
- **Direction / benefit:** retain input and explicit attempt state on the initiating surface; explain what was preserved and offer Retry. Prevent repeated blind submissions.
- **Severity / confidence / complexity:** P1; high LIVE+CODE; M.

### P1-AI-001 — Read-only intent is not preserved across input methods

- **Evidence:** CODE typed Ask dispatches `ask`; voice final always dispatches `send(t)` and omits selection/attachments. Lens question prompts also dispatch Build. [CanvasView.tsx:519–568](D:/lucent/packages/web/src/views/CanvasView.tsx), [DocumentView.tsx:11–25](D:/lucent/packages/web/src/views/DocumentView.tsx).
- **User / impact:** voice users may request explanation and receive board mutation; viewers lose an otherwise supported Ask capability.
- **Principles:** Nielsen consistency/error prevention, human control, mode-error prevention.
- **Root:** separate submission handlers define incompatible intent contracts.
- **Direction / benefit:** text, voice, search and lenses must carry the same explicit intent and context; never silently promote Ask to Build.
- **Severity / confidence / complexity:** P1; high CODE, speech not live-tested; M.

### P1-AI-002 — Approval protection is count-based rather than consequence-based

- **Evidence:** CODE approval checks threshold and existing semantic nodes; a single destructive operation can auto-apply, and Always review does not apply to a node-less board. The separate meeting safety gate is not on the live dispatch path. [workspace.tsx:307–311,1065–1074,1152–1162](D:/lucent/packages/web/src/workspace.tsx), [meeting-extract.ts:84–133](D:/lucent/packages/web/src/meeting-extract.ts), [Settings.tsx:700–726](D:/lucent/packages/web/src/ui/Settings.tsx).
- **User / impact:** anyone relying on review settings; displayed protection is stronger than actual protection.
- **Principles:** Nielsen error prevention, Shneiderman control/reversal, informed consent.
- **Root:** policy and dispatcher diverged; operation count substitutes for impact.
- **Direction / benefit:** one impact-aware gate for all entry points, with labels matching enforcement. Preserve quick reversible small edits.
- **Severity / confidence / complexity:** P1; high CODE; M.

### P1-MT-001 — Ending or leaving a meeting can outrun transcript persistence

- **Evidence:** CODE appends follow extraction; Stop ends server transcript without flushing/awaiting all turns; ended transcripts refuse appends; component unmount stops mic and loses remaining local state. [MeetingView.tsx:160–167,241–282,301–337](D:/lucent/packages/web/src/views/MeetingView.tsx), [server/routes/meetings.ts:85–123](D:/lucent/packages/server/src/routes/meetings.ts).
- **User / impact:** facilitators can lose late source evidence precisely when ending or checking the board.
- **Principles:** Nielsen error prevention, Shneiderman closure, capture reliability.
- **Root:** source durability depends on interpretation and view lifetime.
- **Direction / benefit:** persist capture independently; end must acknowledge flush/checkpoint/close and preserve recoverable unsaved turns.
- **Severity / confidence / complexity:** P1; high CODE, microphone runtime untested; L.

### P1-MT-002 — “Extracted” does not reliably mean applied or reviewable

- **Evidence:** CODE extraction dequeues turns before `send()`, whose void return can represent busy/no-op or internally caught failure. Caller then says Extracted N turns. Pending review is not visible in Meeting. [MeetingView.tsx:301–341,559–568](D:/lucent/packages/web/src/views/MeetingView.tsx), [workspace.tsx:898–899,1085–1088,1164–1195](D:/lucent/packages/web/src/workspace.tsx).
- **User / impact:** facilitators misread extraction completeness and can lose retryable batches.
- **Principles:** Nielsen visibility/recovery, Shneiderman informative feedback.
- **Root:** no explicit outcome contract between capture and generation.
- **Direction / benefit:** distinguish captured, processing, proposed, applied, failed and waiting; retain failed/pending batches and review without leaving capture.
- **Severity / confidence / complexity:** P1; high CODE; M–L.

### P1-EX-001 — “Plan from selection” does not send those sources as model context

- **Evidence:** CODE selected IDs live in `attachments.plan`, but request serialization sends images/documents and separate selection, not `plan`. The response is subsequently stamped with the selected IDs. The plan operation allowlist also permits `SET_STATEMENT` effects broader than its anti-conversion promise. [IntelligenceView.tsx:173–177](D:/lucent/packages/web/src/views/IntelligenceView.tsx), [api.ts:426–467](D:/lucent/packages/web/src/api.ts), [workspace.tsx:1027–1031](D:/lucent/packages/web/src/workspace.tsx), [planGate.ts:24–63](D:/lucent/packages/web/src/planGate.ts).
- **User / impact:** planners can receive work grounded in different content while source attribution implies the chosen statements.
- **Principles:** Nielsen match/control, provenance integrity, recognition over recall.
- **Root:** selection is post-processing metadata rather than an end-to-end request constraint.
- **Direction / benefit:** carry explicit sources through generation and effect validation, then show source→proposed action in review.
- **Severity / confidence / complexity:** P1; high CODE; M.

### P1-AI-003 — Review preview, application result, and undo are not one contract

- **Evidence:** CODE preview covers additions more fully than deletions/renames/statements; shared approval closes panel before success; server can skip invalid operations without reporting them in success; approved remote commits do not enter local inverse history. [CanvasView.tsx:2240–2295](D:/lucent/packages/web/src/views/CanvasView.tsx), [workspace.tsx:618–634,1338–1374](D:/lucent/packages/web/src/workspace.tsx), [server/routes/proposals.ts:180–190,259](D:/lucent/packages/server/src/routes/proposals.ts), [operationHistory.ts:99–106](D:/lucent/packages/core/src/operationHistory.ts).
- **User / impact:** reviewers cannot confidently know what they approved, what actually happened, or how to reverse it.
- **Principles:** Nielsen visibility/control, Shneiderman closure/reversal.
- **Root:** proposal, request, commit and history are separately implemented states.
- **Direction / benefit:** accurate impact preview, persistent pending/error state, actual applied/skipped summary, explicit reversal path.
- **Severity / confidence / complexity:** P1; high CODE; L.

### P1-AI-004 — Provenance wording and local Undo overstate knowledge and scope

- **Evidence:** LIVE Why dialog offers Created by Lucent, source, Undo. CODE no provenance maps to “created by hand” although ordinary AI creation may lack provenance; node-local Undo invokes latest global undo; saved-meeting extraction omits provenance. [WhyThis.tsx:26–27,89–113](D:/lucent/packages/web/src/views/WhyThis.tsx), [workspace.tsx:997–1017](D:/lucent/packages/web/src/workspace.tsx), [MeetingView.tsx:405–413](D:/lucent/packages/web/src/views/MeetingView.tsx).
- **User / impact:** evidence reviewers can infer false authorship or undo unrelated work.
- **Principles:** Nielsen real-world match, trustworthy uncertainty, user control.
- **Root:** absence of evidence is treated as evidence of manual authorship; global action is placed in local context.
- **Direction / benefit:** say Origin not recorded; preserve actual actor/source when known; name the undo target precisely.
- **Severity / confidence / complexity:** P1; high CODE with partial LIVE; M.

### P1-IN-001 — External preview omits fields the executor can write

- **Evidence:** CODE update preview shows title/status/id; stored executable items also carry assignee/due date written by Linear/Jira adapters. [server/routes/integrations.ts:448–456,578–584,629](D:/lucent/packages/server/src/routes/integrations.ts), [integrations/integrations.ts:216–235](D:/lucent/packages/server/src/integrations/integrations.ts), [linear.ts:285–300](D:/lucent/packages/server/src/integrations/linear.ts), [jira.ts:258–277](D:/lucent/packages/server/src/integrations/jira.ts).
- **User / impact:** approvers cannot consent to every external field change.
- **Principles:** informed consent, Nielsen prevention/control.
- **Root:** preview is a lossy representation of executable payload.
- **Direction / benefit:** derive field-level before/after review from the frozen executable payload, including unsupported/lost fields.
- **Severity / confidence / complexity:** P1; high CODE; M. No external action sent during audit.

### P1-IN-002 — Incoming-change acceptance can apply a newer value than the reviewed one

- **Evidence:** CODE provider refresh mutates a pending row under the same ID; browser submits ID only; server accepts latest value. UI decision errors and peer refresh are incomplete. [inbound.ts:106–123](D:/lucent/packages/server/src/integrations/inbound.ts), [boards.ts:676–690](D:/lucent/packages/web/src/boards.ts), [server/routes/integrations.ts:782–812](D:/lucent/packages/server/src/routes/integrations.ts), [IntelligenceView.tsx:120–137](D:/lucent/packages/web/src/views/IntelligenceView.tsx).
- **User / impact:** reviewer may approve a status they never saw.
- **Principles:** Nielsen prevention/status, human control, consistency.
- **Root:** mutable queue identity is used as an immutable review snapshot.
- **Direction / benefit:** require reviewed-version/value precondition; show changed/stale review and explicit recovery.
- **Severity / confidence / complexity:** P1; high CODE; L.

### P1-AC-001 — Canvas focus and global shortcuts have inconsistent ownership

- **Evidence:** CODE Tab prevents default and wraps selection without moving DOM focus; Escape does not leave application. Global mutations ignore only INPUT/TEXTAREA, not dialogs/contenteditable/selects/alternate lenses. LIVE focus stayed on canvas application after Tab/Escape/Tab; browser key dispatch had earlier reliability issues, so full trap verification remains flagged. [CanvasView.tsx:259–276,400–473,819–830](D:/lucent/packages/web/src/views/CanvasView.tsx), [geometry.ts:212–252](D:/lucent/packages/web/src/board/geometry.ts).
- **User / impact:** keyboard users may be unable to traverse/exit predictably, and chrome actions may also trigger canvas operations.
- **Principles:** WCAG 2.1.1/2.1.2/2.4.3, Nielsen control, Shneiderman shortcuts.
- **Root:** selection, focus, input mode and overlay ownership are separate systems.
- **Direction / benefit:** one keyboard boundary with explicit exit, roving focus or active-descendant semantics, and overlay/editable guards.
- **Severity / confidence / complexity:** P1; high CODE, live operability flagged; M.

### P1-CV-001 — Collapsing regions can erase real cross-region relationships

- **Evidence:** CODE edge filter hides an edge when both endpoints are in any collapsed groups, including different groups. One-collapsed-end links retain hidden-node anchors; collapse does not reduce region extent. [DiagramLayer.tsx:181–227,330–364](D:/lucent/packages/web/src/ui/DiagramLayer.tsx).
- **User / impact:** readers of larger architecture/process boards see an inaccurate overview.
- **Principles:** Gestalt connectedness/continuity/common region; progressive disclosure must preserve meaning.
- **Root:** collapsing nodes is not accompanied by a derived aggregate graph.
- **Direction / benefit:** summaries must retain inter-region edges and navigable detail; overview reduces detail, not truth.
- **Severity / confidence / complexity:** P1; high CODE, visual effect untested; L.

### P1-UX-001 — Support recovery itself crashes

- **Evidence:** CODE SettingsModal is outside WorkspaceProvider; SupportPane calls `useWorkspace`, which throws without provider. [App.tsx:273–283](D:/lucent/packages/web/src/App.tsx), [Settings.tsx:961–979](D:/lucent/packages/web/src/ui/Settings.tsx), [workspace.tsx:1812–1815](D:/lucent/packages/web/src/workspace.tsx).
- **User / impact:** a user already encountering a problem can lose the app surface while seeking diagnostics.
- **Principles:** Nielsen help/recovery, Shneiderman error prevention.
- **Root:** global settings and board-scoped diagnostics have incompatible ownership.
- **Direction / benefit:** a safe diagnostics boundary that works with and without an active board.
- **Severity / confidence / complexity:** P1; high CODE, not intentionally crashed on existing user session; S–M.

# 5. Structural UX Problems

### Root cause A — No persistent task context

Symptoms: missing shell, plan result elsewhere, lens generation returns to visual canvas, browser Back does not retrace activity, rail changes position. Affected: Canvas, all lenses, Intelligence, Execution, History, Meeting. Principles: IA, Nielsen recognition/control, cognitive context-switch cost.

**Systemic direction:** keep board identity, navigation and current operation state independent of the active representation. Returning from review/evidence should restore the user's location, selection and intent—not simply default to visual canvas.

### Root cause B — Async operations have no common outcome language

Symptoms: first error hidden; Extracted despite failed/no-op generation; approval panel closes before success; inbound decision errors ignored; connection failure presented as no providers; History loading initially looks empty. Principles: visibility, closure, error recovery.

**Direction:** use one outcome vocabulary: idle, running, waiting for review, partially applied, applied, failed, cancelled, stale, offline. Every task retains initiating context, preserved data, actual outcome, and next action.

### Root cause C — Board, organization and permission identities are fragmented

Symptoms: local-only Projects versus server boards; static Personal; first-membership Admin versus pane-local billing org; retained socket on local switch; read-only Ask hidden while some lens edits remain offered. Principles: match, consistency, error prevention.

**Direction:** a single explicit context/capability model. Read permission and write permission are separate. Never use an empty list to disguise lack of permission or connection.

### Root cause D — Interpretation, acceptance, and execution lack a shared handoff

Symptoms: semantic action “open” versus issue blocked; plans lose selected sources; Intelligence initiates work without showing proposal; inbound provider review lives away from work ledger. Principles: IA taxonomy, semantic consistency, reduced memory burden.

**Direction:** keep separate state layers but show their relationship at the moment of decision. Do not solve this by flattening every status into one pill.

### Root cause E — Visibility heuristics do not share a meaning-preservation rule

Symptoms: collapsed relationships disappear; labels and nodes use different zoom thresholds; minimap does not aggregate; mobile uses a different renderer and removes lenses. Principles: Gestalt, progressive disclosure, recognition, cognitive load.

**Direction:** define one derived view model for visible detail, summaries, relationships, focus, keyboard traversal and alternative representations.

### Root cause F — Components share styling more than behavioral contracts

Symptoms: duplicated dialogs, incomplete focus lifecycles, hover-only export, inert controls, inconsistent disabled/error behavior. Principles: consistency, accessibility, Fitts/Hick, error prevention.

**Direction:** standardize actual consumer behavior before cosmetic token cleanup. Focus, keyboard, loading, disabled, error, success and destructive semantics are part of the component contract.

### State coverage matrix

| Surface       | Empty / loading                           | Partial / error / success                                          | Permission / offline / reconnecting                | Required direction                    |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------- |
| Hero          | Strong initial E; generation leaves hero  | X/retry hidden after return; success may land wrong representation | Quota/recovery lives in absent composer            | Attempt-aware empty state             |
| Canvas/AI     | Phase + cancel exists                     | Partial Fix these, chat X, proposal; completion fragmented         | Sync state exists; Ask/read-only mismatch          | Persistent result + recovery          |
| Meeting       | Ready explicit                            | Success can overstate extraction; late turns at risk               | Local/shared and capture/save dependencies unclear | Capture durability + outcome states   |
| Intelligence  | E explicit                                | Plan progress/review absent; inbound error hidden                  | No common shell/context                            | Review where initiated                |
| Execution     | E instruction but no action               | Sent ledger/cache not refreshed reliably                           | Provider failure/permission can resemble none      | Explicit capability + delivery state  |
| History       | Initial loading resembles no history      | Shared X recovery weak; local restore differs                      | Shared depth/availability dependent                | Identify history source and loading   |
| Search        | E/no match can appear before async result | Errors and fallback claims inconsistent                            | Shared mode disables local scan                    | Pending, unavailable, true no-results |
| Integrations  | Unconfigured/provider paths exist         | Frozen review, partial outcomes are strengths                      | Owner-only discovery obscures editor capability    | Separate setup/access/delivery        |
| Notifications | Good E/L                                  | X/retry/rollback and pagination                                    | Hidden when unavailable                            | Reuse this state discipline           |

### Flow scorecard and handoff map

Scores assess the implemented path, not a completed runtime trial. LIVE sampling is named; all other rows are CODE-led.

| Flow                              | Current path and biggest drop-off                                                                        | Score |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ----: |
| A First launch→first useful board | Clear hero; failed first request returns without visible recovery. LIVE failure branch                   |     5 |
| B Empty canvas→AI diagram         | Structured pipeline exists; success/readability/provider quality not live measured; error handoff weak   |     5 |
| C Generate→edit→undo              | Strong local inverse history; shared approval differs; global/local undo scope inconsistent              |     5 |
| D Voice→live board evolution      | Voice bypasses Ask/context; actual audio untested                                                        |     3 |
| E Meeting→Intelligence            | Capture→extract→statement exists; review/navigation interrupts capture; tail persistence risk            |     3 |
| F Decision→action                 | Typed statements and issue fields exist; acceptance and work lifecycle must be distinguished             |     5 |
| G Action/statements→plan          | Selected sources not transmitted correctly; plan review not visible where initiated                      |     2 |
| H Plan→external provider          | Frozen approval is strong; preview omits writable fields, provider discovery role mismatch               |     4 |
| I External change→Lucent review   | Separate incoming queue exists; stale reviewed-value race and silent decision errors                     |     3 |
| J Collaborator joins→edits→leaves | Role-bearing links/log present; context switching/sign-out lifetime risks; no two-user test              |     4 |
| K Search→evidence→canvas          | LIVE pricing search eventually found and focused object; async no-match/build fallback unsafe            |     6 |
| L Ask→answer→citation→source      | Read-only answer contract/citations exist; shared-board requirement and hidden/mode-inconsistent entries |     5 |
| M AI proposes→approve/reject      | Durable proposals; partial preview, early close, applied/skipped/undo ambiguity                          |     4 |

Requested aggregate flow categories: First-use 5; AI generation 5; Voice meeting 3; Board editing 5; AI correction 4; Search 6; Ask 5; Intelligence 3; Execution 3; Collaboration 4; External sync 3. These are reasoned diagnostic scores, not measured conversion rates.

### Cross-entry consistency checks

- **Find pricing:** LIVE Search found the two named pricing nodes after async settling and focused Pricing model. The immediate intermediate state incorrectly offered “Press Enter to ask Lucent to build pricing.” History described Ask-in-composer even though no composer was present there. Ask/Meeting comparisons were code-inspected, not executed with the existing account.
- **Change an action:** Canvas semantic editor, Intelligence status controls and Kanban issue movement address different state layers. AI plan/voice paths do not consistently retain source and intent. These differences need explicit labels, not forced identical behavior.
- **Why does this exist:** LIVE selected-node Why exposed source and Undo; code shows missing provenance misclassified as manual, saved meeting extraction inconsistently stamped, and Undo not targeted. Search/citation navigation is worth preserving while evidence certainty is corrected.

# 6. Canvas Audit

### Orientation and manipulation

Strengths: board title, kind/scale, selected count, tool pressed state, direct manipulation, fit, overview, focus dimming, comments, validated operations, local undo. The canvas is the primary editable surface in architecture.

Weaknesses: global board mode, input mode, selected-object type, semantic statement status and work status are communicated by separate systems. The DOM sample exposed 16 manual toolbar actions plus 13 navigation entries before contextual controls. This is evidence of choice volume—not a claim about their visual prominence. Hick's Law suggests grouping by task; recognition over recall favors contextual labels; Fitts's Law favors stable reachable actions over tiny always-visible controls.

Manipulation parity is uneven: shapes have clipboard/group/order/hide/lock/resize paths that semantic nodes do not share. Semantic edges lack the manual connector inspector. Do not promise feature parity where domain semantics differ; make the current selection's capabilities obvious.

### Small, medium, and large boards

| Size       | Evidence available                                                                                   | Audit conclusion                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 10         | Factory/schema/position validation only; three-node board sampled live                               | Small-board interaction foundation exists. No current ten-node visual readability score is defensible |
| 20         | Historical layered: 24 edges, 36 crossing proxy, 4 through-node proxy; dense: 41/66/21               | Even small boards can have relationship problems; node count alone is insufficient                    |
| 40         | Historical layered 55/24/14; dense 88/988/50                                                         | Dense topology stresses routing long before 80 nodes                                                  |
| 80         | Historical layered 124/119/21; dense 195/696/116; older live report notes poor fit-scale readability | Region overview/detail recovery needed; older report is not current visual verification               |
| 150        | Historical layered 239/240/40; dense 374/1340/217; earlier 150-node live interaction record          | Culling can already engage at nodes+edges≥300. Fast culling is not readable organization              |
| 300        | Historical layered 512/571/84; dense 791/4431/485                                                    | Current browser readability untested; overview must preserve cross-region meaning                     |
| 500 (300+) | Historical layered 844/902/128; dense 1338/8396/948                                                  | No current human comprehension or rendering-latency acceptance; cannot claim scalable usability       |

Triples after fixture type are edges / crossing proxy / through-node proxy. Source: [2026-09-12-visual-baseline-phase0.md:61–100](D:/lucent/docs/eval-results/2026-09-12-visual-baseline-phase0.md). Historical live caveat: [2026-09-10-live-validation-pass.md:84–87,178–185](D:/lucent/docs/eval-results/2026-09-10-live-validation-pass.md). No table value above is a newly measured screenshot count.

### Meaning and readability findings

- **P1-CV-001:** region collapse can remove inter-region relationships (§4).
- **P2-CV-002:** node, edge and label detail thresholds are independent. Labels vanish below .7; edge tiers change at .55/.3; node mid/far classes have no corresponding CSS behavior beyond some omitted fields. No count/reveal affordance explains hidden meaningful edges. [DiagramLayer.tsx:89–95,244–292,385–507](D:/lucent/packages/web/src/ui/DiagramLayer.tsx), [edgeTiers.ts:34–77](D:/lucent/packages/core/src/edgeTiers.ts).
- **P2-CV-003:** Fit has a 25% floor; sufficiently large/deep boards cannot literally fit. Collapse preserves old extent. Relationship labels are midpoint/staggered, ellipsized and pointer-inert without a complete reveal path. [atoms.tsx:466–487](D:/lucent/packages/web/src/ui/atoms.tsx), [scene.ts:88–142](D:/lucent/packages/web/src/scene.ts), [styles.css:4258–4273](D:/lucent/packages/web/src/styles.css).
- **P2-CV-004:** character-count layout estimates and DOM text wrapping are not a full shared typography contract; mobile/export uses a different single-line renderer. Long identifiers, multilingual labels and text-spacing overrides need actual fixtures. [layout.ts:69–117](D:/lucent/packages/core/src/layout.ts), [geometry.ts:271–360](D:/lucent/packages/web/src/board/geometry.ts).

These affect large-board readers and keyboard/low-vision users. Principles: Gestalt connectedness/proximity/common region, cognitive load, progressive disclosure, recognition. Root cause: incomplete semantic overview and text-fidelity contract. Direction: preserve relationships at summary scale, offer explicit detail navigation, and test meaningful reading tasks. Expected benefit: users can identify the primary flow and recover evidence without scanning hundreds of equally detailed objects. Complexity L for overview, M for text/labels; confidence high CODE, current perceptual impact unmeasured.

### Technical versus perceptual performance

Keep existing culling and deterministic layout, but do not use their tests as evidence that users can understand the diagram. Measure separately:

- Technical: input/paint latency, layout duration, mounted work, stability.
- Perceptual: identify main flow, locate blocker, explain cross-region dependency, find source, cleanup effort.

**Benchmark warning:** current dirty runner obtains candidate-engine layout, then calls `measureVisualMetrics(routed)` without its explicit layout argument. The helper recomputes built-in geometry and timing. Candidate comparisons can mix positions/routes and misattribute timing. Metrics also do not mirror live face anchors/curves. This is an evaluation blocker, not proof that either layout engine is better. [scripts/visual-benchmark.ts:74–108](D:/lucent/scripts/visual-benchmark.ts), [visualBenchmark.ts:132–219](D:/lucent/packages/core/src/visualBenchmark.ts).

# 7. AI UX Audit

### Input

The hero gives examples and a clear description affordance. The problem is not absence of guidance. The mismatch begins when the same user intention can enter through hero, composer, voice, search, node HUD, lens or Intelligence selection with different context and semantics.

**Direction:** one request contract containing board, intent, selected scope, source evidence, attachments and allowed effects. The UI should name scope in ordinary language when it matters: “Explain these three items” versus “Change this flow.”

### Generation and feedback

Understanding/planning/applying/cancel states already exist. Preserve them. Failed first attempts need persistent recovery on the hero; partial batches need an actual applied/skipped explanation, not just an expandable conversation. A transition to the wrong representation can make successful wireframe generation appear blank.

**P2-AI-005:** lens submissions discard representation continuity. Affected: Wireframe/Document/Sequence/ER/Kanban users. Evidence: each lens send returns to visual Canvas; [WireframeView.tsx:22–35](D:/lucent/packages/web/src/views/WireframeView.tsx), [CanvasView.tsx:1708–1761](D:/lucent/packages/web/src/views/CanvasView.tsx). Principle: closure/context preservation. Root: composer callbacks own navigation independently. Direction: reveal the result in its intended lens and preserve return location. Benefit: success is visible. Complexity M; high CODE confidence.

### Review, correction, trust and undo

Critical findings §4 cover impact-aware review, exact preview, actual outcome, scope-aware undo and evidence certainty. Keep these stages distinct:

| Action              | Intended authority                         | Current caution                                             |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Typed Ask           | Read-only answer                           | Strong server boundary; access/UI entry inconsistent        |
| Small Build         | Automatic, locally reversible              | Size alone is not a safe impact classifier                  |
| Large redesign      | Explicit proposal                          | Preview and shared completion/undo incomplete               |
| Voice final         | User input                                 | Currently routes as Build regardless of Ask                 |
| Meeting extraction  | Capture-derived proposed/applied changes   | Feedback may overstate application; provenance inconsistent |
| Plan generation     | Source-constrained proposal                | Sources not serialized as intended                          |
| External send       | Explicit externally consequential approval | Strong gate, incomplete field preview                       |
| External acceptance | Review provider-derived change             | Reviewed value can change before acceptance                 |

### Failure vocabulary

Every recovery surface should answer: what happened, why at a useful level, what remains safe, and what to do next. Example for the observed failure: “Your request could not be sent from this local address. Your board is unchanged. Your request is saved below.” Technical detail may remain expandable. This is an example direction, not an assertion that all CSRF failures share this cause.

Provider failure, partial generation, invalid ops, missing relations, unsupported fields, stale proposals and network loss need distinct outcomes. Do not replace them with one generic red toast.

### Magic moment

The strongest intended moment is a description becoming a structured, editable model. The current blockers are interrupted feedback, uncertain scope, wrong result destination, and relationship readability—not lack of animation or a longer tour.

Time-to-first-useful-board and cleanup burden were **not successfully measured** in this audit. The local request failed before generation due to origin configuration. No fabricated time-to-magic estimate is provided.

### Trust moment

Trust is strongest where the app names evidence and makes an external proposal explicit. It is weakest where wording outpaces guarantees: Always review, Extracted, Created by hand, node-local Undo, and previews omitting writable fields. Fix guarantees before polishing reassurance copy.

# 8. Meeting UX Audit

**Primary job:** preserve what was said and make its interpreted consequences reviewable without interrupting capture.

Current chain: Start→STT finals→heuristic classification→differential extraction→board/proposal→transcript checkpoint→Stop. Source capture and model interpretation are too tightly coupled.

- **Capture:** READY/Start recording is clear. LIVE copy says local STT labels every line You and recommends LiveKit for per-speaker diarisation. This is honest capability disclosure, but “speaker labels” would be clearer than specialist terminology.
- **Live extraction:** status lacks a reliable applied/proposed/failed contract (§4). Do not label a completed request as accepted knowledge.
- **Board changes:** Meeting does not contain proposal review or the canvas result; inspecting those can stop recording by unmounting the view.
- **Topic switching:** topic breaks are local render state; automatic extraction does not use them as the manual path does.
- **Correction:** “Re-extract from here” resends existing text. It is not transcript correction. “Unlink from turn” only navigates to Canvas.
- **Provenance:** some live/re-extract paths carry source metadata; saved Extract diagram does not. An evidence viewer should not infer certainty from a missing record.
- **End meeting:** flush, checkpoint, close, review are not an acknowledged sequence. There is no dependable closure summary distinguishing saved transcript, applied changes, pending proposals and failed batches.

**P2-MT-003 — correction and topic controls overstate their effect.** Affected: facilitators revising interpretation. Evidence: [MeetingView.tsx:107–110,301–305,476–522,656–755](D:/lucent/packages/web/src/views/MeetingView.tsx). Principles: Nielsen match/consistency, cognitive load. Root: navigation/reprocessing stand in for correction. Direction: distinguish source correction, interpretation correction, topic boundary and evidence navigation; label actual effects. Benefit: fewer repeated prompts and false confidence. Complexity M; high CODE confidence, audio untested.

Do not add a second meeting dashboard. Preserve capture lifetime across inspection, and make the existing meeting ending an explicit reviewable handoff.

# 9. Execution UX Audit

**Primary job:** turn accepted intent into inspectable work and external consequences.

### Keep state layers separate

| Layer           | Meaning                                    | Example                                               |
| --------------- | ------------------------------------------ | ----------------------------------------------------- |
| Semantic        | What is asserted/decided and its lifecycle | Decision open/resolved/superseded                     |
| Execution       | Progress of work                           | Action blocked/in progress/completed                  |
| Derived signal  | Analytical condition, not a new fact       | Overdue, at risk due to dependency                    |
| Provider        | What external system currently reports     | Raw mapped provider status                            |
| Delivery/review | What has been proposed/sent/accepted       | Pending approval, partial send, stale incoming change |

Source: [model.ts:109–138,206–215,370–508](D:/lucent/packages/core/src/model.ts).

LIVE Execution showed **1 Blocked**, an attention item “Unblock payments — marked blocked,” and **“What's blocking us / Nothing is blocked.”** The likely distinction is explicitly blocked status versus dependency-derived blockers, but the visible wording collapses them. This is not evidence that the model has no blocked item; it is evidence that the UI explains different measures with conflicting language.

**P2-EX-002 — work signals use contradictory scope labels.** User: project lead. Principle: Nielsen match/consistency. Root: projections lack explicit denominator and meaning. Direction: distinguish “Marked blocked” from “Dependency blockers,” and show the relevant object list. Benefit: trustworthy attention triage. Complexity S–M; high LIVE confidence.

### Action→plan→external task

Plan source selection, proposal handoff and external payload consent require the critical repairs in §4. Execution and Kanban should be coherent views of the same work, with direct item details/source/plan access—not disconnected alternatives.

### Integration discovery, synchronization and conflicts

**P2-IN-003:** connection discovery uses an org-owner endpoint while execution users may be board editors; errors become an empty list. Execution's sent cache is global, not board-scoped, and successful-send callback does not refresh the ledger. [server/routes/integrations.ts:69–71](D:/lucent/packages/server/src/routes/integrations.ts), [boards.ts:552–556](D:/lucent/packages/web/src/boards.ts), [ExecutionView.tsx:20–38,85–110,478–481](D:/lucent/packages/web/src/views/ExecutionView.tsx).

Affected: editors and team leads. Principles: visibility, permission-aware affordances, IA. Root: admin discovery/cache is used as current execution capability. Direction: expose “not connected,” “not permitted,” “unavailable,” and “connected” distinctly; scope ledger to board/account and update after outcomes. Benefit: users know what left Lucent and why an action is unavailable. Complexity M; high CODE confidence.

Do not call a one-way send “Sync.” Prefer “Send 7 actions to Linear,” “Review 2 incoming status changes,” and “3 sent, 1 failed.” Use those labels only where the actual operation matches them.

# 10. Accessibility Audit

### Scope and method

Target: web app, WCAG 2.2 AA issue identification. Technologies: React, HTML/CSS, bespoke DOM/SVG canvas. Structured automated sample: selected desktop canvas and Meeting ready. Manual/DOM sample additionally includes auth, Search, Intelligence, History, provenance and mobile. No random sample or exhaustive WCAG-EM conformance evaluation was completed.

The installed axe engine was loaded into the existing page through the local dev server; no external accessibility service received board content. This was an adapted in-page scan, not an accesslint CLI run. Browser-only work remained in the main audit session.

Human AT baseline not exercised: NVDA+Chrome/Firefox, VoiceOver+Safari/iOS, keyboard-only without automation, low-vision zoom/text-spacing, and touch with motor impairments.

### Automated results

**Selected Canvas, 1280×900, 85% board scale:** two failing rules, seven instances.

- **Critical engine impact / P2 product severity:** `button-name`, one unnamed control: `.selection-hud > button:nth-child(9)`. WCAG **4.1.2**. No accessible text/name/title. Source audit also identifies this trailing HUD action as inert. Naming alone would not make a useless control useful.
- **Serious engine impact / P2 product severity:** `target-size`, six instances, WCAG **2.5.8**. Five reaction buttons (`button[title="React 👍"]`, equivalent heart/celebration/thinking/warning) measured **20.4×20.4 px**, with only about 21.8–22 px safe spacing. `.mono:nth-child(6)` measured **17.8×12.9 px**, with 21.2 px safe spacing. These are real 24px/spacing findings, not an incorrect claim that every control below 44px fails AA.
- 24 rule checks passed; three incomplete rule groups: `aria-prohibited-attr` (1), `aria-valid-attr-value` (1), `color-contrast` (41 nodes).

**Meeting ready, 1280×900:** zero violations in the chosen tags; 17 rule checks passed; `aria-valid-attr-value` (1) and `color-contrast` (20 nodes) remained incomplete. Zero findings in this state is not whole-meeting conformance.

### Conformance ledger

- **Verified failures:** 2 success criteria—4.1.2, 2.5.8—in the sampled canvas state.
- **Whole-product passes:** none asserted. Axe rule passes are not one-to-one whole-product SC passes.
- **Flagged/source-backed:** 2.1.1, 2.1.2, 2.4.3 (keyboard ownership/focus); 1.3.1 and 4.1.2 beyond scanned controls (composite widget/state semantics); 2.5.7 (drag/resize alternatives).
- **Undetermined:** 1.4.3/1.4.11 contrast (engine incomplete); 1.4.4/1.4.10/1.4.12 zoom/reflow/text spacing (viewport resize is not full conformance test); 2.4.7/2.4.11 focus visibility/occlusion (image review unavailable); 4.1.3 actual announcements (AT untested); 2.5.1 touch gestures and all remaining unexercised AA criteria. No global N/A classification asserted.

### Keyboard, focus, semantics

Canvas focus ownership is critical (§4). Dialogs/menus need a shared initial-focus, containment where appropriate, Escape, restoration, and inert-background contract. Shared Dialog currently lacks containment; Settings/custom sheets diverge. Build/Ask uses radiogroup with pressed buttons rather than radio children; selected node name does not expose full semantic state/relationships. Source: [primitives.tsx:13–156](D:/lucent/packages/web/src/ui/primitives.tsx), [AIPill.tsx:192–210](D:/lucent/packages/web/src/ui/AIPill.tsx), [atoms.tsx:178–268](D:/lucent/packages/web/src/ui/atoms.tsx).

Actual screen-reader announcement quality is human-required. A status region existing in DOM is not proof that users hear the right message at the right time.

### Responsive, targets, motion

LIVE measurement after stable layout: manual rectangle tool 32×32, send 38×38, mobile zoom-in 43×36. The text input font was 15.5px at sampled desktop/tablet widths. At 768px the final settled Send rectangle was x703.2–741.2, inside the viewport. An immediate post-resize transient reading extended farther; it was rechecked and **is not reported as stable clipping**.

At 390px, populated Canvas became a mobile region exposing title/live count/zoom/comment/present; no Build, Ask, Projects, search or lens controls. CODE confirms first-30-node comment restriction and no equivalent full object navigation. That is a capability discontinuity, not merely small sizing. No claim is made about on-screen keyboard overlap because it was not tested.

Reduced-motion CSS exists; preserve it. Runtime reduced-motion behavior and meaningful contrast across light/dark/accent/faded states remain unverified. Full color contrast cannot be inferred from token names.

# 11. Design System Audit

The underlying problem is **inconsistent interaction contracts**, not the absence of tokens. Existing surface/ink/stroke/accent, typography, spacing, radii, elevation, motion and focus tokens should be reused.

| Pattern             | Existing strength                                | Inconsistency / systemic direction                                                       |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Buttons             | Native controls and shared visual classes        | Standardize loading/disabled/destructive/semantic behavior; remove inert actions         |
| Icon buttons        | Many real accessible labels                      | Name or remove every action; do not expose raw CSS color tokens as user vocabulary       |
| Inputs              | Main composer and editors labeled                | Dashboard/mobile/ad hoc fields diverge; shared field semantics                           |
| Menus               | Some arrow/Escape support                        | Initial/return focus, outside dismissal, export opening differ                           |
| Tabs/modes          | Clear named native buttons                       | Consistent selected/pressed/radio semantics and mode persistence                         |
| Pills               | Reusable compact visual form                     | Input, status and action look structurally similar; distinct meaning/priority            |
| Badges              | Textual kind/status exists                       | Separate semantic/work/provider/delivery categories; avoid undifferentiated badge stacks |
| Tooltips            | Useful labels/titles                             | Hover-only behavior, potential clipping, no consistent keyboard equivalent               |
| Dialogs             | Shared primitive exists                          | Adopt complete focus/dismiss/background behavior in actual callers                       |
| Drawers/popovers    | Useful contextual review                         | Common width/focus/close/task-state contract                                             |
| Cards               | Central live NodeCard                            | Project cards lack equivalent keyboard behavior; renderer/text divergence                |
| Lists               | Typed model-driven data                          | Consistent semantic lists, scope labels, full reachability rather than silent truncation |
| Empty states        | Strong hero and several guides                   | Distinguish first use, no results, unavailable, denied, loading, previous failure        |
| Loading             | AI phases and notification loader                | Don't show empty/all-clear while requests are pending                                    |
| Errors              | Chat retry and notifications                     | Persistent local recovery, not only transient toast or hidden chat                       |
| Success             | Proposal/results infrastructure                  | Acknowledge actual applied/saved/sent result; avoid optimistic false closure             |
| Confirmation        | Safe default for New, explicit external approval | Share implementation/policy across equivalent entry points                               |
| Destructive actions | Undo-based editing can be efficient              | Impact gate for major AI changes; clear scope and recoverability                         |
| Shortcuts           | Broad existing map                               | Context guards, Windows/macOS legends, actual global availability                        |
| Focus               | Global ring exists                               | Selected styles and ad hoc widgets must not replace/lose focus meaning                   |
| Hover               | Many intentional feedback states                 | Equivalent keyboard/touch access; hover must not be the only entry                       |

Sources: [styles.css:1–173,496–747](D:/lucent/packages/web/src/styles.css), [primitives.tsx:13–261](D:/lucent/packages/web/src/ui/primitives.tsx). Detailed per-pattern evidence: [ux-audit-canvas.md](D:/lucent/.zcode/tmp/ux-audit-canvas.md).

### Microcopy corrections driven by behavior

- Top **Present**→**Meeting** if it enters capture; reserve Present for presentation.
- **Created by hand**→**Origin not recorded** when authorship is unknown.
- Node-local **Undo**→name the actual global action, or provide a real targeted reversal.
- **Extracted 7 turns**→report Captured/Processing/Review required/Applied according to actual outcome.
- **Unlink from turn** must unlink or be renamed to its navigation action.
- **Nothing is blocked** must identify dependency scope if another summary says Blocked 1.
- **Apply all** should say what will change and whether partial refusal is possible.
- **Shared / Templates / Team / Send invite** must not suggest functional systems when their current controls are placeholders.
- Windows users should not see only ⌘ shortcut notation.

**P2-DS-001:** inert/contradictory controls and duplicated behavioral patterns erode discoverability and trust across Projects, Settings and overlays. Users: all, especially novice/keyboard users. Principles: Nielsen consistency/match/help, Shneiderman consistency, Hick/Fitts. Root: implementation placeholders and parallel component systems reached the visible UI. Direction: inventory real actions, hide stubs, adopt common behavior contracts. Benefit: every visible action earns its promise. Complexity M; high CODE and partial LIVE confidence. P3 typography/spacing refinements should follow, not lead.

# 12. UX Debt Map

### Critical UX debt

- Board/session isolation on new/open/import.
- Capture durability and honest meeting extraction outcome.
- Ask/voice and impact-review consent boundaries.
- Exact plan sources and external reviewed payload/version.
- Canvas keyboard ownership.

These undermine trust and core work. They are not styling debt.

### Structural UX debt

- Persistent shell/task state and navigation return.
- Local/shared board discovery and organization identity.
- Outcome/recovery state model.
- Execution/Kanban/Intelligence handoffs.
- Semantic overview and relationship-preserving collapse.
- Shared dialog/menu/input behavior and responsive capability continuity.

### Local UX debt

- Support context crash.
- First-generation hero recovery.
- Misleading blocked-summary wording.
- Search pending/no-match fallback.
- Missing accessible HUD name and scaled reaction targets.
- Saved-meeting provenance omission and misleading Unlink control.

### Cosmetic debt

- Token/corner/spacing/icon refinements that remain after behavioral consolidation.
- Animation polish and decorative previews.
- Theme nuance not connected to measured contrast or hierarchy.

No cosmetic recommendation outranks a task, consent, navigation or accessibility failure.

# 13. Recommended Redesign Principles

1. **The board is the context; views are ways of working with it.** Keep identity, navigation and return location stable.
2. **Every initiated task must visibly reach an outcome.** Running, review, partial success, failure and completion must be inspectable where work began.
3. **Ask never silently becomes Build.** Intent and selected scope survive voice, text, search, lenses and background processing.
4. **Review must match consequences exactly.** Gate by impact, preview the real payload, version what was reviewed, and name reversibility honestly.
5. **Capture evidence before interpreting it.** Meeting source durability must not depend on AI success or a screen remaining mounted.
6. **Progressive disclosure must preserve meaning.** Collapse detail, not important relationships; never hide the only way to recover an object or source.
7. **Separate state categories, connect their meaning.** A decision, task, external status and delivery result are different facts.
8. **Every visible control must work and communicate its scope.** Hide placeholders; name actions, permissions and outcomes precisely.
9. **Accessibility is the interaction contract.** Focus, keyboard ownership, targets, nonvisual relationships and alternative input are not finishing work.
10. **Measure useful work, not only feature count or rendering speed.** Time-to-understanding, correction effort and trust are separate from frame rate and node overlap.

# 14. Prioritized Roadmap

This is an audit recommendation, not implementation authorization. Functional changes are explicitly necessary for several UX repairs; CSS-only redesign cannot resolve them.

| Priority | Problem / affected screens                                                         | Expected user benefit                               | Complexity | Dependencies / acceptance                                                                            |
| -------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| P0       | Retained shared session across board transitions; Canvas/Projects/import/new-board | Edits reach only intended board                     | L          | Isolated two-board regression; socket/permissions/URL/pending work transition atomically             |
| P1       | Missing shell and invisible operation handoffs; Intelligence/Execution/lenses      | Continue task without getting stranded              | M          | Every empty/error/populated view has return; Plan shows running→review→result                        |
| P1       | Capture persistence and false extraction completion; Meeting                       | No lost final turns; honest status                  | L          | Stop during idle/in-flight/offline; persist/restore/review with explicit outcomes                    |
| P1       | Voice Ask and consequence-aware review; all AI entries                             | Intent and consent remain reliable                  | M          | One dispatch/policy contract; tests for Ask+voice/selection, deletion, transform, node-less board    |
| P1       | Selected plan sources and effects; Intelligence→plan                               | Work matches selected evidence                      | M          | Request source serialization and effect-based validation                                             |
| P1       | Review result/undo contract; Canvas/shared proposals                               | Know what happened and recover                      | L          | Accurate preview, failure remains actionable, actual applied/skipped count, explicit shared reversal |
| P1       | External payload/version consent; outgoing/incoming review                         | No unseen external changes                          | L          | Frozen field diff; stale review rejects/reloads; no external send without exact acknowledgment       |
| P1       | Keyboard ownership and support crash; canvas/overlays/settings                     | Reliable navigation and recovery                    | M          | Real keyboard/AT tests, safe support mount; no background mutation under overlays                    |
| P1       | Relationship-preserving collapse; medium/large boards                              | Overview remains truthful                           | L          | Two collapsed groups retain inter-group links and keyboard-accessible detail                         |
| P2       | Shared Projects/org/capability model                                               | Find team work and understand access                | M–L        | Existing APIs reused; empty vs denied vs unavailable differentiated                                  |
| P2       | First-error/retry and asynchronous search states                                   | Recover without restarting or accidental Build      | M          | No-match never shown as final while searching; failed request stays visible                          |
| P2       | Work/attention/ledger consistency; Kanban/Execution/Intelligence                   | Know what matters and what left Lucent              | M          | Board-scoped refreshed ledger; named blocker semantics; one coherent review access                   |
| P2       | Mobile continuity and adaptive chrome                                              | Same task remains reachable on smaller screens      | L          | Five-width matrix including proposal, comments, keyboard, empty→populated transition                 |
| P2       | Shared component semantics/text fidelity                                           | Consistent accessible controls and readable content | M–L        | Full-severity scans, focus lifecycle, long-label/multilingual fixtures                               |
| P3       | Microcopy/token/spacing/icon/motion polish                                         | Lower incidental reading and visual cost            | S–M        | Only after behavior contracts and visual evidence are stable                                         |

### Recommended redesign order

1. **Repair identity and safety beneath the UI first.** Do not test cross-board mutations on real user data until isolation is verified.
2. **Reconnect Canvas–Intelligence–Execution with one task-aware shell.** Fix first-error recovery in the same pass. This is the highest visible workflow improvement.
3. **Repair Meeting capture→review→closure.** Preserve source and recording continuity.
4. **Repair planning and outgoing/incoming review.** Then unify Kanban/Execution navigation and attention.
5. **Connect Projects and real organization/settings capabilities.** Hide placeholders rather than expanding administration.
6. **Complete canvas overview, responsive and accessibility contracts.** Correct the candidate benchmark before using it to choose rendering/layout changes.
7. **Apply visual refinement against actual screenshots and task-based evaluations.** No unmeasured claim that the app needs a different aesthetic.

The deferred acceptance work is concrete: live density ladder at 10/20/40/80/150/300/500; topology and long-label variants; microphone/end-meeting interruption tests; approved test-provider external writes; two-account join/edit/leave/board-switch tests; AT and actual visual review. These are coverage requirements, not completed audit results.

# 15. "Do Not Build Yet"

- **Do not add a workflow dashboard or workflow-builder screen.** The existing work must stop losing context first.
- **Do not add a longer onboarding wizard as the primary solution.** Training cannot repair dead ends, hidden failures or misleading controls.
- **Do not add more top-level navigation, AI modes, agents or status categories.** Clarify the existing taxonomy and dispatch contracts.
- **Do not build another attention center.** Connect pending proposals, failed changes and external review to the existing attention entry without flattening their meanings.
- **Do not add a new canvas framework or static diagram generator.** Preserve structured operations, editability and deterministic semantics.
- **Do not expand integrations before approval accurately represents their effects.** More destinations multiply consent and reconciliation debt.
- **Do not expand enterprise settings placeholders.** Connect existing real capabilities or hide the affordances.
- **Do not add decorative templates/previews to mask weak project discovery.** Actual shared-board identity and return access matter more.
- **Do not optimize dense boards only by shrinking labels or fading edges.** Preserve structure and navigable detail.
- **Do not declare a layout-engine winner from the current candidate benchmark.** Its measurement path is not a faithful candidate comparison.

# 16. Final Verdict

**1. Is Lucent understandable to a first-time user?** The initial promise and description input are understandable. The next steps, failure recovery, knowledge/work handoffs and local/shared distinctions are not consistently understandable. An onboarding session would not solve this.

**2. Is the canvas the visual center?** It is the architectural and interaction center. Whether it is consistently the visual focal point remains unverified because image inspection was unavailable. The large number of chrome controls and several shell-less task views weaken its role as continuous context.

**3. Is AI interaction obvious?** The input is obvious. Intent, scope, review state, actual outcome and recovery are inconsistent across entry points.

**4. Is the product overloaded?** Yes, at the navigation and state-model level. Capabilities, representations and administration are exposed without a sufficiently clear priority model. This is not a claim that all capability should be removed.

**5. Which screens first?** Canvas task feedback and shared shell, then Intelligence/Execution, then Meeting. Identity and consent defects must be repaired underneath those changes before broader redesign.

**6. Which screens merge/remove?** Merge Execution/Kanban entry and work context; connect duplicate template and feedback entries; consolidate Present semantics; place analytics/admin/billing in a coherent organization context. Hide inert Team, settings, shortcut and placeholder controls. Do not remove working History, Search, Ask, Meeting or Intelligence jobs.

**7. Three highest-value improvements?**

1. A continuous board-centered workflow with stable navigation and visible progress→review→outcome.
2. An end-to-end intent/evidence/consent contract for AI, meetings and external work.
3. Reliable board identity and task durability, including recoverable failure and truthful attention state.

**8. What should not change?** The user-describes/AI-constructs model; editable semantic data; validated structured operations; deterministic layout; local reversibility; human-gated consequential actions; provenance/citations; search-to-object navigation; and the canvas as the place where work becomes tangible.

**Attention moment:** Lucent already has useful attention signals. The live example surfaced blocked and overdue work and allowed a jump to its object. The gap is completeness and consistency—not the absence of an attention feature. The current system cannot yet give one reliable answer to “what changed, what needs my approval, what is blocked, and what did Lucent actually do?” across all surfaces.

**Bottom line:** your “there is no workflow” observation is directionally right. The workflow exists in the implementation, but users must reconstruct it themselves—and several handoffs are genuinely broken. Connect and make trustworthy what already exists before adding another feature layer.
