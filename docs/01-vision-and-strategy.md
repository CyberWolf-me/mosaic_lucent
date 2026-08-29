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

## Competitive moat

The moat should **not** be voice transcription (anyone can integrate speech-to-text) or even primarily the LLM (models are becoming commodities). Instead:

1. **Semantic canvas** — the system understands what every object means.
2. **Visual reasoning** — the AI knows how to transform ideas into useful visual representations.
3. **Workspace memory** — the system remembers the project.
4. **Conversation → structure** — years of interactions create a high-quality dataset mapping how people express ideas to visual structures.
5. **Multi-representation model** — one underlying model generates mind map → flowchart → architecture → wireframe → presentation.
6. **Collaboration** — humans and AI work on the same canvas.

## Long-term vision

Eventually the product becomes much bigger than a whiteboard — **a visual operating system for thinking.** You start with "I have an idea," you speak, and the system creates a connected chain: Concept → Requirements → User Journey → Product Architecture → Wireframes → Technical Architecture → Tasks → Presentation. Everything remains connected.

**The ultimate interaction:** a founder says "I want to build an AI-powered marketplace for freelance designers," then narrates the details ("There are designers and customers," "Customers can post projects," "We take 10% commission," "Payments use Stripe," "Let's make a mobile app," "Show me the onboarding," "Turn everything we've discussed into a pitch deck") — and each utterance produces the corresponding nodes, flows, business model, architecture, wireframes, and finally a presentation.

## Product identity

Avoid calling it simply "AI Whiteboard" — that makes it sound like an incremental Miro feature. The stronger category is **AI Visual Workspace**, **Conversational Canvas**, or **AI Canvas**. The fundamental promise: _Think out loud. Build visually._

## The most important strategic decision

Do not start by reproducing all of FigJam. Start with one incredibly good experience:

> "I can talk about an idea and watch a beautiful, editable, structured visual representation emerge in real time."

If that experience feels magical, you have the foundation. Then add, in order: collaboration → documents → images → wireframes → presentations → code → meetings. That's a far more defensible trajectory than building another generic whiteboard with a chatbot attached.
