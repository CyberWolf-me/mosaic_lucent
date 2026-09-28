import * as z from "zod/v4";
import {
  IDENTITY,
  VECTOR_LIMITS,
  flattenGradients,
  normalizePathData,
  precisionFor,
  recolorVector,
  scaleVectorStrokes,
  vectorDataSchema,
  vectorGradientSchema,
  vectorPalette,
  vectorPathSchema,
  type JsonSchema,
  type VectorData,
  type VectorGradient,
  type VectorPath,
} from "@lucent/core";
import type { TokenUsage } from "./provider.js";

/**
 * "Edit with AI" for an existing vector (docs/26 §6.3, V3): the sixth thing a
 * provider can be asked to do. A person selects a vector and says what to
 * change — "make it flat, two colours", "round the corners", "outline only".
 *
 * The model-independent path: the configured LLM reads the vector as
 * structured paths (never SVG text, and never the vendor prompt it came from)
 * and answers the whole edited drawing through one forced tool. What comes
 * back is untrusted like any model output — `assembleVectorEdit` normalizes
 * every path through core's path grammar, keeps only paint the schema
 * accepts, re-indexes gradients that validate, and refuses an empty result.
 * The person sees before and after and applies it or not (human approval);
 * applying is one UPDATE_SHAPE, one undo.
 *
 * Only small vectors are sent (`VECTOR_EDIT_LIMITS`): a traced photo of
 * thousands of paths is past what a model can rewrite faithfully, and the
 * inspector says to simplify it first.
 */

export interface VectorEditRequest {
  /** The person's words. */
  instruction: string;
  vector: VectorData;
}

/** What the model returns: the whole edited drawing, loosely typed until assembled. */
export interface VectorEditDraft {
  summary: string;
  viewBox?: number[];
  paths: Array<{
    d: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    fillRule?: "nonzero" | "evenodd";
    opacity?: number;
    cap?: "butt" | "round" | "square";
    join?: "miter" | "round" | "bevel";
    fillGradient?: number;
    strokeGradient?: number;
  }>;
  gradients?: unknown[];
}

export interface VectorEditResult extends VectorEditDraft {
  model?: string;
  usage?: TokenUsage;
}

/** The finished edit: a vector the schema accepts, and what changed. */
export interface VectorEdit {
  vector: VectorData;
  summary: string;
  /** Paths the model returned that weren't drawable path data. */
  dropped: number;
}

export const VECTOR_EDIT_LIMITS = {
  /** Largest vector sent: paths, and total characters of path data. */
  paths: 80,
  chars: 16_000,
  instruction: 500,
  summary: 200,
} as const;

/** Small enough to send to a model? Otherwise the caller asks for a simplify first. */
export function vectorEditable(v: VectorData): boolean {
  return (
    v.paths.length <= VECTOR_EDIT_LIMITS.paths &&
    v.paths.reduce((n, p) => n + p.d.length, 0) <= VECTOR_EDIT_LIMITS.chars
  );
}

export const VECTOR_EDIT_TOOL_NAME = "edit_vector";
export const VECTOR_EDIT_TOOL_DESCRIPTION =
  "Return the whole edited vector drawing: every path in paint order (later on top), with its path data and paint, any gradients the paths refer to by index, and a one-sentence summary of the change.";

