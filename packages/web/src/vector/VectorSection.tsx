import { useState, type FormEvent } from "react";
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
import { editVectorWithAi } from "./generate.js";
import { combineVectorOps, splitVectorOps, SPLIT_MAX } from "./ops.js";
import { VectorSvg } from "./VectorSvg.js";
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
 *
 * "Edit with AI" sends one vector and the person's words to the model and
 * shows before and after; nothing changes until they apply it (the approval
 * gate), and then it is one UPDATE_SHAPE like any edit.
 */

type AiEdit =
  | { id: string; phase: "ask"; text: string; error?: string }
  | { id: string; phase: "working"; text: string }
  | { id: string; phase: "preview"; text: string; vector: VectorData; summary: string };

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
  boardId = null,
  onApply,
  onSelect,
}: {
  shapes: Shape[];
  /** Every shape on the board, for stacking split parts on top. */
  allShapes?: Shape[];
  /** The shared board, whose AI policy an edit with AI answers to. */
  boardId?: string | null;
  onApply: (ops: Operation[], label: string) => boolean | void;
  onSelect?: (ids: Set<string>) => void;
}) {
  const vectors = shapes.filter((s): s is Shape & { vector: VectorData } => Boolean(s.vector));
  const [from, setFrom] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [aiEdit, setAiEdit] = useState<AiEdit | null>(null);
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

  // An edit with AI belongs to the vector it was started on.
  const ai = one && aiEdit?.id === one.id ? aiEdit : null;

  const askAi = async (e: FormEvent) => {
    e.preventDefault();
    if (!one || !ai || ai.phase !== "ask" || ai.text.trim().length < 2) return;
    const text = ai.text.trim();
    setAiEdit({ id: one.id, phase: "working", text });
    const r = await editVectorWithAi({ vector: one.vector, instruction: text, boardId });
    setAiEdit((cur) => {
      if (cur?.id !== one.id || cur.phase !== "working") return cur;
      return r.ok
        ? { id: one.id, phase: "preview", text, vector: r.vector, summary: r.summary }
        : { id: one.id, phase: "ask", text, error: r.error };
    });
  };

  const applyAi = () => {
    if (!one || !ai || ai.phase !== "preview") return;
    if (
      onApply([{ op: "UPDATE_SHAPE", id: one.id, vector: ai.vector }], "Edit vector with AI") !==
      false
    )
      setAiEdit(null);
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
      {one && !ai && (
        <button
          className="insp-structure"
          onClick={() => setAiEdit({ id: one.id, phase: "ask", text: "" })}
          disabled={locked}
          title="Describe a change and preview it before it's applied"
        >
          Edit with AI
        </button>
      )}
      {one && ai && ai.phase !== "preview" && (
        <form className="vector-ai" onSubmit={(e) => void askAi(e)}>
          <input
            aria-label="Describe the change"
            placeholder="“Flat, two colours”"
            value={ai.text}
            disabled={ai.phase === "working"}
            autoFocus
            maxLength={500}
            onChange={(e) => setAiEdit({ id: one.id, phase: "ask", text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setAiEdit(null);
            }}
          />
          <div className="vector-ai-row">
            <button
              type="submit"
              className="insp-structure"
              disabled={ai.phase === "working" || ai.text.trim().length < 2}
            >
              {ai.phase === "working" ? "Working…" : "Preview"}
            </button>
            <button type="button" onClick={() => setAiEdit(null)}>
              Cancel
            </button>
          </div>
          {ai.phase === "ask" && ai.error && (
            <span role="alert" className="vector-ai-error">
              {ai.error}
            </span>
          )}
        </form>
      )}
      {one && ai?.phase === "preview" && (
        <div className="vector-ai" role="group" aria-label="AI edit preview">
          <div className="vector-ai-compare" style={{ color: ink }}>
            <figure>
              <VectorSvg vector={one.vector} title="Before" />
              <figcaption>Before</figcaption>
            </figure>
            <figure>
              <VectorSvg vector={ai.vector} title="After" />
              <figcaption>After</figcaption>
            </figure>
          </div>
          <span role="status" className="vector-ai-summary">
            {ai.summary}
          </span>
          <div className="vector-ai-row">
            <button className="insp-structure" onClick={applyAi}>
              Apply
            </button>
            <button onClick={() => setAiEdit({ id: one.id, phase: "ask", text: ai.text })}>
              Change
            </button>
            <button onClick={() => setAiEdit(null)}>Discard</button>
          </div>
        </div>
      )}
      {note && (
        <span role="status" style={{ fontSize: 11, lineHeight: 1.35, color: "var(--ink-3)" }}>
          {note}
        </span>
      )}
    </div>
  );
}
