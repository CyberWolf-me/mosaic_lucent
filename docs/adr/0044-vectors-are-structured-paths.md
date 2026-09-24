# 0044 — An editable vector is structured paths, and SVG enters through one door

- Status: Accepted
- Date: 2026-09-24

## Context

Vector Studio (docs/26 §6.3, V2) puts SVG artwork on the board as something
people edit, not a picture: a logo from a design tool, an icon, a traced photo,
a pen sketch, and — next (V3) — generated art from a vendor API or the model.
SVG is also a scripting surface: `<script>`, event handlers, `foreignObject`,
external references and entity tricks all live in the same format as the
paths people want. The board must never render hostile markup, whoever
produced it.

The old path (`svgToOps`) regex-scraped a few primitives into loose rects and
ellipses, ignored transforms, and let any attribute value through as a colour.

## Decision

**A new shape kind, `vector`, carries `vector: { viewBox, paths[], source? }`.**

- Each path is **normalized path data** — absolute `M L C Q Z` only, rounded
  numbers (grammar-checked, 60 KB per path, 400 KB and 2,000 paths per
  vector) — plus a closed set of paint fields: `fill` / `stroke` (the board's
  colour grammar, `none`, or `currentColor`), `strokeWidth`, `fillRule`,
  `opacity`, `cap`, `join`. An unset fill is the shape's ink, so monochrome
  art follows the theme and the inspector.
- `CREATE_SHAPE.vector` and `UPDATE_SHAPE.vector` (replace the paths): every
  edit is an ordinary validated, shared, undoable op. Only a vector shape may
  carry paths, and a vector shape must.
- **One importer, in core** (`importSvg`): a small XML reader with no DTDs or
  custom entities; an allowlist of drawable elements and containers (the rest
  is skipped with its whole subtree); styles resolved from attributes, inline
  style, simple stylesheet rules and inheritance; gradients reduced to a stop
  colour; `<use>` resolved for local references only; transforms flattened
  into the coordinates (arcs become cubics); output checked by the schema.
  It is used by paste, file drop, board import, the local tracer, and will be
  by the server for vendor output.
- The renderer draws React `<path>` elements from the data. Nothing is ever
  inserted into the DOM as SVG text.

Local ways in (V2): paste or drop an SVG; place a registry icon; trace an
image in a worker (imagetracerjs, public domain — pixels never leave the
browser, so it is allowed on restricted boards); smooth pen strokes into a
vector (Ramer–Douglas–Peucker, then Catmull-Rom curves).

## Consequences

- Gradients, clip paths, masks, filters, text and embedded images do not
  survive import; the user is told what was skipped. A file too detailed to
  edit (over the caps) is refused as a vector and pasted as an image instead.
- The stored-board schema drops a vector that no longer parses (the shape
  shows a placeholder) rather than refusing the board.
- V3's generators (Recraft, the model) add no new rendering path: their
  output goes through the same importer and lands as the same shape kind.
