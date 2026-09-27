import type { NotesRequest, NotesResult } from "./notes.js";
import type { ThemesRequest, ThemesResult } from "./themes.js";
import type { DiagramKind, Operation, Workspace } from "@lucent/core";
import { commentThreads, compositionLine, reactionTally, voteRanking } from "@lucent/core";
import type { AnswerRequest, AnswerResult } from "./answer.js";
import type { ExternalPlanRequest, ExternalPlanResult } from "./externalPlan.js";

/**
 * Provider-agnostic AI boundary. The moat is the semantic canvas + harness, not
 * the model (docs/09 section 0). Anthropic, OpenAI, a mock, or a future
 * in-house model all implement this one interface, so the rest of the system
 * never depends on a specific vendor.
 */

/** Compact description of the current workspace sent as context (docs/12). */
export interface WorkspaceSummary {
  diagramKind: DiagramKind;
  nodes: Array<{
    id: string;
    nodeType: string;
    label: string;
    groupId?: string;
    /** Work-tracking fields, when this node is a Kanban/issue card. */
    issue?: {
      type: string;
      status: string;
      statusCategory: string;
      assignee?: string;
      priority?: string;
      storyPoints?: number;
      parentId?: string;
      /** Stage D2: the execution fields (ADR 0027) — plans must preserve them. */
      dueDate?: string;
      description?: string;
    };
    /**
     * The semantic statement this node carries (Stage C2): what it IS — a
     * decision, proposal, question, action, requirement, or risk — with its
     * lifecycle status, topic key, and supersession links. The model needs
     * this to update a decision it can see ("actually, we changed our mind")
     * and to avoid re-deciding what is already decided. Provenance is
     * deliberately omitted: the model cannot emit it, so showing it would be
     * context the ops can never carry.
     */
    statement?: {
      kind: "decision" | "proposal" | "question" | "action" | "requirement" | "risk";
      status: "open" | "resolved" | "rejected" | "superseded";
      topic?: string;
      supersedes?: string[];
    };
  }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
  /**
   * Semantic groups. The model is asked to reuse group ids and to declare a
   * group before referencing it, which it cannot do without seeing them.
   * `kind` marks a diagram region — its own rendering lens on one board —
   * which the model needs to see to target "the pricing mind map" instead of
   * the whole board.
   */
  groups?: Array<{ id: string; label: string; children: string[]; kind?: string }>;
  /**
   * Manual board objects (sticky notes, shapes, frames, drawings, media). The
   * model can create and edit these, so it has to see them — otherwise
   * "what's on this board?" ignores everything placed by hand.
   */
  shapes?: Array<{
    id: string;
    kind: string;
    text?: string;
    groupId?: string;
    locked?: boolean;
    hidden?: boolean;
    /**
     * A table shape's content (V4), so "add a row to the pricing table" can see
     * the columns it has to fill. Capped by `capTableSummary`.
     */
    table?: TableSummary;
    /** A chart shape's shape (V4): what it plots, not the numbers. */
    chart?: ChartSummary;
  }>;
  /** Manual connectors between shapes. */
  shapeLinks?: Array<{ id: string; source: string; target: string; label?: string }>;
  /** Derived wireframes by id/title; the element tree is omitted for size. */
  wireframes?: Array<{ id: string; title: string; viewport: string }>;
  /**
   * Vote counts per object from a voting round, highest first. Lets the model
   * answer "which idea won?" and act on the result ("expand the top three").
   */
  votes?: Array<{ targetId: string; votes: number }>;
  /** Emoji reaction counts per object, e.g. `{ targetId, emoji: "👍", count: 2 }`. */
  reactions?: Array<{ targetId: string; emoji: string; count: number }>;
  /**
   * Open comment threads, so the model can act on feedback ("address the
   * comments", "what are people asking about?"). Resolved threads are omitted.
   */
  comments?: Array<{
    id: string;
    targetId: string;
    body: string;
    by: string;
    replies: number;
  }>;
  /** Ids the user currently has selected — lets the AI resolve "this/these"
   * (docs/15 Phase C reference resolution). Optional for back-compat. */
  selection?: string[];
  /**
   * V1 composition, derived in core: one line naming the board's main
   * story (longest chain through the highest-degree node) and its regions.
   * Empty string when the board has no edges. The model reads this BEFORE
   * the node list, so "explain this architecture" leads with the story
   * instead of rediscovering it from ids.
   */
  composition?: string;
  /**
   * Present when the board was too large to send in full. Counts are the true
   * totals before capping; the AI should ask for a focused slice instead of
   * reasoning about the partial view.
   */
  truncated?: { nodes?: number; edges?: number };
}

