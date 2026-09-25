/**
 * THE REPRESENTATION REGISTRY (docs/26 §6.1, V4).
 *
 * One table defines every diagram family: its human label, when to use it, the
 * rules the model follows to build it, the node vocabulary it speaks, the
 * layout geometry and edge style it is drawn with, which node types are drawn
 * as small pseudo-nodes, which lens presents it, and where it may appear
 * (AI-created, "Convert to…", as a region, laid out by ELK). Everything else
 * reads from here rather than keeping its own per-kind table:
 *
 *   - `layout.ts`   derives its strategy-per-kind map (`layoutStrategyFor`) and
 *                   its pseudo-node shrink (`pseudoRoleFor`);
 *   - `routing.ts`  derives its route-style-per-kind map (`routeStyleFor`);
 *   - the web canvas derives its labels, the convert and region pickers, the
 *     lens a board opens in, the pseudo-node shapes and the ELK eligibility;
 *   - the AI system prompt renders its family section from
 *     `representationCatalogPrompt()`.
 *
 * So a new family is an ADDITIVE change: add the kind to `DIAGRAM_KINDS`
 * (model.ts) and one entry here, and the layout dispatch, the routing, the
 * labels, the pickers and the AI's menu all pick it up. That is the whole point
 * of V4 — "one entry adds a type".
 *
 * This module holds no live data and imports only types from `layout`/`routing`
 * (erased at runtime), so it sits cleanly under both without a cycle.
 */

import { DIAGRAM_KINDS, type DiagramKind } from "./model.js";
import type { Operation } from "./operations.js";
import type { LayoutStrategy } from "./layout.js";
import type { RouteStyle } from "./routing.js";

/** Loose grouping used to organize the family list in the UI and the prompt. */
export type RepresentationCategory = "flow" | "structure" | "planning";

/** A lens that replaces the canvas surface for a family (web `CanvasLens`). */
export type RepresentationLens = "sequence" | "er";

/** The role a pseudo-node plays: where a flow begins, or where it ends. */
export type PseudoRole = "start" | "end";

/**
 * Builds a family's starter template: the operations that seed a minimal,
 * still-editable example of the family. `idPrefix` namespaces every generated
 * id so repeated inserts never collide (the caller passes a fresh prefix).
 * These are SEMANTIC seeds (nodes, edges, groups) — not fixed geometry — so the
 * layout engine positions them and the AI can keep building on them.
 */
export type StarterTemplate = (idPrefix: string) => Operation[];

export interface RepresentationSpec {
  readonly kind: DiagramKind;
  /** Human display name ("State machine"), shown in labels and the picker. */
  readonly label: string;
  /**
   * One line the AI reads to choose a family, and the picker shows as a
   * tooltip: what the family is FOR, not how it is drawn.
   */
  readonly summary: string;
  /**
   * How the model builds this family with operations — the construction rules
   * the system prompt carries under the family's line (swimlanes are groups, a
   * transition's relationship is its event, …). Empty when the summary says
   * everything.
   */
  readonly guidance: readonly string[];
  /** The node types this family speaks, most characteristic first. */
  readonly nodeTypes: readonly string[];
  /**
   * Node types drawn as small pseudo-nodes (a start dot, an end bullseye, a
   * BPMN event) rather than cards — the layout shrinks them and the canvas
   * draws their shape. Absent when the family has none.
   */
  readonly pseudo?: { readonly start: readonly string[]; readonly end: readonly string[] };
  /** The lens that presents this family instead of the plain canvas. */
  readonly lens?: RepresentationLens;
  readonly category: RepresentationCategory;
  /** Geometry this family lays out with (see `layout.ts` LayoutStrategy). */
  readonly layout: LayoutStrategy;
  /** Drawn path a routed edge of this family takes (see `routing.ts`). */
  readonly route: RouteStyle;
  /**
   * Whether the AI is told it may create this family directly (CREATE_DIAGRAM).
   * The Zod enum still accepts every kind; this only shapes the prompt catalog.
   */
  readonly aiCreatable: boolean;
  /** Whether this family is offered as a "Convert board to…" target. */
  readonly convertible: boolean;
  /**
   * Whether this family works as a REGION (a group with this kind inside a
   * board of another kind). Families whose geometry is built from groups —
   * matrix cells, timeline lanes, story-map activities — or that are
   * presented through a whole-surface lens do not: inside a region every
   * member's group is the region itself.
   */
  readonly regionable: boolean;
  /** Whether the ELK engine may lay this family out (large layered graphs). */
  readonly elk: boolean;
  /** Seed a minimal editable example of this family (docs/26 §6.1). */
  readonly starter: StarterTemplate;
}

