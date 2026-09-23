#!/usr/bin/env node
/**
 * Build the icon registry's data (docs/26 §6.2) from the pinned `iconoir` and
 * `simple-icons` devDependencies of @lucent/web:
 *
 *   npm run icons -w @lucent/web
 *
 * Output (packages/web/src/icons/data/, committed, reproducible):
 *   index.json          names + brand titles/colours, for search and resolving
 *   iconoir-<n>.json    { name: Stroke[] }          hash-bucketed (see bucketOf),
 *   simple-<n>.json     { slug: [d, hex, title, guidelines?] }  so a board loads only what it shows
 *   NOTICE.md           the upstream licences and the trademark note
 *
 * Every icon is reduced to plain path data here, at build time: the browser
 * renders `<path d>` elements from JSON and never parses or injects SVG markup.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages/web/src/icons/data");
const ICONOIR = join(ROOT, "node_modules/iconoir");
const SIMPLE = join(ROOT, "node_modules/simple-icons");

const version = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
/**
 * Hash buckets, not alphabetical shards: prefixes are wildly uneven (the "co"
 * brands alone are 160 KB), while FNV-1a buckets come out even — ~16 KB
 * gzipped per Iconoir bucket, ~31 KB per Simple Icons bucket. A board showing
 * a Postgres and a Stripe mark loads two small files, not the catalogue.
 * packages/web/src/icons/registry.ts computes the same hash; the registry test
 * pins that they agree.
 */
export const BUCKETS = { iconoir: 8, simple: 64 };
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const bucketOf = (set, name) => fnv1a(name) % BUCKETS[set];

/** Attributes of one start tag, as a plain object. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const num = (v) => Number.parseFloat(v ?? "0");

/** One drawable element → path data, or null for something we don't draw. */
function toPathData(name, a) {
  switch (name) {
    case "path":
      return a.d ?? null;
    case "rect": {
      const x = num(a.x),
        y = num(a.y),
        w = num(a.width),
        h = num(a.height);
      const r = Math.min(num(a.rx ?? a.ry), w / 2, h / 2);
      if (!r) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return (
        `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}` +
        `a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}` +
        `v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
      );
    }
    case "circle":
    case "ellipse": {
      const cx = num(a.cx),
        cy = num(a.cy);
      const rx = num(a.r ?? a.rx),
        ry = num(a.r ?? a.ry);
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
    }
    case "line":
      return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
    case "polyline":
    case "polygon": {
      const pts = (a.points ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return name === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/**
 * Iconoir "regular": 24×24 outlines, stroke 1.5, stroke="currentColor" per
 * element; a few elements also fill. Encoded per element as a bare string
 * (stroke only — the common case) or [mode, d] where mode is "f" (fill),
 * "b" (fill and stroke), plus "e" for an evenodd fill rule.
 */
function buildIconoir() {
  const dir = join(ICONOIR, "icons/regular");
  const shards = {};
  const names = [];
  let skipped = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".svg")) continue;
    const name = file.slice(0, -4);
    const svg = readFileSync(join(dir, file), "utf8").replace(/<defs>[\s\S]*?<\/defs>/g, "");
    // Three icons position parts with transform=; flattening transforms is
    // Vector Studio's importer's job (§6.3), not this generator's.
    if (svg.includes("transform=")) {
      skipped++;
      continue;
    }
    const parts = [];
    for (const m of svg.matchAll(/<(path|rect|circle|ellipse|line|polyline|polygon)\b([^>]*)>/g)) {
      const a = attrs(m[2]);
      const d = toPathData(m[1], a);
      if (!d) continue;
      const fills = a.fill === "currentColor";
      const strokes =
        a.stroke === "currentColor" || (!fills && a.fill !== "none" && a.stroke === undefined);
      const evenodd = a["fill-rule"] === "evenodd" ? "e" : "";
      if (fills && strokes) parts.push([`b${evenodd}`, d]);
      else if (fills) parts.push([`f${evenodd}`, d]);
      else parts.push(d);
    }
    if (parts.length === 0) {
      skipped++;
      continue;
    }
    (shards[bucketOf("iconoir", name)] ??= {})[name] = parts;
    names.push(name);
  }
  return { shards, names, skipped };
}

/** Simple Icons: one filled 24×24 path per brand, plus title/hex/aliases. */
function buildSimple() {
  const meta = JSON.parse(readFileSync(join(SIMPLE, "data/simple-icons.json"), "utf8"));
  const list = Array.isArray(meta) ? meta : meta.icons;
  const shards = {};
  const index = [];
  for (const icon of [...list].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const svg = readFileSync(join(SIMPLE, "icons", `${icon.slug}.svg`), "utf8");
    const d = /<path d="([^"]+)"/.exec(svg)?.[1];
    if (!d) continue;
    (shards[bucketOf("simple", icon.slug)] ??= {})[icon.slug] = icon.guidelines
      ? [d, icon.hex, icon.title, icon.guidelines]
      : [d, icon.hex, icon.title];
    const aka = icon.aliases?.aka ?? [];
    index.push(
      aka.length ? [icon.slug, icon.title, icon.hex, aka] : [icon.slug, icon.title, icon.hex],
    );
  }
  return { shards, index };
}

const iconoir = buildIconoir();
const simple = buildSimple();

// Clear the directory's contents rather than the directory, so a shell or
// editor sitting in it doesn't make the rebuild fail.
mkdirSync(OUT, { recursive: true });
for (const file of readdirSync(OUT)) rmSync(join(OUT, file), { force: true });
const write = (file, value) => writeFileSync(join(OUT, file), `${JSON.stringify(value)}\n`);

for (const [k, shard] of Object.entries(iconoir.shards)) write(`iconoir-${k}.json`, shard);
for (const [k, shard] of Object.entries(simple.shards)) write(`simple-${k}.json`, shard);
write("index.json", {
  iconoir: { version: version(ICONOIR), names: iconoir.names },
  simple: { version: version(SIMPLE), icons: simple.index },
});

writeFileSync(
  join(OUT, "NOTICE.md"),
  [
    "# Icon data notices",
    "",
    "Generated by `scripts/build-icons.mjs`; do not edit by hand.",
    "",
    `## Iconoir ${version(ICONOIR)} — MIT`,
    "",
    "The `iconoir-*.json` files are path data extracted from Iconoir (https://iconoir.com).",
    "",
    "```text",
    readFileSync(join(ICONOIR, "LICENSE"), "utf8").trim(),
    "```",
    "",
    `## Simple Icons ${version(SIMPLE)} — CC0-1.0`,
    "",
    "The `simple-*.json` files and the brand list in `index.json` come from Simple Icons",
    "(https://simpleicons.org), released under CC0-1.0.",
    "",
    "The logos themselves remain trademarks of their owners, and some carry their own",
    "licence. Lucent uses them only to identify the product a node names, never as",
    "Lucent branding. Each brand's guidelines link, where published, is kept next to",
    "its path and shown when the mark is chosen.",
    "",
    "```text",
    readFileSync(join(SIMPLE, "DISCLAIMER.md"), "utf8").trim(),
    "```",
    "",
  ].join("\n"),
);

console.log(
  `iconoir ${iconoir.names.length} (skipped ${iconoir.skipped}) · simple ${simple.index.length} → ${OUT}`,
);