/**
 * What the model sees of a table: its header row, then as many leading rows as
 * fit the character budget, never a partial row (a row cut mid-way reads as a
 * row with empty cells). The totals are the real size, so the prompt can say
 * when rows are hidden — an UPDATE_SHAPE `table` replaces the whole grid, and
 * a model rewriting a table it saw only the top of would delete the rest.
 */
export interface TableSummary {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
}

/**
 * What the model sees of a chart: enough to name it and to say what it plots
 * ("the revenue chart", "add a 2027 series"). The values stay out — they are
 * the bulk of a chart and a model has no use for them it could not get from
 * the table the chart was built from.
 */
export interface ChartSummary {
  type: string;
  title?: string;
  labels: string[];
  series: string[];
  totalLabels: number;
}

/** One prior turn of the conversation, so follow-ups resolve (docs/12 memory). */
export interface ConversationTurn {
  role: "user" | "ai";
  text: string;
}

/**
 * An image the user attached to their request — a screenshot to redraw, a
 * whiteboard photo to digitize, a mockup to turn into a wireframe.
 *
 * Providers that support vision send this alongside the text; ones that don't
 * fall back gracefully and say the image was ignored, rather than pretending to
 * have looked at it.
 */
export interface ImageAttachment {
  /** Base64 payload without the data-URL prefix. */
  data: string;
  /** e.g. "image/png". */
  mediaType: string;
}

/** A document the user attached — extracted text, not the raw bytes. */
export interface DocumentAttachment {
  name: string;
  text: string;
}

export interface GenerateRequest {
  /** The user's natural-language message (from text or transcribed voice). */
  message: string;
  /** Current workspace state so follow-ups resolve references. */
  summary: WorkspaceSummary;
  /**
   * Recent conversation turns, oldest first, excluding the current message.
   * Without this each request was stateless, so "make it simpler" or "add three
   * more like that" had nothing to refer back to.
   */
  history?: ConversationTurn[];
  /** Images to look at while answering (vision-capable providers only). */
  images?: ImageAttachment[];
  /** Documents whose text should inform the answer. */
  documents?: DocumentAttachment[];
  /**
   * The requester's local calendar date, YYYY-MM-DD. The prompt tells the
   * model to resolve "by Friday" to a dueDate "against the conversation's
   * date" — without this it had no date to resolve against and guessed from
   * its training data (a live board got "Friday" → a date a year in the
   * past). Local, not server UTC: "Friday" is the speaker's Friday.
   */
  today?: string;
}

/**
 * Tokens one completion consumed, as the provider reported them.
 *
 * Both counts are optional because gateways disagree about what they return —
 * some send only a total, some omit usage entirely. A missing count is recorded
 * as absent rather than as zero: M4 reconciles revenue against `usage_events`,
 * and a fabricated 0 is worse than a visible gap.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface GenerateResult {
  operations: Operation[];
  /** Optional natural-language explanation for the conversation pane (docs/13). */
  explanation?: string;
  /**
   * What Lucent says back in a voice conversation: talking with the person,
   * not reading them the diff — often ending in one follow-up question. The
   * pane keeps `explanation`; voice speaks this, and falls back to the
   * explanation when a model leaves it out.
   */
  reply?: string;
  /**
   * The model that actually answered, as the provider named it in its response
   * — not the one that was requested. Gateways silently reroute, and the meter
   * has to record what was billed (M4).
   */
  model?: string;
  /** Token counts for this completion, when the provider reported them. */
  usage?: TokenUsage;
}

/**
 * Receivers for a streaming generation (M5/E1). `onDelta` gets the payload
 * text as the model writes it — operation JSON and explanation prose alike —
 * so a client can show progress; the returned `GenerateResult` is the same
 * parsed, validated-on-arrival shape `generateOperations` returns, and is the
 * only thing a client may apply. Deltas are display material, never state.
 */
export interface StreamCallbacks {
  onDelta(delta: string): void;
}

