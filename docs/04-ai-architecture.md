# 4. AI Architecture

## Technical architecture

A possible end-to-end architecture:

```
                    CLIENT
                       │
          ┌────────────┼────────────┐
          │            │            │
       Canvas        Voice         Chat
          │            │            │
          └────────────┼────────────┘
                       ↓
                 API Gateway
                       ↓
              Conversation Engine
                       ↓
                 Context Engine
                       ↓
                Visual AI Agent
                       ↓
              Action Validator
                       ↓
              Semantic Workspace
                       ↓
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
    Canvas State   Knowledge       History
        │
        ↓
     Renderer
```

## AI architecture — agents/modules

Separate the AI system into an orchestrator coordinating specialized agents:

```
                    AI Orchestrator
                          │
          ┌───────────────┼───────────────┐
          ↓               ↓               ↓
     Conversation      Visual           Context
        Agent           Agent            Agent
          │               │               │
          ↓               ↓               ↓
       Intent         Canvas Ops        Memory
```

Specialized agents:

- **Conversation Agent** — understands the user.
- **Visual Agent** — decides what to create.
- **Context Agent** — retrieves workspace information.
- **Layout Agent** — determines positioning and layout.
- **Validation Agent** — checks that the diagram is structurally valid.
- **Explanation Agent** — explains why something was created.

## AI transformations

One of the strongest features: **transform one visual representation into another.** The information remains connected across representations:

```
Product Requirements → User Journey → User Flow
→ Wireframe → Technical Architecture → Sequence Diagram
```

Because everything stays connected, the user can say "Show me the technical implementation of this feature" and the AI doesn't start from zero — it uses the existing workspace.

## Persistent workspace memory

Every project has persistent context:

```
Project
├── Goals
├── Users
├── Requirements
├── Decisions
├── Entities
├── Relationships
├── Diagrams
├── Wireframes
├── Conversations
└── History
```

This lets the AI remember decisions like "authentication uses Google OAuth." So when the user later says "Update the login flow," the AI knows what authentication means in that project.
