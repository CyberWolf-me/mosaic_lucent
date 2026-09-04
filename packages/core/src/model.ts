/**
 * Core semantic model for the Lucent workspace.
 *
 * The workspace is a structured graph, never a picture. Renderers (tldraw, etc.)
 * derive visuals from this model; the AI only ever proposes changes to it via
 * validated operations. See docs/03-semantic-canvas-and-data-model.md.
 */

/**
 * Representations the semantic model can render as. Each maps to a layout
 * strategy in layout.ts — the model is one graph, the kind chooses the geometry.
 */
export type DiagramKind =
  | "flowchart"
  | "architecture"
  | "mindmap"
  | "journey"
  | "decisiontree"
  | "process"
  | "orgchart";

/** Coordinates are always assigned by the layout engine, never by the AI. */
export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Node {
  id: string;
  /** Semantic type, e.g. "service", "screen", "decision", "actor". Free-form. */
  nodeType: string;
  label: string;
  groupId?: string;
  /** Assigned by the layout engine. Undefined until laid out. */
  position?: Position;
  size?: Size;
  /**
   * True once the user has dragged this node by hand. The layout engine then
   * leaves its coordinates alone, so a manual arrangement isn't undone the next
   * time the board re-lays out (docs/03: layout owns positions, but an explicit
   * human placement outranks it).
   */
  pinned?: boolean;
  /**
   * Optional work-tracking fields (Jira-style). Present when a node represents a
   * unit of work rather than a diagram element, so the same semantic node can be
   * shown as an architecture box or as a Kanban card. All fields optional so a
   * plain diagram node carries no issue overhead.
   */
  issue?: IssueFields;
  /** What this node IS semantically — the statement it carries (Stage C2). */
  statement?: StatementFields;
  /** Creation evidence — which meeting/turns produced this node (Stage C2). */
  provenance?: ProvenanceFields;
  metadata?: Record<string, unknown>;
}

/** Work-item hierarchy, mirroring Jira's epic → story/task → subtask + bug. */
export type IssueType = "epic" | "story" | "task" | "subtask" | "bug";

/** The four canonical workflow states. Custom statuses map onto one of these
 * categories so a board always has somewhere to put a card. */
export type IssueStatusCategory = "todo" | "in_progress" | "done";

export type IssuePriority = "highest" | "high" | "medium" | "low" | "lowest";

export interface IssueFields {
  type: IssueType;
  /** Free-form status label ("To Do", "In Review", "Blocked", "Done" — or a
   * Stage D1 canonical execution status: open/assigned/in_progress/blocked/
   * completed/cancelled). The vocabulary is convention + teaching, not an
   * enum: existing boards keep whatever labels they already carry. */
  status: string;
  /** Which column a board places this in; derived from status when omitted. */
  statusCategory: IssueStatusCategory;
  assignee?: string;
  priority?: IssuePriority;
  /** Estimation points (Fibonacci-ish in Jira; any non-negative number here). */
  storyPoints?: number;
  labels?: string[];
  /** Parent work item (an epic id for a story, a story id for a subtask). */
  parentId?: string;
  /** Stage D1: the work's deadline, ISO YYYY-MM-DD. The first date field in
   * the system — words like "by Friday" are resolved at emission against a
   * reference timestamp (never stored as words), so the same meeting always
   * produces the same date. */
  dueDate?: string;
  /** Stage D1: what the work involves — the action's body text. Capped at
   * 2000 like Comment.body; the validator is authoritative. */
  description?: string;
}

/* -------------------------------------------------------------------------- */
/* The execution model (Stage D1, ADR 0027)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The canonical execution-status vocabulary (Stage D1). Deliberately a
 * documented list, NOT a zod enum: `issue.status` stays a free-form string so
 * existing boards ("To Do", "In Review", "Done") load unchanged. The
 * vocabulary is what the AI is taught, what Intelligence renders, and what
 * `executionStatusColumn` maps — convention over constraint.
 */
export const EXECUTION_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * The Board-column projection of the canonical execution statuses (ADR 0027):
 * the column is a PRESENTATION of the execution state, never its definition.
 * Legacy labels keep `categorizeStatus`'s keyword behavior; only these six
 * values take the explicit mapping.
 */
export function executionStatusColumn(status: string): IssueStatusCategory | undefined {
  switch (status) {
    case "open":
    case "assigned":
      return "todo";
    case "in_progress":
    case "blocked":
      return "in_progress";
    case "completed":
    case "cancelled":
      return "done";
    default:
      return undefined;
  }
}