export interface LLMProvider {
  readonly name: string;
  generateOperations(request: GenerateRequest): Promise<GenerateResult>;
  /**
   * The answering call type (Stage C1): the same board, read instead of
   * written. Required, so a provider cannot compile as a silent gap where
   * asking breaks at runtime — the three shipped providers implement it and
   * test stubs say what they want. No streaming variant: answers are short,
   * and the citations only make sense as part of a whole.
   */
  generateAnswer(request: AnswerRequest): Promise<AnswerResult>;
  /**
   * The external-plan call type (Stage D9): the same board, narrowed
   * instead of written or read. The model selects which of the server's
   * candidate actions to propose for external sync, plus a rationale; the
   * server builds every item from real state and the human approves.
   * Required, so a provider cannot compile as a silent gap — the narrowing
   * contract is a platform promise, not a per-provider courtesy.
   */
  generateExternalPlan(request: ExternalPlanRequest): Promise<ExternalPlanResult>;
  /**
   * The meeting-notes call type (docs/27 N1): enhance a person's notes with
   * cited lines from the transcript. Optional — a provider without it gets
   * the server's offline enhancer — so test stubs need not grow a method.
   */
  generateNotes?(request: NotesRequest): Promise<NotesResult>;
  /**
   * The sticky-sort call type (docs/27 D2): group sticky notes into titled
   * themes, by index. Optional for the same reason — without it the server's
   * offline keyword sorter answers.
   */
  generateThemes?(request: ThemesRequest): Promise<ThemesResult>;
  /**
   * Streaming variant. Optional: the single-shot contract stays the default,
   * and `streamViaGenerate` adapts any non-streaming provider so callers can
   * ask for a stream without feature-detecting. Implementations must deliver
   * the deltas in order and resolve with the same result the concatenated
   * deltas parse to.
   */
  streamOperations?(request: GenerateRequest, callbacks: StreamCallbacks): Promise<GenerateResult>;
}

/**
 * The default stream: one call, deltas delivered once the answer exists. It
 * is honest — a provider without a streaming API has nothing to stream — and
 * it means the SSE route and every caller downstream need no feature detect.
 */
export function streamViaGenerate(
  provider: LLMProvider,
  request: GenerateRequest,
  callbacks: StreamCallbacks,
): Promise<GenerateResult> {
  const generate = provider.generateOperations.bind(provider);
  return generate(request).then((result) => {
    callbacks.onDelta(
      JSON.stringify({ operations: result.operations, explanation: result.explanation ?? null }),
    );
    return result;
  });
}

/** Caps so a large board or long chat can't blow up the context window. */
export const SUMMARY_LIMITS = {
  nodes: 200,
  edges: 400,
  shapes: 120,
  shapeLinks: 60,
  /** Sticky/text content is the useful part; long bodies get truncated. */
  shapeTextChars: 140,
  historyTurns: 8,
  historyChars: 600,
  comments: 40,
  commentChars: 300,
  /**
   * Table and chart content (V4). A table is the one shape whose text can be
   * large by design (TABLE_LIMITS allows 200k characters), so it gets its own
   * budget rather than `shapeTextChars`: the header row plus leading rows up to
   * `tableChars`, each cell cut to `dataCellChars`. Enough to see the columns
   * and the kind of values, which is what "add a row" and "chart this" need;
   * 120 tables at the cap is still less than one attached document.
   */
  tableRows: 10,
  tableColumns: 12,
  tableChars: 800,
  dataCellChars: 60,
  chartLabels: 24,
  chartSeries: 12,
} as const;

/**
 * Caps for the collections whose size follows from the node and shape budgets
 * rather than being chosen: at worst one group per node, one vote per object,
 * one wireframe per shape. Separate from SUMMARY_LIMITS only because a `const`
 * object cannot reference itself - conceptually these are part of it, and
 * `summarizeWorkspace` slices to them like any other cap.
 */
export const DERIVED_LIMITS = {
  /** At worst one group per node, and at worst every node inside one group. */
  groups: SUMMARY_LIMITS.nodes,
  groupChildren: SUMMARY_LIMITS.nodes,
  /** A wireframe is a board object, so the shape budget is the right order. */
  wireframes: SUMMARY_LIMITS.shapes,
  /** One row per voted or selected object, and an object is a node or a shape. */
  votes: SUMMARY_LIMITS.nodes + SUMMARY_LIMITS.shapes,
  selection: SUMMARY_LIMITS.nodes + SUMMARY_LIMITS.shapes,
  /** One row per (object, emoji) pair; four distinct emoji per object is already unusual. */
  reactions: (SUMMARY_LIMITS.nodes + SUMMARY_LIMITS.shapes) * 4,
} as const;

