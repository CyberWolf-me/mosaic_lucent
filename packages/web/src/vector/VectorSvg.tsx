import { memo } from "react";
import type { VectorData } from "@lucent/core";

/**
 * Draws a vector shape's structured paths (docs/26 §6.3) as React `<path>`
 * elements — never SVG text, so the only thing that reaches the DOM is path
 * data and literal paint the schema already checked. A path without a fill
 * takes `currentColor`: the shape's ink, so a monochrome icon follows the
 * theme and the inspector's text colour.
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
      {vector.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill ?? "currentColor"}
          {...(p.stroke
            ? {
                stroke: p.stroke,
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
