/**
 * Regenerate the golden ELK geometry hashes (doc 18 Phase 4 item 4).
 *
 * Usage: npx tsx scripts/regen-elk-goldens.ts
 *
 * The initial run pins elkjs 0.12.0's geometry. Later runs (an elkjs bump,
 * an adapter mapping change) rewrite the hashes — the regeneration commit's
 * message must then carry the before/after table, and ADR 0039 clause 4
 * (benchmark re-run as the bump's gate) applies before it merges.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ELK_LAYOUT_ENGINE } from "../packages/web/src/diagram/elk/elkLayoutEngine.js";
import { goldenElkWorkspaces } from "../packages/web/test/elkGoldenFixtures.js";

function geometryHash(out: {
  layout: Record<
    string,
    { position: { x: number; y: number }; size: { width: number; height: number } }
  >;
}): string {
  const parts = Object.keys(out.layout)
    .sort()
    .map((id) => {
      const e = out.layout[id]!;
      return `${id}@${e.position.x.toFixed(3)},${e.position.y.toFixed(3)}:${e.size.width}x${e.size.height}`;
    });
  let h = 0x811c9dc5;
  for (const s of parts.join("|")) {
    h ^= s.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const results: Record<string, string> = {};
for (const [name, build] of Object.entries(goldenElkWorkspaces)) {
  const out = await ELK_LAYOUT_ENGINE.layout({ workspace: build(), options: {} });
  results[name] = geometryHash(out);
  console.log(`${name}: ${results[name]} (${Object.keys(out.layout).length} nodes)`);
}

// Rewrite the hashes block in the fixtures module, in place.
const fixturesPath = fileURLToPath(
  new URL("../packages/web/test/elkGoldenFixtures.ts", import.meta.url),
);
let src = readFileSync(fixturesPath, "utf8");
const block = Object.entries(results)
  .map(([k, v]) => `  "${k}": "${v}",`)
  .join("\n");
src = src.replace(
  /export const goldenElkHashes: Record<string, string> = \{[^}]*\}/,
  `export const goldenElkHashes: Record<string, string> = {\n${block}\n}`,
);
writeFileSync(fixturesPath, src);
console.log(`\nWrote ${Object.keys(results).length} golden hashes to test/elkGoldenFixtures.ts`);