/**
 * Resolve a relative deadline phrase to an ISO date, against a reference
 * timestamp (Stage D1's determinism rule: same words + same reference =
 * same date; never store "Friday"). Pure — callers pass the meeting/message
 * time the phrase was spoken in. Recognized: weekday names ("by Friday",
 * "next Monday" — strictly forward, today never matches), "tomorrow",
 * "today", "end of week" (Friday), and "the Nth"/"before the Nth" (day of
 * the reference's month; a past date rolls to the next month — "the 15th"
 * said on the 20th means next month's). Returns undefined when the words
 * name no date: an unresolvable deadline stores nothing, never a guess.
 */
export function resolveDueDate(words: string, referenceAt: number): string | undefined {
  const text = words.toLowerCase();
  const ref = new Date(referenceAt);
  if (Number.isNaN(ref.getTime())) return undefined;
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (n: number): Date => {
    const d = new Date(ref);
    d.setDate(d.getDate() + n);
    return d;
  };
  // The next strictly-forward weekday (0=Sunday…6=Saturday). Both "by
  // Friday" and "by next Friday" said mid-week mean the upcoming Friday —
  // the way people speak (ADR 0027's reference rule); the only case the
  // "next" word matters for is handled by strict forwardness itself, since
  // TODAY never matches.
  const WEEKDAYS: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const nextWeekday = (target: number): Date => {
    const delta = ((target - ref.getDay() + 7) % 7) || 7;
    return addDays(delta);
  };
  const nextWeek = /next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/.exec(text);
  if (nextWeek) return iso(nextWeekday(WEEKDAYS[nextWeek[1]!]!));
  const thisWeek = /(^|[^a-z])(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/.exec(text);
  if (thisWeek) return iso(nextWeekday(WEEKDAYS[thisWeek[2]!]!));
  if (/\btomorrow\b/.test(text)) return iso(addDays(1));
  if (/\btoday\b/.test(text)) return iso(ref);
  if (/\bend of (the )?week\b/.test(text)) return iso(nextWeekday(WEEKDAYS.friday!));
  // "the 15th" / "before the 3rd" — day of month, rolled forward when past.
  const nth = /\b(?:by |before |on )?the (\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (nth) {
    const day = Number(nth[1]);
    if (day >= 1 && day <= 31) {
      let d = new Date(ref.getFullYear(), ref.getMonth(), day);
      if (d < ref) d = new Date(ref.getFullYear(), ref.getMonth() + 1, day);
      return iso(d);
    }
  }
  // An explicit ISO date passes through verbatim (the AI may have one).
  const explicit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(words);
  if (explicit) return explicit[1]!;
  return undefined;
}

/**
 * The executable actions on a board (Stage D1): nodes that ARE actions
 * (statement.kind === "action") AND carry work-tracking fields — the C2
 * statement says "this is work to do"; the issue fields make it executable.
 * A bare action statement without an issue is still just a statement
 * ("maybe we should redesign onboarding" is not work), so it is excluded.
 */
export function actionNodes(workspace: Workspace): Node[] {
  return Object.values(workspace.nodes).filter(
    (n) => n.statement?.kind === "action" && n.issue,
  );
}

/* -------------------------------------------------------------------------- */
/* Statement semantics (Stage C2, ADR 0021)                                    */
/* -------------------------------------------------------------------------- */

/**
 * The six statement kinds. A closed set: each carries a distinct lifecycle
 * (decisions/proposals supersede, questions resolve, actions complete,
 * requirements change, risks mitigate), and a new kind requires evidence of
 * its own lifecycle behavior — not merely a new label — before it joins the
 * union (ADR 0021's freeze rule).
 */
export type StatementKind =
  | "decision"
  | "proposal"
  | "question"
  | "action"
  | "requirement"
  | "risk";

/** Lifecycle statuses shared by every kind (see ADR 0021 for the reasoning). */
export type StatementStatus = "open" | "resolved" | "rejected" | "superseded";

/**
 * What a node IS semantically — the decision/proposal/question/action/
 * requirement/risk it represents, with its lifecycle state and evidence.
 * The mirror of IssueFields for meaning instead of work tracking: set by
 * validated operations (SET_STATEMENT/UPDATE_STATEMENT), shared through the
 * op log, undone by inverse ops. Survives relabels and transforms — the
 * statement is the node's identity, not its current caption.
 */
export interface StatementFields {
  kind: StatementKind;
  status: StatementStatus;
  /** Short kebab-case subject key so "pricing" groups across nodes (C2: a
   * plain key; entity resolution across wordings is C5's topic work). */
  topic?: string;
  /** Nodes this statement replaces. The reducer marks those superseded. */
  supersedes?: string[];
  /** Evidence for the statement itself (meeting loop enrichment). */
  provenance?: ProvenanceFields;
}

/**
 * Creation evidence on a node (Stage C2, ADR 0022): which meeting, which
 * turns, which words produced it. Set once at CREATE_NODE and untouched by
 * every later operation — a node's origin does not change when its label,
 * layout, or statement does.
 */
export interface ProvenanceFields {
  meetingId: string;
  /** Inclusive index range into the meeting's turns. */
  turnRange?: [number, number];
  /** The meeting loop's classification of the source turns, in turn order. */
  turnKinds?: string[];
  /** The words that produced this node, capped at 240 characters. */
  quote?: string;
}

export interface Edge {
  id: string;
  source: string;
  target: string;
  /** Semantic relationship, e.g. "calls", "initiates", "receives". */
  relationship: string;
  metadata?: Record<string, unknown>;
}

export interface Group {
  id: string;
  label: string;
  /** Node ids belonging to this group. */
  children: string[];
  /**
   * When set, this group is a *diagram region*: its members are laid out by
   * the strategy for this kind while the rest of the board keeps the board-wide
   * `diagramKind`. Unset groups remain plain visual containers — a swimlane's
   * lanes, an actor boundary — so existing boards change nothing. The kind is a
   * rendering lens, not content: the same nodes can move between kinds freely
   * (the "one model, many representations" principle, applied per region).
   */
  kind?: DiagramKind;
}

/**
 * Wireframe as a *derived representation* of the semantic model, not a picture.
 * The AI emits this structure (regions, rows, fields, buttons) as operations; it
 * never sets pixel coordinates. A flexbox renderer turns the tree into visuals,
 * so wireframes stay editable like everything else (docs/03, docs/05).
 */
export type WireframeViewport = "desktop" | "tablet" | "mobile";

/** Free-form kind; the renderer styles known kinds and falls back for others. */
export interface WireframeElement {
  /** e.g. "screen", "row", "column", "card", "nav", "header", "sidebar",
   * "section", "heading", "text", "field", "input", "button", "image",
   * "divider", "checkbox", "list". */
  kind: string;
  label?: string;
  placeholder?: string;
  variant?: "primary" | "secondary" | "ghost";
  /** Container flow direction. Ignored by leaf kinds. */
  direction?: "row" | "column";
  /** Flex weight within its parent (defaults to 1). */
  weight?: number;
  children?: WireframeElement[];
}

export interface Wireframe {
  id: string;
  title: string;
  viewport: WireframeViewport;
  root: WireframeElement;
}

/**
 * A manual board element: something the user draws/drops by hand, as opposed to
 * a semantic Node the AI creates. Shapes carry their OWN pinned coordinates and
 * are never moved by the layout engine (docs/13). They still live in the model
 * so they persist, undo/redo, and can be read/upgraded by the AI.
 */
export type ShapeKind =
  | "rect"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "star"
  | "sticky"
  | "text"
  | "draw"
  | "image"
  | "frame"
  | "embed"
  | "file";

export interface ShapeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: "left" | "center" | "right";
  opacity?: number;
  radius?: number;
}

export interface Shape {
  id: string;
  kind: ShapeKind;
  position: Position;
  size: Size;
  rotation?: number;
  text?: string;
  /** SVG path data for kind "draw". */
  path?: string;
  /**
   * Source for kind "image" -- an `asset:ast_...` reference once the bytes live
   * in object storage (M3), a data URL on a board written before that, or an
   * http(s) URL. Embed URL for kind "embed", which stays http(s)-only.
   */
  src?: string;
  style?: ShapeStyle;
  /** Explicit z-order; higher renders on top. */
  z?: number;
  /** Manual grouping id (distinct from semantic node Groups). */
  groupId?: string;
  /** When true, the shape can't be moved/resized/deleted until unlocked. */
  locked?: boolean;
  /** When true, the shape is hidden from the canvas (still in the model). */
  hidden?: boolean;
}

/** A manual connector binding two shapes; re-routes as they move (docs/13). */
export interface ShapeLink {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Routing style; defaults to "curved". */
  variant?: "straight" | "elbow" | "curved";
  /** Arrowheads at both ends instead of just the target. */
  doubleArrow?: boolean;
}

/**
 * A vote cast for a board object during a voting session (docs/14 §workshop).
 *
 * Votes are stored individually rather than as a per-object counter so they can
 * be withdrawn, attributed, and undone one at a time — and so a future
 * multiplayer session can attribute them to real participants without a schema
 * change. `by` is always a real author id: the server stamps it from the
 * committing session (authorship.ts), and the two spellings that are not a
 * person — `ASSISTANT_AUTHOR` for annotations the AI wrote itself and
 * `UNKNOWN_AUTHOR` for a record predating stamping — are reserved ids outside
 * the `usr_...` namespace, so neither can be mistaken for an account.
 */
export interface Vote {
  id: string;
  /** Node or shape id this vote is for. */
  targetId: string;
  by: string;
}

/** An emoji reaction attached to a board object. Same storage rationale as Vote. */
export interface Reaction {
  id: string;
  /** Node or shape id this reaction is attached to. */
  targetId: string;
  /** A single emoji character, e.g. "👍". */
  emoji: string;
  by: string;
}

/**
 * A comment anchored to a board object, or a reply within a thread.
 *
 * A thread is a root comment (`parentId` undefined) plus its replies. Storing
 * replies as ordinary comments with a `parentId` keeps the model flat, so a
 * reply undoes independently and a future multiplayer session can stream
 * individual comments without a nested-document merge.
 *
 * `resolved` lives on the root; replies inherit their thread's state.
 */
export interface Comment {
  id: string;
  /** Node or shape id this thread hangs off. Replies repeat their root's target. */
  targetId: string;
  body: string;
  by: string;
  createdAt: number;
  /** Root comment id when this is a reply; undefined for a thread root. */
  parentId?: string;
  /** Only meaningful on a thread root. */
  resolved?: boolean;
  /** Names extracted from @mentions in the body, for notification later. */
  mentions?: string[];
}

export interface Workspace {
  id: string;
  name: string;
  diagramKind: DiagramKind;
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  groups: Record<string, Group>;
  wireframes: Record<string, Wireframe>;
  shapes: Record<string, Shape>;
  shapeLinks: Record<string, ShapeLink>;
  votes: Record<string, Vote>;
  reactions: Record<string, Reaction>;
  comments: Record<string, Comment>;
}

export function createWorkspace(
  init: Partial<Pick<Workspace, "id" | "name" | "diagramKind">> = {},
): Workspace {
  return {
    id: init.id ?? "workspace",
    name: init.name ?? "Untitled",
    diagramKind: init.diagramKind ?? "flowchart",
    nodes: {},
    edges: {},
    groups: {},
    wireframes: {},
    shapes: {},
    shapeLinks: {},
    votes: {},
    reactions: {},
    comments: {},
  };
}

/** A thread: its root comment plus replies in creation order. */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

/** Threads for one target, or for the whole board when targetId is omitted. */
export function commentThreads(workspace: Workspace, targetId?: string): CommentThread[] {
  const all = Object.values(workspace.comments ?? {});
  const roots = all
    .filter((c) => !c.parentId && (targetId === undefined || c.targetId === targetId))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return roots.map((root) => ({
    root,
    replies: all
      .filter((c) => c.parentId === root.id)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
  }));
}

/** Count of unresolved threads per target id, for pin badges. */
export function openCommentCounts(workspace: Workspace): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of Object.values(workspace.comments ?? {})) {
    if (c.parentId || c.resolved) continue;
    counts[c.targetId] = (counts[c.targetId] ?? 0) + 1;
  }
  return counts;
}