/**
 * Starter-template builders. Small helpers so each family's starter reads as a
 * list of nodes/edges/groups. Every id is prefixed with the caller's `p` so
 * repeated inserts never collide. Declared as functions (hoisted) because the
 * REPRESENTATIONS literal below references them inside its starter closures.
 */
function diag(kind: DiagramKind): Operation {
  return { op: "CREATE_DIAGRAM", kind };
}
function nd(
  p: string,
  id: string,
  nodeType: string,
  label: string,
  groupId?: string,
): Operation {
  return {
    op: "CREATE_NODE",
    id: `${p}-${id}`,
    nodeType,
    label,
    ...(groupId ? { groupId: `${p}-${groupId}` } : {}),
  };
}
function ed(p: string, source: string, target: string, relationship: string): Operation {
  return { op: "CONNECT_NODES", source: `${p}-${source}`, target: `${p}-${target}`, relationship };
}
function grp(p: string, id: string, label: string): Operation {
  return { op: "CREATE_GROUP", id: `${p}-${id}`, label, children: [] };
}
function story(p: string, id: string, release: string): Operation {
  return {
    op: "SET_ISSUE",
    id: `${p}-${id}`,
    issue: { type: "story", status: "open", labels: [release] },
  };
}

/**
 * The table, in `DIAGRAM_KINDS` order (the order `listRepresentations`
 * returns). The prompt catalog and the pickers group by `category`.
 *
 * Route styles carry the benchmark verdict recorded in
 * docs/eval-results/2026-09-13-routing-styles.md (see `routing.ts` for the
 * full reasoning): the layered flow families route `ortho`; families that draw
 * no long-edge routes hold `polyline` as the inert default.
 */