/**
 * Ceilings the server enforces on an inbound /api/generate body (M5 size caps).
 *
 * Derived from SUMMARY_LIMITS rather than chosen again, because the two are one
 * contract seen from either end: `summarizeWorkspace` decides what a legitimate
 * client sends, so anything it can produce must parse, and anything larger is a
 * hand-built request whose only purpose is to inflate the prompt. Two
 * independent sets of numbers drift the first time one of them is tuned — which
 * is what had already happened here, with the request schema accepting 20
 * conversation turns of 4,000 characters while the summariser sent 8 of 600.
 *
 * Every key is a mirror: `summarizeWorkspace` slices all of them, the five in
 * DERIVED_LIMITS included. It did not always - groups, wireframes, votes,
 * reactions and selection were capped here but never truncated there, so a
 * marquee-select of a large board produced a request the server refused with a
 * 400 instead of a slightly shorter prompt.
 */
export const REQUEST_LIMITS = {
  // Mirrors — the summariser slices to exactly these.
  nodes: SUMMARY_LIMITS.nodes,
  edges: SUMMARY_LIMITS.edges,
  shapes: SUMMARY_LIMITS.shapes,
  shapeLinks: SUMMARY_LIMITS.shapeLinks,
  shapeTextChars: SUMMARY_LIMITS.shapeTextChars,
  comments: SUMMARY_LIMITS.comments,
  commentChars: SUMMARY_LIMITS.commentChars,
  historyTurns: SUMMARY_LIMITS.historyTurns,
  historyChars: SUMMARY_LIMITS.historyChars,
  tableRows: SUMMARY_LIMITS.tableRows,
  tableColumns: SUMMARY_LIMITS.tableColumns,
  tableChars: SUMMARY_LIMITS.tableChars,
  dataCellChars: SUMMARY_LIMITS.dataCellChars,
  chartLabels: SUMMARY_LIMITS.chartLabels,
  chartSeries: SUMMARY_LIMITS.chartSeries,
  ...DERIVED_LIMITS,
  /**
   * Free-text ceilings for the fields the summariser never truncates. Ids and
   * kinds reuse the shape-text budget (a 140-character id is already absurd),
   * labels and titles the one-turn budget. They bound prompt size; they are not
   * an opinion about what a label may say.
   */
  idChars: SUMMARY_LIMITS.shapeTextChars,
  textChars: SUMMARY_LIMITS.historyChars,
  /**
   * The live request. Usually what a person typed or said, but not always:
   * a meeting extraction's message is the app's differential prompt (~3.5k
   * of instructions) wrapped around the new turns, and at 4k it left room for
   * about 500 characters of speech — a longer batch was refused whole, so the
   * live loop dropped exactly the busy stretches (found in docs/26 A5). 12k
   * holds a real batch and still bounds the prompt (~3k tokens).
   */
  messageChars: 12_000,
  /** Attachments: the browser extracts document text, so no parser sees bytes. */
  documents: 4,
  documentNameChars: 200,
  documentChars: 20_000,
  images: 4,
  /** ~4MB of base64 per image keeps one request within provider limits. */
  imageBase64Chars: 6_000_000,
} as const;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function totalLength(cells: readonly string[]): number {
  return cells.reduce((n, cell) => n + cell.length, 0);
}

/**
 * Cap a table to what the summary carries: at most `tableColumns` columns and
 * `tableRows` rows, each cell cut to `dataCellChars`, and rows added only while
 * the whole stays within `tableChars`. Rows are padded or clipped to the header
 * width, as the renderer draws them.
 *
 * Exported because it runs twice: `summarizeWorkspace` applies it to the board,
 * and `buildUserPrompt` applies it again to whatever summary it was handed. The
 * same function with the same numbers makes the second pass a no-op for a
 * summary this module produced — the model is never told about a smaller table
 * than the app sent — while a hand-built request still cannot inflate the prompt.
 * `totals` carries the real size when the input is already a slice.
 */