/** Every distinct name mentioned in unresolved threads (a notification feed). */
export function openMentions(workspace: Workspace): string[] {
  const roots = new Map(
    Object.values(workspace.comments ?? {})
      .filter((c) => !c.parentId)
      .map((c) => [c.id, c]),
  );
  const names = new Set<string>();
  for (const c of Object.values(workspace.comments ?? {})) {
    const root = c.parentId ? roots.get(c.parentId) : c;
    if (root?.resolved) continue;
    for (const m of c.mentions ?? []) names.add(m);
  }
  return [...names].sort();
}

/** Extract @mention names from a comment body. Names are word characters, dots, and dashes. */
export function parseMentions(body: string): string[] {
  const found = body.match(/@[\w.-]+/g) ?? [];
  return [...new Set(found.map((m) => m.slice(1)))];
}

/**
 * Map a free-form status label onto one of the three board columns. Jira lets
 * teams invent statuses ("In Review", "Blocked", "QA"); a board still needs to
 * know which column to drop the card in, so we categorize by keyword and default
 * unknown statuses to "todo".
 */
export function categorizeStatus(status: string): IssueStatusCategory {
  const s = status.trim().toLowerCase();
  // The canonical execution statuses take the explicit D1 projection first
  // (ADR 0027) — the Board column is a presentation of execution state.
  // Legacy labels fall through to the keyword behavior unchanged.
  const canonical = executionStatusColumn(s);
  if (canonical) return canonical;
  if (/(^|\b)(done|closed|resolved|complete|completed|shipped|merged)\b/.test(s)) return "done";
  if (
    /(^|\b)(in progress|in-progress|doing|active|review|in review|testing|qa|blocked|started)\b/.test(
      s,
    )
  ) {
    return "in_progress";
  }
  if (/(^|\b)(to ?do|todo|backlog|open|new|planned|ready)\b/.test(s)) return "todo";
  return "todo";
}