export const REPRESENTATIONS: Record<DiagramKind, RepresentationSpec> = {
  flowchart: {
    kind: "flowchart",
    label: "Flowchart",
    summary: "Steps and decisions in the order they happen — the default for a process or algorithm.",
    guidance: [
      'nodeType "start" / "end" for the terminals, "decision" for a branch point; label each',
      'branch edge with its condition ("yes", "no", "over limit").',
    ],
    nodeTypes: ["start", "step", "decision", "end"],
    category: "flow",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("flowchart"),
      nd(p, "start", "start", "Start"),
      nd(p, "step", "step", "Do the work"),
      nd(p, "end", "end", "Done"),
      ed(p, "start", "step", "next"),
      ed(p, "step", "end", "then"),
    ],
  },
  architecture: {
    kind: "architecture",
    label: "Architecture",
    summary: "Systems, services and stores and how they connect — technical building blocks.",
    guidance: [
      'nodeType "client", "service", "datastore", "queue" or "external"; each edge\'s',
      'relationship is the verb ("calls", "reads/writes", "publishes to").',
    ],
    nodeTypes: ["client", "service", "datastore", "queue", "external"],
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("architecture"),
      nd(p, "client", "client", "Web client"),
      nd(p, "api", "service", "API service"),
      nd(p, "db", "datastore", "Database"),
      ed(p, "client", "api", "calls"),
      ed(p, "api", "db", "reads/writes"),
    ],
  },
  mindmap: {
    kind: "mindmap",
    label: "Mind map",
    summary: "A central idea with radiating branches — brainstorming and open exploration.",
    guidance: ['One central node; connect every other node to its parent with relationship "branch".'],
    nodeTypes: ["idea"],
    category: "structure",
    layout: "radial",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: false,
    starter: (p) => [
      diag("mindmap"),
      nd(p, "core", "idea", "Central idea"),
      nd(p, "b1", "idea", "Branch A"),
      nd(p, "b2", "idea", "Branch B"),
      nd(p, "b3", "idea", "Branch C"),
      ed(p, "core", "b1", "branch"),
      ed(p, "core", "b2", "branch"),
      ed(p, "core", "b3", "branch"),
    ],
  },
  journey: {
    kind: "journey",
    label: "User journey",
    summary: "A person's path through stages of an experience, left to right.",
    guidance: [
      'nodeType "stage" for each stage, connected in the order the person moves through',
      'them; a touchpoint, pain or feeling is a node connected to the stage it belongs to.',
    ],
    nodeTypes: ["stage", "touchpoint", "pain"],
    category: "flow",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("journey"),
      nd(p, "aware", "stage", "Awareness"),
      nd(p, "consider", "stage", "Consideration"),
      nd(p, "decide", "stage", "Decision"),
      ed(p, "aware", "consider", "then"),
      ed(p, "consider", "decide", "then"),
    ],
  },
  decisiontree: {
    kind: "decisiontree",
    label: "Decision tree",
    summary: "Branching choices from a single root, each branch a distinct outcome.",
    guidance: [
      'The root is the first question (nodeType "choice"), leaves are outcomes (nodeType',
      '"outcome"); label each edge with the answer that leads down it.',
    ],
    nodeTypes: ["choice", "outcome"],
    category: "flow",
    layout: "tree",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: false,
    starter: (p) => [
      diag("decisiontree"),
      nd(p, "root", "choice", "Decision?"),
      nd(p, "yes", "outcome", "Yes"),
      nd(p, "no", "outcome", "No"),
      ed(p, "root", "yes", "yes"),
      ed(p, "root", "no", "no"),
    ],
  },
  process: {
    kind: "process",
    label: "Process map",
    summary: "Who does what, in what order — one swimlane per actor or system.",
    guidance: [
      "CREATE_GROUP for each swimlane (an owner, team, or stage) and give every step its",
      "groupId — the lanes come from the groups.",
    ],
    nodeTypes: ["step", "decision"],
    category: "flow",
    layout: "swimlane",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: false,
    starter: (p) => [
      diag("process"),
      grp(p, "customer", "Customer"),
      grp(p, "system", "System"),
      nd(p, "request", "step", "Submit request", "customer"),
      nd(p, "process", "step", "Process request", "system"),
      ed(p, "request", "process", "hands off"),
    ],
  },
  orgchart: {
    kind: "orgchart",
    label: "Org chart",
    summary: "A reporting or containment hierarchy, parents centred over their children.",
    guidance: ['Connect a manager to each direct report with relationship "manages".'],
    nodeTypes: ["role"],
    category: "structure",
    layout: "tree",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: false,
    starter: (p) => [
      diag("orgchart"),
      nd(p, "lead", "role", "Team lead"),
      nd(p, "r1", "role", "Report 1"),
      nd(p, "r2", "role", "Report 2"),
      ed(p, "lead", "r1", "manages"),
      ed(p, "lead", "r2", "manages"),
    ],
  },
  bpmn: {
    kind: "bpmn",
    label: "BPMN process",
    summary: "A business process in BPMN notation: events, tasks, and exclusive/parallel gateways.",
    guidance: [
      'nodeType "entry" for the start event, "exit" for an end event, "task" for an',
      'activity, "choice" for an exclusive gateway and "parallel" for a parallel one; label',
      "each gateway's outgoing edge with its condition.",
    ],
    nodeTypes: ["entry", "task", "choice", "parallel", "exit"],
    pseudo: { start: ["entry", "start"], end: ["exit", "end"] },
    category: "flow",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("bpmn"),
      nd(p, "start", "entry", "Start"),
      nd(p, "task", "task", "Review request"),
      nd(p, "gate", "choice", "Approved?"),
      nd(p, "ship", "task", "Fulfil"),
      nd(p, "end", "exit", "End"),
      nd(p, "reject", "exit", "Rejected"),
      ed(p, "start", "task", "next"),
      ed(p, "task", "gate", "then"),
      ed(p, "gate", "ship", "yes"),
      ed(p, "gate", "reject", "no"),
      ed(p, "ship", "end", "done"),
    ],
  },
  timeline: {
    kind: "timeline",
    label: "Timeline",
    summary: "Milestones or phases along a time axis — roadmaps and schedules. Links to actions' due dates.",
    guidance: [
      "Give each dated item SET_ISSUE with dueDate (YYYY-MM-DD, resolved against today's",
      'date), nodeType "milestone" for milestones, and one CREATE_GROUP per lane (a team or',
      "workstream). Time runs left to right from the dates.",
    ],
    nodeTypes: ["milestone", "task"],
    category: "planning",
    layout: "timeline",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    // The time axis is drawn for a whole timeline board only.
    regionable: false,
    elk: false,
    starter: (p) => [
      diag("timeline"),
      grp(p, "phase1", "Phase 1"),
      grp(p, "phase2", "Phase 2"),
      nd(p, "kickoff", "milestone", "Kickoff", "phase1"),
      nd(p, "build", "task", "Build", "phase1"),
      nd(p, "launch", "milestone", "Launch", "phase2"),
      ed(p, "kickoff", "build", "then"),
      ed(p, "build", "launch", "then"),
    ],
  },
  matrix: {
    kind: "matrix",
    label: "Matrix",
    summary: "Items placed in a grid by two dimensions — 2×2, SWOT, RACI, prioritization.",
    guidance: [
      "One CREATE_GROUP per cell, in reading order (top-left, top-right, bottom-left,",
      'bottom-right), each labelled with its axis values ("Quick wins · high impact, low',
      'effort"); put every item in its cell with groupId. No edges.',
    ],
    nodeTypes: ["idea"],
    category: "planning",
    layout: "grid",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    // Cells are groups; inside a region every member's group is the region.
    regionable: false,
    elk: false,
    starter: (p) => [
      diag("matrix"),
      grp(p, "q1", "High impact · low effort"),
      grp(p, "q2", "High impact · high effort"),
      grp(p, "q3", "Low impact · low effort"),
      grp(p, "q4", "Low impact · high effort"),
      nd(p, "n1", "idea", "Quick win", "q1"),
      nd(p, "n2", "idea", "Big bet", "q2"),
    ],
  },
  statemachine: {
    kind: "statemachine",
    label: "State machine",
    summary: "States and the transitions between them, with guards — use for lifecycles and status models.",
    guidance: [
      'nodeType "state", one "start" and at least one "end" pseudo-state; each transition\'s',
      'relationship is the event, with a guard in brackets when it has one ("pay [card valid]").',
    ],
    nodeTypes: ["state", "start", "end", "decision"],
    pseudo: { start: ["start", "initial"], end: ["end", "final"] },
    category: "flow",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: false,
    starter: (p) => [
      diag("statemachine"),
      nd(p, "start", "start", "Start"),
      nd(p, "draft", "state", "Draft"),
      nd(p, "published", "state", "Published"),
      nd(p, "end", "end", "End"),
      ed(p, "start", "draft", "create"),
      ed(p, "draft", "published", "publish"),
      ed(p, "published", "end", "archive"),
    ],
  },
  dependency: {
    kind: "dependency",
    label: "Dependency graph",
    summary:
      "What depends on or blocks what — a directed graph over depends_on / blocks / drives relationships.",
    guidance: [
      'Every edge is "depends_on" (the source needs the target first), "blocks" (the source',
      'holds up the target) or "drives" (a decision drives an action). Dependencies never',
      "form a cycle.",
    ],
    nodeTypes: ["task", "decision", "milestone"],
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("dependency"),
      nd(p, "a", "task", "Task A"),
      nd(p, "b", "task", "Task B"),
      nd(p, "c", "task", "Task C"),
      ed(p, "a", "b", "depends_on"),
      ed(p, "b", "c", "blocks"),
    ],
  },
  c4: {
    kind: "c4",
    label: "C4 model",
    summary:
      "Software architecture at one C4 level — context, container or component — systems and their relationships.",
    guidance: [
      "One level per diagram. Context: nodeType \"person\", \"system\" and \"external_system\".",
      'Container: "container" and "database" nodes inside a CREATE_GROUP for the system',
      'boundary. Component: "component" nodes inside a CREATE_GROUP for their container.',
      "Put a node's technology and responsibility in its details; each edge's relationship",
      'says what flows ("reads orders [JDBC]").',
    ],
    nodeTypes: ["person", "system", "external_system", "container", "database", "component"],
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("c4"),
      grp(p, "boundary", "Online shop"),
      nd(p, "person", "person", "Customer"),
      nd(p, "web", "container", "Web application", "boundary"),
      nd(p, "db", "database", "Orders database", "boundary"),
      nd(p, "pay", "external_system", "Payment provider"),
      ed(p, "person", "web", "places orders"),
      ed(p, "web", "db", "reads/writes"),
      ed(p, "web", "pay", "charges cards"),
    ],
  },
  network: {
    kind: "network",
    label: "Network / infrastructure",
    summary:
      "Infrastructure with zones and trust boundaries — hosts, networks and the connections between them (group nodes into zones).",
    guidance: [
      "One CREATE_GROUP per zone or segment (Internet, DMZ, private, data), from the least to",
      'the most trusted; nodeType "gateway", "firewall", "host", "service" or "datastore";',
      'each edge\'s relationship is the protocol and port ("HTTPS 443").',
    ],
    nodeTypes: ["gateway", "firewall", "host", "service", "datastore"],
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("network"),
      grp(p, "dmz", "DMZ"),
      grp(p, "private", "Private zone"),
      nd(p, "lb", "gateway", "Load balancer", "dmz"),
      nd(p, "app", "host", "App server", "private"),
      nd(p, "db", "datastore", "Database", "private"),
      ed(p, "lb", "app", "HTTPS 443"),
      ed(p, "app", "db", "TCP 5432"),
    ],
  },
  sequence: {
    kind: "sequence",
    label: "Sequence diagram",
    summary:
      "Actors exchanging messages over time — nodes are participants, edges are messages in order. Presented through the sequence lens.",
    guidance: [
      'nodeType "actor" per participant; each CONNECT_NODES is one message, created in the',
      'order the messages happen, labelled with the message; a reply is its own edge back.',
    ],
    nodeTypes: ["actor"],
    lens: "sequence",
    category: "flow",
    layout: "layered",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    // A whole-surface lens: there is no sequence drawing inside a region.
    regionable: false,
    elk: false,
    starter: (p) => [
      diag("sequence"),
      nd(p, "user", "actor", "User"),
      nd(p, "api", "actor", "API"),
      nd(p, "db", "actor", "Database"),
      ed(p, "user", "api", "request"),
      ed(p, "api", "db", "query"),
      ed(p, "db", "api", "rows"),
      ed(p, "api", "user", "response"),
    ],
  },
  er: {
    kind: "er",
    label: "ER diagram",
    summary:
      "Entities and the relationships between them — nodes are entities, edges are relationships. Presented through the ER lens.",
    guidance: [
      'nodeType "entity" per table; list its columns in its details ("id PK", "email",',
      '"user_id FK"); each edge\'s relationship names the association ("places", "contains").',
    ],
    nodeTypes: ["entity"],
    lens: "er",
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: false,
    elk: true,
    starter: (p) => [
      diag("er"),
      nd(p, "user", "entity", "User"),
      nd(p, "order", "entity", "Order"),
      nd(p, "product", "entity", "Product"),
      ed(p, "user", "order", "places"),
      ed(p, "order", "product", "contains"),
    ],
  },
  class: {
    kind: "class",
    label: "UML class diagram",
    summary:
      "Classes with their attributes and operations, and how they relate — inheritance, interfaces, associations.",
    guidance: [
      'nodeType "class", "interface", "abstract" or "enum"; put attributes and operations in',
      'the node\'s details, in UML form ("+id: UUID", "+save(): void"); relationships are',
      '"inherits", "implements", "association", "composition", "aggregation" or "depends".',
    ],
    nodeTypes: ["class", "interface", "abstract", "enum"],
    category: "structure",
    layout: "layered",
    route: "ortho",
    aiCreatable: true,
    convertible: true,
    regionable: true,
    elk: true,
    starter: (p) => [
      diag("class"),
      nd(p, "entity", "abstract", "Entity"),
      nd(p, "user", "class", "User"),
      nd(p, "order", "class", "Order"),
      nd(p, "repo", "interface", "Repository"),
      ed(p, "user", "entity", "inherits"),
      ed(p, "order", "entity", "inherits"),
      ed(p, "user", "order", "association"),
    ],
  },
  storymap: {
    kind: "storymap",
    label: "User story map",
    summary:
      "A backlog laid out as the user's journey: activities left to right, stories beneath, sliced into releases.",
    guidance: [
      "One CREATE_GROUP per user activity (the backbone), left to right in the order the",
      "user does them; each story is a node in its activity's group, with SET_ISSUE type",
      '"story" whose first label names its release ("MVP", "Release 2") — releases become',
      "rows, earliest first.",
    ],
    nodeTypes: ["story"],
    category: "planning",
    // docs/27 D3: the story-map geometry (activities × releases) replaces this
    // grid packing when it lands.
    layout: "grid",
    route: "polyline",
    aiCreatable: true,
    convertible: true,
    regionable: false,
    elk: false,
    starter: (p) => [
      diag("storymap"),
      grp(p, "find", "Find a product"),
      grp(p, "buy", "Buy it"),
      nd(p, "search", "story", "Search by name", "find"),
      nd(p, "filter", "story", "Filter by price", "find"),
      nd(p, "cart", "story", "Add to cart", "buy"),
      nd(p, "applepay", "story", "Pay with Apple Pay", "buy"),
      story(p, "search", "MVP"),
      story(p, "filter", "Release 2"),
      story(p, "cart", "MVP"),
      story(p, "applepay", "Release 2"),
    ],
  },
};

