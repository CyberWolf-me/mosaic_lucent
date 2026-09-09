import { safeParseOperations, type Operation } from "@lucent/core";
import type { GenerateRequest, GenerateResult, LLMProvider, StreamCallbacks } from "../provider.js";
import type { AnswerCitation, AnswerRequest, AnswerResult } from "../answer.js";
import {
  MAX_AI_SELECTED_ACTIONS,
  type ExternalPlanRequest,
  type ExternalPlanResult,
} from "../externalPlan.js";

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
    // Stage D3: the ordering script — "can't start until X" becomes a typed
    // dependency edge, DIRECTION PINNED (the waiting work is the source,
    // the prerequisite is the target — the exact thing models flip).
    match: (m) => /can'?t start until|until .*(approved|done|complete)/i.test(m),
    build: (req) => {
      // The real prerequisite node if the summary names one; else a
      // design-approval node the script creates.
      const named = req.summary.nodes.find((n) =>
        /design|approv/i.test(n.label),
      );
      const targetId = named?.id ?? "design-approval";
      const ops: Operation[] = named
        ? []
        : [
            {
              op: "CREATE_NODE",
              id: targetId,
              nodeType: "action",
              label: "Design approval",
            },
          ];
      return {
        explanation: `Implementation waits on design approval: Implementation depends_on ${targetId} — the waiting work is the source, the prerequisite is the target.`,
        operations: [
          ...ops,
          {
            op: "CREATE_NODE",
            id: "implementation",
            nodeType: "action",
            label: "Implementation",
          },
          {
            op: "CONNECT_NODES",
            source: "implementation",
            target: targetId,
            relationship: "depends_on",
          },
        ] as Operation[],
      };
    },
  },
  {
    // Stage D2: the plan script — "create the work/plan from these
    // statements" over a summary carrying decisions/actions/requirements/
    // risks (the acceptance fixture's shape). The mock reads the summary's
    // REAL statement nodes: decisions organize (a region), requirements/
    // risks derive mitigation actions, existing actions are NOT re-emitted
    // (preserved as-is), and — the acceptance rule — NO UPDATE_STATEMENT
    // and no work minted from proposals/questions. Plan-shaped ops only.
    match: (m) => /create (the )?(work|plan)/i.test(m),
    build: (req) => {
      const statements = req.summary.nodes.filter((n) => n.statement);
      const decisions = statements.filter((n) => n.statement!.kind === "decision");
      const requirements = statements.filter((n) => n.statement!.kind === "requirement");
      const risks = statements.filter((n) => n.statement!.kind === "risk");
      const derived: Operation[] = [];
      const derivedIds: string[] = [];
      for (const n of [...requirements, ...risks]) {
        const id = `${n.id}-action`;
        derivedIds.push(id);
        derived.push({
          op: "CREATE_NODE",
          id,
          nodeType: "action",
          label: `Address: ${n.label.slice(0, 40)}`,
        });
        derived.push({
          op: "SET_STATEMENT",
          id,
          statement: { kind: "action", status: "open", topic: "plan" },
        });
        derived.push({
          op: "SET_ISSUE",
          id,
          issue: { type: "task", status: "open" },
        });
      }
      // Stage E1: each derived action traces to the decision that caused
      // it — a drives edge per action, the decision chosen round-robin so
      // the pairing is deterministic when there are more actions than
      // decisions. A board with no decisions drives nothing.
      const drives = derivedIds.map((id, i) => ({
        op: "CONNECT_NODES",
        source: decisions[i % Math.max(decisions.length, 1)]?.id ?? "",
        target: id,
        relationship: "drives",
      })) as Operation[];
      // Stage E3: workstream sub-groups — the task-tree shape the plan
      // grows. Four canonical workstreams (the strategic example),
      // derived actions assigned round-robin so the tree is
      // deterministic. Kindless groups: a workstream is a container, not
      // a diagram lens. The plan region keeps ALL derived nodes (plus
      // the decisions) in its own children list, so region and
      // workstreams overlap by design (bounds are measured per group
      // over its children; the label-pill fix in 511903a keeps nested
      // labels readable).
      const WORKSTREAMS = ["Research", "Design", "Engineering", "QA"] as const;
      const workstreamChildren = new Map<string, string[]>();
      if (derivedIds.length > 0) {
        derivedIds.forEach((id, i) => {
          const name = WORKSTREAMS[i % WORKSTREAMS.length]!;
          const list = workstreamChildren.get(name) ?? [];
          list.push(id);
          workstreamChildren.set(name, list);
        });
      }
      const workstreams = [...workstreamChildren.entries()].map(([name, children]) => ({
        op: "CREATE_GROUP",
        id: `plan-ws-${name.toLowerCase()}`,
        label: name,
        children,
      })) as Operation[];
      return {
        explanation: `Organized the board's semantic state into a plan: ${
          decisions.length
        } decision(s) as the region, ${derivedIds.length} derived action(s) for requirements and risks organized into ${
          workstreams.length
        } workstream group(s), each action linked to the decision that drives it. Existing actions preserved; proposals and questions untouched.`,
        operations: [
          // Decisions create structure: the plan region holds the derived
          // work (and the decision nodes it organizes around), emitted
          // FIRST — the reducer's CREATE_GROUP sets each existing child's
          // node.groupId, last write wins, so the region's pass leaves the
          // decision nodes on the region and the derived nodes untouched
          // until the workstreams claim them. The region's bounds are
          // measured over its own children list, so the nesting renders.
          ...(decisions.length
            ? [
                {
                  op: "CREATE_GROUP",
                  id: "plan-region",
                  label: "Launch plan",
                  children: [...derivedIds, ...decisions.map((d) => d.id)],
                  kind: "process" as const,
                } as Operation,
              ]
            : []),
          ...derived,
          // The workstreams come AFTER the derived nodes exist, so each
          // CREATE_GROUP stamps its children's groupId onto real nodes —
          // and being later than the region, the stamp wins.
          ...workstreams,
          ...(decisions.length ? drives : []),
        ] as Operation[],
      };
    },
  },
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
    // P0-3: statement-kind scripts (Stage C2: the doctrine as data now). A
    // rejection visibly supersedes — the statement flips to rejected, never
    // silence and never a second contradictory node; a correction replaces
    // the earlier statement in place. The prompts carry "The board currently
    // shows a node…" phrasing the golden cases pin.
    match: (m) => /not doing usage-based pricing/i.test(m),
    build: () => ({
      explanation:
        "Marked the usage-based pricing proposal as rejected in place — the board now shows the rejection, not the proposal.",
      operations: [
        {
          op: "CHANGE_TEXT",
          id: "usage-pricing",
          text: "Rejected: usage-based pricing",
        },
        {
          op: "UPDATE_STATEMENT",
          id: "usage-pricing",
          status: "rejected",
        },
      ] as Operation[],
    }),
  },
  {
    // Stage C5: topic REUSE over variant minting. A message that names the
    // subject with different wording ("the pricing model") over a board
    // already carrying a statement topic — the mock reads the summary's
    // existing topics and reuses the key it finds rather than minting
    // "pricing-model" beside it. The doctrine v5 teaches, made executable
    // so the offline eval gate exercises it.
    match: (m) => /pricing model/i.test(m),
    build: (request) => {
      // The existing authored key the board carries — real data only.
      const existing = request.summary.nodes
        .map((n) => n.statement?.topic)
        .find((t) => typeof t === "string");
      return {
        explanation: existing
          ? `Reused the board's existing '${existing}' topic for the new pricing statement instead of minting a variant key.`
          : "Created the pricing statement with a short kebab-case topic.",
        operations: [
          {
            op: "CREATE_NODE",
            id: "pricing-model-node",
            nodeType: "decision",
            label: "Pricing model",
          },
          {
            op: "SET_STATEMENT",
            id: "pricing-model-node",
            statement: {
              kind: "decision",
              status: "open",
              ...(existing ? { topic: existing } : { topic: "pricing" }),
            },
          },
        ] as Operation[],
      };
    },
  },
  {
    // Stage C3: the correction arrives as a LATER MEETING over a board that
    // already holds Monday's decision — the doctrine spans meetings. The
    // mock supersedes the existing statement visibly instead of re-deciding
    // from scratch, so the offline eval gate exercises cross-meeting
    // continuity the way the golden case pins it. MUST sit before the
    // decided-$15 script: both match "$15/month", but only a correction
    // ("actually…") should supersede — a plain "we decided" is born-resolved
    // with no predecessor.
    match: (m) => /actually[^.]*\$?15/i.test(m),
    build: () => ({
      explanation:
        "Wednesday's correction supersedes Monday's $20 decision visibly: the board now shows $15/month as the resolved decision and the old one as superseded.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "pricing-new",
          nodeType: "decision",
          label: "Pricing at $15/month",
        },
        {
          op: "SET_STATEMENT",
          id: "pricing-new",
          statement: {
            kind: "decision",
            status: "resolved",
            topic: "pricing",
            supersedes: ["pricing-decision"],
          },
        },
      ] as Operation[],
    }),
  },
  {
    // The decided shape (Stage C2): "we decided $15/month" is a decision BORN
    // resolved, superseding the $20 proposal the board already carries.
    // Matches the decided verb plus a 15/fifteen anywhere after it — the
    // golden phrasing is "decided to price it at $15/month".
    match: (m) => /decided\b[^.]*\b(15|fifteen)\b/i.test(m) || /\b(15|fifteen)\b[^.]*\/month/i.test(m),
    build: () => ({
      explanation:
        "The team decided $15/month: a decision node, born resolved, superseding the $20 proposal.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "pricing-decision",
          nodeType: "decision",
          label: "Pricing at $15/month",
        },
        {
          op: "SET_STATEMENT",
          id: "pricing-decision",
          statement: {
            kind: "decision",
            status: "resolved",
            topic: "pricing",
            supersedes: ["pricing-proposal"],
          },
        },
      ] as Operation[],
    }),
  },
  {
    match: (m) => /actually,? young professionals/i.test(m),
    build: () => ({
      explanation:
        "Corrected the target users node in place: young professionals replaces students, no contradictory copy survives.",
      operations: [
        {
          op: "CHANGE_TEXT",
          id: "target",
          text: "Target users: young professionals",
        },
      ] as Operation[],
    }),
  },
  {
    // The ambiguity case: a mention is not an owner. "Talk to Sarah about
    // pricing" is an action to DISCUSS with Sarah — the golden set pins
    // that it must not come out as an action assigned to Sarah.
    match: (m) => /talk to sarah about/i.test(m),
    build: () => ({
      explanation:
        "Added an action to discuss the pricing model with Sarah. Sarah is the person to talk to, not the owner of this action — the speaker owns it.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "discuss-pricing-sarah",
          nodeType: "action",
          label: "Discuss pricing model with Sarah",
        },
      ] as Operation[],
    }),
  },
  {
    // Stage A attribution polarity (the gate's F7). The ✓ commitment shapes:
    // a genuine 'I'll…' or 'Sarah will…' is an action WITH an owner, in any
    // meeting style — the golden cases pin the SET_ISSUE assignee.
    // Stage D1: the deadline the words name finally lands on the op —
    // dueDate resolved to ISO (A FIXED REFERENCE keeps the offline gate
    // deterministic), status initialized to the canonical 'assigned'.
    match: (m) => /i'?ll prepare the launch brief/i.test(m),
    build: () => ({
      explanation:
        "David committed to the launch brief: an action card with David as owner, due Friday.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "launch-brief",
          nodeType: "action",
          label: "Prepare launch brief",
        },
        {
          op: "SET_ISSUE",
          id: "launch-brief",
          issue: {
            type: "task",
            status: "assigned",
            assignee: "David",
            dueDate: "2026-09-11",
            description: "The final launch brief covering messaging and timeline.",
          },
        },
        // Stage C2: a commitment is an action statement, open until done.
        {
          op: "SET_STATEMENT",
          id: "launch-brief",
          statement: { kind: "action", status: "open", topic: "launch" },
        },
      ] as Operation[],
    }),
  },
  {
    match: (m) => /sarah will review both prototypes/i.test(m),
    build: () => ({
      explanation:
        "Sarah is tasked with reviewing both prototypes Monday: an action owned by Sarah.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "review-prototypes",
          nodeType: "action",
          label: "Review both prototypes",
        },
        {
          op: "SET_ISSUE",
          id: "review-prototypes",
          issue: { type: "task", status: "To Do", assignee: "Sarah" },
        },
      ] as Operation[],
    }),
  },
  {
    // 'Can you ask Sarah…' — the speaker is asked to do the asking; the
    // action is 'ask Sarah', owned by the SPEAKER. The golden case forbids
    // a SET_ISSUE with assignee Sarah.
    match: (m) => /can you ask sarah about/i.test(m),
    build: () => ({
      explanation:
        "The speaker was asked to ask Sarah about the pricing model: an action to ask Sarah, owned by the speaker — Sarah is the topic, not the owner.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "ask-sarah-pricing",
          nodeType: "action",
          label: "Ask Sarah about the pricing model",
        },
      ] as Operation[],
    }),
  },
  {
    // The ✗ hedged shape: 'we should probably ask Sarah' is a suggestion,
    // not a commitment — the action may exist as a proposal, but NO owner.
    match: (m) => /should probably ask sarah/i.test(m),
    build: () => ({
      explanation:
        "Jin's line is a hedged suggestion, not a commitment: noted as a proposal-style idea with no owner. Nobody signed up to ask Sarah.",
      operations: [
        {
          op: "CREATE_NODE",
          id: "ask-sarah-idea",
          nodeType: "idea",
          label: "Proposal: ask Sarah about pricing",
        },
        // Stage C2: the proposal-ness is data now — open, never resolved,
        // until words that decide arrive.
        {
          op: "SET_STATEMENT",
          id: "ask-sarah-idea",
          statement: { kind: "proposal", status: "open", topic: "pricing" },
        },
      ] as Operation[],
    }),
  },
  {
    // The anti-lexical guard: 'I'll think about it' contains "I'll" but is
    // not a task in any meaningful sense — nothing lands on the board.
    match: (m) => /i'?ll think about it/i.test(m),
    build: () => ({
      explanation:
        "Lena said she'd think about it — a deferral, not a task. Nothing was committed, so nothing was added to the board.",
      operations: [],
    }),
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

/**
 * The answer scripts (Stage C1). Intent matching over the QUESTION, evidence
 * synthesis from the CONTEXT — the mock never invents an id, because the
 * server's citation validation drops invented ids and a mock whose citations
 * were all dropped would exercise nothing. Three scripts cover the shapes the
 * offline demo and the route tests need: a "what changed" answer synthesized
 * from the history window (the disclosure case included), a "why is this node
 * here" answer citing node + source meeting from provenance, and a default
 * that answers from the current board digest.
 */
interface AnswerScript {
  match: (question: string) => boolean;
  build: (request: AnswerRequest) => AnswerResult;
}

const answerScripts: AnswerScript[] = [
  {
    // Retrieval-grounded asking (Stage C4): a question whose answer lives in
    // the unclassified turns the digest never shows. The mock cites the
    // retrieved turn's MEETING (the only citable kind for a turn, the C3
    // rule) and names the turnIndex in the answer text — real ids only, the
    // standing rule, and `retrieved` carries exactly the ids the server
    // validated into the request.
    match: (q) => /\b(who said|what did .* say|find|search|where.*discuss)/i.test(q),
    build: (request) => {
      const retrieved = request.retrieved ?? [];
      const turnHit = retrieved.find((h) => h.kind === "turn");
      if (!turnHit) {
        return {
          answer: "No retrieved evidence matches that within your visible window.",
          citations: [],
        };
      }
      const turnText =
        turnHit.turnIndex !== undefined ? ` (turn ${turnHit.turnIndex})` : "";
      return {
        answer:
          `The retrieved evidence finds it in meeting ${turnHit.id}${turnText}: ` +
          `"${turnHit.label}" — matched on ${turnHit.matched.join(", ")}. ` +
          `That turn is not in the classified extracts, so the digest alone would not have shown it.`,
        citations: [{ kind: "meeting", id: turnHit.id }],
      };
    },
  },
  {
    // "Why did we switch/change between meetings?" (Stage C3): the evolution
    // lens. The mock reads the two most recent meetings' classified turns
    // and names the turn indices — real ids only, the C1 rule — so the
    // offline demo exercises the same cross-meeting shape the evolution
    // section of the digest teaches.
    match: (q) =>
      /(why|how)\s+(did|do)\s+we\s+(change|switch|move)|between.*meetings?|since\s+(monday|tuesday|wednesday|last)/i.test(
        q,
      ),
    build: (request) => {
      const meetings = request.meetings;
      if (meetings.length < 2) {
        return {
          answer: "I can only see one meeting in the visible window, so I can't trace a change across meetings.",
          citations: [],
        };
      }
      const [newer, older] = meetings;
      const newerTurn = newer!.turns[0];
      const olderTurn = older!.turns[0];
      const disclosure = request.meetingsTruncated
        ? " (older meetings exist beyond the visible window — there may be earlier chapters)"
        : "";
      const citations: AnswerCitation[] = [
        { kind: "meeting", id: newer!.id },
        { kind: "meeting", id: older!.id },
      ];
      return {
        answer:
          `Between the meetings: in ${older!.id} (turn ${olderTurn?.index ?? 0}) the team said "${olderTurn?.text.slice(0, 60) ?? "(nothing classified)"}". ` +
          `Later, in ${newer!.id} (turn ${newerTurn?.index ?? 0}), the position changed: "${newerTurn?.text.slice(0, 60) ?? "(nothing classified)"}". ` +
          `The board's statements reflect the latest position.${disclosure}`,
        citations,
      };
    },
  },
  {
    // "What changed?" — the lens the C1 acceptance scenario drives. The answer
    // names the revisions it was built from, newest first, and states the
    // window honestly when it is truncated (the historian's trust rule, made
    // executable so the offline path demonstrates it).
    match: (q) => /what( |'s)?\s*(changed|change|happened)|since\b/i.test(q),
    build: (request) => {
      const history = request.history;
      const newest = history[0];
      const oldest = history[history.length - 1];
      if (!history.length || !newest || !oldest) {
        return { answer: "No revisions are recorded for this board yet.", citations: [] };
      }
      const actors = [...new Set(history.map((h) => h.actorName))];
      const cited = history.slice(0, 3).map((h) => ({
        kind: "revision" as const,
        id: String(h.seq),
        detail: h.label,
      }));
      const disclosure = request.historyTruncated
        ? ` You see the latest ${history.length} revisions${
            request.historyDepth !== null
              ? ` (your plan's history depth is ${request.historyDepth})`
              : ""
          }, so there may be older changes outside this window.`
        : "";
      return {
        answer:
          `${history.length} revisions are visible. The most recent was revision ${newest.seq} ` +
          `at ${new Date(newest.at).toISOString().slice(0, 16).replace("T", " ")} UTC — ` +
          `${newest.actorName} ${newest.label.toLowerCase()} (${newest.opCount} op${
            newest.opCount === 1 ? "" : "s"
          }). ` +
          `The oldest visible revision is ${oldest.seq} (${oldest.actorName}). ` +
          `${actors.length === 1 ? `${actors[0] ?? "someone"} made every change` : `${actors.length} contributors made changes`}.${disclosure}`,
        citations: cited,
      };
    },
  },
  {
    // "Why is this node here?" — provenance tracing. The node comes from the
    // question's own text when it names one that exists (the mock resolves
    // against nodeIndex); the source meeting is cited only when the digest
    // mentions provenance for it.
    match: (q) => /\bwhy\b.*\b(node|here|this)\b|\bwhy\b/i.test(q),
    build: (request) => {
      const named = request.nodeIndex.find((n) => {
        const words = n.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        return words.some((w) => request.question.toLowerCase().includes(w));
      });
      const node = named ?? request.nodeIndex[0];
      if (!node) {
        return { answer: "This board has no nodes to explain yet.", citations: [] };
      }
      const meeting = request.meetings[0];
      const provenance = meeting
        ? ` It traces to meeting ${meeting.id} (${meeting.turns[0]?.speaker ?? "the team"}: "${
            meeting.turns.find((t) => t.text.toLowerCase().includes(node.label.toLowerCase().split(" ")[0] ?? "§"))?.text.slice(0, 80) ??
            meeting.turns[0]?.text.slice(0, 80) ??
            "discussed"
          }").`
        : "";
      const citations: AnswerCitation[] = [{ kind: "node", id: node.id, detail: node.label }];
      if (meeting) citations.push({ kind: "meeting", id: meeting.id });
      return {
        answer: `"${node.label}" is on the board as node ${node.id}.${provenance} The current state is in the board context above.`,
        citations,
      };
    },
  },
];

export class MockProvider implements LLMProvider {
  readonly name = "mock";

  /**
   * The answer path (Stage C1). Scripts first, then a digest-grounded default:
   * whichever surface the offline demo drives, the mock answers from the same
   * windowed context the server will send and cites only ids that context
   * really contains.
   */
  async generateAnswer(request: AnswerRequest): Promise<AnswerResult> {
    const script = answerScripts.find((s) => s.match(request.question));
    if (script) return script.build(request);

    // Default: answer from the board itself. One node citation (or none, on
    // an empty board) keeps the offline path honest without synthesizing a
    // narrative the context does not support.
    const node = request.nodeIndex[0];
    const nodeCount = request.nodeIndex.length;
    return {
      answer: node
        ? `This board ("${request.boardName}") currently has ${nodeCount} node${
            nodeCount === 1 ? "" : "s"
          }, including "${node.label}". ${request.history.length} revision${
            request.history.length === 1 ? "" : "s"
          } are visible in its history.`
        : `This board ("${request.boardName}") has no nodes yet.`,
      citations: node ? [{ kind: "node", id: node.id }] : [],
    };
  }

  /**
   * The external-plan path (Stage D9). Deterministic narrowing: the
   * candidates whose label or statement topic shares a word with the
   * request, capped at MAX_AI_SELECTED_ACTIONS; when nothing matches, ALL
   * candidates (an honest broad default — the human reviews the whole set).
   * The mock grounds its selection in the same candidate list the server
   * computed, so the offline flow exercises the real intersection.
   */
  async generateExternalPlan(request: ExternalPlanRequest): Promise<ExternalPlanResult> {
    const words = new Set(
      request.request
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
    const matches = request.candidates.filter((c) => {
      const haystack = `${c.label} ${c.statementTopic ?? ""}`.toLowerCase();
      return [...words].some((w) => haystack.includes(w));
    });
    const selected = (matches.length > 0 ? matches : request.candidates).slice(
      0,
      MAX_AI_SELECTED_ACTIONS,
    );
    return {
      nodeIds: selected.map((c) => c.nodeId),
      explanation:
        selected.length === request.candidates.length
          ? `All ${selected.length} of the board's executable actions appear relevant to the request.`
          : `These ${selected.length} of ${request.candidates.length} actions appear to match the request; the human reviews the selection.`,
    };
  }

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