export function capTableSummary(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  totals: { rows?: number; columns?: number } = {},
): TableSummary {
  const cell = (text: string | undefined) => truncate(text ?? "", SUMMARY_LIMITS.dataCellChars);
  const width = Math.min(headers.length, SUMMARY_LIMITS.tableColumns);
  const shownHeaders = headers.slice(0, width).map(cell);
  let budget = SUMMARY_LIMITS.tableChars - totalLength(shownHeaders);
  const shownRows: string[][] = [];
  for (const row of rows.slice(0, SUMMARY_LIMITS.tableRows)) {
    const cells = Array.from({ length: width }, (_, i) => cell(row[i]));
    const cost = totalLength(cells);
    if (cost > budget) break;
    budget -= cost;
    shownRows.push(cells);
  }
  return {
    headers: shownHeaders,
    rows: shownRows,
    totalRows: Math.max(totals.rows ?? 0, rows.length),
    totalColumns: Math.max(totals.columns ?? 0, headers.length),
  };
}

/** Cap a chart's description the same way, and for the same two callers. */
export function capChartSummary(chart: {
  type: string;
  title?: string;
  labels: readonly string[];
  series: readonly string[];
  totalLabels?: number;
}): ChartSummary {
  const cell = (text: string) => truncate(text, SUMMARY_LIMITS.dataCellChars);
  const title = chart.title ? cell(chart.title) : "";
  return {
    type: cell(chart.type),
    ...(title ? { title } : {}),
    labels: chart.labels.slice(0, SUMMARY_LIMITS.chartLabels).map(cell),
    series: chart.series.slice(0, SUMMARY_LIMITS.chartSeries).map(cell),
    totalLabels: Math.max(chart.totalLabels ?? 0, chart.labels.length),
  };
}

