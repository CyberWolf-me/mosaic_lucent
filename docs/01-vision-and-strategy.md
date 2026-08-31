# 1. Vision & Strategy

## Product concept

Lucent is a collaborative visual workspace similar to FigJam, Miro, Whimsical, Lucidspark, and Excalidraw — but designed around an AI agent as the primary creation interface.

Instead of manually creating shapes, arrows, sticky notes, mind maps, diagrams, wireframes, flows, and architecture diagrams, the user simply talks or types. For example:

> "We're building a food delivery platform. Customers search restaurants, add meals to their cart, pay, and track their delivery. Restaurants receive the order after payment and drivers pick it up."

The AI understands the intent and creates a structured visual workspace. The user then continues to refine it conversationally:

- "Separate the restaurant and customer flows."
- "Add authentication."
- "Show me the checkout sequence."
- "Now create a wireframe for the checkout page."

The workspace continuously changes.

**Core loop:** Speak / Type → AI understands → AI structures → Canvas changes → User corrects → AI updates

The product is therefore a combination of: Whiteboard + AI Agent + Voice Interface + Diagramming + Visual Knowledge Workspace.

## The problem

Current visual collaboration tools are powerful but still require humans to do most of the visual construction. A product manager with an idea has to open FigJam/Miro, create a frame, create shapes, write text, connect shapes, arrange and resize objects, group them, reorganize everything — and repeat whenever requirements change.

The cognitive process is: **Think → translate thought into UI actions → draw.**

Lucent changes this to: **Think → communicate naturally → AI translates thought into visuals.**

## Target users

Start with users who already have a reason to visualize information.

- **Product teams** — "Create a user journey for our onboarding process." Then "Highlight the points where users might drop off."
- **Designers** — "Create a rough wireframe for a dashboard with a sidebar, analytics cards and a recent activity table." The designer refines manually afterward.
- **Developers** — "Visualize the architecture of this application." AI produces a frontend → API gateway → services → database diagram.
- **Founders** — Explain an entire startup idea verbally; the system produces a product map, business model, user journey, feature hierarchy, architecture, and roadmap without requiring diagramming skills.
- **Consultants** — Turn meeting conversations into process maps, org structures, strategic frameworks, customer journeys, and decision trees.
- **Teachers / students** — "Explain the human digestive system." AI creates an interactive visual map.

## Core product philosophy

The most important principle: **The user describes. The AI constructs.**

Traditional flow: User → Toolbar → Shapes → Connectors → Canvas.

Lucent's flow: User → Natural language / voice → AI → Semantic model → Canvas.

Manual editing remains available, but it isn't the primary interaction.

## Competitive positioning

The goal isn't to beat Miro at "who has the best whiteboard." It's to create a new category: the **conversational visual workspace**. On an axis from traditional to AI-native visual collaboration, Lucent sits at the AI-native end, above tools like FigJam AI, Napkin, and SayCanvas, and well beyond traditional tools like Miro, Whimsical, and Excalidraw.

**The market as it actually stands (re-audited 2026-08 — do not pitch against an outdated picture):**