/** The spec for a kind. Total over `DiagramKind`, so never undefined. */
export function getRepresentation(kind: DiagramKind): RepresentationSpec {
  return REPRESENTATIONS[kind];
}

/** Every representation, in `DIAGRAM_KINDS` order. */
export function listRepresentations(): RepresentationSpec[] {
  return DIAGRAM_KINDS.map((kind) => REPRESENTATIONS[kind]);
}

/** The layout geometry for a kind — the source `layout.ts` reads. */
export function layoutStrategyFor(kind: DiagramKind): LayoutStrategy {
  return REPRESENTATIONS[kind].layout;
}

/** The human label for a kind — the source the canvas labels read. */
export function representationLabel(kind: DiagramKind): string {
  return REPRESENTATIONS[kind].label;
}

/**
 * Whether a node of `nodeType` is a pseudo-node in `kind`, and which end of
 * the flow it marks — the one answer the layout (which shrinks it) and the
 * canvas (which draws its shape) both read, so they cannot disagree.
 */
export function pseudoRoleFor(kind: DiagramKind, nodeType: string): PseudoRole | null {
  const pseudo = REPRESENTATIONS[kind].pseudo;
  if (!pseudo) return null;
  if (pseudo.start.includes(nodeType)) return "start";
  if (pseudo.end.includes(nodeType)) return "end";
  return null;
}

