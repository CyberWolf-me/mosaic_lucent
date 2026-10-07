import * as z from "zod/v4";
import { createWorkspace, DIAGRAM_KINDS, type Workspace } from "./model.js";
import { vectorDataSchema } from "./vector.js";
import { tableDataSchema } from "./table.js";
import { chartDataSchema } from "./chart.js";
import { nodeDetailsSchema } from "./operations.js";
import {
  iconRef,
  isImageDataUrl,
  optionalCssColor,
  optionalImageSrc,
  optionalSvgPathData,
} from "./schemaPrimitives.js";

/**
 * Zod schema for the full Workspace JSON (M0.5).
 *
 * Replaces the M0.3 ad-hoc `parseWorkspace` helper and the `withDefaults` shim in
 * workspace.tsx with a single contract. Three properties it has to honour:
 *
 *  - tolerant: an older build's board may be missing collections or fields the
 *    current model knows about. The schema fills in defaults rather than
 *    throwing, so a board written two releases ago still loads.
 *  - strict on sinks: shape `fill`, `stroke`, `path`, `src` are validated by the
 *    same primitives the operations union uses, so a workspace that landed on
 *    disk because a hostile model bypassed validation can't sneak through here.
 *  - result-typed: callers get a discriminated union back rather than a thrown
 *    ZodError, so HTTP handlers and the Postgres read path produce the same
 *    error shape they already do.
 */

const COLLECTION_KEYS = [
  "nodes",
  "edges",
  "groups",
  "wireframes",
  "shapes",
  "shapeLinks",
  "votes",
  "reactions",
  "comments",
] as const;

