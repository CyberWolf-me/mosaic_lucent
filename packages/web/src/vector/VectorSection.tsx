import { useState } from "react";
import {
  flattenGradients,
  recolorVector,
  scaleVectorStrokes,
  simplifyVector,
  vectorPalette,
  vectorToSvg,
  type Operation,
  type Shape,
  type VectorData,
} from "@lucent/core";
import { nextZ } from "../shapes.js";
import { combineVectorOps, splitVectorOps, SPLIT_MAX } from "./ops.js";
import { openVectorsPanel } from "./VectorsPanel.js";

/**
 * The shape inspector's section for editable vectors (docs/26 §6.3): the
 * vector's own palette (click a colour, pick its replacement — every path
 * using it changes), the ink its unfilled parts take, stroke weight, and a
 * download of the vector as a standalone SVG. Every change is one
 * UPDATE_SHAPE carrying the new paths, so it is validated, shared and
 * undoable like any edit.
 *
 * And the structural edits (docs/26 §6.3): simplify (fewer points, same
 * drawing), flatten gradients to their solid colours, split one vector into
 * a vector per part, and combine several back into one — each one batch,
 * one undo.
 */

/** Replacement colours: the board palette as literals, plus the theme's ink. */
const REPLACEMENTS = [
  "currentColor",
  "#1a1a1a",
  "#ffffff",
  "oklch(0.48 0.22 260)",
  "oklch(0.62 0.18 250)",
  "oklch(0.62 0.22 25)",
  "oklch(0.65 0.18 145)",
  "oklch(0.75 0.18 75)",
  "oklch(0.62 0.22 300)",
  "oklch(0.90 0.11 92)",
  "oklch(0.86 0.08 235)",
  "oklch(0.87 0.09 145)",
];

const INKS = [
  "#1a1a1a",
  "#ffffff",
  "oklch(0.48 0.22 260)",
  "oklch(0.62 0.22 25)",
  "oklch(0.65 0.18 145)",
];

function swatchStyle(c: string, ink: string): React.CSSProperties {
  return c === "currentColor"
    ? {
        background: ink,
        backgroundImage:
          "linear-gradient(135deg, transparent 46%, var(--canvas-0) 46% 54%, transparent 54%)",
      }
    : { background: c };
}

