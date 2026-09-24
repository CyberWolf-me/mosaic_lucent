import { useEffect, useState } from "react";
import type { Operation, Shape } from "@lucent/core";
import { cloneShapeOp, shapeId, zOrderOps, type ZMove } from "../shapes.js";
import { VectorSection } from "../vector/VectorSection.js";
import { alignPositions, distributePositions, type AlignMode } from "../board/geometry.js";

/**
 * Floating inspector for the current shape selection (docs/13 Tier 2). Edits
 * fill/stroke color, brings shapes forward/back (z-order), and duplicates —
 * each as an UPDATE_SHAPE / CREATE_SHAPE operation so it persists and undoes.
 */

// Literal colours only: a fill is board DATA, so it must pass the schema's
// colour grammar and render the same in an export and for every collaborator.
// These used to include var(--canvas-2), var(--ink-0) and the --sig-* tokens,
// which the schema refuses, so those swatches silently did nothing
// (docs/26 F7). The literals are the tokens' light-theme values.
const FILLS = [
  "oklch(0.90 0.11 92)",
  "oklch(0.86 0.08 235)",
  "oklch(0.86 0.10 10)",
  "oklch(0.87 0.09 145)",
  "oklch(0.945 0.024 84)", // paper
];

const STROKES = [
  "oklch(0.20 0.030 45)", // ink
  "oklch(0.48 0.22 260)", // bloom
  "oklch(0.72 0.11 235)",
  "oklch(0.78 0.11 155)",
  "oklch(0.72 0.15 25)",
];

const TEXT_COLORS = [
  "#1a1a1a",
  "#ffffff",
  "oklch(0.72 0.11 235)",
  "oklch(0.72 0.15 25)",
  "oklch(0.78 0.11 155)",
];

export const Z_MOVE_LABEL: Record<ZMove, string> = {
  front: "Bring to front",
  forward: "Bring forward",
  backward: "Send backward",
  back: "Send to back",
};

/**
 * A compact number field that commits on Enter or blur, reverts on Escape,
 * and follows the board when someone else changes the value meanwhile.
 */
function NumField({
  label,
  title,
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  title?: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const shown = Math.round(value * 100) / 100;
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);
  const commit = () => {
    const n = Number.parseFloat(draft);
    if (!Number.isFinite(n)) return setDraft(String(shown));
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (clamped !== shown) onCommit(clamped);
    else setDraft(String(shown));
  };
  return (
    <label className="insp-num" title={title ?? label}>
      <span aria-hidden>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        aria-label={title ?? label}
        value={draft}
        step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(String(shown));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <i aria-hidden>{suffix}</i>}
    </label>
  );
}

export type StructureAction = "themes" | "flowchart" | "mindmap" | "matrix";

