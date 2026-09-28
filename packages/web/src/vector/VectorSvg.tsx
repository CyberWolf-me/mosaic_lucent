import { memo, useId } from "react";
import type { VectorData, VectorGradient } from "@lucent/core";

/**
 * Draws a vector shape's structured paths (docs/26 §6.3) as React `<path>`
 * elements — never SVG text, so the only thing that reaches the DOM is path
 * data and literal paint the schema already checked. A path without a fill
 * takes `currentColor`: the shape's ink, so a monochrome icon follows the
 * theme and the inspector's text colour. Gradients are React elements too,
 * with ids private to this drawing so two vectors never paint each other's.
 */
export const VectorSvg = memo(function VectorSvg({
  vector,
  className,
  title,
}: {
  vector: VectorData;
  className?: string;
  title?: string;
}) {
  const uid = `vg${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const gradients = vector.gradients ?? [];
  const ref = (i: number | undefined) =>
    i !== undefined && gradients[i] ? `url(#${uid}-${i})` : undefined;
  return (
    <svg
      className={className}
      viewBox={vector.viewBox.join(" ")}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      focusable="false"
      style={{ display: "block", overflow: "visible" }}
    >
      {gradients.length > 0 && (
        <defs>
          {gradients.map((g, i) => (
            <Gradient key={i} id={`${uid}-${i}`} g={g} />
          ))}
        </defs>
      )}
      {vector.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={ref(p.fillGradient) ?? p.fill ?? "currentColor"}
          {...(p.stroke
            ? {
                stroke: ref(p.strokeGradient) ?? p.stroke,
                strokeWidth: p.strokeWidth ?? 1,
                strokeLinecap: p.cap ?? "butt",
                strokeLinejoin: p.join ?? "miter",
              }
            : {})}
          {...(p.fillRule ? { fillRule: p.fillRule } : {})}
          {...(p.opacity !== undefined ? { opacity: p.opacity } : {})}
        />
      ))}
    </svg>
  );
});

function Gradient({ id, g }: { id: string; g: VectorGradient }) {
  const units = g.units === "user" ? "userSpaceOnUse" : "objectBoundingBox";
  const stops = g.stops.map((s, i) => (
    <stop
      key={i}
      offset={s.offset}
      stopColor={s.color}
      {...(s.opacity !== undefined ? { stopOpacity: s.opacity } : {})}
    />
  ));
  return g.kind === "linear" ? (
    <linearGradient id={id} gradientUnits={units} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
      {stops}
    </linearGradient>
  ) : (
    <radialGradient
      id={id}
      gradientUnits={units}
      cx={g.cx}
      cy={g.cy}
      r={g.r}
      {...(g.fx !== undefined ? { fx: g.fx } : {})}
      {...(g.fy !== undefined ? { fy: g.fy } : {})}
    >
      {stops}
    </radialGradient>
  );
}
