import { z } from "zod";
import { REQUEST_LIMITS, streamViaGenerate, summarizeWorkspace } from "@lucent/ai";
import type { GenerateResult, LLMProvider, StreamCallbacks, TokenUsage } from "@lucent/ai";
import {
  ASSISTANT_AUTHOR,
  DIAGRAM_KINDS,
  validateOperations,
  createWorkspace,
  applyOperations,
  applyValidOperations,
  repairOperations,
  isHumanOnlyOperation,
  withoutTrust,
  stampAuthorship,
  existingTopics,
  foldStatementTopics,
  layoutStrategyFor,
} from "@lucent/core";
import type { DiagramKind, Operation, Shape, Workspace } from "@lucent/core";
import type { BoardStore } from "./boards.js";

/**
 * Request handling for POST /api/generate, framework-free so it can run under
 * Node's http server, Vite middleware, or a serverless function. Everything
 * from the model is untrusted: we schema-parse the request, ask the provider,
 * then semantically validate the operations against the reconstructed
 * workspace before they are trusted (docs/09 section 8).
 */

/**
 * Size caps on the request body (M5).
 *
 * Every string here has a length cap and every array a `.max()`, all of them
 * REQUEST_LIMITS values — the same numbers `summarizeWorkspace` truncates to,
 * imported rather than restated so the two cannot drift.
 *
 * Before this, individual strings were capped but no array was, and the array
 * limits existed only inside the client-side summariser. A hand-built POST could
 * therefore carry a million nodes: `buildUserPrompt` renders every row,
 * `workspaceFromSummary` applies an operation per row, and one request could
 * exhaust a provider's context budget (billed to this account) or the event
 * loop. Enforcing the summariser's own ceilings costs a real client nothing,
 * because the summariser has already trimmed to them before the request is sent.
 *
 * `shortText` is for ids and enum-like fields, `lineText` for a label, title, or
 * relationship a person typed.
 */
const shortText = z.string().max(REQUEST_LIMITS.idChars);
const lineText = z.string().max(REQUEST_LIMITS.textChars);

