import * as z from "zod/v4";
import { optionalCssColor, optionalImageSrc, optionalSvgPathData } from "./schemaPrimitives.js";

/**
 * The AI never manipulates the canvas directly. It emits these structured
 * operations, the app validates them, and the reducer executes them.
 * See docs/03 (AI action system) and docs/09 (the contract).
 *
 * Note: the AI proposes node ids, labels, and relationships. It never sets
 * coordinates — the layout engine owns position/size. MOVE_NODE is the sole
 * coordinate-bearing operation and is reserved for direct human manipulation;
 * the AI tool definition (toolSchema.ts) and `AI_OPERATION_NAMES` below strip
 * it from the enum the model may emit, while `AI_FORBIDDEN_OPS` lists it
 * explicitly for the runtime guard.
 *
 * This module is the single source of truth for the operation contract. The
 * provider tool definition is derived from it (see toolSchema.ts) so the
 * operations advertised to the model can never drift from the ones the
 * validator accepts.
 */

const diagramKind = z.enum([
  "flowchart",
  "architecture",
  "mindmap",
  "journey",
  "decisiontree",
  "process",
  "orgchart",
]);

/** Work-tracking (Jira-style) fields attached to a node. All optional so the
 * model can set only what it knows; the reducer fills a default statusCategory. */
const issueFieldsSchema = z.object({
  type: z.enum(["epic", "story", "task", "subtask", "bug"]),
  status: z.string().min(1),
  statusCategory: z.enum(["todo", "in_progress", "done"]).optional(),
  assignee: z.string().optional(),
  priority: z.enum(["highest", "high", "medium", "low", "lowest"]).optional(),
  storyPoints: z.number().min(0).max(1000).optional(),
  labels: z.array(z.string()).max(20).optional(),
  parentId: z.string().min(1).optional(),
});

/**
 * Recursive wireframe element schema. The AI describes UI *structure* — nested
 * regions, rows, fields, buttons — and a flexbox renderer lays it out. No pixel
 * coordinates are ever accepted from the model (docs/03, docs/25).
 */
