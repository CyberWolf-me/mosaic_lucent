import * as z from "zod/v4";
import { DIAGRAM_KINDS, NODE_DETAILS_LIMITS, type NodeDetails } from "./model.js";
import { vectorDataSchema } from "./vector.js";
import { tableDataSchema } from "./table.js";
import { chartDataSchema } from "./chart.js";
import {
  iconRef,
  normalizeIconRef,
  optionalCssColor,
  optionalImageSrc,
  optionalSvgPathData,
} from "./schemaPrimitives.js";

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

// Built from the single source of truth in model.ts, so the operation contract,
// the workspace schema and the representation registry can never disagree about
// which families exist.
const diagramKind = z.enum(DIAGRAM_KINDS);

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
  /** Stage D1: the work's deadline. ISO YYYY-MM-DD — resolved from words at
   * emission ("by Friday" never stores "Friday"); the field is the first
   * date in the system, so the format is strict. */
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be an ISO YYYY-MM-DD date")
    .optional(),
  /** Stage D1: what the work actually involves. Capped like Comment.body —
   * the server/core validator is authoritative even where a textarea isn't. */
  description: z.string().max(2000).optional(),
});

/**
 * Where a node came from (Stage C2): the meeting evidence behind its
 * creation. The model never emits this — it cannot see meeting ids or turn
 * indices — so the meeting loop enriches the ops with it before they are
 * committed (attachProvenance), and from there it rides the one pipeline
 * everything trusts: validate → apply → log → peers → undo.
 *
 * This replaced a client-side post-pass that wrote `metadata.meeting` onto
 * nodes after the ops were applied. The stamp existed only in the capturing
 * browser — never in the op log, never on peers, never in undo history — so
 * "why is this node here?" had a different answer on every machine (ADR
 * 0022). Provenance on the originating operation is the same idea with one
 * writer and zero divergence.
 *
 * `extractedAt` is deliberately absent: the op log's own `at` already
 * records when the creation happened, and a second timestamp on the node
 * would be a second source of truth the moment anyone edits it.
 *
 * Stage D2 (ADR 0022's own extension clause — "when later stages add other
 * evidence kinds, they extend attachProvenance rather than inventing a
 * third mechanism"): a second evidence kind joins the family. `createdFrom`
 * carries the SOURCE STATEMENT node ids a plan item was derived from — the
 * statement→action link. Either evidence kind alone is valid (a plan from
 * board selection carries createdFrom only; a meeting extraction carries
 * meetingId only; a plan from a meeting carries both), so meetingId is
 * optional with at least-one required.
 */
export const provenanceFieldsSchema = z
  .object({
    meetingId: z.string().min(1).max(120).optional(),
    /** Stable index range into the meeting's turns, inclusive. */
    turnRange: z
      .tuple([z.number().int().min(0), z.number().int().min(0)])
      .refine((range) => range[1] >= range[0], "turnRange end must be at least its start")
      .optional(),
    /** The meeting loop's classification of the source turns, in turn order. */
    turnKinds: z.array(z.string().min(1)).max(8).optional(),
    /** The words that produced this node, capped like the old stamp was. */
    quote: z.string().max(240).optional(),
    /** Stage D2: the statement node ids this item was derived from — the
     * plan send path stamps it (attachPlanProvenance), never the model. */
    createdFrom: z.array(z.string().min(1)).max(20).optional(),
    /** ADR 0042: the board conversation request this came from — stamped by
     * the client's send path (attachProvenance), never by the model. */
    conversation: z
      .object({
        at: z.number().int().nonnegative(),
        by: z.string().min(1).max(80).optional(),
      })
      .optional(),
  })
  .refine(
    (p) =>
      p.meetingId !== undefined ||
      (p.createdFrom !== undefined && p.createdFrom.length > 0) ||
      p.conversation !== undefined,
    "provenance needs meeting evidence, source statements (createdFrom), or a conversation request",
  );