- **Miro** has repositioned as an "AI Innovation Workspace": AI diagram creation/editing, clustering, summaries, workflows, connectors to external context, and **Talktrack** — voice/video recordings attached to canvas content, with AI-extracted summaries, chapters, and next steps. They are already moving from "whiteboard" toward "work context."
- **FigJam** has AI board/diagram generation, sticky clustering, summaries, audio calls inside the board, facilitation tooling — and is explicitly connecting Claude conversations to editable FigJam diagrams.
- **Wavelength** — "Talk your process. Get a diagram everyone sees" — real-time voice-to-diagram, close to our core loop, but narrowly focused on process/data-flow diagrams.
- **SayCanvas** — "a voice-first AI workspace for turning conversations into living visual artifacts" (pages, diagrams, mind maps from voice). Conceptually the closest competitor; still private/early access.
- **VoxeNova** and emerging meeting-intelligence tools: listens during a session, asks clarifying questions, builds diagrams as people talk, maintains decision logs, links information back to exact moments in the conversation.
- Independent convergence from education (Athenoo; the open-source Tokai voice tutor's live concept maps) confirms the underlying behavior is real.

**What this means, stated plainly:** "AI can make a diagram" is no longer the product, and "the first voice-powered AI whiteboard" is not a defensible pitch. The defensible pitch is: **"Lucent is a visual workspace that understands conversations."**

The competitive set splits three ways — canvas-first (Miro/FigJam), voice-first (Wavelength, SayCanvas), meeting-first (VoxeNova). Lucent is the only product combining all three, and its depth differentiator is the one none of them have: the workspace as **persistent, traceable team memory** — not a transcript, not a single diagram, but an evolving model of what the team is thinking, deciding, and building, where every AI-generated object can answer _who said it, when, and in which words_ (provenance, M2).

The strategic question is not "can we beat Miro?" It is: **"Why would a team use Lucent instead of opening Miro + Zoom + Otter + Notion + Linear?"** The answer: because Lucent turns the meeting itself into the workspace. The organization happens _as_ the meeting happens, not as manual cleanup afterward.

## Competitive moat

The moat should **not** be voice transcription (anyone can integrate speech-to-text) or even primarily the LLM (models are becoming commodities). Instead:

1. **Semantic canvas** — the system understands what every object means.
2. **Visual reasoning** — the AI knows how to transform ideas into useful visual representations.
3. **Workspace memory** — the system remembers the project. Six months of Lucent use means a workspace that knows how the team's thinking _evolved_: decisions with history, superseded proposals, provenance on every AI-generated object. A microphone button is copyable in a sprint; that accumulated, traceable model is not.
4. **Conversation → structure** — years of interactions create a high-quality dataset mapping how people express ideas to visual structures.
5. **Multi-representation model** — one underlying model generates mind map → flowchart → architecture → wireframe → presentation.
6. **Collaboration** — humans and AI work on the same canvas.
7. **Conversation _understanding_, not transcription** — distinguishing fact / proposal / question / opinion / decision / rejection (docs/05), so "maybe we could launch in September" never becomes a decided launch date. Meeting-intelligence competitors transcribe; interpreting — including corrections, contradictions, and topic switches — is the moat.

## Long-term vision

Eventually the product becomes much bigger than a whiteboard — **a visual operating system for thinking.** You start with "I have an idea," you speak, and the system creates a connected chain: Concept → Requirements → User Journey → Product Architecture → Wireframes → Technical Architecture → Tasks → Presentation. Everything remains connected.

**The ultimate interaction:** a founder says "I want to build an AI-powered marketplace for freelance designers," then narrates the details ("There are designers and customers," "Customers can post projects," "We take 10% commission," "Payments use Stripe," "Let's make a mobile app," "Show me the onboarding," "Turn everything we've discussed into a pitch deck") — and each utterance produces the corresponding nodes, flows, business model, architecture, wireframes, and finally a presentation.

**The meeting-native form of the same vision (2026-08):** the user presses _Start Lucent_, forgets about the software, and talks with the team for 30 minutes. At the end the workspace holds the board, a decisions log, open questions, actions with owners, and risks — every item traceable to who said it, when, and in which words. Meeting #1 (product) through meeting #4 (go-to-market) are **one evolving workspace, not four unrelated boards**. The principle: _Lucent does not produce a transcript, or even a diagram — it maintains a continuously evolving visual model of the conversation._

The company-level form of the thesis: **Mosaic builds intelligent workspaces that turn human activity into structured, persistent systems. Lattice understands the systems teams build (the code). Lucent understands the ideas teams discuss (the conversation) — and connects them.** The long-term loop: conversation (Lucent) and code (Lattice) converge into one shared model, so "let's add a discount system" can be answered with "here is the proposed design, overlaid on the system that actually exists, and here is what would have to change."

## Product identity

Avoid calling it simply "AI Whiteboard" — that makes it sound like an incremental Miro feature. The stronger category is **AI Visual Workspace**, **Conversational Canvas**, or **AI Canvas**. The fundamental promise: _Think out loud. Build visually._

## The most important strategic decision

Do not start by reproducing all of FigJam. Start with one incredibly good experience:

> "I can talk about an idea and watch a beautiful, editable, structured visual representation emerge in real time."

If that experience feels magical, you have the foundation. Then add, in order: collaboration → documents → images → wireframes → presentations → code → meetings. That's a far more defensible trajectory than building another generic whiteboard with a chatbot attached.

**The engineering corollary (2026-08, both proven live):** the magic only survives if the canvas is _trustworthy_. A board whose connectors render broken, or that rearranges itself every time the AI adds something, destroys the experience faster than any missing feature. Hence two non-negotiables now written into the code:

- _Reliability before features_ — connectors render fully at any length; one bad operation costs itself, not the whole generation (M1).
- _Spatial additivity_ — AI additions never rearrange what the user has already read; existing committed objects keep their positions unless the user explicitly asks for a transformation (ADR 0015).

And the discipline for what comes next: resist big-architecture rebuilds (ELK, new layout engines, semantic zoom frameworks) until the product has a **measured** readability problem. The current benchmark board is 40 nodes / 72 edges / 1,922px-long connectors — real, not hypothetical. The next milestone (M3) is three small UX layers — selection focus, connector visibility tiers, region collapse — tested against that board, and _only then_ decide whether anything heavier is justified. Not "how much can Lucent create?" but **"how much complexity can Lucent remove?"**
