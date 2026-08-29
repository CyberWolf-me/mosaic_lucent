import { z } from "zod";
import { REQUEST_LIMITS, streamViaGenerate } from "@lucent/ai";
import type { GenerateResult, LLMProvider, StreamCallbacks, TokenUsage } from "@lucent/ai";
import {
  ASSISTANT_AUTHOR,
  validateOperations,
  createWorkspace,
  applyOperations,
  repairOperations,
  isHumanOnlyOperation,
  stampAuthorship,
} from "@lucent/core";
import type { Operation, Shape, Workspace } from "@lucent/core";
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
  diagramKind: z.enum([
    "flowchart",
    "architecture",
    "mindmap",
    "journey",
    "decisiontree",
    "process",
    "orgchart",
  ]),
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
  // working, but the model needs these to see the board it is editing.
  groups: z
    .array(
      z.object({
        id: shortText,
        label: lineText,
        children: z.array(shortText).max(REQUEST_LIMITS.groupChildren),
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
    // Groups first: a node may reference its groupId.
    ...(summary.groups ?? []).map((g) => ({
      op: "CREATE_GROUP" as const,
      id: g.id,
      label: g.label,
      children: [] as string[],
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
    // epic that already exists on the board.
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

/** How many repair-message characters may describe the failing batch. */
const REPAIR_OPS_BUDGET = 2_000;

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
    .slice(0, 8)
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
): Promise<HandleResult> {
  const outcome = await runGeneratePipeline(provider, rawBody, userId, authoritative);
  if (!outcome.ok) {
    return { status: outcome.status, body: outcome.body };
  }
  return {
    status: 200,
    body: {
      operations: outcome.operations,
      explanation: outcome.explanation,
      provider: outcome.provider,
      ...(outcome.boardVersion > 0 ? { boardVersion: outcome.boardVersion } : {}),
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
      provider: string;
      /** 0 when no authoritative board backed the request (field omitted downstream). */
      boardVersion: number;
      completion: NonNullable<HandleResult["completion"]>;
    }
  | { ok: false; status: number; body: unknown };

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
): Promise<PipelineOutcome> {
  const parsed = generateRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: { error: "invalid request", detail: parsed.error.format() },
    };
  }

  let result;
  try {
    result = stream
      ? await (provider.streamOperations
          ? provider.streamOperations(parsed.data, stream)
          : streamViaGenerate(provider, parsed.data, stream))
      : await provider.generateOperations(parsed.data);
  } catch (err) {
    return {
      ok: false,
      status: 502,
      body: { error: "provider failed", detail: (err as Error).message },
    };
  }

  // Defence in depth: the tool schema already withholds coordinate-bearing
  // operations, but a model could still emit one. Drop them rather than letting
  // the AI position anything (docs/03). Then stamp authorship so the model can
  // never pick a peer's id for an annotation (M0.4): the author is the
  // authenticated caller, or the assistant when there is no user to attribute an
  // AI-written comment to. The same helper Room.commit uses, so both entry paths
  // attribute identically.
  const filtered = result.operations.filter((op) => !isHumanOnlyOperation(op.op));
  const permitted = stampAuthorship(filtered, userId ?? ASSISTANT_AUTHOR);

  // Authoritative when a stored board backs this request AND belongs to the
  // caller. The HTTP layer checks ownership too; enforcing it here means the
  // function that touches the data can never be talked past with a hand-built
  // call. A board owned by someone else falls back to advisory validation and
  // is never read from or written to.
  const candidateBoard = authoritative
    ? await authoritative.store.get(authoritative.boardId)
    : undefined;
  const authoritativeBoard =
    candidateBoard && userId === candidateBoard.ownerId ? candidateBoard : undefined;
  const workspace = authoritativeBoard
    ? authoritativeBoard.workspace
    : workspaceFromSummary(parsed.data.summary);
  // Repair likely-mis-ordered model output (e.g. node before its group) before
  // validating, so good-intent batches aren't rejected on ordering alone.
  let operations = repairOperations(permitted);
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
        second.operations.filter((op) => !isHumanOnlyOperation(op.op)),
        userId ?? ASSISTANT_AUTHOR,
      );
      operations = repairOperations(repairedPermitted);
      errors = validateOperations(workspace, operations);
    }
  }

  if (errors.length > 0) {
    // Reject rather than apply an inconsistent batch; the client can retry.
    return {
      ok: false,
      status: 422,
      body: { error: "operations failed validation", errors, repaired },
    };
  }

  // Only the keys the provider actually reported: a model that omits usage must
  // not be metered as having used zero tokens.
  const completion: NonNullable<HandleResult["completion"]> = {
    ...(result.model ? { model: result.model } : {}),
    ...(usageFor(result, firstResult) ? { usage: usageFor(result, firstResult)! } : {}),
  };

  // Persist the merged board so the next request validates against the new state.
  if (authoritative && authoritativeBoard) {
    const updated = applyOperations(workspace, operations);
    await authoritative.store.put({
      ...authoritativeBoard,
      workspace: updated,
      updatedAt: Date.now(),
    });
    return {
      ok: true,
      operations,
      explanation: result.explanation ?? null,
      provider: provider.name,
      // The client learns the new server-side version in the same response.
      boardVersion: Date.now(),
      completion,
    };
  }

  return {
    ok: true,
    operations,
    explanation: result.explanation ?? null,
    provider: provider.name,
    // No authoritative board: there is no server-side version to report.
    boardVersion: 0,
    completion,
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
  send?: (event: "start" | "delta" | "done" | "error", data: unknown) => void,
): Promise<{
  status: number;
  provider: string;
  operations: number;
  completion: NonNullable<HandleResult["completion"]> | null;
}> {
  const emit = send ?? (() => {});
  emit("start", { provider: provider.name, streaming: true });
  const outcome = await runGeneratePipeline(provider, rawBody, userId, authoritative, {
    onDelta: (delta) => emit("delta", { text: delta }),
  });
  if (!outcome.ok) {
    emit("error", outcome.body);
    return { status: outcome.status, provider: provider.name, operations: 0, completion: null };
  }
  emit("done", {
    operations: outcome.operations,
    explanation: outcome.explanation,
    provider: outcome.provider,
    boardVersion: outcome.boardVersion,
  });
  return {
    status: 200,
    provider: outcome.provider,
    operations: outcome.operations.length,
    completion: outcome.completion,
  };
}