/**
 * The six statement kinds (Stage C2, ADR 0021). A closed set on purpose: each
 * kind carries a distinct lifecycle — decision/proposal supersede, question
 * resolves, action completes, requirement changes, risk mitigates — and the
 * freeze rule is that a NEW kind needs evidence of its own lifecycle, not
 * merely a new label (`fact`/`constraint` were left out of C2 for exactly
 * that reason; docs/05's wider taxonomy stays transcript context until a kind
 * earns independent behavior).
 */
export const statementKindSchema = z.enum([
  "decision",
  "proposal",
  "question",
  "action",
  "requirement",
  "risk",
]);

/**
 * Lifecycle statuses shared by every kind. Four, not per-kind state machines:
 * the nuance lives in the label and the op log records the story. Decisions
 * are born `resolved` (an undecided decision is a proposal); proposals and
 * questions open; a rejected/superseded statement keeps its history because
 * the supersession is visible on the target (the reducer flips the target's
 * status) rather than deleting anything.
 */
export const statementStatusSchema = z.enum(["open", "resolved", "rejected", "superseded"]);

/** The trust ladder (ADR 0047). Stamped at commit — the model never sets it. */
export const statementTrustSchema = z.enum([
  "ai-suggested",
  "human-approved",
  "human-edited",
  "human-created",
  "system",
]);

const statementFieldsSchema = z.object({
  kind: statementKindSchema,
  status: statementStatusSchema,
  /** Short kebab-case subject key so "pricing" groups across nodes. */
  topic: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "topic must be kebab-case")
    .optional(),
  /** Node ids this statement replaces. Validated: must exist, carry
   * statements, and not form a cycle back to this node. */
  supersedes: z.array(z.string().min(1)).max(10).optional(),
  /** Evidence for the statement itself, when the meeting loop enriched it. */
  provenance: provenanceFieldsSchema.optional(),
  /** How it came to be trusted (ADR 0047). Stamped by the committer. */
  trust: statementTrustSchema.optional(),
});

/** Characters a node's details carry in titles and items — what `totalChars` caps. */
export function nodeDetailsChars(details: NodeDetails): number {
  let n = 0;
  for (const s of details.sections) {
    n += s.title?.length ?? 0;
    for (const item of s.items) n += item.length;
  }
  return n;
}

/**
 * One line of details text. A line is a line: no newline or other control
 * character, so an item means the same row on the card, in the ER lens, in
 * the inspector's one-item-per-line editor and in an SVG export (where a
 * control character is not even valid XML).
 */
// eslint-disable-next-line no-control-regex
const DETAILS_LINE = /^[^\u0000-\u001f\u007f]*$/;
const detailsLine = (max: number) =>
  z
    .string()
    .max(max)
    .regex(DETAILS_LINE, "a details line holds no line breaks or control characters");

/**
 * A node's compartments (V4: UML attributes/operations, ER columns, C4
 * technology). Sized by NODE_DETAILS_LIMITS — the per-field caps bound a
 * single line, the total bounds the card and the op-log entry. An empty
 * `sections` list is accepted and means "no details" (the reducer stores it
 * as absence), so a model that sends `{ sections: [] }` to clear is not
 * refused for spelling it differently from `null`.
 */
export const nodeDetailsSchema = z
  .object({
    sections: z
      .array(
        z.object({
          title: detailsLine(NODE_DETAILS_LIMITS.titleChars).optional(),
          items: z.array(detailsLine(NODE_DETAILS_LIMITS.itemChars)).max(NODE_DETAILS_LIMITS.items),
        }),
      )
      .max(NODE_DETAILS_LIMITS.sections),
  })
  .refine((d) => nodeDetailsChars(d) <= NODE_DETAILS_LIMITS.totalChars, {
    message: `a node's details hold at most ${NODE_DETAILS_LIMITS.totalChars} characters in total`,
  });

/**
 * Fit arbitrary sections inside NODE_DETAILS_LIMITS — for producers that read
 * text they don't control (a Mermaid import, the inspector's textarea): lines
 * are flattened to one line, clipped to the item/title caps, and the sections,
 * items and total are truncated in order, so the result always validates.
 * Returns null when nothing is left (no sections, or only empty ones), which
 * is what SET_NODE_DETAILS spells "clear".
 */