export function VectorSection({
  shapes,
  allShapes,
  onApply,
  onSelect,
}: {
  shapes: Shape[];
  /** Every shape on the board, for stacking split parts on top. */
  allShapes?: Shape[];
  onApply: (ops: Operation[], label: string) => boolean | void;
  onSelect?: (ids: Set<string>) => void;
}) {
  const vectors = shapes.filter((s): s is Shape & { vector: VectorData } => Boolean(s.vector));
  const [from, setFrom] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (vectors.length === 0) return null;
  const locked = vectors.some((s) => s.locked);

  const palette = [...new Set(vectors.flatMap((s) => vectorPalette(s.vector)))].slice(0, 12);
  const hasStrokes = vectors.some((s) =>
    s.vector.paths.some((p) => p.stroke && p.stroke !== "none"),
  );
  const ink = vectors[0]!.style?.color ?? "var(--ink-0)";

  const edit = (fn: (v: VectorData) => VectorData, label: string) =>
    onApply(
      vectors.map((s) => ({ op: "UPDATE_SHAPE" as const, id: s.id, vector: fn(s.vector) })),
      label,
    );

  const hasGradients = vectors.some((s) => (s.vector.gradients?.length ?? 0) > 0);
  const one = vectors.length === 1 ? vectors[0]! : null;
  const canSplit = one !== null && one.vector.paths.length > 1;

  const simplify = () => {
    let before = 0;
    let after = 0;
    const ops: Operation[] = [];
    for (const s of vectors) {
      const r = simplifyVector(s.vector);
      before += r.before;
      after += r.after;
      if (r.vector !== s.vector && r.after < r.before)
        ops.push({ op: "UPDATE_SHAPE", id: s.id, vector: r.vector });
    }
    if (ops.length === 0) {
      setNote("Already as simple as it gets.");
      return;
    }
    if (onApply(ops, "Simplify vector") !== false)
      setNote(`Simplified: ${before.toLocaleString()} → ${after.toLocaleString()} points.`);
  };

  const split = () => {
    if (!one) return;
    if (one.vector.paths.length > SPLIT_MAX) {
      setNote(`${one.vector.paths.length} parts is too many to split — simplify it first.`);
      return;
    }
    const r = splitVectorOps(one, nextZ(allShapes ?? shapes));
    if (!r) return;
    if (onApply(r.ops, "Split into parts") !== false) {
      setNote(null);
      onSelect?.(new Set(r.ids));
    }
  };

  const combine = () => {
    const r = combineVectorOps(vectors);
    if (!r) return;
    if ("error" in r) {
      setNote(r.error);
      return;
    }
    if (onApply(r.ops, "Combine vectors") !== false) {
      setNote(null);
      onSelect?.(new Set([r.id]));
    }
  };

  const download = () => {
    const s = vectors[0]!;
    const svg = vectorToSvg(
      s.vector,
      Math.round(s.size.width),
      Math.round(s.size.height),
      s.style?.color ?? "#1a1a1a",
    );
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.vector.source?.ref?.replace(/[^a-z0-9-]+/gi, "-") ?? "lucent-vector"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="insp-group vector-section">
      <span className="insp-cap">Vector colours</span>
      <div className="insp-swatches">
        {palette.map((c) => (
          <button
            key={c}
            className={`insp-swatch${from === c ? " is-picked" : ""}`}
            style={swatchStyle(c, ink)}
            onClick={() => setFrom((f) => (f === c ? null : c))}
            title={c === "currentColor" ? "Ink (follows the theme)" : c}
            aria-label={`Replace ${c === "currentColor" ? "ink" : c}`}
            aria-pressed={from === c}
          />
        ))}
      </div>
      {from && (
        <>
          <span className="insp-cap">Replace with</span>
          <div className="insp-swatches">
            {REPLACEMENTS.filter((c) => c !== from).map((c) => (
              <button
                key={c}
                className="insp-swatch"
                style={swatchStyle(c, ink)}
                onClick={() => {
                  edit((v) => recolorVector(v, from, c), "Recolour vector");
                  setFrom(null);
                }}
                title={c === "currentColor" ? "Ink (follows the theme)" : c}
                aria-label={`Use ${c === "currentColor" ? "ink" : c}`}
              />
            ))}
          </div>
        </>
      )}
      <span className="insp-cap">Ink</span>
      <div className="insp-swatches">
        {INKS.map((c) => (
          <button
            key={c}
            className="insp-swatch"
            style={{ background: c }}
            onClick={() =>
              onApply(
                vectors.map((s) => ({
                  op: "UPDATE_SHAPE" as const,
                  id: s.id,
                  style: { color: c },
                })),
                "Vector ink",
              )
            }
            title="Colour of the parts drawn in ink"
            aria-label={`Ink ${c}`}
          />
        ))}
      </div>
      {(hasStrokes || one) && (
        <div className="segmented">
          {hasStrokes && (
            <>
              <button
                onClick={() => edit((v) => scaleVectorStrokes(v, 0.8), "Thinner strokes")}
                title="Thinner strokes"
              >
                Thinner
              </button>
              <button
                onClick={() => edit((v) => scaleVectorStrokes(v, 1.25), "Thicker strokes")}
                title="Thicker strokes"
              >
                Thicker
              </button>
            </>
          )}
          {vectors.length === 1 && vectors[0]!.vector.source?.prompt && (
            <button
              onClick={() => openVectorsPanel(vectors[0]!.vector.source!.prompt)}
              title="Generate variations from the same prompt"
            >
              More
            </button>
          )}
          {vectors.length === 1 && (
            <button onClick={download} title="Download this vector as an SVG file">
              SVG
            </button>
          )}
        </div>
      )}
      <div className="segmented" role="group" aria-label="Vector structure">
        <button
          onClick={simplify}
          disabled={locked}
          title="Fewer points, the same drawing — and tiny specks removed"
        >
          Simplify
        </button>
        {hasGradients && (
          <button
            onClick={() => edit(flattenGradients, "Flatten gradients")}
            disabled={locked}
            title="Replace each gradient with its solid colour"
          >
            Flat
          </button>
        )}
        {canSplit && (
          <button
            onClick={split}
            disabled={locked}
            title={`Make each of the ${one.vector.paths.length} parts its own shape`}
          >
            Split
          </button>
        )}
        {vectors.length > 1 && (
          <button onClick={combine} disabled={locked} title="Join these vectors into one">
            Combine
          </button>
        )}
      </div>
      {note && (
        <span role="status" style={{ fontSize: 11, lineHeight: 1.35, color: "var(--ink-3)" }}>
          {note}
        </span>
      )}
    </div>
  );
}