const summarySchema = z.object({
  // Derived from the single source of truth (DIAGRAM_KINDS) so a board on any
  // registered family — timeline, matrix, state machine, dependency, C4,
  // network, sequence, ER, … — can be generated against. This enum was
  // hand-maintained at the original eight and silently 400'd every newer kind.
  diagramKind: z.enum(DIAGRAM_KINDS),
  nodes: z
    .array(
      z.object({
        id: shortText,
        nodeType: shortText,
        label: lineText,
        groupId: shortText.optional(),
        issue: z
          .object({
            type: shortText,
            status: shortText,
            statusCategory: shortText,
            assignee: shortText.optional(),
            priority: shortText.optional(),
            storyPoints: z.number().optional(),
            parentId: shortText.optional(),
            // Stage D2: the D1 execution fields — the server's rebuilt
            // workspace must carry them or a plan would validate against a
            // board that lost its deadlines (the five-place rule's summary
            // arm; ADR 0027).
            dueDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            description: z.string().max(2000).optional(),
          })
          .optional(),
        // Statement semantics (Stage C2): what the node IS. Provenance is
        // deliberately absent here — the client never sends it in a summary
        // (the meeting loop attaches it to the ops, not the workspace echo),
        // and a client that did would be claiming evidence the server did
        // not witness.
        statement: z
          .object({
            kind: z.enum(["decision", "proposal", "question", "action", "requirement", "risk"]),
            status: z.enum(["open", "resolved", "rejected", "superseded"]),
            topic: shortText.optional(),
            supersedes: z.array(shortText).max(10).optional(),
          })
          .optional(),
      }),
    )
    .max(REQUEST_LIMITS.nodes),
  edges: z
    .array(
      z.object({
        source: shortText,
        target: shortText,
        relationship: lineText,
      }),
    )
    .max(REQUEST_LIMITS.edges),
  // Board context beyond the semantic graph. Optional so an older client keeps
  // working, but the model needs these to see the board it is editing. A
  // group's optional `kind` marks a diagram region — its own layout lens on
  // one board — which the model needs to see to target region-scoped edits.
  groups: z
    .array(
      z.object({
        id: shortText,
        label: lineText,
        children: z.array(shortText).max(REQUEST_LIMITS.groupChildren),
        // Same source of truth as the board kind: a region can be any family
        // (SET_GROUP_KIND accepts them all), so the summary echo must too.
        kind: z.enum(DIAGRAM_KINDS).optional(),
      }),
    )
    .max(REQUEST_LIMITS.groups)
    .optional(),
  shapes: z
    .array(
      z.object({
        id: shortText,
        kind: shortText,
        text: z.string().max(REQUEST_LIMITS.shapeTextChars).optional(),
        groupId: shortText.optional(),
        locked: z.boolean().optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .max(REQUEST_LIMITS.shapes)
    .optional(),
  shapeLinks: z
    .array(
      z.object({
        id: shortText,
        source: shortText,
        target: shortText,
        label: lineText.optional(),
      }),
    )
    .max(REQUEST_LIMITS.shapeLinks)
    .optional(),
  wireframes: z
    .array(z.object({ id: shortText, title: lineText, viewport: shortText }))
    .max(REQUEST_LIMITS.wireframes)
    .optional(),
  // The per-target counts stay unbounded numbers on purpose: a board really can
  // collect more votes on one sticky than we would ever rebuild records for, and
  // rejecting the request over it would be wrong. What has to be bounded is the
  // rebuild, and that is `ANNOTATION_REBUILD_BUDGET` below.
  votes: z
    .array(z.object({ targetId: shortText, votes: z.number() }))
    .max(REQUEST_LIMITS.votes)
    .optional(),
  reactions: z
    .array(z.object({ targetId: shortText, emoji: z.string().max(16), count: z.number() }))
    .max(REQUEST_LIMITS.reactions)
    .optional(),
  comments: z
    .array(
      z.object({
        id: shortText,
        targetId: shortText,
        // 300, not 2000: the summariser truncates a body to exactly this, so a
        // longer one can only come from a client bypassing it.
        body: z.string().max(REQUEST_LIMITS.commentChars),
        by: shortText,
        replies: z.number(),
      }),
    )
    .max(REQUEST_LIMITS.comments)
    .optional(),
  selection: z.array(shortText).max(REQUEST_LIMITS.selection).optional(),
});

/** Recent conversation turns so follow-up references resolve (docs/12). */
const historySchema = z
  .array(
    z.object({
      role: z.enum(["user", "ai"]),
      text: z.string().max(REQUEST_LIMITS.historyChars),
    }),
  )
  .max(REQUEST_LIMITS.historyTurns)
  .optional();

export const generateRequestSchema = z.object({
  message: z.string().min(1).max(REQUEST_LIMITS.messageChars),
  summary: summarySchema,
  history: historySchema,
  /**
   * When present and backed by server storage, validation runs against the
   * stored board (authoritative) instead of this request's summary.
   */
  boardId: z.string().min(1).max(REQUEST_LIMITS.idChars).optional(),
  /**
   * ADR 0047: what the AI run is for — the board the person is on and where
   * they asked (the canvas, a meeting, by voice). Recorded on the run only;
   * unlike `boardId` it changes nothing about validation.
   */
  run: z
    .object({
      boardId: z.string().min(1).max(REQUEST_LIMITS.idChars).optional(),
      surface: z.enum(["canvas", "meeting", "voice"]).optional(),
    })
    .optional(),
  /** The requester's local date (YYYY-MM-DD), so "by Friday" resolves to
   * a real dueDate (packages/ai GenerateRequest.today). */
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * Attachments the model should look at. Images go to vision-capable providers;
   * documents are already-extracted text (the browser does the extraction, so no
   * parser runs server-side on untrusted bytes). Document text is third-party
   * content: the prompt harness envelopes and filters it (packages/ai/prompt.ts).
   */
  images: z
    .array(
      z.object({
        // ~4MB of base64 per image keeps one request within provider limits.
        data: z.string().min(1).max(REQUEST_LIMITS.imageBase64Chars),
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      }),
    )
    .max(REQUEST_LIMITS.images)
    .optional(),
  documents: z
    .array(
      z.object({
        name: z.string().max(REQUEST_LIMITS.documentNameChars),
        text: z.string().min(1).max(REQUEST_LIMITS.documentChars),
      }),
    )
    .max(REQUEST_LIMITS.documents)
    .optional(),
});

export type GenerateRequestBody = z.infer<typeof generateRequestSchema>;

const SHAPE_KINDS = new Set([
  "rect",
  "ellipse",
  "diamond",
  "triangle",
  "star",
  "sticky",
  "text",
  "draw",
  "image",
  "frame",
  "embed",
  "file",
]);

/**
 * Total vote/reaction records the reconstructed workspace will rebuild, across
 * every row of the summary.
 *
 * `applyOperation` copies the collection it touches, so rebuilding N annotation
 * records costs O(N²): measured here, 1,000 ADD_VOTE ops take ~0.4s and 4,000
 * take ~11s of blocked event loop. The per-row clamp below never stopped that,
 * because 320 rows each claiming 200 votes multiply to 64,000 records. The array
 * caps bound the rows; this bounds their product.
 *
 * Truncating is safe in a way that rejecting would not be: the model never sees
 * an individual vote id — only the per-target counts in the summary — so these
 * placeholder records exist purely to give a REMOVE_VOTE it emits something to
 * resolve against. Past the budget an unlikely REMOVE_VOTE for a high-index
 * record fails validation with the usual 422, and the board itself is untouched.
 */
const ANNOTATION_REBUILD_BUDGET = 400;

/** Records rebuilt for any single target, unchanged from before the budget. */
const ANNOTATION_PER_TARGET_LIMIT = 200;

/**
 * Rebuild a workspace from the summary so operations can be validated against
 * it. This must include shapes, groups, and wireframes, not just nodes and
 * edges: the model can now emit shape operations, and validating those against a
 * nodes-only workspace would reject every legitimate edit to an existing shape.
 * Geometry is placeholder — only identity and kind matter here, and the client
 * holds the authoritative coordinates.
 */
function workspaceFromSummary(summary: GenerateRequestBody["summary"]): Workspace {
  const ws = createWorkspace({ diagramKind: summary.diagramKind });
  // Votes and reactions draw on one shared budget, spent in row order.
  let annotationBudget = ANNOTATION_REBUILD_BUDGET;
  const rebuildCount = (reported: number): number => {
    const allowed = Math.max(0, Math.min(reported, ANNOTATION_PER_TARGET_LIMIT, annotationBudget));
    annotationBudget -= allowed;
    return allowed;
  };
  const ops: Operation[] = [
    // Groups first: a node may reference its groupId. The kind rides along so
    // the validation workspace knows which groups are regions — a SET_GROUP_KIND
    // must validate against a region that actually exists there.
    ...(summary.groups ?? []).map((g) => ({
      op: "CREATE_GROUP" as const,
      id: g.id,
      label: g.label,
      children: [] as string[],
      ...(g.kind ? { kind: g.kind } : {}),
    })),
    ...summary.nodes.map((n) => ({
      op: "CREATE_NODE" as const,
      id: n.id,
      nodeType: n.nodeType,
      label: n.label,
      ...(n.groupId ? { groupId: n.groupId } : {}),
    })),
    ...summary.edges.map((e) => ({
      op: "CONNECT_NODES" as const,
      source: e.source,
      target: e.target,
      relationship: e.relationship,
    })),
    // Reattach issue fields so the model can UPDATE_ISSUE or reference a parent
    // epic that already exists on the board. Stage D2: the execution fields
    // ride the rebuild too — a plan validates against deadlines it must not
    // lose.
    ...summary.nodes
      .filter((n) => n.issue)
      .map((n) => ({
        op: "SET_ISSUE" as const,
        id: n.id,
        issue: {
          type: (["epic", "story", "task", "subtask", "bug"].includes(n.issue!.type)
            ? n.issue!.type
            : "task") as "epic" | "story" | "task" | "subtask" | "bug",
          status: n.issue!.status,
          statusCategory: (["todo", "in_progress", "done"].includes(n.issue!.statusCategory)
            ? n.issue!.statusCategory
            : "todo") as "todo" | "in_progress" | "done",
          ...(n.issue!.assignee ? { assignee: n.issue!.assignee } : {}),
          ...(n.issue!.storyPoints !== undefined ? { storyPoints: n.issue!.storyPoints } : {}),
          ...(n.issue!.parentId ? { parentId: n.issue!.parentId } : {}),
          ...(n.issue!.dueDate ? { dueDate: n.issue!.dueDate } : {}),
          ...(n.issue!.description ? { description: n.issue!.description } : {}),
        },
      })),
    // Reattach statements (Stage C2) so the model can UPDATE_STATEMENT what it
    // can see — a visible decision it can supersede, an open question it can
    // resolve. Provenance never rebuilds: it is evidence, and evidence is not
    // re-derivable from a summary.
    ...summary.nodes
      .filter((n) => n.statement)
      .map((n) => ({
        op: "SET_STATEMENT" as const,
        id: n.id,
        statement: {
          kind: n.statement!.kind,
          status: n.statement!.status,
          ...(n.statement!.topic ? { topic: n.statement!.topic } : {}),
          ...(n.statement!.supersedes?.length ? { supersedes: n.statement!.supersedes } : {}),
        },
      })),
    ...(summary.shapes ?? []).map((s) => ({
      op: "CREATE_SHAPE" as const,
      id: s.id,
      kind: (SHAPE_KINDS.has(s.kind) ? s.kind : "rect") as Shape["kind"],
      position: { x: 0, y: 0 },
      size: { width: 10, height: 10 },
      ...(s.text !== undefined ? { text: s.text } : {}),
      ...(s.locked !== undefined ? { locked: s.locked } : {}),
      ...(s.hidden !== undefined ? { hidden: s.hidden } : {}),
    })),
    ...(summary.shapeLinks ?? []).map((l) => ({
      op: "CONNECT_SHAPES" as const,
      id: l.id,
      source: l.source,
      target: l.target,
      ...(l.label !== undefined ? { label: l.label } : {}),
    })),
    ...(summary.wireframes ?? []).map((w) => ({
      op: "CREATE_WIREFRAME" as const,
      id: w.id,
      title: w.title,
      // The assertion looks redundant (eslint says so) but is not: without it the
      // narrowed literals widen to `string` in this object literal and the operation
      // union rejects the whole array.
      /* eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion */
      viewport: (w.viewport === "tablet" || w.viewport === "mobile" ? w.viewport : "desktop") as
        | "desktop"
        | "tablet"
        | "mobile",
      root: { kind: "screen" },
    })),
    // Rebuild vote/reaction annotations so the model can remove or clear them.
    // Only identity matters here; the client owns the authoritative records.
    // `by` is left off: the summary carries no author, this workspace exists for
    // validation and is never persisted, and inventing one is exactly the
    // placeholder this file used to leak into real boards. These ops never reach
    // stampAuthorship either — that stamps what the model emits, not what the
    // client reported.
    ...(summary.votes ?? []).flatMap((v) =>
      Array.from({ length: rebuildCount(v.votes) }, (_, i) => ({
        op: "ADD_VOTE" as const,
        id: `${v.targetId}#v${i}`,
        targetId: v.targetId,
      })),
    ),
    ...(summary.reactions ?? []).flatMap((r) =>
      Array.from({ length: rebuildCount(r.count) }, (_, i) => ({
        op: "ADD_REACTION" as const,
        id: `${r.targetId}#${r.emoji}#${i}`,
        targetId: r.targetId,
        emoji: r.emoji,
      })),
    ),
    // Rebuild open threads so the model may resolve or reply to them by id.
    ...(summary.comments ?? []).map((c) => ({
      op: "ADD_COMMENT" as const,
      id: c.id,
      targetId: c.targetId,
      body: c.body,
      by: c.by,
    })),
  ];
  return applyOperations(ws, ops);
}

export interface HandleResult {
  status: number;
  body: unknown;
  /**
   * Why the generation ended (see GenerateOutcome) — recorded by the routes
   * so the telemetry counts provider vs validation vs other failures
   * separately instead of inferring them from status codes.
   */
  outcome: GenerateOutcome;
  /** Whether the bounded repair round ran, success or not. */
  repaired: boolean;
  /**
   * What the provider reported about the completion: which model answered and
   * what it cost. Deliberately a sibling of `body` rather than a field in it —
   * the meter needs it to reconcile revenue against `usage_events` (M4), the
   * client has no use for it, and putting it in the body would widen the public
   * response shape to expose our provider costs.
   */
  completion?: Pick<GenerateResult, "model" | "usage">;
}

/**
 * When a stored board is supplied, validation runs against it instead of the
 * client-reported summary — this is what makes the server *authoritative*. A
 "connect to a node deleted a moment ago" is now genuinely rejectable, because
 the workspace under validation is real state rather than the client's claim.
 */
export interface AuthoritativeContext {
  boardId: string;
  store: BoardStore;
}

/**
 * How many repair-message characters may describe the failing batch.
 *
 * 12,000 (M1): a large generation is a 40-50 op batch — 2,000 chars showed the
 * model roughly its first three operations and asked it to "correct" the
 * other 47 blind. The corrected batch predictably re-emitted shorter, and the
 * ops that vanished were the CONNECT_NODES (emitted last, per dependency
 * order) — the repair round was starving itself of exactly the edges it was
 * meant to recover. 12k chars covers a full ~50-op batch; the outer
 * `REQUEST_LIMITS.messageChars` clamp still bounds the total.
 */
const REPAIR_OPS_BUDGET = 12_000;

/** How many validator complaints the repair message may carry (was 8: a
 * 30-error batch left 22 errors invisible to the model). */
const REPAIR_ERROR_BUDGET = 20;

/**
 * One bounded repair round (M5): hand the provider its own rejected batch and
 * the validator's complaints, and ask for a corrected batch against the same
 * state. Returns null when the provider fails — the caller then reports the
 * original validation errors, which is the honest answer — and its result
 * otherwise, still subject to the same filter/stamp/validate path as the
 * first attempt. The message is clamped to the request's own message cap, so
 * a huge failing batch cannot smuggle an oversized prompt past the caps that
 * bound every other request.
 */
async function requestRepair(
  provider: LLMProvider,
  request: z.infer<typeof generateRequestSchema>,
  rejected: Operation[],
  errors: ReadonlyArray<{ message: string }>,
): Promise<GenerateResult | null> {
  const opsSummary = JSON.stringify(rejected).slice(0, REPAIR_OPS_BUDGET);
  const complaints = errors
    .slice(0, REPAIR_ERROR_BUDGET)
    .map((e) => `- ${e.message}`)
    .join("\n");
  const message = [
    "Your previous batch was rejected by the validator against the current board state.",
    "Rejected batch:",
    opsSummary,
    "Validation errors:",
    complaints,
    "Emit a corrected full batch that passes against the current board state. Keep every operation inside the permitted vocabulary.",
  ].join("\n");
  try {
    return await provider.generateOperations({
      ...request,
      message: message.slice(0, REQUEST_LIMITS.messageChars),
    });
  } catch {
    return null;
  }
}

/** Which kinds are a connected graph (their meaning IS the connections), so an
 * edgeless or floating-node result is a defect worth one re-ask — unlike
 * grid/timeline/storymap, where standalone items are legitimate. */
function expectsEdges(kind: DiagramKind): boolean {
  const s = layoutStrategyFor(kind);
  return s === "layered" || s === "tree" || s === "radial" || s === "swimlane";
}

/** Of `ids`, those with no incident edge in `ws` — floating semantic nodes. */
function floatingAmong(ws: Workspace, ids: readonly string[]): string[] {
  const connected = new Set<string>();
  for (const e of Object.values(ws.edges)) {
    connected.add(e.source);
    connected.add(e.target);
  }
  return ids.filter((id) => ws.nodes[id] && !connected.has(id));
}

/**
 * Connectivity re-ask (the "a semantic node must never float" rule): when a
 * generation on a connected-graph kind leaves nodes with no connectors — the
 * "horizontal row of unconnected boxes" symptom — ask the model once to wire
 * them in. It is told to return CONNECT_NODES only; the caller validates and
 * merges what comes back and never loops.
 */
async function requestConnect(
  provider: LLMProvider,
  today: string | undefined,
  workspace: Workspace,
  floatingIds: string[],
): Promise<GenerateResult | null> {
  const named = floatingIds
    .slice(0, 40)
    .map((id) => `${id} (${workspace.nodes[id]?.label ?? "?"})`)
    .join(", ");
  const message = [
    "The diagram you just built left these nodes disconnected, with no connectors:",
    named,
    "Add CONNECT_NODES operations so every one of them is wired into the graph with a meaningful relationship verb (leads_to, calls, depends_on, branch, …) — a semantic node must never float.",
    "Return ONLY CONNECT_NODES operations against the current board; create no new nodes.",
  ].join("\n");
  try {
    return await provider.generateOperations({
      message: message.slice(0, REQUEST_LIMITS.messageChars),
      summary: summarizeWorkspace(workspace),
      ...(today ? { today } : {}),
    });
  } catch {
    return null;
  }
}

/**
 * Meter both attempts: a repair round is real spend, so its tokens join the
 * first call's rather than replacing them. Absent counts stay absent (M4
 * reconciles against what providers actually reported).
 */
function usageFor(last: GenerateResult, first: GenerateResult | undefined): TokenUsage | undefined {
  if (!first || !first.usage) return last.usage;
  if (!last.usage) return first.usage;
  const sum = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : a + b);
  return {
    inputTokens: sum(first.usage.inputTokens, last.usage.inputTokens),
    outputTokens: sum(first.usage.outputTokens, last.usage.outputTokens),
  };
}

export async function handleGenerate(
  provider: LLMProvider,
  rawBody: unknown,
  /**
   * Authenticated author for annotations. Absent when authentication is disabled,
   * and then the AI's annotations are attributed to the assistant rather than to
   * a person who never wrote them.
   */
  userId?: string,
  /** Present when the request carries a boardId backed by server storage. */
  authoritative?: AuthoritativeContext,
  /**
   * The server-assembled workspace-memory digest (docs/23): the board's own
   * settled statements plus vetted project siblings. Rides the first model call
   * only; assembled by the route (app.ts) under its access + classification
   * gates, never taken from the client body.
   */
  memory?: string | null,
): Promise<HandleResult> {
  const outcome = await runGeneratePipeline(
    provider,
    rawBody,
    userId,
    authoritative,
    undefined,
    memory,
  );
  if (!outcome.ok) {
    return {
      status: outcome.status,
      body: outcome.body,
      outcome: outcome.outcome,
      repaired: outcome.repaired,
    };
  }
  return {
    status: 200,
    outcome: outcome.outcome,
    repaired: outcome.repaired,
    body: {
      operations: outcome.operations,
      explanation: outcome.explanation,
      reply: outcome.reply,
      provider: outcome.provider,
      ...(outcome.boardVersion > 0 ? { boardVersion: outcome.boardVersion } : {}),
      // Partial-application skips (M1), same as the SSE done frame.
      ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
    },
    completion: outcome.completion,
  };
}

/**
 * What the shared pipeline produced, or why it refused. Both the JSON route
 * (`handleGenerate`) and the SSE route (`handleGenerateStream`) consume this,
 * so there is exactly one filter/stamp/repair/validate path for model output
 * no matter how it was transported (M5/E1).
 */
export type PipelineOutcome =
  | {
      ok: true;
      operations: Operation[];
      explanation: string | null;
      /** What Lucent says back in a voice conversation (GenerateResult.reply). */
      reply: string | null;
      provider: string;
      /** 0 when no authoritative board backed the request (field omitted downstream). */
      boardVersion: number;
      completion: NonNullable<HandleResult["completion"]>;
      /** Why the generation ended (see GenerateOutcome). */
      outcome: GenerateOutcome;
      /** Whether the bounded repair round ran, success or not. */
      repaired: boolean;
      /**
       * Operations that failed validation and were skipped rather than applied
       * (partial application, M1). Empty on a clean batch. Each carries the
       * validator's own reason so the client can show exactly what didn't
       * land and offer to re-ask the model for just those.
       */
      warnings?: Array<{ op: string; reason: string }>;
    }
  | {
      ok: false;
      status: number;
      body: unknown;
      /** Why the generation ended (see GenerateOutcome). */
      outcome: GenerateOutcome;
      /** False on every refusal: the repair round only runs post-provider. */
      repaired: boolean;
    };

/**
 * WHY a generation ended the way it did (the 2026-09 review's §7: "Is
 * Lucent unreliable, or is the upstream provider unreliable?"). Assigned at
 * each pipeline arm where the knowledge lives, so the telemetry counts the
 * distinction instead of inferring it from status codes:
 *   success    — validated operations reached the client (partial
 *                application counts: the user got a board).
 *   provider   — the provider call itself failed (throw / transport).
 *   validation — the model answered but the batch failed validation even
 *                after the bounded repair round.
 *   other      — refused before spend (bad request shape, quota): neither
 *                Lucent's generation quality nor the provider's.
 */
export type GenerateOutcome = "success" | "provider" | "validation" | "other";

/**
 * The one post-provider pipeline: filter human-only ops, stamp authorship,
 * resolve the authoritative workspace, run the deterministic repairer,
 * validate, apply the bounded repair round, persist the merged board.
 * `stream`, when given, receives the model's payload deltas as they arrive —
 * display material only; nothing here trusts them, and the result that comes
 * back is validated exactly as the non-streamed path validates it.
 */
async function runGeneratePipeline(
  provider: LLMProvider,
  rawBody: unknown,
  userId?: string,
  authoritative?: AuthoritativeContext,
  stream?: StreamCallbacks,
  memory?: string | null,
): Promise<PipelineOutcome> {
  const parsed = generateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid request", detail: parsed.error.format() },
      outcome: "other",
      repaired: false,
    };
  }

  // Resolve the authoritative board for VALIDATION and persistence: a stored
  // board that belongs to the caller is validated against its real state
  // instead of the request's summary, and the merged result is persisted back.
  // Workspace memory is NOT tied to this gate — the caller assembles it (own
  // board + vetted project siblings) and passes it in as `memory`, so it also
  // reaches the advisory web path, which never sets `authoritative` (app.ts).
  const candidateBoard = authoritative
    ? await authoritative.store.get(authoritative.boardId)
    : undefined;
  const authoritativeBoard =
    candidateBoard && userId === candidateBoard.ownerId ? candidateBoard : undefined;

  // Workspace memory (docs/23) rides the FIRST model call only — not the bounded
  // repair round below, which fixes validator complaints that memory can't help
  // with and whose re-send would double the context cost of a failure.
  const modelRequest = memory ? { ...parsed.data, memory } : parsed.data;

  let result;
  try {
    result = stream
      ? await (provider.streamOperations
          ? provider.streamOperations(modelRequest, stream)
          : streamViaGenerate(provider, modelRequest, stream))
      : await provider.generateOperations(modelRequest);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body: { error: "provider failed", detail: (err as Error).message },
      outcome: "provider",
      repaired: false,
    };
  }

  // Defence in depth: the tool schema already withholds coordinate-bearing
  // operations, but a model could still emit one. Drop them rather than letting
  // the AI position anything (docs/03). Then stamp authorship so the model can
  // never pick a peer's id for an annotation (M0.4): the author is the
  // authenticated caller, or the assistant when there is no user to attribute an
  // AI-written comment to. The same helper Room.commit uses, so both entry paths
  // attribute identically.
  // ADR 0047: the model never sets a statement's trust — the committer does.
  const filtered = withoutTrust(result.operations.filter((op) => !isHumanOnlyOperation(op.op)));
  const permitted = stampAuthorship(filtered, userId ?? ASSISTANT_AUTHOR);

  // Authoritative board + ownership were resolved before the model call (above),
  // so the digest could ride the first request; the stored workspace is the
  // validation oracle here, else the request's own summary.
  const workspace = authoritativeBoard
    ? authoritativeBoard.workspace
    : workspaceFromSummary(parsed.data.summary);
  // Repair likely-mis-ordered model output (e.g. node before its group) before
  // validating, so good-intent batches aren't rejected on ordering alone.
  // The topic fold (Stage C5) runs on every machine-authored batch — the
  // model's ops, never a human's — converging morphological topic variants
  // on the board's existing authored keys. Machine-ops-only BY PLACEMENT:
  // this pipeline is the model's; the web's manual path never calls it.
  const topics = existingTopics(workspace);
  let operations = foldStatementTopics(repairOperations(permitted), topics);
  let errors = validateOperations(workspace, operations);

  // M5: one bounded repair round. A batch that fails validation goes back to
  // the provider once, with its own output and the validator's complaints, on
  // the chance the model can fix what the validator can name. Exactly one
  // round: a second would multiply cost for a failure the client can retry,
  // and a batch that cannot be repaired once will rarely repair twice. A
  // provider failure inside the round is not a 502 — the first call
  // succeeded, so the honest answer is still the validation failure.
  let repaired = false;
  const firstResult = result;
  if (errors.length > 0) {
    const second = await requestRepair(provider, parsed.data, operations, errors);
    if (second) {
      repaired = true;
      result = second;
      const repairedPermitted = stampAuthorship(
        withoutTrust(second.operations.filter((op) => !isHumanOnlyOperation(op.op))),
        userId ?? ASSISTANT_AUTHOR,
      );
      // The repaired re-emission folds too (Stage C5): a second chance at
      // the topics is not a second chance to split the group.
      operations = foldStatementTopics(repairOperations(repairedPermitted), topics);
      errors = validateOperations(workspace, operations);
    }
  }

  // Only the keys the provider actually reported: a model that omits usage must
  // not be metered as having used zero tokens. `let`, because a connectivity
  // re-ask below is extra spend whose tokens must join these.
  let completion: NonNullable<HandleResult["completion"]> = {
    ...(result.model ? { model: result.model } : {}),
    ...(usageFor(result, firstResult) ? { usage: usageFor(result, firstResult)! } : {}),
  };

  // PARTIAL APPLICATION (M1): a batch that still fails validation after the
  // repair round no longer dies whole. One mis-referenced edge id used to
  // reject 39 valid ops with it — the single most damaging failure an AI
  // canvas has, because the user loses every node over one bad relationship.
  // `applyValidOperations` partitions the batch using the SAME validator that
  // just ran (one canonical simulator — the applier cannot disagree with the
  // validator), applies the valid remainder, and reports the skips.
  const partial = errors.length > 0 ? applyValidOperations(workspace, operations) : undefined;
  if (partial && partial.applied.length === 0) {
    // Nothing salvageable — the honest refusal, unchanged.
    return {
      ok: false,
      status: 422,
      body: { error: "operations failed validation", errors, repaired },
      outcome: "validation",
      repaired,
    };
  }
  const warnings = partial
    ? partial.skipped.map((s) => ({ op: s.op.op, reason: s.reason }))
    : undefined;
  // From here on, this is what actually applies.
  const appliedBase = partial ? partial.applied : operations;
  let mergedWorkspace = partial ? partial.workspace : applyOperations(workspace, appliedBase);

  // CONNECTIVITY GUARD (the "a semantic node must never float" rule): a
  // generation on a connected-graph kind that left nodes with no connectors —
  // the "row of unconnected boxes" symptom — gets ONE bounded re-ask to wire
  // them in. It fires only when this batch created >=2 nodes with a floating
  // one among them, so an ordinary edge-bearing generation pays nothing; the
  // re-ask may add only CONNECT_NODES, validated and partial-applied exactly
  // like the first batch, and never loops.
  let connectOps: Operation[] = [];
  const createdIds = appliedBase.flatMap((op) => (op.op === "CREATE_NODE" ? [op.id] : []));
  if (createdIds.length >= 2 && expectsEdges(mergedWorkspace.diagramKind)) {
    const floating = floatingAmong(mergedWorkspace, createdIds);
    if (floating.length > 0) {
      const connect = await requestConnect(provider, parsed.data.today, mergedWorkspace, floating);
      if (connect) {
        const candidate = stampAuthorship(
          withoutTrust(connect.operations.filter((op) => op.op === "CONNECT_NODES")),
          userId ?? ASSISTANT_AUTHOR,
        );
        const connErrors = validateOperations(mergedWorkspace, candidate);
        const connApplied =
          connErrors.length > 0
            ? applyValidOperations(mergedWorkspace, candidate).applied
            : candidate;
        if (connApplied.length > 0) {
          connectOps = connApplied;
          mergedWorkspace = applyOperations(mergedWorkspace, connApplied);
        }
        if (connect.usage) {
          const sum = (a?: number, b?: number) =>
            a === undefined ? b : b === undefined ? a : a + b;
          completion = {
            ...completion,
            usage: {
              inputTokens: sum(completion.usage?.inputTokens, connect.usage.inputTokens),
              outputTokens: sum(completion.usage?.outputTokens, connect.usage.outputTokens),
            },
          };
        }
      }
    }
  }
  const appliedOps = connectOps.length > 0 ? [...appliedBase, ...connectOps] : appliedBase;

  // Persist the merged board so the next request validates against the new state.
  if (authoritative && authoritativeBoard) {
    // `mergedWorkspace` already reflects the partial application AND any
    // connectivity edges added above, so it is the exact state the client will
    // reach by applying `appliedOps`.
    const updated = mergedWorkspace;
    await authoritative.store.put({
      ...authoritativeBoard,
      workspace: updated,
      updatedAt: Date.now(),
    });
    return {
      ok: true,
      operations: appliedOps,
      explanation: result.explanation ?? null,
      reply: result.reply ?? null,
      provider: provider.name,
      // The client learns the new server-side version in the same response.
      boardVersion: Date.now(),
      completion,
      warnings,
      outcome: "success",
      repaired,
    };
  }

  return {
    ok: true,
    operations: appliedOps,
    explanation: result.explanation ?? null,
    reply: result.reply ?? null,
    provider: provider.name,
    // No authoritative board: there is no server-side version to report.
    boardVersion: 0,
    completion,
    warnings,
    outcome: "success",
    repaired,
  };
}