/** The lens that presents `kind`, if it has one. */
export function lensFor(kind: DiagramKind): RepresentationLens | undefined {
  return REPRESENTATIONS[kind].lens;
}

/**
 * The operations that seed a minimal editable example of `kind`. `idPrefix`
 * namespaces the generated ids; pass a fresh value per insert so a second
 * insert doesn't collide with the first (the reducer rejects duplicate ids).
 */
export function starterFor(kind: DiagramKind, idPrefix: string): Operation[] {
  return REPRESENTATIONS[kind].starter(idPrefix);
}

/** The kinds offered as "Convert board to…" targets, in order. */
export function convertibleKinds(): DiagramKind[] {
  return listRepresentations()
    .filter((r) => r.convertible)
    .map((r) => r.kind);
}

/** The kinds a region may take, in order. */
export function regionKinds(): DiagramKind[] {
  return listRepresentations()
    .filter((r) => r.regionable)
    .map((r) => r.kind);
}

/** The kinds the ELK engine may lay out. */
export function elkKinds(): DiagramKind[] {
  return listRepresentations()
    .filter((r) => r.elk)
    .map((r) => r.kind);
}

/** The kinds the AI is told it may create, in order. */
export function aiCreatableKinds(): DiagramKind[] {
  return listRepresentations()
    .filter((r) => r.aiCreatable)
    .map((r) => r.kind);
}

