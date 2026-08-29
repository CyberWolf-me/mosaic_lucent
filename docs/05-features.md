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

## Multimodal input

Eventually all of these become inputs: Voice, Text, Image, Screenshot, PDF, Document, URL, Codebase.

For example, upload a PRD and the AI responds: "I've identified 18 requirements and 5 user journeys." `[Visualize]` → it creates the workspace automatically.

## Code integration

For developers, the platform can eventually connect to GitHub/GitLab.

> User: "Visualize this repository."

The AI analyzes the frontend, backend, database, services, infrastructure, and dependencies, and creates the architecture. Then "Where does authentication happen?" highlights the relevant components. This turns the canvas into a **visual interface to a software system.**
