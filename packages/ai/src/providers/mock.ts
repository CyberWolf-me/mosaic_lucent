import { safeParseOperations, type Operation } from "@lucent/core";
import type { GenerateRequest, GenerateResult, LLMProvider, StreamCallbacks } from "../provider.js";

/**
 * Offline provider so the full pipeline (generate -> validate -> reduce ->
 * layout -> render) is demoable and CI-testable without any API key
 * (docs/09 sections 6-7). It matches a few scripted intents by keyword and
 * otherwise falls back to creating a single node from the message.
 *
 * Intent matching here is intentionally dumb — it is NOT the product. It only
 * exercises the deterministic machinery downstream.
 */

interface Script {
  match: (message: string) => boolean;
  build: (request: GenerateRequest) => GenerateResult;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "node"
  );
}

/** A short region label from a request like "also add a mind map for pricing ideas". */
function shortRegionLabel(message: string): string {
  const m = message.match(/for ([a-z0-9][a-z0-9 -]{2,30})/i);
  const raw = (m?.[1] ?? message).trim();
  return (raw.length > 30 ? `${raw.slice(0, 29)}…` : raw).replace(/^./, (c) => c.toUpperCase());
}

/** The centre/step label for a region seed. */
function coreLabel(message: string): string {
  const m = message.match(/for ([a-z0-9][a-z0-9 -]{2,30})/i);
  const raw = (m?.[1] ?? "Core idea").trim();
  const capped = raw.replace(/^./, (c) => c.toUpperCase());
  return capped.length > 26 ? `${capped.slice(0, 25)}…` : capped;
}

