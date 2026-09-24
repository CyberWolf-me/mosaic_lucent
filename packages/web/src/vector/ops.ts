import {
  importSvg,
  normalizePathData,
  sketchToVector,
  vectorDataSchema,
  type Operation,
  type Shape,
  type VectorData,
} from "@lucent/core";
import type { IconGlyph } from "../icons/registry.js";
import { normalizeZ, shapeId } from "../shapes.js";

/**
 * The ways a vector gets onto the board (docs/26 §6.3, V2), as operations:
 * a pasted or dropped SVG file, a registry icon, a traced image, and pen
 * sketches. Each produces one `vector` shape through the same schema.
 */

type CreateShape = Extract<Operation, { op: "CREATE_SHAPE" }>;

/** Fit a natural size into a longest side of `max`, never below 16px. */
export function fitSize(
  width: number,
  height: number,
  max = 240,
): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(16, Math.round(width * k)),
    height: Math.max(16, Math.round(height * k)),
  };
}

export function vectorShapeOp(
  vector: VectorData,
  at: { x: number; y: number },
  size: { width: number; height: number },
  z: number,
): CreateShape {
  return {
    op: "CREATE_SHAPE",
    id: shapeId(),
    kind: "vector",
    position: { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) },
    size,
    vector,
    z: normalizeZ(z),
  };
}

/**
 * SVG text → one editable vector shape centred on `at`, or the importer's
 * reason it couldn't be (the caller can fall back to an image).
 */
export function svgToVectorOp(
  svg: string,
  at: { x: number; y: number },
  z: number,
): { ok: true; op: CreateShape; dropped: string[] } | { ok: false; error: string } {
  const r = importSvg(svg, { generator: "import" });
  if (!r.ok) return r;
  return {
    ok: true,
    op: vectorShapeOp(r.vector, at, fitSize(r.width, r.height, 320), z),
    dropped: r.dropped,
  };
}

/**
 * A registry icon as an editable vector: Iconoir outlines keep their 1.5
 * stroke in the shape's ink; a brand mark keeps its own colour.
 */
export function vectorFromGlyph(glyph: IconGlyph): VectorData | null {
  const paths = glyph.parts
    .map((part) => {
      const raw = typeof part === "string" ? part : part[1];
      const d = normalizePathData(raw);
      if (!d) return null;
      if (typeof part === "string") {
        return {
          d,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          cap: "round" as const,
          join: "round" as const,
        };
      }
      const mode = part[0];
      return {
        d,
        ...(glyph.set === "simple" && glyph.hex ? { fill: `#${glyph.hex.toLowerCase()}` } : {}),
        ...(mode.startsWith("b") ? { stroke: "currentColor", strokeWidth: 1.5 } : {}),
        ...(mode.includes("e") ? { fillRule: "evenodd" as const } : {}),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  const vector = {
    viewBox: [0, 0, 24, 24] as [number, number, number, number],
    paths,
    source: { generator: "icon" as const, ref: glyph.ref },
  };
  return vectorDataSchema.safeParse(vector).success ? vector : null;
}

/** Selected pen strokes → one smooth vector, replacing them in one undoable batch. */
export function sketchToVectorOps(strokes: Shape[], z: number): Operation[] | null {
  const draws = strokes.filter((s) => s.kind === "draw" && s.path);
  if (draws.length === 0) return null;
  const r = sketchToVector(
    draws.map((s) => ({
      d: s.path!,
      x: s.position.x,
      y: s.position.y,
      ...(s.style?.stroke ? { stroke: s.style.stroke } : {}),
      ...(s.style?.strokeWidth !== undefined ? { strokeWidth: s.style.strokeWidth } : {}),
    })),
  );
  if (!r || !vectorDataSchema.safeParse(r.vector).success) return null;
  return [
    ...draws.map((s) => ({ op: "DELETE_SHAPE" as const, id: s.id })),
    {
      op: "CREATE_SHAPE",
      id: shapeId(),
      kind: "vector",
      position: { x: Math.round(r.x), y: Math.round(r.y) },
      size: { width: Math.round(r.width), height: Math.round(r.height) },
      vector: r.vector,
      z: normalizeZ(z),
    },
  ];
}

/** Swap a traced image for its vector, in place, as one undoable batch. */
export function replaceWithVectorOps(image: Shape, vector: VectorData): Operation[] {
  return [
    { op: "DELETE_SHAPE", id: image.id },
    {
      op: "CREATE_SHAPE",
      id: shapeId(),
      kind: "vector",
      position: image.position,
      size: image.size,
      ...(image.rotation ? { rotation: image.rotation } : {}),
      vector,
      z: normalizeZ(image.z),
    },
  ];
}