const num = z.number();
const draftArgsSchema = z.object({
  summary: z.string().min(1).max(400).describe("One short sentence: what you changed."),
  viewBox: z
    .array(num)
    .length(4)
    .optional()
    .describe("[minX, minY, width, height]. Omit to keep the drawing's own."),
  paths: z
    .array(
      z.object({
        d: z
          .string()
          .min(1)
          .max(20_000)
          .describe("SVG path data in the viewBox's coordinates (M, L, C, Q, A, Z)."),
        fill: z
          .string()
          .max(80)
          .optional()
          .describe('A colour ("#rrggbb"), "none", or "currentColor" (the shape\'s ink).'),
        stroke: z.string().max(80).optional(),
        strokeWidth: num.optional(),
        fillRule: z.enum(["nonzero", "evenodd"]).optional(),
        opacity: num.optional(),
        cap: z.enum(["butt", "round", "square"]).optional(),
        join: z.enum(["miter", "round", "bevel"]).optional(),
        fillGradient: z.number().int().optional().describe("Index into gradients."),
        strokeGradient: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(VECTOR_EDIT_LIMITS.paths * 2),
  gradients: z
    .array(
      z.object({
        kind: z.enum(["linear", "radial"]),
        units: z
          .enum(["user", "box"])
          .describe('"box": 0–1 of the path\'s bounds; "user": viewBox units.'),
        x1: num.optional(),
        y1: num.optional(),
        x2: num.optional(),
        y2: num.optional(),
        cx: num.optional(),
        cy: num.optional(),
        r: num.optional(),
        fx: num.optional(),
        fy: num.optional(),
        stops: z
          .array(z.object({ offset: num, color: z.string().max(80), opacity: num.optional() }))
          .min(2)
          .max(16),
      }),
    )
    .max(32)
    .optional(),
});

export function vectorEditToolParametersJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(draftArgsSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export function anthropicVectorEditToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  return {
    name: VECTOR_EDIT_TOOL_NAME,
    description: VECTOR_EDIT_TOOL_DESCRIPTION,
    input_schema: vectorEditToolParametersJsonSchema(),
  };
}

export function openAiVectorEditToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  return {
    type: "function",
    function: {
      name: VECTOR_EDIT_TOOL_NAME,
      description: VECTOR_EDIT_TOOL_DESCRIPTION,
      parameters: vectorEditToolParametersJsonSchema(),
    },
  };
}

/** Parse tool arguments (object or JSON text) or a prose reply's JSON object. */
export function parseVectorEditDraft(raw: string | object): VectorEditDraft {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end < start) throw new Error("No JSON object found in model response");
    try {
      value = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
    }
  }
  const parsed = draftArgsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Vector edit did not match the schema: ${parsed.error.message}`);
  return parsed.data as VectorEditDraft;
}

const pathField = vectorPathSchema.shape;
function keep<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
}

/**
 * A draft → a vector the board accepts. Path data goes through the core
 * normalizer (so arcs, relative and shorthand commands become the stored
 * M/L/C/Q/Z); each paint field survives only if the schema takes it; a
 * gradient survives only whole, and references to one that didn't are
 * dropped (the path keeps its solid fill). Throws when nothing drawable is
 * left — the caller says so rather than applying an empty drawing.
 */
export function assembleVectorEdit(
  request: VectorEditRequest,
  draft: VectorEditDraft,
  source: { generator: "llm" | "mock"; model?: string },
): VectorEdit {
  const own = request.vector.viewBox;
  const vb = draft.viewBox;
  const viewBox: [number, number, number, number] =
    vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0
      ? [vb[0]!, vb[1]!, vb[2]!, vb[3]!]
      : own;
  const decimals = precisionFor(Math.max(viewBox[2], viewBox[3]));

  const gradients: VectorGradient[] = [];
  const index = new Map<number, number>();
  (draft.gradients ?? []).forEach((g, i) => {
    const r = vectorGradientSchema.safeParse(g);
    if (r.success && gradients.length < VECTOR_LIMITS.gradients) {
      index.set(i, gradients.length);
      gradients.push(r.data as VectorGradient);
    }
  });

  let dropped = 0;
  const paths: VectorPath[] = [];
  for (const p of draft.paths) {
    const d = normalizePathData(p.d, IDENTITY, decimals);
    if (!d || d.length > VECTOR_LIMITS.pathChars) {
      dropped++;
      continue;
    }
    const out: VectorPath = { d };
    const fill = keep(pathField.fill, p.fill);
    const stroke = keep(pathField.stroke, p.stroke);
    const strokeWidth = keep(pathField.strokeWidth, p.strokeWidth);
    const fillRule = keep(pathField.fillRule, p.fillRule);
    const opacity = keep(pathField.opacity, p.opacity);
    const cap = keep(pathField.cap, p.cap);
    const join = keep(pathField.join, p.join);
    if (fill !== undefined) out.fill = fill;
    if (stroke !== undefined) out.stroke = stroke;
    if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
    if (fillRule !== undefined) out.fillRule = fillRule;
    if (opacity !== undefined) out.opacity = opacity;
    if (cap !== undefined) out.cap = cap;
    if (join !== undefined) out.join = join;
    const fg = p.fillGradient !== undefined ? index.get(p.fillGradient) : undefined;
    const sg = p.strokeGradient !== undefined ? index.get(p.strokeGradient) : undefined;
    if (fg !== undefined && out.fill !== "none") out.fillGradient = fg;
    if (sg !== undefined && out.stroke !== undefined && out.stroke !== "none")
      out.strokeGradient = sg;
    paths.push(out);
  }
  if (paths.length === 0) throw new Error("The edit came back with nothing drawable.");

  const vector: VectorData = {
    viewBox,
    paths: paths.slice(0, VECTOR_LIMITS.paths),
    ...(gradients.length ? { gradients } : {}),
    source: {
      generator: source.generator,
      prompt: request.instruction.trim().slice(0, 1_000),
      ...(source.model ? { model: source.model.slice(0, 100) } : {}),
    },
  };
  const checked = vectorDataSchema.safeParse(vector);
  if (!checked.success) throw new Error("The edit didn't make a valid vector.");
  const summary =
    draft.summary.replace(/\s+/g, " ").trim().slice(0, VECTOR_EDIT_LIMITS.summary) ||
    "Edited the vector.";
  return { vector: checked.data as VectorData, summary, dropped };
}

const NAMED: Record<string, string> = {
  red: "#e5484d",
  orange: "#f76b15",
  yellow: "#ffc53d",
  green: "#30a46c",
  teal: "#12a594",
  blue: "#0090ff",
  purple: "#8e4ec6",
  pink: "#d6409f",
  black: "#1a1a1a",
  white: "#ffffff",
  grey: "#8b8d98",
  gray: "#8b8d98",
};

/**
 * The offline editor (MockProvider): a handful of edits read from keywords —
 * outline, one colour, two colours or flat, a named colour, bolder or finer
 * strokes — so "edit with AI" works end to end with no key. It says in its
 * summary that it is the offline editor and what it did.
 */
export function mockVectorEdit(request: VectorEditRequest): VectorEditDraft {
  const text = request.instruction.toLowerCase();
  let v: VectorData = request.vector;
  const did: string[] = [];
  const [, , w, h] = v.viewBox;

  if (/\boutlines?\b|line[- ]?art|no fills?|strokes? only/.test(text)) {
    const sw = Math.round((Math.max(w, h) / 24) * 1.5 * 100) / 100;
    v = flattenGradients(v);
    v = {
      ...v,
      paths: v.paths.map((p) => ({
        d: p.d,
        fill: "none",
        stroke: p.fill && p.fill !== "none" ? p.fill : (p.stroke ?? "currentColor"),
        strokeWidth: p.strokeWidth ?? sw,
        cap: "round" as const,
        join: "round" as const,
      })),
    };
    did.push("turned it into outlines");
  }
  if (/\bmono(chrome)?\b|\b(one|single) colou?r\b|black and white/.test(text)) {
    v = flattenGradients(v);
    v = {
      ...v,
      paths: v.paths.map((p) => {
        const q: VectorPath = { ...p };
        if (q.fill !== "none") delete q.fill;
        if (q.stroke && q.stroke !== "none") q.stroke = "currentColor";
        return q;
      }),
    };
    did.push("made it one colour, the shape's ink");
  } else if (/\btwo colou?rs?\b|\bflat\b/.test(text)) {
    v = flattenGradients(v);
    const [a, b, ...rest] = vectorPalette(v);
    for (const c of rest) if (a) v = recolorVector(v, c, a);
    did.push(b ? "flattened it to two colours" : "flattened it");
  }
  const named = /\b(red|orange|yellow|green|teal|blue|purple|pink|black|white|gr[ae]y)\b/.exec(
    text,
  );
  if (named) {
    const main = vectorPalette(v).find((c) => c !== "currentColor") ?? "currentColor";
    v = recolorVector(v, main, NAMED[named[1]!]!);
    did.push(`made the main colour ${named[1]}`);
  }
  if (/\b(bold|bolder|thick|thicker|heavier)\b/.test(text)) {
    v = scaleVectorStrokes(v, 1.5);
    did.push("made the strokes bolder");
  } else if (/\b(thin|thinner|finer|lighter)\b/.test(text)) {
    v = scaleVectorStrokes(v, 0.66);
    did.push("made the strokes finer");
  }
  if (did.length === 0) {
    const [a, b] = vectorPalette(v);
    if (a && b) {
      const swap = (c: string) => (c === a ? b : c === b ? a : c);
      v = {
        ...v,
        paths: v.paths.map((p) => {
          const q: VectorPath = { ...p };
          const fill = swap(p.fill ?? "currentColor");
          if (fill === "currentColor") delete q.fill;
          else q.fill = fill;
          if (p.stroke) q.stroke = swap(p.stroke);
          return q;
        }),
        ...(v.gradients
          ? {
              gradients: v.gradients.map((g) => ({
                ...g,
                stops: g.stops.map((s) => ({ ...s, color: swap(s.color) })),
              })),
            }
          : {}),
      };
      did.push("swapped its two main colours");
    } else {
      did.push("left it as it was");
    }
  }
  return {
    summary: `Offline editor: ${did.join(", ")}.`,
    viewBox: [...v.viewBox],
    paths: v.paths,
    ...(v.gradients ? { gradients: v.gradients } : {}),
  };
}