export function clampNodeDetails(
  sections: readonly NodeDetails["sections"][number][],
): NodeDetails | null {
  const flat = (s: string, max: number) =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, max);
  let budget: number = NODE_DETAILS_LIMITS.totalChars;
  const out: NodeDetails["sections"] = [];
  for (const section of sections.slice(0, NODE_DETAILS_LIMITS.sections)) {
    const title =
      section.title !== undefined ? flat(section.title, NODE_DETAILS_LIMITS.titleChars) : "";
    if (title.length > budget) break;
    budget -= title.length;
    const items: string[] = [];
    for (const raw of section.items.slice(0, NODE_DETAILS_LIMITS.items)) {
      const item = flat(raw, NODE_DETAILS_LIMITS.itemChars);
      if (!item) continue;
      if (item.length > budget) break;
      budget -= item.length;
      items.push(item);
    }
    if (!title && items.length === 0) continue;
    out.push({ ...(title ? { title } : {}), items });
  }
  return out.length > 0 ? { sections: out } : null;
}

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
  // docs/26 §6.3: an editable vector — structured paths in `vector`, never markup.
  "vector",
  // docs/26 §6.1: a structured data table in `table` (table.ts).
  "table",
  // docs/26 §6.1: a data-bound chart in `chart` (chart.ts).
  "chart",
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
    /**
     * Creation evidence (Stage C2): the meeting a node was extracted from.
     * Optional because plain "make me a flowchart" requests have no source
     * meeting. The model never sets it; the meeting loop does (see
     * provenanceFieldsSchema above). Untouched by every later operation —
     * a node's origin does not change when its label or layout does.
     */
    provenance: provenanceFieldsSchema.optional(),
    /**
     * A registry icon (docs/26 §6.2): "iconoir:<name>" or "simple:<slug>".
     * Omit it and the renderer derives one from the label.
     */
    icon: iconRef.optional(),
    /**
     * The node's compartments (V4), in the same batch as the node: a class's
     * attributes and operations, an entity's columns, a C4 element's
     * technology. Text only — the layout sizes the card to fit it.
     */
    details: nodeDetailsSchema.optional(),
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
   * Choose a node's icon (docs/26 §6.2): "iconoir:<name>" for a concept,
   * "simple:<slug>" for a brand mark. `null` clears it back to the icon the
   * renderer derives from the label. Presentation-only: never re-lays out.
   */
  z.object({
    op: z.literal("SET_NODE_ICON"),
    id: z.string().min(1),
    icon: iconRef.nullable(),
  }),
  /**
   * Replace a node's details wholesale (V4): its compartments — UML
   * attributes/operations, ER columns, C4 technology and responsibility.
   * `null` clears them. Whole-value rather than a per-line patch so the
   * inverse is exact (it restores the previous value, or null) and two edits
   * never interleave into a list nobody wrote. It changes the card's height,
   * so a client re-lays out after it.
   */
  z.object({
    op: z.literal("SET_NODE_DETAILS"),
    id: z.string().min(1),
    details: nodeDetailsSchema.nullable(),
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
   * or "assign to Sam" edit, without resending the whole issue. Null clears;
   * undefined leaves untouched. Status and the D1 execution fields patch
   * independently — no field ever derives another (ADR 0027).
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
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "dueDate must be an ISO YYYY-MM-DD date")
      .nullable()
      .optional(),
    description: z.string().max(2000).nullable().optional(),
  }),
  /**
   * Attach or replace the semantic statement on a node (Stage C2): the
   * decision/proposal/question/action/requirement/risk the node IS, with its
   * lifecycle status and its evidence. Setting `statement: null` clears it
   * back to a plain node. The mirror of SET_ISSUE for meaning instead of
   * work tracking — one field, one op, one source of truth on the node.
   */
  z.object({
    op: z.literal("SET_STATEMENT"),
    id: z.string().min(1),
    statement: statementFieldsSchema.nullable(),
  }),
  /**
   * Patch a statement's lifecycle without resending it — the "we decided" /
   * "rejected" / "superseded by" / "resolved" edit. `topic: null` clears the
   * key; `supersedes` replaces the list wholesale; `kind` is deliberately NOT
   * patchable: kind is the statement's identity, and a change of kind is a
   * new statement (SET_STATEMENT, visible as its own revision).
   */
  z.object({
    op: z.literal("UPDATE_STATEMENT"),
    id: z.string().min(1),
    status: statementStatusSchema.optional(),
    topic: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .nullable()
      .optional(),
    supersedes: z.array(z.string().min(1)).max(10).optional(),
    /** A review's promotion (ADR 0047): approve, edit. Never from an agent. */
    trust: statementTrustSchema.optional(),
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
    relationship: z.string().default(""),
  }),
  z.object({
    op: z.literal("DISCONNECT_NODES"),
    source: z.string().min(1),
    target: z.string().min(1),
    relationship: z.string().default(""),
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
  /**
   * Layout intent (doc 18, Phase 5, advisory V7): the AI states WHAT the
   * diagram should emphasize — never WHERE anything sits. This is the whole
   * op: ids and enums, not one coordinate. It is a replace-whole patch, so
   * the model may send emphasis without re-sending direction it doesn't
   * mean to change… and a later SET_LAYOUT_INTENT replaces the intent
   * outright (deliberate: a new intent is a new statement about the board,
   * not a merge — merging two model turns into one hybrid intent would be
   * a layout nobody asked for).
   */
  z.object({
    op: z.literal("SET_LAYOUT_INTENT"),
    direction: z.enum(["vertical", "horizontal"]).optional(),
    /** Node ids in narrative order. Must exist (validator); no coordinates. */
    primaryFlow: z.array(z.string().min(1)).max(50).optional(),
    /** Node ids to keep salient. Must exist (validator). */
    emphasis: z.array(z.string().min(1)).max(50).optional(),
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
    /** Kind "vector" only: structured paths (vector.ts). */
    vector: vectorDataSchema.optional(),
    /** Kind "table" only: a structured data grid (table.ts). */
    table: tableDataSchema.optional(),
    /** Kind "chart" only: a data-bound chart (chart.ts). */
    chart: chartDataSchema.optional(),
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
    /** Replace a vector shape's paths (recolour, restroke, simplify, AI edit). */
    vector: vectorDataSchema.optional(),
    /** Replace a table shape's data (edit cells, add rows/columns). */
    table: tableDataSchema.optional(),
    /** Replace a chart shape's data (change type, series, values). */
    chart: chartDataSchema.optional(),
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

/**
 * Per-op-name sets of the only top-level keys the contract knows. Built from
 * the union's own shapes, so a new op or field is automatically known — this
 * cannot drift from the schema it guards.
 */
const KNOWN_OP_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  operationSchema.options.map((o) => [o.shape.op.value as string, new Set(Object.keys(o.shape))]),
);

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

/**
 * The conversation on a board — comments, replies, reactions, votes and
 * resolving a thread — as opposed to its content. A board `commenter` may
 * send these and nothing else (docs/26 F8); the server room enforces it (and
 * lets a commenter delete only their own comments), the web client mirrors
 * it so its local state never runs ahead of the room.
 */
export const CONVERSATION_OPS: ReadonlySet<Operation["op"]> = new Set<Operation["op"]>([
  "ADD_COMMENT",
  "REPLY_COMMENT",
  "RESOLVE_COMMENT",
  "DELETE_COMMENT",
  "ADD_REACTION",
  "REMOVE_REACTION",
  "ADD_VOTE",
  "REMOVE_VOTE",
]);

/** True when every operation in the batch is conversation, not content. */
export function isConversationOnly(ops: readonly Operation[]): boolean {
  return ops.length > 0 && ops.every((op) => CONVERSATION_OPS.has(op.op));
}

const OP_ALIASES: Record<string, string> = {
  ADD_NODE: "CREATE_NODE",
  NEW_NODE: "CREATE_NODE",
  INSERT_NODE: "CREATE_NODE",
  CREATE_EDGE: "CONNECT_NODES",
  ADD_EDGE: "CONNECT_NODES",
  CONNECT: "CONNECT_NODES",
  LINK_NODES: "CONNECT_NODES",
  LINK: "CONNECT_NODES",
  REMOVE_NODE: "DELETE_NODE",
  DELETE: "DELETE_NODE",
  SET_NODE_TYPE: "CHANGE_NODE_TYPE",
  UPDATE_NODE_TYPE: "CHANGE_NODE_TYPE",
  CHANGE_TYPE: "CHANGE_NODE_TYPE",
  SET_TYPE: "CHANGE_NODE_TYPE",
  MODIFY_NODE_TYPE: "CHANGE_NODE_TYPE",
  RENAME_NODE: "CHANGE_TEXT",
  SET_LABEL: "CHANGE_TEXT",
  UPDATE_TEXT: "CHANGE_TEXT",
  UPDATE_LABEL: "CHANGE_TEXT",
  UPDATE_WIREFRAME: "CREATE_WIREFRAME",
  MODIFY_WIREFRAME: "CREATE_WIREFRAME",
  EDIT_WIREFRAME: "CREATE_WIREFRAME",
  SET_WIREFRAME: "CREATE_WIREFRAME",
  ADD_WIREFRAME: "CREATE_WIREFRAME",
  REMOVE_WIREFRAME: "DELETE_WIREFRAME",
};

/**
 * Tolerant normalization for wireframe element trees emitted by LLMs.
 * Maps common variations (text/title/name -> label, horizontal/vertical -> row/column,
 * outline/solid/default -> secondary/primary) into valid WireframeElement structures.
 */
function sanitizeWireframeElement(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    return { kind: "text", label: String(raw ?? "") };
  }
  const el = { ...(raw as Record<string, unknown>) };

  if (typeof el.kind !== "string" || !el.kind.trim()) {
    el.kind = typeof el.type === "string" && el.type.trim() ? el.type.trim() : "card";
  } else {
    el.kind = el.kind.trim();
  }

  if (typeof el.label !== "string") {
    const candidate = el.text ?? el.title ?? el.name ?? el.value ?? el.heading ?? el.caption;
    if (candidate !== undefined && candidate !== null) {
      el.label = String(candidate);
    }
  }

  if (el.placeholder !== undefined && el.placeholder !== null && typeof el.placeholder !== "string") {
    el.placeholder = String(el.placeholder);
  }

  if (el.variant !== undefined && el.variant !== null) {
    const v = String(el.variant).toLowerCase().trim();
    if (v === "primary" || v === "secondary" || v === "ghost") {
      el.variant = v;
    } else if (v === "outline" || v === "muted" || v === "subtle") {
      el.variant = "secondary";
    } else if (v === "solid" || v === "default" || v === "accent" || v === "brand") {
      el.variant = "primary";
    } else if (v === "text" || v === "link") {
      el.variant = "ghost";
    } else {
      delete el.variant;
    }
  }

  if (el.direction !== undefined && el.direction !== null) {
    const d = String(el.direction).toLowerCase().trim();
    if (d === "row" || d === "horizontal" || d === "inline") {
      el.direction = "row";
    } else if (d === "column" || d === "vertical" || d === "stack") {
      el.direction = "column";
    } else {
      delete el.direction;
    }
  }

  if (el.weight !== undefined && el.weight !== null) {
    const num = typeof el.weight === "number" ? el.weight : parseFloat(String(el.weight));
    if (Number.isFinite(num) && num > 0) {
      el.weight = num;
    } else {
      delete el.weight;
    }
  }

  const rawChildren = Array.isArray(el.children)
    ? el.children
    : Array.isArray(el.elements)
      ? el.elements
      : Array.isArray(el.items)
        ? el.items
        : undefined;

  if (rawChildren) {
    el.children = rawChildren.map((c) => sanitizeWireframeElement(c));
  } else {
    delete el.children;
  }

  return el;
}

/**
 * Models write "id PK\nemail\nuser_id FK" as one item as often as three. A
 * details line may not hold a line break (nodeDetailsSchema), so rather than
 * refuse the whole batch over it, the tolerant model path splits such an item
 * into the lines it plainly meant. Anything that isn't the expected shape is
 * returned untouched for the schema to judge.
 */
function splitDetailLines(details: unknown): unknown {
  if (typeof details !== "object" || details === null) return details;
  const sections = (details as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return details;
  return {
    ...details,
    sections: sections.map((s: unknown) => {
      const items = (s as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return s;
      return {
        ...(s as object),
        items: items.flatMap((item: unknown) =>
          typeof item === "string" && /[\r\n]/.test(item)
            ? item
                .split(/\r?\n|\r/)
                .map((l) => l.trim())
                .filter(Boolean)
            : [item],
        ),
      };
    }),
  };
}

/**
 * Batch-wide shapes that fail every operation at once, so nothing is left to
 * salvage: the array sent as a JSON string, the array wrapped in its own
 * `{ operations: [...] }` object, or one bare operation instead of a list.
 */
function unwrapOperations(raw: unknown): unknown {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return raw;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = (value as { operations?: unknown }).operations;
    if (Array.isArray(inner)) return inner;
    if ("op" in value) return [value];
    return raw;
  }
  return Array.isArray(value) ? value : raw;
}

/** Keys a model uses for the operation name when it leaves out `op`. */
const OP_NAME_KEYS = ["operation", "action", "type"] as const;

/** Keys a model uses to nest the operation fields one level down. */
const NESTED_ARG_KEYS = ["params", "parameters", "args", "arguments", "payload"] as const;

function knownOpName(value: unknown, knownOps: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.toUpperCase().trim();
  const resolved = OP_ALIASES[name] ?? name;
  return knownOps.has(resolved) ? resolved : undefined;
}

export function sanitizeRawOperations(input: unknown): unknown {
  const raw = unwrapOperations(input);
  if (!Array.isArray(raw)) return raw;
  const knownOps = new Set(ALL_OPERATION_NAMES);
  const normalized: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      normalized.push(item as unknown as Record<string, unknown>);
      continue;
    }
    const copy = { ...item } as Record<string, unknown>;
    let op = typeof copy.op === "string" ? copy.op.toUpperCase().trim() : "";
    if (!op) {
      for (const key of OP_NAME_KEYS) {
        const named = knownOpName(copy[key], knownOps);
        if (named) {
          op = named;
          delete copy[key];
          break;
        }
      }
    }
    const aliased = OP_ALIASES[op];
    if (aliased) op = aliased;
    const contract = KNOWN_OP_KEYS.get(op);
    for (const key of NESTED_ARG_KEYS) {
      const nested = copy[key];
      if (contract?.has(key) || !nested || typeof nested !== "object" || Array.isArray(nested)) {
        continue;
      }
      delete copy[key];
      for (const [k, v] of Object.entries(nested)) {
        if (copy[k] === undefined) copy[k] = v;
      }
    }
    if (!knownOps.has(op)) {
      if (copy.source && copy.target) {
        op = "CONNECT_NODES";
      } else if (copy.label || copy.nodeType || copy.type) {
        op = "CREATE_NODE";
      }
    }
    if (op) {
      copy.op = op;
    }
    if (copy.op === "CREATE_NODE") {
      if (!copy.id || typeof copy.id !== "string") {
        copy.id = `node_${Math.random().toString(36).slice(2, 9)}`;
      }
      if (typeof copy.nodeType !== "string" || !copy.nodeType.trim()) {
        const candidate = copy.type ?? copy.node_type ?? copy.kind ?? copy.newType;
        if (typeof candidate === "string" && candidate.trim()) {
          copy.nodeType = candidate.trim();
        } else {
          copy.nodeType = "service";
        }
      }
      if (typeof copy.label !== "string") {
        copy.label = String(copy.label ?? copy.title ?? copy.text ?? copy.name ?? copy.id ?? "");
      }
      // A malformed icon costs the icon, never the node: repair what can be
      // repaired ("SI:Stripe" → "simple:stripe") and drop the rest.
      if (copy.icon !== undefined) {
        const icon = normalizeIconRef(copy.icon);
        if (icon) copy.icon = icon;
        else delete copy.icon;
      }
    }
    if (copy.op === "CHANGE_NODE_TYPE") {
      if (typeof copy.nodeType !== "string" || !copy.nodeType.trim()) {
        const candidate = copy.type ?? copy.newType ?? copy.to ?? copy.node_type ?? copy.kind;
        if (typeof candidate === "string" && candidate.trim()) {
          copy.nodeType = candidate.trim();
        } else {
          copy.nodeType = "step";
        }
      }
    }
    if (copy.op === "CHANGE_TEXT") {
      if (typeof copy.text !== "string") {
        copy.text = String(
          copy.text ?? copy.label ?? copy.newText ?? copy.title ?? copy.name ?? "",
        );
      }
    }
    if (copy.op === "MOVE_NODE") {
      if (!copy.position && typeof copy.x === "number" && typeof copy.y === "number") {
        copy.position = { x: copy.x, y: copy.y };
      }
    }
    if (copy.op === "SET_NODE_ICON" && copy.icon !== null && copy.icon !== undefined) {
      // Unrepairable → a clear, which is what "no usable icon" means.
      copy.icon = normalizeIconRef(copy.icon) ?? null;
    }
    if ((copy.op === "CREATE_NODE" || copy.op === "SET_NODE_DETAILS") && copy.details) {
      copy.details = splitDetailLines(copy.details);
    }
    if (copy.op === "CONNECT_NODES" || copy.op === "DISCONNECT_NODES") {
      if (!copy.source && typeof copy.from === "string") copy.source = copy.from;
      if (!copy.target && typeof copy.to === "string") copy.target = copy.to;
      if (copy.relationship === null || copy.relationship === undefined) {
        copy.relationship = "";
      }
    }
    if (copy.op === "CREATE_WIREFRAME") {
      if (!copy.id || typeof copy.id !== "string" || !copy.id.trim()) {
        copy.id = `wf_${Math.random().toString(36).slice(2, 9)}`;
      } else {
        copy.id = copy.id.trim();
      }
      if (typeof copy.title !== "string" || !copy.title.trim()) {
        const candidate = copy.name ?? copy.label ?? copy.title ?? "Wireframe";
        copy.title = String(candidate).trim() || "Wireframe";
      } else {
        copy.title = copy.title.trim();
      }
      if (copy.viewport !== "desktop" && copy.viewport !== "tablet" && copy.viewport !== "mobile") {
        const vp = String(copy.viewport ?? "").toLowerCase().trim();
        if (vp === "mobile" || vp === "phone" || vp === "mobile-first" || vp === "smartphone") {
          copy.viewport = "mobile";
        } else if (vp === "tablet" || vp === "ipad") {
          copy.viewport = "tablet";
        } else {
          copy.viewport = "desktop";
        }
      }
      if (!copy.root || typeof copy.root !== "object") {
        const rawChildren = Array.isArray(copy.children)
          ? copy.children
          : Array.isArray(copy.elements)
            ? copy.elements
            : Array.isArray(copy.items)
              ? copy.items
              : [];
        copy.root = {
          kind: "screen",
          children: rawChildren.map(sanitizeWireframeElement),
        };
      } else {
        copy.root = sanitizeWireframeElement(copy.root);
      }
    }
    normalized.push(copy);
  }
  return normalized;
}

/** Parse raw (untrusted) AI output into typed operations, throwing on invalid. */
export function parseOperations(raw: unknown): Operation[] {
  return operationsSchema.parse(sanitizeRawOperations(raw));
}

/** Safe variant that returns a result instead of throwing. */
export function safeParseOperations(raw: unknown) {
  return operationsSchema.safeParse(sanitizeRawOperations(raw));
}

/**
 * The programmatic caller's parse (ws room, ops route, any future agent
 * transport): unknown top-level keys are refused instead of stripped, so a
 * malformed batch answers with a schema issue rather than committing a
 * silently acked no-op — the class found live on 2026-09-10, where
 * `{op:'UPDATE_ISSUE', id, patch:{...}}` validated (zod stripped `patch`),
 * committed, acked, and changed nothing. Model output does NOT use this: it
 * keeps the tolerant schema because providers emit harmless extras and the
 * repair round owns real drift.
 *
 * The key check runs BEFORE `operationsSchema.safeParse` because a zod
 * superRefine sees the already-stripped output — the extra keys are gone by
 * the time a refinement could look at them. The result shape matches zod's,
 * so callers read `.success` / `.data` / `.error.issues` unchanged.
 */
export function safeParseProgrammaticOperations(raw: unknown) {
  if (Array.isArray(raw)) {
    const issues: z.ZodIssue[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== "object" || entry === null) return; // the union reports this
      const opName = (entry as { op?: unknown }).op;
      if (typeof opName !== "string") return; // the union reports this
      const known = KNOWN_OP_KEYS.get(opName);
      if (!known) return; // an unknown op name is the union's issue to report
      for (const key of Object.keys(entry as object)) {
        if (!known.has(key)) {
          issues.push({
            code: z.ZodIssueCode.custom,
            path: [index, key],
            message: `unknown key "${key}" on ${opName} — not part of the operation contract`,
            input: entry,
          });
        }
      }
    });
    if (issues.length > 0) return { success: false as const, error: new z.ZodError(issues) };
  }
  return operationsSchema.safeParse(raw);
}