const scripts: Script[] = [
  {
    // "e-commerce" seed graph from the example MVP session (docs/07).
    match: (m) => /e-?commerce|online store|shop/i.test(m),
    build: () => ({
      explanation: "Created an e-commerce flow from customer to shipping.",
      operations: [
        { op: "CREATE_DIAGRAM", kind: "flowchart" },
        { op: "CREATE_NODE", id: "customer", nodeType: "actor", label: "Customer" },
        { op: "CREATE_NODE", id: "products", nodeType: "screen", label: "Products" },
        { op: "CREATE_NODE", id: "cart", nodeType: "screen", label: "Cart" },
        { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
        { op: "CREATE_NODE", id: "stripe", nodeType: "service", label: "Stripe" },
        { op: "CREATE_NODE", id: "order", nodeType: "service", label: "Order" },
        { op: "CREATE_NODE", id: "warehouse", nodeType: "service", label: "Warehouse" },
        { op: "CREATE_NODE", id: "shipping", nodeType: "service", label: "Shipping" },
        { op: "CONNECT_NODES", source: "customer", target: "products", relationship: "browses" },
        { op: "CONNECT_NODES", source: "products", target: "cart", relationship: "adds" },
        { op: "CONNECT_NODES", source: "cart", target: "checkout", relationship: "next" },
        { op: "CONNECT_NODES", source: "checkout", target: "stripe", relationship: "pays" },
        { op: "CONNECT_NODES", source: "stripe", target: "order", relationship: "confirms" },
        { op: "CONNECT_NODES", source: "order", target: "warehouse", relationship: "sends" },
        { op: "CONNECT_NODES", source: "warehouse", target: "shipping", relationship: "ships" },
      ],
    }),
  },
  {
    // "add authentication" follow-up (docs/07).
    match: (m) => /add (auth|authentication|login|sign ?in)/i.test(m),
    build: () => ({
      explanation: "Added an authentication service in front of checkout.",
      operations: [
        { op: "CREATE_NODE", id: "auth", nodeType: "service", label: "Authentication" },
        { op: "CONNECT_NODES", source: "auth", target: "checkout", relationship: "guards" },
      ],
    }),
  },
  {
    // "use google oauth" refinement (docs/07).
    match: (m) => /google oauth|use oauth/i.test(m),
    build: () => ({
      explanation: "Switched authentication to Google OAuth.",
      operations: [{ op: "CHANGE_TEXT", id: "auth", text: "Google OAuth" }],
    }),
  },
  {
    // Question-answering: no ops, answer in the explanation (docs/15 Phase C).
    match: (m) => /^(explain|what|why|how|summar|describe|which)\b/i.test(m.trim()),
    build: (req) => ({
      explanation:
        req.summary.nodes.length === 0
          ? "The board is empty — describe what you'd like to build and I'll create it."
          : `This board has ${req.summary.nodes.length} nodes and ${req.summary.edges.length} connections (${req.summary.diagramKind}). Key elements: ${req.summary.nodes
              .slice(0, 6)
              .map((n) => n.label)
              .join(", ")}.`,
      operations: [],
    }),
  },
  {
    // Parallel diagrams (found by the live test pass): a request that names a
    // system a populated board is clearly NOT about gets the no-ops answer
    // the prompt's new rule requires, so the client can offer "build this on
    // a new board". On an empty board the same words are just the next thing
    // to build, so it answers with a connected seed flow instead (the same
    // shape as the generic fallback, but named from the matched system).
    match: (m) =>
      /(marketing|analytics pipeline|onboarding funnel|hr system|inventory system|crm|data platform|recommendation engine|billing system|notification service)/i.test(
        m,
      ),
    build: (req) => {
      if (req.summary.nodes.length === 0) {
        const id = slug(req.message);
        return {
          explanation: `Built a connected flow for "${req.message.slice(0, 40)}".`,
          operations: [
            { op: "CREATE_NODE", id: `${id}-request`, nodeType: "actor", label: "Trigger" },
            { op: "CREATE_NODE", id: `${id}-step`, nodeType: "step", label: "Core process" },
            { op: "CREATE_NODE", id: `${id}-outcome`, nodeType: "goal", label: "Outcome" },
            {
              op: "CONNECT_NODES",
              source: `${id}-request`,
              target: `${id}-step`,
              relationship: "starts",
            },
            {
              op: "CONNECT_NODES",
              source: `${id}-step`,
              target: `${id}-outcome`,
              relationship: "yields",
            },
          ] as Operation[],
        };
      }
      return {
        explanation:
          'That looks like a separate system rather than part of this board — mixing unrelated systems into one diagram makes both unreadable. It belongs on its own board; use "New workspace" (or the button below) and describe it there.',
        operations: [],
      };
    },
  },
  {
    // Diagram regions (docs/03): "also add a mind map for X on this board"
    // builds a second diagram kind as a region group instead of transforming
    // the whole board — the behaviour the prompt's region rule teaches.
    match: (m) =>
      /(also|add|put|create).{0,24}(mind ?map|org ?chart|flow ?chart|journey)\b/i.test(m),
    build: (req) => {
      const id = slug(req.message);
      const mind = /mind ?map/i.test(req.message);
      const kind = mind
        ? "mindmap"
        : /org ?chart/i.test(req.message)
          ? "orgchart"
          : /journey/i.test(req.message)
            ? "journey"
            : "flowchart";
      return {
        explanation: `Added a ${kind} region for "${req.message.slice(0, 40)}" without touching the rest of the board.`,
        operations: [
          {
            op: "CREATE_GROUP",
            id: `${id}-region`,
            label: shortRegionLabel(req.message),
            children: [],
            kind,
          },
          {
            op: "CREATE_NODE",
            id: `${id}-core`,
            nodeType: mind ? "topic" : "step",
            label: coreLabel(req.message),
            groupId: `${id}-region`,
          },
          {
            op: "CREATE_NODE",
            id: `${id}-one`,
            nodeType: "idea",
            label: "First branch",
            groupId: `${id}-region`,
          },
          {
            op: "CREATE_NODE",
            id: `${id}-two`,
            nodeType: "idea",
            label: "Second branch",
            groupId: `${id}-region`,
          },
          {
            op: "CONNECT_NODES",
            source: `${id}-core`,
            target: `${id}-one`,
            relationship: mind ? "branch" : "leads to",
          },
          {
            op: "CONNECT_NODES",
            source: `${id}-core`,
            target: `${id}-two`,
            relationship: mind ? "branch" : "leads to",
          },
        ],
      };
    },
  },
  {
    // Region retarget: "change the X section to a Y" flips one region's kind.
    match: (m) =>
      /change (the |this )?.{0,32}(section|region|diagram|part) to (an? )?(mind ?map|org ?chart|flow ?chart|journey|process|architecture|decision tree)/i.test(
        m,
      ),
    build: (req) => {
      const m = req.message;
      const kind = /mind ?map/i.test(m)
        ? "mindmap"
        : /org ?chart/i.test(m)
          ? "orgchart"
          : /journey/i.test(m)
            ? "journey"
            : /process/i.test(m)
              ? "process"
              : /architecture/i.test(m)
                ? "architecture"
                : /decision ?tree/i.test(m)
                  ? "decisiontree"
                  : "flowchart";
      // Target the most recently declared kind-bearing group when several
      // exist; fall back to the only/first region the summary reports.
      const region =
        req.summary.groups?.filter((g) => g.kind).slice(-1)[0]?.id ?? req.summary.groups?.[0]?.id;
      if (!region) {
        return {
          explanation:
            "There is no region on this board to change yet — create the diagram first, then ask to change its kind.",
          operations: [],
        };
      }
      return {
        explanation: `Changed region "${region}" to a ${kind}.`,
        operations: [{ op: "SET_GROUP_KIND", id: region, kind }],
      };
    },
  },
  {
    // "wireframe / mockup / UI" -> a derived checkout wireframe (docs/05, docs/07).
    match: (m) => /wireframe|mock ?up|ui screen|checkout page|design the (ui|screen|page)/i.test(m),
    build: () => ({
      explanation: "Created a checkout wireframe from the semantic model.",
      operations: [
        {
          op: "CREATE_WIREFRAME",
          id: "wf-checkout",
          title: "Checkout",
          viewport: "desktop",
          root: {
            kind: "screen",
            direction: "column",
            children: [
              {
                kind: "header",
                direction: "row",
                children: [
                  { kind: "heading", label: "Checkout", weight: 3 },
                  { kind: "text", label: "Step 3 of 3", weight: 1 },
                ],
              },
              {
                kind: "row",
                children: [
                  {
                    kind: "column",
                    weight: 2,
                    children: [
                      { kind: "heading", label: "Contact" },
                      { kind: "field", label: "Email address", placeholder: "you@example.com" },
                      { kind: "heading", label: "Shipping" },
                      {
                        kind: "row",
                        children: [
                          { kind: "field", label: "First name" },
                          { kind: "field", label: "Last name" },
                        ],
                      },
                      { kind: "field", label: "Address" },
                      { kind: "heading", label: "Payment" },
                      {
                        kind: "row",
                        children: [
                          { kind: "button", label: "Card", variant: "primary" },
                          { kind: "button", label: "Apple Pay", variant: "secondary" },
                          { kind: "button", label: "PayPal", variant: "secondary" },
                        ],
                      },
                      { kind: "field", label: "Card number" },
                      { kind: "button", label: "Place order · $84.20", variant: "primary" },
                    ],
                  },
                  {
                    kind: "card",
                    weight: 1,
                    children: [
                      { kind: "heading", label: "Your order · 3 items" },
                      { kind: "text", label: "Sourdough starter kit — $32.00" },
                      { kind: "text", label: "Ceramic proofing basket — $28.00" },
                      { kind: "text", label: "Bench scraper — $14.00" },
                      { kind: "divider" },
                      { kind: "text", label: "Total — $84.20" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
  },
];

export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async generateOperations(request: GenerateRequest): Promise<GenerateResult> {
    const script = scripts.find((s) => s.match(request.message));
    if (script) return script.build(request);

    // Fallback: a small CONNECTED flow built from the request, not one
    // orphan note. The single-note fallback is what the live test pass
    // surfaced: an unrecognized prompt dropped a disconnected card with the
    // whole message as its label, stacked on an existing node — the exact
    // "nodes not connected, can't tell what does what" complaint. A mock's
    // job is to look like the product's real answer shape, and real answers
    // are graphs: a request, its key step, and the outcome, wired together.
    const id = slug(request.message);
    const short = request.message.replace(/\s+/g, " ").trim().slice(0, 28);
    const operations: Operation[] = [
      { op: "CREATE_NODE", id: `${id}-request`, nodeType: "actor", label: short || "Request" },
      { op: "CREATE_NODE", id: `${id}-step`, nodeType: "step", label: "Key step" },
      { op: "CREATE_NODE", id: `${id}-outcome`, nodeType: "goal", label: "Outcome" },
      {
        op: "CONNECT_NODES",
        source: `${id}-request`,
        target: `${id}-step`,
        relationship: "triggers",
      },
      {
        op: "CONNECT_NODES",
        source: `${id}-step`,
        target: `${id}-outcome`,
        relationship: "produces",
      },
    ];
    // Guard against schema drift if Operation changes shape.
    safeParseOperations(operations);
    return {
      operations,
      explanation: `Added a connected flow for "${request.message.slice(0, 40)}".`,
    };
  }

  /**
   * The mock streams by writing its answer's JSON out in fixed-size slices:
   * enough deltas to exercise every client render path (and every SSE framing
   * edge in the tests) without any network. The resolved result is the same
   * object generateOperations returns.
   */
  async streamOperations(
    request: GenerateRequest,
    callbacks: StreamCallbacks,
  ): Promise<GenerateResult> {
    const result = await this.generateOperations(request);
    const payload = JSON.stringify({
      operations: result.operations,
      explanation: result.explanation ?? null,
    });
    for (let i = 0; i < payload.length; i += 64) {
      callbacks.onDelta(payload.slice(i, i + 64));
      // Yield so a consumer that awaits between deltas observes ordering.
      await new Promise<void>((resolve) => setTimeout(resolve, 0).unref?.());
    }
    return result;
  }
}
