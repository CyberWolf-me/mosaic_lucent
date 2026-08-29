# 7. MVP

Keep V1 surprisingly small.

## MVP functionality

**Canvas**

- Infinite canvas
- Shapes
- Text
- Connectors
- Groups
- Sticky notes
- Pan/zoom

**AI**

- Text → diagram
- Voice → diagram
- Conversational modification
- Semantic canvas
- Undo/redo
- AI explanation

**Diagram types**

- Flowchart
- Mind map
- Architecture diagram
- User journey

**Voice**

- Push-to-talk
- Realtime transcription
- Command interpretation

**Workspace**

- Projects
- Save/load
- History

That's enough.

## Example MVP session

User opens a **New Workspace**. AI: "What would you like to visualize?"

User presses the microphone 🎙️:

> "I'm designing an e-commerce platform. Customers browse products, add products to their cart and checkout. Payments are handled by Stripe. Orders go to the warehouse and then shipping."

AI generates:

```
                         E-Commerce
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
          Customer         Products          Cart
              │                               │
              └───────────────┬───────────────┘
                              ▼
                          Checkout
                              │
                              ▼
                           Stripe
                              │
                              ▼
                            Order
                              │
                              ▼
                          Warehouse
                              │
                              ▼
                          Shipping
```

The conversation continues:

- "Add authentication." → AI adds it.
- "Use Google OAuth." → AI modifies authentication.
- "Show me the payment sequence." → AI creates another frame:

```
Customer → Checkout
Checkout → Stripe
Stripe → Checkout
Checkout → Order Service
Order Service → Warehouse
```

- "Now create a simple checkout wireframe." → AI creates a UI wireframe.

**That is your wow moment.**