/** Build the compact summary the AI needs from a full workspace. */
export function summarizeWorkspace(workspace: Workspace, selection?: string[]): WorkspaceSummary {
  const groups = Object.values(workspace.groups)
    .slice(0, DERIVED_LIMITS.groups)
    .map((g) => ({
      id: g.id,
      label: g.label,
      children: g.children.slice(0, DERIVED_LIMITS.groupChildren),
      ...(g.kind ? { kind: g.kind } : {}),
    }));

  const shapes = Object.values(workspace.shapes)
    .slice(0, SUMMARY_LIMITS.shapes)
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      ...(s.text ? { text: truncate(s.text, SUMMARY_LIMITS.shapeTextChars) } : {}),
      ...(s.groupId ? { groupId: s.groupId } : {}),
      ...(s.locked ? { locked: true } : {}),
      ...(s.hidden ? { hidden: true } : {}),
      // V4 data objects: their content is what the model edits or charts, and
      // without it a table on the board was an opaque "(table)" line.
      ...(s.table
        ? {
            table: capTableSummary(
              s.table.columns.map((c) => c.header),
              s.table.rows.map((r) => r.cells),
            ),
          }
        : {}),
      ...(s.chart
        ? {
            chart: capChartSummary({
              type: s.chart.type,
              ...(s.chart.title ? { title: s.chart.title } : {}),
              labels: s.chart.labels,
              series: s.chart.series.map((series) => series.name),
            }),
          }
        : {}),
    }));

  const shapeLinks = Object.values(workspace.shapeLinks)
    .slice(0, SUMMARY_LIMITS.shapeLinks)
    .map((l) => ({
      id: l.id,
      source: l.source,
      target: l.target,
      ...(l.label ? { label: l.label } : {}),
    }));

  const wireframes = Object.values(workspace.wireframes)
    .slice(0, DERIVED_LIMITS.wireframes)
    .map((w) => ({
      id: w.id,
      title: w.title,
      viewport: w.viewport as string,
    }));

  // Vote/reaction tallies, so the model can read a workshop's outcome.
  // Ranked already, so a slice keeps the top of the poll rather than an
  // arbitrary page of it.
  const votes = voteRanking(workspace).slice(0, DERIVED_LIMITS.votes);
  const reactionRows = Object.entries(reactionTally(workspace))
    .flatMap(([targetId, byEmoji]) =>
      Object.entries(byEmoji).map(([emoji, count]) => ({ targetId, emoji, count })),
    )
    .slice(0, DERIVED_LIMITS.reactions);

  // Only unresolved threads: resolved feedback is history, not a to-do.
  const comments = commentThreads(workspace)
    .filter((t) => !t.root.resolved)
    .slice(0, SUMMARY_LIMITS.comments)
    .map((t) => ({
      id: t.root.id,
      targetId: t.root.targetId,
      body: truncate(t.root.body, SUMMARY_LIMITS.commentChars),
      by: t.root.by,
      replies: t.replies.length,
    }));

  const allNodes = Object.values(workspace.nodes);
  const allEdges = Object.values(workspace.edges);
  const nodesTruncated = allNodes.length > SUMMARY_LIMITS.nodes;
  const edgesTruncated = allEdges.length > SUMMARY_LIMITS.edges;

  return {
    diagramKind: workspace.diagramKind,
    nodes: allNodes.slice(0, SUMMARY_LIMITS.nodes).map((n) => ({
      id: n.id,
      nodeType: n.nodeType,
      label: n.label,
      ...(n.groupId ? { groupId: n.groupId } : {}),
      ...(n.issue
        ? {
            issue: {
              type: n.issue.type,
              status: n.issue.status,
              statusCategory: n.issue.statusCategory,
              ...(n.issue.assignee ? { assignee: n.issue.assignee } : {}),
              ...(n.issue.priority ? { priority: n.issue.priority } : {}),
              ...(n.issue.storyPoints !== undefined ? { storyPoints: n.issue.storyPoints } : {}),
              ...(n.issue.parentId ? { parentId: n.issue.parentId } : {}),
              // Stage D2: the execution fields — a plan request must see and
              // preserve deadlines the way it sees assignees (ADR 0027's D1
              // fields reaching the model surface).
              ...(n.issue.dueDate ? { dueDate: n.issue.dueDate } : {}),
              ...(n.issue.description ? { description: n.issue.description.slice(0, 240) } : {}),
            },
          }
        : {}),
      ...(n.statement
        ? {
            statement: {
              kind: n.statement.kind,
              status: n.statement.status,
              ...(n.statement.topic ? { topic: n.statement.topic } : {}),
              ...(n.statement.supersedes?.length ? { supersedes: n.statement.supersedes } : {}),
            },
          }
        : {}),
    })),
    edges: allEdges.slice(0, SUMMARY_LIMITS.edges).map((e) => ({
      source: e.source,
      target: e.target,
      relationship: e.relationship,
    })),
    // Omit empty collections so a fresh board keeps the prompt small.
    ...(groups.length ? { groups } : {}),
    ...(shapes.length ? { shapes } : {}),
    ...(shapeLinks.length ? { shapeLinks } : {}),
    ...(wireframes.length ? { wireframes } : {}),
    ...(votes.length ? { votes } : {}),
    ...(reactionRows.length ? { reactions: reactionRows } : {}),
    ...(comments.length ? { comments } : {}),
    ...(selection && selection.length
      ? { selection: selection.slice(0, DERIVED_LIMITS.selection) }
      : {}),
    // V1: the derived composition line leads the summary when the board has
    // a story to name.
    ...(compositionLine(workspace) ? { composition: compositionLine(workspace) } : {}),
    // Surfaces truncation so the model can ask for a slice rather than
    // reasoning about a partial graph it doesn't know is partial.
    ...(nodesTruncated || edgesTruncated
      ? {
          truncated: {
            ...(nodesTruncated ? { nodes: allNodes.length } : {}),
            ...(edgesTruncated ? { edges: allEdges.length } : {}),
          },
        }
      : {}),
  };
}

/**
 * Trim a conversation to its most recent turns, dropping error entries and
 * clamping long messages. Oldest first, so the model reads it in order.
 */
export function recentHistory(
  entries: Array<{ role: string; text: string; reply?: string }>,
  limit: number = SUMMARY_LIMITS.historyTurns,
): ConversationTurn[] {
  return entries
    .filter((e) => e.role === "user" || e.role === "ai")
    .slice(-limit)
    .map((e) => ({
      role: e.role as ConversationTurn["role"],
      // What Lucent SAID matters as much as what it did: "yes, do that"
      // answers the question in its reply, so the reply rides along.
      text: truncate(
        e.reply && e.reply.trim() && e.reply.trim() !== e.text.trim()
          ? `${e.text}\n(Said to the person: ${e.reply.trim()})`
          : e.text,
        SUMMARY_LIMITS.historyChars,
      ),
    }));
}
