# 2. Interface & Interaction

## The product interface

The application has five primary areas, with the canvas at the center:

```
┌─────────────────────────────────────────────────────────────┐
│ Logo     Project Name          Share   Present   Profile     │
├────────────┬────────────────────────────────────────────────┤
│            │                                                 │
│ Workspace  │                                                 │
│            │                                                 │
│ + New      │                                                 │
│            │                  CANVAS                         │
│ Projects   │                                                 │
│            │                                                 │
│ Architecture│                                                │
│ User Flow  │                                                 │
│ Wireframes │                                                 │
│            │                                                 │
├────────────┴────────────────────────────────────────────────┤
│                                                              │
│ 🎙  "Tell me what you want to build..."          Send        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## AI interaction — three primary inputs

- **Voice** — user presses the microphone: "Add a payment service between checkout and the database." The AI understands and modifies the workspace.
- **Text** — user types: "Create a sequence diagram for login." The AI creates it.
- **Visual input** — user uploads a screenshot, photo, hand-drawn diagram, PDF, existing architecture, or design. The AI analyzes it.

## Voice mode

Voice is a major differentiator, but it should not be treated as simply `microphone → transcription`. The full pipeline is:

```
Microphone → Speech Recognition → Conversation → Intent Detection
          → Workspace Context → Visual Agent → Canvas Operations
```

The system must understand which kind of intent the user has:

| Intent       | Example                              |
| ------------ | ------------------------------------ |
| Creating     | "Create a user journey."             |
| Modifying    | "Move checkout to the right."        |
| Adding       | "Add Stripe."                        |
| Removing     | "Remove the legacy authentication."  |
| Asking       | "Why did you connect these two?"     |
| Transforming | "Turn this into a sequence diagram." |
| Exploring    | "What happens if payment fails?"     |

Detecting intent (rather than blindly transcribing) is what makes the voice agent powerful.

## Conversation + canvas

The conversation itself is part of the workspace, shown alongside the canvas:

```
┌─────────────────────┬──────────────────────────┐
│ Conversation        │ Canvas                   │
│                     │                          │
│ User:               │       Architecture       │
│ Add authentication  │                          │
│                     │      Frontend            │
│ AI:                 │          │               │
│ Added OAuth and     │          ▼               │
│ session management. │       Auth API           │
│                     │          │               │
│ User:               │          ▼               │
│ Use Google OAuth.   │       Database           │
│                     │                          │
└─────────────────────┴──────────────────────────┘
```

Every AI operation becomes part of the workspace history.

## Human approval

Match the confirmation level to the operation's impact:

- **Simple operations** ("Move this node.") execute immediately.
- **Major operations** ("Redesign the entire architecture.") show a reviewable diff before applying:

```
AI proposes 14 changes

+ Add Payment Service
+ Add Redis
+ Add Queue
~ Move Checkout
~ Change API Gateway
- Remove Legacy API

[ Review Changes ]
[ Apply All ]  [ Cancel ]
```

This makes the system trustworthy.