const wireframeElementSchema: z.ZodType<import("./model.js").WireframeElement> = z.lazy(() =>
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

export const shapeKind = z.enum([
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

const shapeStyleSchema = z.object({
  // fill/stroke are interpolated into SVG attribute sinks (M0.5). They must
  // be valid CSS color literals, not raw markup — the previous `z.string()`
  // let a model emit "red\" onload=\"..." and break out of the attribute.
  fill: optionalCssColor,
  stroke: optionalCssColor,
  strokeWidth: z.number().nonnegative().optional(),
  // `color` is the text colour: same rule applies.
  color: optionalCssColor,
  fontSize: z.number().positive().optional(),
  fontWeight: z.number().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  radius: z.number().nonnegative().optional(),
});

const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("CREATE_NODE"),
    id: z.string().min(1),
    nodeType: z.string().min(1),
    label: z.string(),
    groupId: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("DELETE_NODE"),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("CHANGE_TEXT"),
    id: z.string().min(1),
    text: z.string(),
  }),
  z.object({
    op: z.literal("CHANGE_NODE_TYPE"),
    id: z.string().min(1),
    nodeType: z.string().min(1),
  }),
  /**
   * Attach or replace the work-tracking fields on a node, turning it into a
   * Kanban card (Jira-style). Setting `issue: null` clears them back to a plain
   * diagram node.
   */
  z.object({
    op: z.literal("SET_ISSUE"),
    id: z.string().min(1),
    issue: issueFieldsSchema.nullable(),
  }),
  /**
   * Patch individual issue fields — the common "move this card to In Progress"
   * or "assign to Sam" edit, without resending the whole issue.
   */
  z.object({
    op: z.literal("UPDATE_ISSUE"),
    id: z.string().min(1),
    status: z.string().min(1).optional(),
    statusCategory: z.enum(["todo", "in_progress", "done"]).optional(),
    assignee: z.string().nullable().optional(),
    priority: z.enum(["highest", "high", "medium", "low", "lowest"]).nullable().optional(),
    storyPoints: z.number().min(0).max(1000).nullable().optional(),
    labels: z.array(z.string()).max(20).optional(),
    parentId: z.string().min(1).nullable().optional(),
  }),
  /**
   * A user dragging a node by hand. This is the one operation that carries
   * coordinates, and only a human may emit it — the AI still never positions
   * anything (docs/03). Applying it pins the node so re-layout preserves the
   * placement.
   */
  z.object({
    op: z.literal("MOVE_NODE"),
    id: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }),
    /** Set false to release the node back to automatic layout. */
    pinned: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("CONNECT_NODES"),
    source: z.string().min(1),
    target: z.string().min(1),
    relationship: z.string().min(1),
  }),
  z.object({
    op: z.literal("DISCONNECT_NODES"),
    source: z.string().min(1),
    target: z.string().min(1),
    relationship: z.string().min(1),
  }),
  z.object({
    op: z.literal("CREATE_GROUP"),
    id: z.string().min(1),
    label: z.string(),
    children: z.array(z.string().min(1)).default([]),
    /** Declares this group a diagram region rendered as the given kind. */
    kind: diagramKind.optional(),
  }),
  z.object({
    op: z.literal("DELETE_GROUP"),
    id: z.string().min(1),
  }),
  /**
   * Change or clear a region's kind — "turn the pricing section into an org
   * chart" without touching any other diagram on the board. `kind: null`
   * dissolves the region back into the board-wide layout. Semantics (nodes,
   * edges, membership) are untouched; only the rendering lens changes.
   */
  z.object({
    op: z.literal("SET_GROUP_KIND"),
    id: z.string().min(1),
    kind: diagramKind.nullable(),
  }),
  z.object({
    op: z.literal("CREATE_DIAGRAM"),
    kind: diagramKind,
  }),
  z.object({
    op: z.literal("TRANSFORM_DIAGRAM"),
    to: diagramKind,
  }),
  z.object({
    op: z.literal("CREATE_WIREFRAME"),
    id: z.string().min(1),
    title: z.string(),
    viewport: z.enum(["desktop", "tablet", "mobile"]).default("desktop"),
    root: wireframeElementSchema,
  }),
  z.object({
    op: z.literal("DELETE_WIREFRAME"),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("CREATE_SHAPE"),
    id: z.string().min(1),
    kind: shapeKind,
    position: z.object({ x: z.number(), y: z.number() }),
    size: z.object({ width: z.number().positive(), height: z.number().positive() }),
    rotation: z.number().optional(),
    text: z.string().optional(),
    // `path` reaches an SVG `d=""` attribute sink: it must be SVG path data,
    // not arbitrary markup (M0.5). `src` reaches an image or iframe src: an
    // http(s) URL always, an `asset:ast_...` reference once the bytes are in
    // object storage (M3, and what an upload now produces), plus the strict
    // base64 data URL that carried pasted and AI-generated images before it and
    // still has to parse. The image-only rule for the inline form is enforced by
    // the semantic validator, where `kind` and the existing shape are in scope.
    path: optionalSvgPathData,
    src: optionalImageSrc,
    style: shapeStyleSchema.optional(),
    z: z.number().optional(),
    groupId: z.string().min(1).optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("UPDATE_SHAPE"),
    id: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    size: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
    rotation: z.number().optional(),
    text: z.string().optional(),
    style: shapeStyleSchema.optional(),
    z: z.number().optional(),
    groupId: z.string().min(1).nullable().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("DELETE_SHAPE"),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("CONNECT_SHAPES"),
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    label: z.string().optional(),
    variant: z.enum(["straight", "elbow", "curved"]).optional(),
    doubleArrow: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("UPDATE_LINK"),
    id: z.string().min(1),
    label: z.string().optional(),
    variant: z.enum(["straight", "elbow", "curved"]).optional(),
    doubleArrow: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("DISCONNECT_SHAPES"),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal("GROUP_SHAPES"),
    groupId: z.string().min(1),
    ids: z.array(z.string().min(1)).min(2),
  }),
  z.object({
    op: z.literal("UNGROUP_SHAPES"),
    groupId: z.string().min(1),
  }),
  /**
   * Authorship, for every `by` in the annotation family below: optional, never
   * defaulted. A default made the schema invent an identity — it said "me", so a
   * comment nobody wrote could be persisted as if someone had — and requiring it
   * would push the same invention onto the AI, which cannot know who is asking.
   * The author is not the client's to choose: both server entry paths
   * (`Room.commit`, `handleGenerate`) run `stampAuthorship` before validation, so
   * what reaches a workspace carries the author the server picked, and a client
   * that omits `by` still parses.
   */
  /**
   * Voting (docs/14 §workshop). One operation per vote so a vote can be
   * withdrawn and undone individually. `targetId` may be a node or a shape.
   */
  z.object({
    op: z.literal("ADD_VOTE"),
    id: z.string().min(1),
    targetId: z.string().min(1),
    by: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("REMOVE_VOTE"),
    id: z.string().min(1),
  }),
  /** Clear a whole voting round; omit targetId to reset the entire board. */
  z.object({
    op: z.literal("CLEAR_VOTES"),
    targetId: z.string().min(1).optional(),
  }),
  /** Emoji reactions on a node or shape. */
  z.object({
    op: z.literal("ADD_REACTION"),
    id: z.string().min(1),
    targetId: z.string().min(1),
    emoji: z.string().min(1).max(8),
    by: z.string().min(1).optional(),
  }),
  z.object({
    op: z.literal("REMOVE_REACTION"),
    id: z.string().min(1),
  }),
  /**
   * Comment threads anchored to a node or shape. A reply is a comment carrying
   * `parentId`; resolution applies to the thread root.
   */
  z.object({
    op: z.literal("ADD_COMMENT"),
    id: z.string().min(1),
    targetId: z.string().min(1),
    body: z.string().min(1).max(2000),
    by: z.string().min(1).optional(),
    createdAt: z.number().optional(),
  }),
  z.object({
    op: z.literal("REPLY_COMMENT"),
    id: z.string().min(1),
    /** Thread root being replied to. */
    parentId: z.string().min(1),
    body: z.string().min(1).max(2000),
    by: z.string().min(1).optional(),
    createdAt: z.number().optional(),
  }),
  z.object({
    op: z.literal("RESOLVE_COMMENT"),
    id: z.string().min(1),
    /** false re-opens a resolved thread. */
    resolved: z.boolean().default(true),
  }),
  z.object({
    op: z.literal("DELETE_COMMENT"),
    id: z.string().min(1),
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

/**
 * Operations the AI is allowed to emit: everything except MOVE_NODE, which
 * carries coordinates and belongs to direct human manipulation only. Keeping
 * this as a filter over the same union means a newly added operation reaches the
 * model automatically, with no second list to update.
 */
export const AI_FORBIDDEN_OPS = ["MOVE_NODE"] as const;

export type AiForbiddenOp = (typeof AI_FORBIDDEN_OPS)[number];
export type AiOperation = Exclude<Operation, { op: AiForbiddenOp }>;

/** The discriminated union itself, for schema derivation (see toolSchema.ts). */
export const operationUnionSchema = operationSchema;

export const operationsSchema = z.array(operationSchema);

/** Every operation name the reducer/validator accepts, in declaration order. */
export const ALL_OPERATION_NAMES: readonly string[] = operationSchema.options.map(
  (o) => o.shape.op.value as string,
);

/** Operation names the AI may emit (all minus the human-only ones). */
export const AI_OPERATION_NAMES: readonly string[] = ALL_OPERATION_NAMES.filter(
  (n) => !(AI_FORBIDDEN_OPS as readonly string[]).includes(n),
);

/** True when this operation is reserved for direct human manipulation. */
export function isHumanOnlyOperation(op: string): boolean {
  return (AI_FORBIDDEN_OPS as readonly string[]).includes(op);
}

/** Parse raw (untrusted) AI output into typed operations, throwing on invalid. */
export function parseOperations(raw: unknown): Operation[] {
  return operationsSchema.parse(raw);
}

/** Safe variant that returns a result instead of throwing. */
export function safeParseOperations(raw: unknown) {
  return operationsSchema.safeParse(raw);
}