/** The default column order a Kanban board renders. */
export const BOARD_COLUMNS: ReadonlyArray<{ category: IssueStatusCategory; label: string }> = [
  { category: "todo", label: "To Do" },
  { category: "in_progress", label: "In Progress" },
  { category: "done", label: "Done" },
];

/** Nodes that carry issue fields, i.e. the work items on a board. */
export function issueNodes(workspace: Workspace): Node[] {
  return Object.values(workspace.nodes).filter((n) => n.issue);
}

/**
 * Nodes that carry a statement, i.e. the semantic layer of a board (Stage
 * C2): the decisions, proposals, questions, actions, requirements, and risks
 * it holds. The selector behind every statement-aware surface — chips, the
 * HUD editor's supersedes candidates, the C6 views to come.
 */
export function statementNodes(workspace: Workspace): Node[] {
  return Object.values(workspace.nodes).filter((n) => n.statement);
}

/** Group issue nodes by board column, preserving insertion order within each. */
export function boardColumns(workspace: Workspace): Record<IssueStatusCategory, Node[]> {
  const cols: Record<IssueStatusCategory, Node[]> = { todo: [], in_progress: [], done: [] };
  for (const n of issueNodes(workspace)) {
    cols[n.issue!.statusCategory].push(n);
  }
  return cols;
}