/**
 * Enrich a batch with its meeting evidence (Stage C2) — the op-level
 * replacement for the old client post-pass. The meeting loop holds the
 * provenance the model can never see (meeting id, turn range, the words
 * said); this attaches it to the ops BEFORE they are committed, so it lands
 * in the op log, on every peer, in the server's board, and in undo history —
 * everywhere the ops themselves go — instead of only in the capturing
 * browser's memory.
 *
 * Placement rules:
 * - CREATE_NODE gains `provenance` (creation evidence).
 * - SET_STATEMENT embeds it in the statement (the evidence for the statement
 *   the node now carries — e.g. the "let's price it at $15" turn behind a
 *   decision node).
 * - Everything else is untouched: provenance is about the CREATION/change
 *   that produced the object, not a footnote on every later edit.
 *
 * Idempotent per op: an op that already carries provenance keeps its own —
 * a second meeting extraction batch over the same node does not overwrite
 * the first origin.
 */
export function attachProvenance(
  ops: readonly Operation[],
  provenance: z.infer<typeof provenanceFieldsSchema>,
): Operation[] {
  return ops.map((op) => {
    if (op.op === "CREATE_NODE") {
      if (op.provenance) return op;
      return { ...op, provenance } as Operation;
    }
    if (op.op === "SET_STATEMENT") {
      if (op.statement === null || op.statement.provenance) return op;
      return {
        ...op,
        statement: { ...op.statement, provenance },
      } as Operation;
    }
    return op;
  });
}