const CATEGORY_TITLE: Record<RepresentationCategory, string> = {
  flow: "Flow & process",
  structure: "Structure",
  planning: "Planning",
};

/**
 * The family section of the AI system prompt, generated from the registry so
 * a new family reaches the model with no prompt edit: each creatable family's
 * `- kind — summary` line, grouped by category, with its construction rules
 * indented beneath. It belongs in the SYSTEM prompt (rendered once, at load):
 * the per-request board context is data, and a catalog there would teach the
 * model that board data can carry instructions.
 */
export function representationCatalogPrompt(): string {
  const lines: string[] = [
    "Diagram families you can create or convert to (CREATE_DIAGRAM / TRANSFORM_DIAGRAM `kind`).",
    "Pick the one whose shape matches the idea; the layout engine handles positions.",
  ];
  for (const category of ["flow", "structure", "planning"] as const) {
    const specs = listRepresentations().filter(
      (r) => r.aiCreatable && r.category === category,
    );
    if (specs.length === 0) continue;
    lines.push(`${CATEGORY_TITLE[category]}:`);
    for (const spec of specs) {
      lines.push(`- ${spec.kind} — ${spec.summary}`);
      for (const g of spec.guidance) lines.push(`    ${g}`);
    }
  }
  return lines.join("\n");
}