/** Sum of story points per column, for a board's capacity readout. */
export function pointsByCategory(workspace: Workspace): Record<IssueStatusCategory, number> {
  const totals: Record<IssueStatusCategory, number> = { todo: 0, in_progress: 0, done: 0 };
  for (const n of issueNodes(workspace)) {
    totals[n.issue!.statusCategory] += n.issue!.storyPoints ?? 0;
  }
  return totals;
}

/** Vote count per target id, for badges and the results tally. */
export function voteTally(workspace: Workspace): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const vote of Object.values(workspace.votes)) {
    tally[vote.targetId] = (tally[vote.targetId] ?? 0) + 1;
  }
  return tally;
}

/** Targets ordered by vote count, highest first; ties keep insertion order. */
export function voteRanking(workspace: Workspace): Array<{ targetId: string; votes: number }> {
  return Object.entries(voteTally(workspace))
    .map(([targetId, votes]) => ({ targetId, votes }))
    .sort((a, b) => b.votes - a.votes);
}

/** Reaction counts per target, grouped by emoji: `{ [targetId]: { "👍": 2 } }`. */
export function reactionTally(workspace: Workspace): Record<string, Record<string, number>> {
  const tally: Record<string, Record<string, number>> = {};
  for (const r of Object.values(workspace.reactions)) {
    const forTarget = (tally[r.targetId] ??= {});
    forTarget[r.emoji] = (forTarget[r.emoji] ?? 0) + 1;
  }
  return tally;
}

/** Deterministic edge id so CONNECT/DISCONNECT are idempotent and reversible. */
export function edgeId(source: string, target: string, relationship: string): string {
  return `${source}->${target}:${relationship}`;
}