/**
 * Attach the plan's source-statement evidence (Stage D2): the createdFrom
 * link stamped by the plan send path — a fourth writer alongside the three
 * ADR 0022 named, extending the same family per its own clause.
 *
 * Unlike attachProvenance (whole-object fill), this MERGES: an op that
 * already carries meeting evidence keeps it and gains createdFrom — a plan
 * generated from a meeting's decisions carries both evidence kinds, not
 * one overwriting the other. An op that already has createdFrom keeps its
 * own (idempotence — the client stamps before send; the server's
 * approve-time enrichment is a no-op over it).
 */
export function attachPlanProvenance(
  ops: readonly Operation[],
  statementIds: readonly string[],
): Operation[] {
  if (statementIds.length === 0) return [...ops];
  return ops.map((op) => {
    if (op.op === "CREATE_NODE") {
      const existing = op.provenance;
      if (existing?.createdFrom) return op;
      return {
        ...op,
        ...(existing
          ? { provenance: { ...existing, createdFrom: [...statementIds] } }
          : { provenance: { createdFrom: [...statementIds] } }),
      } as Operation;
    }
    if (op.op === "SET_STATEMENT") {
      if (op.statement === null) return op;
      const existing = op.statement.provenance;
      if (existing?.createdFrom) return op;
      return {
        ...op,
        statement: {
          ...op.statement,
          ...(existing
            ? { provenance: { ...existing, createdFrom: [...statementIds] } }
            : { provenance: { createdFrom: [...statementIds] } }),
        },
      } as Operation;
    }
    return op;
  });
}
