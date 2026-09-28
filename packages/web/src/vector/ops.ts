import {
  combineVectors,
  importSvg,
  normalizePathData,
  sketchToVector,
  splitVector,
  vectorDataSchema,
  type Operation,
  type Shape,
  type VectorData,
} from "@lucent/core";
import type { IconGlyph } from "../icons/registry.js";
import { normalizeZ, shapeId, Z_MAX } from "../shapes.js";

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

/** Past this many parts a split would bury the board; simplify first. */
export const SPLIT_MAX = 200;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One vector → a vector per path, each where it was drawn (docs/26 §6.3
 * "split into parts, each selectable"), as one undoable batch. The parts
 * keep the shape's rotation (each turned about the whole's centre), ink and
 * group, and stack in paint order above `topZ`.
 */
export function splitVectorOps(
  shape: Shape,
  topZ: number,
): { ops: Operation[]; ids: string[] } | null {
  const v = shape.vector;
  if (!v || v.paths.length < 2 || v.paths.length > SPLIT_MAX) return null;
  const parts = splitVector(v);
  if (parts.length < 2) return null;
  const [vx, vy, vw, vh] = v.viewBox;
  const { width: W, height: H } = shape.size;
  const k = Math.min(W / vw, H / vh);
  const ox = (W - vw * k) / 2;
  const oy = (H - vh * k) / 2;
  const turn = ((shape.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const ids: string[] = [];
  const ops: Operation[] = [{ op: "DELETE_SHAPE", id: shape.id }];
  parts.forEach((part, i) => {
    const w = Math.max(0.5, r2(part.box.width * k));
    const h = Math.max(0.5, r2(part.box.height * k));
    // The part's centre, relative to the whole's centre, turned with it.
    const dx = ox + (part.box.x - vx) * k + w / 2 - W / 2;
    const dy = oy + (part.box.y - vy) * k + h / 2 - H / 2;
    const cx = shape.position.x + W / 2 + dx * cos - dy * sin;
    const cy = shape.position.y + H / 2 + dx * sin + dy * cos;
    const id = `${shapeId()}_${i}`;
    ids.push(id);
    ops.push({
      op: "CREATE_SHAPE",
      id,
      kind: "vector",
      position: { x: r2(cx - w / 2), y: r2(cy - h / 2) },
      size: { width: w, height: h },
      ...(shape.rotation ? { rotation: shape.rotation } : {}),
      vector: part.vector,
      ...(shape.style ? { style: shape.style } : {}),
      ...(shape.groupId ? { groupId: shape.groupId } : {}),
      z: Math.min(normalizeZ(topZ) + i, Z_MAX),
    });
  });
  return { ops, ids };
}

/**
 * Several vectors → one (split's inverse), in paint order, at the top one's
 * z. Rotated vectors are refused: their boxes don't map onto one upright
 * viewBox without redrawing every path.
 */
export function combineVectorOps(
  shapes: Shape[],
): { ops: Operation[]; id: string } | { error: string } | null {
  const vs = shapes
    .filter((s): s is Shape & { vector: VectorData } => Boolean(s.vector))
    .sort((a, b) => normalizeZ(a.z) - normalizeZ(b.z));
  if (vs.length < 2) return null;
  if (vs.some((s) => s.rotation))
    return { error: "Straighten the turned parts before combining them." };
  const first = vs[0]!;
  const r = combineVectors(
    vs.map((s) => ({
      vector: s.vector,
      x: s.position.x,
      y: s.position.y,
      width: s.size.width,
      height: s.size.height,
      ...(s.style?.color ? { ink: s.style.color } : {}),
    })),
    first.style?.color,
  );
  if (!r) return { error: "Together they're too detailed for one vector." };
  const id = shapeId();
  return {
    id,
    ops: [
      ...vs.map((s) => ({ op: "DELETE_SHAPE" as const, id: s.id })),
      {
        op: "CREATE_SHAPE",
        id,
        kind: "vector",
        position: { x: r2(r.x), y: r2(r.y) },
        size: { width: r2(r.width), height: r2(r.height) },
        vector: r.vector,
        ...(first.style ? { style: first.style } : {}),
        z: normalizeZ(vs[vs.length - 1]!.z),
      },
    ],
  };
}
