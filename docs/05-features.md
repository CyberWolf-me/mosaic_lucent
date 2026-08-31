# 5. Features

## Visual artifact types

The platform should eventually support many visual representations, grouped by domain.

**Diagrams**

- Flowcharts
- System architecture
- Sequence diagrams
- State diagrams
- ER diagrams
- Network diagrams
- Infrastructure diagrams

**Product**

- User journeys
- Customer journeys
- Feature maps
- Product roadmaps
- Story maps
- Process maps

**Design**

- Wireframes
- UI mockups
- User flows
- Component maps

**Brainstorming**

- Mind maps
- Sticky notes
- Idea clusters
- Affinity diagrams

**Business**

- Organizational charts
- Business models
- Strategy maps
- Decision trees
- Process diagrams

## Collaboration

Once the core AI canvas works, add multiplayer. Multiple people join the same canvas, seeing presence indicators ("Bob is editing…", "AI is generating…").

The interesting part: **AI can participate in collaborative sessions.** Imagine a product meeting:

> Sarah: "We should add enterprise accounts."
> John: "But enterprise users need SSO."
> AI: "I detected a new requirement. Should I add Enterprise Accounts and SSO to the architecture?" `[Add] [Ignore]`

## Meeting mode

This could become one of the best features. The AI listens to a meeting and continuously extracts structure:

- People say "Customers are dropping during checkout." → AI detects **Problem: Checkout abandonment**.
- "Maybe the payment flow is too complicated." → AI adds **Hypothesis: Checkout complexity**.
- "We should try one-click checkout." → AI creates **Solution → One-click checkout**.

At the end, "Generate a summary" produces decisions, problems, ideas, actions, diagrams, and requirements. The whiteboard becomes a **meeting intelligence system.**

> **Status 2026-08 (M2):** live. While recording, a hybrid trigger (speaker-pause / burst / wall-clock valve) sends only NEW turns with a differential prompt; additive batches auto-apply, destructive ones gate behind review; the transcript checkpoints to the server after every extract; extracted nodes carry provenance (meeting id + quoted words). The spatial-additivity invariant (ADR 0015) guarantees each topic's region stays where the user read it, and live topic-switch tests proved the loop _updates_ an existing region rather than duplicating it.

### Statement kinds — the trust foundation

**The single most important meeting-mode rule: not every sentence deserves an object.** A naive extractor turns "maybe we could launch in September" into a decided launch date, and that single confident misunderstanding destroys trust in everything else on the board. Every captured statement is classified before it becomes anything:

| Kind       | Example                                | Visual treatment                                                |
| ---------- | -------------------------------------- | --------------------------------------------------------------- |
| Fact       | "Our launch is September 15."          | Information node                                                |
| Proposal   | "Maybe we should launch in September." | Lighter card, marked _proposed_ — never a requirement           |
| Question   | "Should we launch in September?"       | Unresolved marker (stays in _Open Questions_)                   |
| Opinion    | "I think September is too early."      | Context on the object it concerns                               |
| Decision   | "Okay, let's launch September 15."     | Strong card → _Decisions_ log                                   |
| Rejection  | "No, we're not doing September."       | Marks the superseded proposal as rejected                       |
| Action     | "Sarah will handle marketing."         | Task card with owner (speaker identity flows from the STT seam) |
| Constraint | "No crypto in v1."                     | Scope marker                                                    |
| Risk       | "Payment conversion could tank."       | Risk card                                                       |

Two consequences follow:

1. **Conversation evolution, not sentences.** Meetings are full of "maybe…", "actually…", "no wait…", "let's go back". The model must thread these: proposal (18:10) → concern (18:13) → decision (18:15) _supersedes_ the October proposal. The board shows the decision with its history, not three contradictory nodes.
2. **A visualize filter.** Before creating anything, the extraction asks: _is this novel, material, and asserted?_ Small talk, restatements, and speculation become conversation context, not board objects — the meeting board must never become a transcript dump. (Current form: the differential prompt carries this instruction; the trigger thresholds are configurable so the filter can tighten from evidence.)

### The meeting produces more than a board

The board is the visual surface, but the meeting's durable outputs are structured panels every item in which is traceable to its source:

```
┌──────────────────────┬─────────────────────────┐
│ DECISIONS            │ OPEN QUESTIONS          │
│ Launch Sep 15        │ Monthly vs annual?      │
│ Students first       │ 3 or 5 step onboarding? │
├──────────────────────┴─────────────────────────┤
│ ACTIONS: Sarah → onboarding research · Alex →  │
│ checkout prototype · David → launch campaign   │
├────────────────────────────────────────────────┤
│ RISKS: payment conversion · acquisition cost   │
└────────────────────────────────────────────────┘
```

This is where meeting → execution connects: decisions and actions are already work items (Jira-style issues exist on nodes today), so "create a plan from today's meeting" is a projection, not a re-entry problem. Later: Lucent → Linear/Jira/GitHub sync.

### Meeting lenses

Because everything is one semantic model, the same meeting can be re-projected on demand — nothing deleted, nothing lost, just clarity:

- **Brainstorm lens** — ideas, alternatives, open possibilities
- **Decision lens** — decisions, rejected proposals, open questions
- **Product lens** — users, problems, features, requirements
- **Engineering lens** — architecture, dependencies, APIs, data, risks
- **Execution lens** — tasks, owners, deadlines, dependencies

"Show me only what changed since last week's meeting" is the same mechanism: a projection over the model filtered by provenance timestamps.

## Multimodal input

Eventually all of these become inputs: Voice, Text, Image, Screenshot, PDF, Document, URL, Codebase.

For example, upload a PRD and the AI responds: "I've identified 18 requirements and 5 user journeys." `[Visualize]` → it creates the workspace automatically.

## Code integration

For developers, the platform can eventually connect to GitHub/GitLab.

> User: "Visualize this repository."

The AI analyzes the frontend, backend, database, services, infrastructure, and dependencies, and creates the architecture. Then "Where does authentication happen?" highlights the relevant components. This turns the canvas into a **visual interface to a software system.**

## Large-board readability (M3 direction)

The known unsolved problem: _large AI-generated boards contain too much visual information_. After a 30-minute meeting the board is technically complete and functionally unreadable — "where am I supposed to look?" The discipline (per docs/01): **improve readability without changing the workspace data model, the layout engine, or the AI pipeline.** Three small layers, in order:

1. **Selection focus** — selecting a node makes it and its connections prominent; everything else fades slightly. No data changes, no layout changes, no AI changes. The cheapest possible win.
2. **Connector visibility tiers** — primary ━━━▶ / secondary ───▶ / contextual ·····▶ with a user toggle (_All / Important / Off_). A simple visual hierarchy, no AI ranking needed for v1.
3. **Region collapse** — a region renders as a summary card (`ARCHITECTURE · 24 nodes · 31 edges [Expand]`) that expands to exactly today's diagram.

Then stop and measure against the real benchmark board (40 nodes / 72 edges), and escalate to 80 and 150 nodes: _"Can I actually understand this?"_ If focus + tiers + collapse make 80 nodes readable, don't build more. Only a measured failure at 150 justifies investigating ELK or edge routing.

**Explicitly not built unless the measurement demands it:** ELK/Dagre, edge bundling, a new layout engine, semantic zoom architecture, a new graph representation, complicated routing algorithms, region-system rewrites. (The LLM-owns-meaning / engine-owns-geometry split already in the codebase is the right architecture; these would be re-solving problems we haven't demonstrated having.)
