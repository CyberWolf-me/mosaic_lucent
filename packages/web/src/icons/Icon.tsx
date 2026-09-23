import { memo } from "react";
import { brandInk } from "./brandInk.js";
import { useIcon, type IconGlyph } from "./registry.js";

export { brandInk };

/**
 * Draws a registry glyph as React `<path>` elements — never markup, so the
 * path data is the only thing that reaches the DOM. Iconoir parts stroke in
 * `currentColor`; brand marks fill in it, so the caller's `color` decides.
 */
export function IconSvg({
  glyph,
  size = 16,
  strokeWidth = 1.6,
  title,
}: {
  glyph: IconGlyph;
  size?: number;
  strokeWidth?: number;
  /** Accessible name; omit for a decorative icon beside its own label. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      focusable="false"
    >
      {glyph.parts.map((part, i) =>
        typeof part === "string" ? (
          <path
            key={i}
            d={part}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            key={i}
            d={part[1]}
            fill="currentColor"
            stroke={part[0].startsWith("b") ? "currentColor" : "none"}
            strokeWidth={strokeWidth}
            {...(part[0].includes("e") ? { fillRule: "evenodd" as const } : {})}
          />
        ),
      )}
    </svg>
  );
}

/**
 * A node's icon: its chosen one, or — when it has none, or the registry
 * doesn't know the chosen one — the one its label earns. Renders nothing
 * while loading, so a card never flashes the wrong mark.
 */
export const NodeIcon = memo(function NodeIcon({
  icon,
  fallback,
  size = 14,
}: {
  icon?: string | undefined;
  fallback?: string | null | undefined;
  size?: number;
}) {
  const chosen = useIcon(icon);
  const derived = useIcon(chosen === null ? fallback : undefined);
  const glyph = chosen ?? (chosen === null ? derived : undefined);
  if (!glyph) return null;
  const ink = glyph.set === "simple" ? brandInk(glyph.hex) : undefined;
  return (
    <span className="node-icon" style={ink ? { color: ink } : undefined} title={glyph.title}>
      <IconSvg glyph={glyph} size={size} />
    </span>
  );
});