export function ShapeInspector({
  shapes,
  selectedIds,
  onApply,
  onSelect,
  onStructure,
  structuring = false,
}: {
  shapes: Record<string, Shape>;
  selectedIds: Set<string>;
  onApply: (ops: Operation[], label: string) => void;
  onSelect: (ids: Set<string>) => void;
  /** docs/27 D2: turn the selected stickies into structure (always a proposal). */
  onStructure?: (action: StructureAction) => void;
  /** A structure request is in flight. */
  structuring?: boolean;
}) {
  const ids = [...selectedIds].filter((id) => shapes[id]);
  if (ids.length === 0) return null;
  const stickyCount = ids.filter((id) => {
    const s = shapes[id]!;
    return s.kind === "sticky" && !s.locked && !s.hidden && s.text?.trim();
  }).length;

  const setFill = (fill: string) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { fill } })),
      "Recolor shape",
    );

  const setStroke = (stroke: string) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { stroke } })),
      "Restyle stroke",
    );

  const order = (move: ZMove) => {
    const ops = zOrderOps(shapes, ids, move);
    if (ops.length) onApply(ops, Z_MOVE_LABEL[move]);
  };

  // Numeric geometry (docs/26 §6.4): one shape at a time, committed on Enter
  // or blur — never per keystroke, so a typed "120" is one undo step.
  const one = ids.length === 1 ? shapes[ids[0]!]! : null;
  const setGeometry = (patch: { x?: number; y?: number; w?: number; h?: number; r?: number }) => {
    if (!one) return;
    onApply(
      [
        {
          op: "UPDATE_SHAPE",
          id: one.id,
          ...(patch.x !== undefined || patch.y !== undefined
            ? { position: { x: patch.x ?? one.position.x, y: patch.y ?? one.position.y } }
            : {}),
          ...(patch.w !== undefined || patch.h !== undefined
            ? { size: { width: patch.w ?? one.size.width, height: patch.h ?? one.size.height } }
            : {}),
          ...(patch.r !== undefined ? { rotation: patch.r } : {}),
        },
      ],
      patch.r !== undefined ? "Rotate shape" : patch.w !== undefined || patch.h !== undefined ? "Resize shape" : "Move shape",
    );
  };
  const opacityOf = (s: Shape) => Math.round((s.style?.opacity ?? 1) * 100);
  const setOpacity = (pct: number) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { opacity: pct / 100 } })),
      "Opacity",
    );
  const setStrokeWidth = (strokeWidth: number) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { strokeWidth } })),
      "Stroke width",
    );

  const duplicate = () => {
    const ops: Operation[] = [];
    const newIds = new Set<string>();
    for (const id of ids) {
      const s = shapes[id]!;
      const nid = shapeId();
      newIds.add(nid);
      ops.push(cloneShapeOp(s, nid, 24, (s.z ?? 0) + 1));
    }
    onApply(ops, `Duplicate ${ids.length} shape${ids.length > 1 ? "s" : ""}`);
    onSelect(newIds);
  };

  const setFontSize = (fontSize: number) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { fontSize } })),
      "Text size",
    );

  const toggleBold = () => {
    const anyBold = ids.some((id) => (shapes[id]?.style?.fontWeight ?? 400) >= 600);
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { fontWeight: anyBold ? 400 : 700 } })),
      "Bold text",
    );
  };

  const setAlign = (align: "left" | "center" | "right") =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { align } })),
      "Align text",
    );

  /** Text colour. The model and renderer already supported style.color; only the
   * control was missing, so text was stuck on the default ink. */
  const setColor = (color: string) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { color } })),
      "Text colour",
    );

  /** Corner radius — turns a rectangle into a rounded rectangle. */
  const setRadius = (radius: number) =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, style: { radius } })),
      "Corner radius",
    );

  const selectedShapes = ids.map((id) => shapes[id]!);
  const allVectors = selectedShapes.every((s) => s.kind === "vector");
  const anyLocked = selectedShapes.some((s) => s.locked);

  const toggleLock = () =>
    onApply(
      ids.map((id) => ({ op: "UPDATE_SHAPE", id, locked: !anyLocked })),
      anyLocked ? "Unlock" : "Lock",
    );

  const align = (mode: AlignMode) => {
    const pos = alignPositions(selectedShapes, mode);
    const ops = Object.entries(pos).map(([id, p]) => ({
      op: "UPDATE_SHAPE" as const,
      id,
      position: p,
    }));
    if (ops.length) onApply(ops, "Align shapes");
  };
  const distribute = (axis: "h" | "v") => {
    const pos = distributePositions(selectedShapes, axis);
    const ops = Object.entries(pos).map(([id, p]) => ({
      op: "UPDATE_SHAPE" as const,
      id,
      position: p,
    }));
    if (ops.length) onApply(ops, "Distribute shapes");
  };

  const anyGrouped = selectedShapes.some((s) => s.groupId);
  const groupShapes = () => {
    if (ids.length < 2) return;
    onApply(
      [{ op: "GROUP_SHAPES", groupId: `grp_${Date.now().toString(36)}`, ids }],
      "Group shapes",
    );
  };
  const ungroupShapes = () => {
    const gids = new Set(selectedShapes.map((s) => s.groupId).filter(Boolean) as string[]);
    if (gids.size === 0) return;
    onApply(
      [...gids].map((groupId) => ({ op: "UNGROUP_SHAPES" as const, groupId })),
      "Ungroup shapes",
    );
  };

  return (
    <div className="shape-inspector">
      <div className="insp-label">{ids.length > 1 ? `${ids.length} selected` : "Shape"}</div>
      <VectorSection shapes={selectedShapes} onApply={onApply} />
      {/* A vector's paint lives in its paths (VectorSection); the box styling
          below would only draw a background and border around it. */}
      {!allVectors && (
        <>
        <div className="insp-group">
          <span className="insp-cap">Fill</span>
          <div className="insp-swatches">
            {FILLS.map((c) => (
              <button
                key={c}
                className="insp-swatch"
                style={{ background: c }}
                onClick={() => setFill(c)}
                title="Fill"
                aria-label={`Fill ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="insp-group">
          <span className="insp-cap">Stroke</span>
          <div className="insp-swatches">
            {STROKES.map((c) => (
              <button
                key={c}
                className="insp-swatch"
                style={{ background: c }}
                onClick={() => setStroke(c)}
                title="Stroke"
                aria-label={`Stroke ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="insp-group">
          <span className="insp-cap">Text</span>
          <div className="segmented">
            <button onClick={toggleBold} style={{ fontWeight: 700 }} aria-label="Bold" title="Bold">
              B
            </button>
            <button onClick={() => setFontSize(12)} aria-label="Small text" title="Small">
              S
            </button>
            <button onClick={() => setFontSize(16)} aria-label="Medium text" title="Medium">
              M
            </button>
            <button onClick={() => setFontSize(22)} aria-label="Large text" title="Large">
              L
            </button>
          </div>
          <div className="segmented" style={{ marginTop: 6 }}>
            <button onClick={() => setAlign("left")} aria-label="Align left" title="Align left">
              ◧
            </button>
            <button onClick={() => setAlign("center")} aria-label="Align center" title="Align center">
              ▣
            </button>
            <button onClick={() => setAlign("right")} aria-label="Align right" title="Align right">
              ◨
            </button>
          </div>
          <div className="insp-swatches" style={{ marginTop: 6 }}>
            {TEXT_COLORS.map((c) => (
              <button
                key={c}
                className="insp-swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
                title="Text colour"
                aria-label={`Text colour ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="insp-group">
          <span className="insp-cap">Corners</span>
          <div className="segmented">
            <button onClick={() => setRadius(0)} title="Square corners">
              ▢
            </button>
            <button onClick={() => setRadius(8)} title="Rounded">
              ▣
            </button>
            <button onClick={() => setRadius(22)} title="Very rounded">
              ◍
            </button>
          </div>
        </div>
        </>
      )}
      {onStructure && stickyCount >= 3 && (
        <div className="insp-group">
          <span className="insp-cap">Structure {stickyCount} notes</span>
          <button
            className="insp-structure primary"
            onClick={() => onStructure("themes")}
            disabled={structuring}
            title="Group these notes into titled frames by theme — you review it before it lands"
          >
            {structuring ? "Working…" : "Sort into themes"}
          </button>
          <div className="segmented" style={{ marginTop: 6 }}>
            <button
              onClick={() => onStructure("flowchart")}
              disabled={structuring}
              title="Make these notes a flowchart — proposed for review"
            >
              Flowchart
            </button>
            <button
              onClick={() => onStructure("mindmap")}
              disabled={structuring}
              title="Make these notes a mind map — proposed for review"
            >
              Mind map
            </button>
            <button
              onClick={() => onStructure("matrix")}
              disabled={structuring}
              title="Place these notes on a 2×2 matrix — proposed for review"
            >
              2×2
            </button>
          </div>
        </div>
      )}
      {ids.length > 1 && (
        <div className="insp-group">
          <span className="insp-cap">Align</span>
          <div className="segmented">
            <button onClick={() => align("left")} title="Align left">
              ⇤
            </button>
            <button onClick={() => align("hcenter")} title="Center horizontally">
              ⇔
            </button>
            <button onClick={() => align("right")} title="Align right">
              ⇥
            </button>
          </div>
          <div className="segmented" style={{ marginTop: 6 }}>
            <button onClick={() => align("top")} title="Align top">
              ⤒
            </button>
            <button onClick={() => align("vcenter")} title="Center vertically">
              ⇕
            </button>
            <button onClick={() => align("bottom")} title="Align bottom">
              ⤓
            </button>
          </div>
          {ids.length > 2 && (
            <div className="segmented" style={{ marginTop: 6 }}>
              <button onClick={() => distribute("h")} title="Distribute horizontally">
                ↔ Even
              </button>
              <button onClick={() => distribute("v")} title="Distribute vertically">
                ↕ Even
              </button>
            </div>
          )}
        </div>
      )}
      <div className="insp-group">
        <span className="insp-cap">{one ? "Position · size" : "Appearance"}</span>
        <div className="insp-fields">
          {one && (
            <>
              <NumField label="X" value={one.position.x} onCommit={(x) => setGeometry({ x })} />
              <NumField label="Y" value={one.position.y} onCommit={(y) => setGeometry({ y })} />
              <NumField label="W" value={one.size.width} min={4} onCommit={(w) => setGeometry({ w })} />
              <NumField label="H" value={one.size.height} min={4} onCommit={(h) => setGeometry({ h })} />
              <NumField
                label="↻"
                title="Rotation, degrees"
                value={one.rotation ?? 0}
                suffix="°"
                onCommit={(r) => setGeometry({ r: ((((r + 180) % 360) + 360) % 360) - 180 })}
              />
            </>
          )}
          <NumField
            label="α"
            title="Opacity, percent"
            value={opacityOf(selectedShapes[0]!)}
            min={5}
            max={100}
            suffix="%"
            onCommit={setOpacity}
          />
          {!allVectors && (
            <NumField
              label="—"
              title="Stroke width"
              value={selectedShapes[0]!.style?.strokeWidth ?? 1.5}
              min={0}
              max={24}
              step={0.5}
              onCommit={setStrokeWidth}
            />
          )}
        </div>
      </div>
      <div className="insp-sep" />
      <div className="segmented insp-order" role="group" aria-label="Stacking order">
        <button onClick={() => order("back")} title="Send to back · ⇧⌘[">
          ⤓
        </button>
        <button onClick={() => order("backward")} title="Send backward · ⌘[">
          ↓
        </button>
        <button onClick={() => order("forward")} title="Bring forward · ⌘]">
          ↑
        </button>
        <button onClick={() => order("front")} title="Bring to front · ⇧⌘]">
          ⤒
        </button>
      </div>
      <button className="insp-btn" onClick={duplicate}>
        Duplicate
      </button>
      {ids.length > 1 && !anyGrouped && (
        <button className="insp-btn" onClick={groupShapes}>
          Group
        </button>
      )}
      {anyGrouped && (
        <button className="insp-btn" onClick={ungroupShapes}>
          Ungroup
        </button>
      )}
      <button className="insp-btn" onClick={toggleLock}>
        {anyLocked ? "Unlock" : "Lock"}
      </button>
    </div>
  );
}