/**
 * The streaming route's handler (M5/E1). Same pipeline, same validation, same
 * repair round as `/api/generate` — only the transport differs: `send` emits
 * `delta` frames as the model writes, then exactly one terminal frame, either
 * `done` (validated operations; the only frame a client may apply) or `error`
 * (a refusal, carrying the same body the JSON route would have returned).
 * Returns the outcome so the route can meter and log it exactly as it meters
 * the JSON path.
 */
export async function handleGenerateStream(
  provider: LLMProvider,
  rawBody: unknown,
  userId?: string,
  authoritative?: AuthoritativeContext,
  send?: (event: "start" | "delta" | "done" | "error" | "phase", data: unknown) => void,
  /**
   * Runs after validation, before the done frame: its fields ride the frame.
   * The route records the AI run here (ADR 0047), so the client gets its run
   * id with the operations it will commit.
   */
  beforeDone?: (result: {
    operations: Operation[];
    provider: string;
    model: string | undefined;
  }) => Promise<Record<string, unknown>>,
  /** The server-assembled workspace-memory digest (docs/23); see handleGenerate. */
  memory?: string | null,
): Promise<{
  status: number;
  provider: string;
  operations: number;
  completion: NonNullable<HandleResult["completion"]> | null;
  outcome: GenerateOutcome;
  repaired: boolean;
}> {
  const emit = send ?? (() => {});
  emit("start", { provider: provider.name, streaming: true });
  // UX-P1-004: Progressive phase indicator during generation
  emit("phase", { phase: "understanding", message: "Parsing intent..." });

  let sawDelta = false;
  const outcome = await runGeneratePipeline(
    provider,
    rawBody,
    userId,
    authoritative,
    {
      onDelta: (delta) => {
        if (!sawDelta) {
          sawDelta = true;
          emit("phase", { phase: "constructing", message: "Designing architecture..." });
        }
        emit("delta", { text: delta });
      },
    },
    memory,
  );
  if (!outcome.ok) {
    emit("error", outcome.body);
    return {
      status: outcome.status,
      provider: provider.name,
      operations: 0,
      completion: null,
      outcome: outcome.outcome,
      repaired: outcome.repaired,
    };
  }
  emit("phase", { phase: "validating", message: "Optimizing layout..." });
  emit("phase", { phase: "applying", message: "Rendering nodes..." });
  const extra = beforeDone
    ? await beforeDone({
        operations: outcome.operations,
        provider: outcome.provider,
        model: outcome.completion.model,
      }).catch(() => ({}))
    : {};
  emit("done", {
    ...extra,
    operations: outcome.operations,
    explanation: outcome.explanation,
    reply: outcome.reply,
    provider: outcome.provider,
    boardVersion: outcome.boardVersion,
    // Partial-application skips (M1): the client shows what didn't land and
    // can offer to fix just those. Omitted on a clean batch.
    ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
  });
  return {
    status: 200,
    provider: outcome.provider,
    operations: outcome.operations.length,
    completion: outcome.completion,
    outcome: outcome.outcome,
    repaired: outcome.repaired,
  };
}