const nodeSchema = z.object({
  id: z.string().min(1),
  nodeType: z.string().min(1),
  label: z.string(),
  groupId: z.string().min(1).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  size: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  pinned: z.boolean().optional(),
  // docs/26 §6.2. Looser than the op schema on purpose: a malformed icon on a
  // stored board is dropped (the label's automatic icon renders), never a
  // reason to refuse the whole board.
  icon: iconRef.optional().catch(undefined),
  // V4 compartments. The op schema itself, imported rather than restated: the
  // limits are the contract and there is no older shape to stay loose for.
  // Tolerant like `icon`: details that no longer parse are dropped (the card
  // shows its name alone), never a reason to refuse the board.
  details: nodeDetailsSchema.optional().catch(undefined),
  issue: z
    .object({
      type: z.enum(["epic", "story", "task", "subtask", "bug"]),
      status: z.string().min(1),
      statusCategory: z.enum(["todo", "in_progress", "done"]).optional(),
      assignee: z.string().optional(),
      priority: z.enum(["highest", "high", "medium", "low", "lowest"]).optional(),
      storyPoints: z.number().min(0).max(1000).optional(),
      labels: z.array(z.string()).max(20).optional(),
      parentId: z.string().min(1).optional(),
      // Stage D1 (ADR 0027): the execution fields — restated deliberately
      // like every issue field; missing here means stripped on every load.
      // The load path is deliberately LOOSER than the op schema (no dueDate
      // regex): a stored board whose date predates the contract loads
      // rather than being refused (the workspaceSchema precedent).
      dueDate: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  // Statement semantics (Stage C2). Restated here rather than imported from
  // operations.ts, the same accepted duplication as `issue` above (ADR 0014):
  // the parse contract is a wire-format view of the model, and a change to
  // either shape should have to be made twice deliberately. A statement or
  // provenance field missing from THIS schema would be silently stripped on
  // every parseWorkspace — persisted boards would load without them.
  statement: z
    .object({
      kind: z.enum(["decision", "proposal", "question", "action", "requirement", "risk"]),
      status: z.enum(["open", "resolved", "rejected", "superseded"]),
      topic: z.string().min(1).max(60).optional(),
      supersedes: z.array(z.string().min(1)).max(10).optional(),
      // ADR 0047: dropped here, a board would lose every review on reload.
      trust: z
        .enum(["ai-suggested", "human-approved", "human-edited", "human-created", "system"])
        .optional(),
      // Stage D2: createdFrom joins the family. The load path is deliberately
      // LOOSER than the op schema (meetingId optional, no at-least-one
      // refine): a stored board whose provenance predates either contract
      // loads rather than being refused (the workspaceSchema precedent).
      provenance: z
        .object({
          meetingId: z.string().min(1).max(120).optional(),
          turnRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
          turnKinds: z.array(z.string().min(1)).max(8).optional(),
          quote: z.string().max(240).optional(),
          createdFrom: z.array(z.string().min(1)).max(20).optional(),
          conversation: z.object({ at: z.number(), by: z.string().max(80).optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
  provenance: z
    .object({
      meetingId: z.string().min(1).max(120).optional(),
      turnRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
      turnKinds: z.array(z.string().min(1)).max(8).optional(),
      quote: z.string().max(240).optional(),
      createdFrom: z.array(z.string().min(1)).max(20).optional(),
      // ADR 0042: conversation evidence — without it here, parseWorkspace
      // would silently strip it from every persisted board on load.
      conversation: z.object({ at: z.number(), by: z.string().max(80).optional() }).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const shapeStyleSchema = z.object({
  fill: optionalCssColor,
  stroke: optionalCssColor,
  strokeWidth: z.number().nonnegative().optional(),
  color: optionalCssColor,
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().nonnegative().optional(),
});

const shapeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
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
      "vector",
      "table",
      "chart",
    ]),
    position: z.object({ x: z.number(), y: z.number() }),
    size: z.object({ width: z.number().positive(), height: z.number().positive() }),
    rotation: z.number().optional(),
    text: z.string().optional(),
    path: optionalSvgPathData,
    src: optionalImageSrc,
    // docs/26 §6.3. Tolerant like `icon`: a stored vector that no longer parses
    // is dropped (the shape shows its placeholder), never a refused board.
    vector: vectorDataSchema.optional().catch(undefined),
    // docs/26 §6.1. Tolerant the same way: a malformed table is dropped, not a
    // refused board.
    table: tableDataSchema.optional().catch(undefined),
    // docs/26 §6.1. Same tolerance for a chart's data.
    chart: chartDataSchema.optional().catch(undefined),
    style: shapeStyleSchema.optional(),
    z: z.number().optional(),
    groupId: z.string().min(1).optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .superRefine((shape, ctx) => {
    // An inline image is fine on an image shape (that src reaches an <img>); on
    // an embed it would reach an iframe, so those stay http(s)-only.
    if (shape.src && shape.kind !== "image" && isImageDataUrl(shape.src)) {
      ctx.addIssue({
        code: "custom",
        path: ["src"],
        message: `a data URL src is only allowed on an image shape, not "${shape.kind}"`,
      });
    }
  });

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relationship: z.string().default(""),
  label: z.string().optional(),
  // Derived routing waypoints (layout-stamped, like Node.position); optional
  // so every pre-route board parses unchanged.
  route: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

const groupSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  children: z.array(z.string().min(1)),
  /**
   * Diagram regions (per-group kind); absent on every pre-region board. The
   * full family set (docs/26 §6.1 registry) so a region can be any kind the
   * board can — matching SET_GROUP_KIND, which already accepts them all.
   */
  kind: z.enum(DIAGRAM_KINDS).optional(),
});

const commentSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  body: z.string(),
  by: z.string(),
  createdAt: z.number(),
  parentId: z.string().optional(),
  resolved: z.boolean().optional(),
  mentions: z.array(z.string()).optional(),
});

const voteSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  by: z.string(),
});

const reactionSchema = z.object({
  id: z.string().min(1),
  targetId: z.string().min(1),
  emoji: z.string().min(1),
  by: z.string(),
});

const wireframeElementSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    kind: z.string().min(1),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    variant: z.enum(["primary", "secondary", "ghost"]).optional(),
    direction: z.enum(["row", "column"]).optional(),
    weight: z.number().positive().optional(),
    children: z.array(wireframeElementSchema).optional(),
  }),
);

const wireframeSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
  root: wireframeElementSchema,
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .transform((n) => n.trim() || "Untitled")
    .default("Untitled"),
  diagramKind: z.enum(DIAGRAM_KINDS),
  // Layout intent (Phase 5): optional and additive — every pre-intent board
  // parses unchanged. Ids are validated only as strings here; the op-level
  // validator checks node existence when the AI SETS an intent.
  layoutIntent: z
    .object({
      direction: z.enum(["vertical", "horizontal"]).optional(),
      primaryFlow: z.array(z.string().min(1)).optional(),
      emphasis: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  nodes: z.record(z.string(), nodeSchema).default({}),
  edges: z.record(z.string(), edgeSchema).default({}),
  groups: z.record(z.string(), groupSchema).default({}),
  wireframes: z.record(z.string(), wireframeSchema).default({}),
  shapes: z.record(z.string(), shapeSchema).default({}),
  shapeLinks: z
    .record(
      z.string(),
      z.object({
        id: z.string().min(1),
        source: z.string().min(1),
        target: z.string().min(1),
        label: z.string().optional(),
        variant: z.enum(["straight", "elbow", "curved"]).optional(),
        doubleArrow: z.boolean().optional(),
      }),
    )
    .default({}),
  votes: z.record(z.string(), voteSchema).default({}),
  reactions: z.record(z.string(), reactionSchema).default({}),
  comments: z.record(z.string(), commentSchema).default({}),
});

export interface ParseWorkspaceResult {
  ok: boolean;
  workspace?: Workspace;
  /** Human-readable detail for a 400 response. */
  detail?: string;
  /**
   * Referential repairs made while loading, for callers that surface them.
   * Today: edges whose source/target node id does not resolve are DROPPED
   * rather than poisoning the board — the canvas skipped them as silent
   * no-ops anyway, but a dropped-with-a-report load says what happened
   * instead of leaving the user to wonder why a relationship is missing.
   */
  dropped?: string[];
}

/**
 * Parse an unknown value into a Workspace. Tolerant of older shapes: missing
 * collections become empty, missing optional fields stay undefined. Refuses a
 * payload that's missing required primitives, has the wrong type for any
 * collection, or contains a sink-hostile string. Pure so it runs on the client,
 * the server route, and the Postgres read path with identical behaviour.
 */
export function parseWorkspace(value: unknown): ParseWorkspaceResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "workspace must be an object" };
  }
  const obj = value as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    const v = obj[key];
    if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
      return { ok: false, detail: `workspace.${key} must be an object` };
    }
  }
  const parsed = workspaceSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.join(".") ?? "(root)";
    return { ok: false, detail: `workspace.${path}: ${first?.message ?? "invalid"}` };
  }
  const workspace = parsed.data as Workspace;
  // Referential repair, NON-DESTRUCTIVELY (Stage A safety, P3). An edge
  // pointing at a node id that doesn't resolve renders as silent nothing on
  // the canvas (its draw path bails when either endpoint is missing) — but
  // that is exactly why nothing needs to DELETE it: the skip is the belt.
  // The first cut dropped these edges at the load boundary, and dropping is
  // a data-loss bug in disguise: load → drop → save permanently deletes
  // them, so any transient bug that mismatches one node id silently deleted
  // its edges forever. A dangling edge is RECOVERABLE state (the node it
  // references may come back — an undo of a delete, a re-import, a server
  // catch-up); deleting it at load removed the recovery. We now retain them
  // and report: `dropped` keeps its name for caller compatibility but now
  // means "dangling, retained" — the render layer already skips them safely.
  const dropped: string[] = [];
  if (workspace.edges && Object.keys(workspace.edges).length > 0) {
    for (const [id, edge] of Object.entries(workspace.edges)) {
      if (!(workspace.nodes[edge.source] && workspace.nodes[edge.target])) {
        dropped.push(id);
      }
    }
  }
  return dropped.length > 0 ? { ok: true, workspace, dropped } : { ok: true, workspace };
}

/**
 * Parse-or-default. Used when the caller cannot refuse the input (the existing
 * `withDefaults` shim). Always returns a usable Workspace; logs a one-line
 * warning to the console when defaults were filled.
 */
export function parseWorkspaceOrDefault(value: unknown, label = "workspace"): Workspace {
  const result = parseWorkspace(value);
  if (result.ok) return result.workspace!;
  // Top-level corruption: fall back to an empty board rather than crashing
  // the renderer. The previous behaviour was the same (`createWorkspace()` +
  // spread), so this is a strict improvement: warnings tell operators when
  // a stored board is bad.
  if (typeof console !== "undefined") {
    console.warn(`[lucent] ${label} did not parse: ${result.detail}`);
  }
  return createWorkspace();
}
