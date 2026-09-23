import type { Node } from "@lucent/core";
import { autoIconFor } from "./auto.js";
import { brandInk } from "./brandInk.js";
import { peekIcon, type IconGlyph } from "./registry.js";

/**
 * Icons in the static SVG export (docs/26 §6.2, F10): the same glyph the card
 * shows, drawn as path elements from the loaded registry. Sync on purpose —
 * the export is sync — so callers warm the buckets first with
 * `preloadIcons(nodeIconRefs(...))`; an icon that isn't loaded is left out
 * rather than guessed.
 */

type IconNode = Pick<Node, "icon" | "label" | "nodeType">;

/** Every reference a set of nodes could show: chosen and automatic. */
export function nodeIconRefs(nodes: Iterable<IconNode>): string[] {
  const refs = new Set<string>();
  for (const n of nodes) {
    if (n.icon) refs.add(n.icon);
    const auto = autoIconFor(n.label, n.nodeType);
    if (auto) refs.add(auto);
  }
  return [...refs];
}

/** The glyph a node shows right now: chosen, else — if that's missing — automatic. */
export function nodeGlyphNow(node: IconNode): IconGlyph | null {
  const chosen = node.icon ? peekIcon(node.icon) : null;
  if (chosen) return chosen;
  // Still loading: leave it out rather than export the fallback by mistake.
  if (chosen === undefined) return null;
  const auto = autoIconFor(node.label, node.nodeType);
  return (auto && peekIcon(auto)) || null;
}

const attr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One glyph as an SVG group at (x, y), `size` px square. */
export function glyphSvg(
  glyph: IconGlyph,
  x: number,
  y: number,
  size: number,
  ink: string,
): string {
  const colour = (glyph.set === "simple" && brandInk(glyph.hex)) || ink;
  const paths = glyph.parts
    .map((part) =>
      typeof part === "string"
        ? `<path d="${attr(part)}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${attr(part[1])}" fill="currentColor"${part[0].startsWith("b") ? ` stroke="currentColor" stroke-width="1.6"` : ""}${part[0].includes("e") ? ` fill-rule="evenodd"` : ""}/>`,
    )
    .join("");
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" color="${attr(colour)}">${paths}</g>`;
}
