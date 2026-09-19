/**
 * Phase 4 item 4 — version pinning + golden geometry (doc 18): a dependency
 * bump must NEVER silently rearrange existing boards. The goldens pin the
 * ELK adapter's geometry on three representative fixtures at a readable
 * scale; changing them requires regenerating deliberately (see the header
 * comment in the fixture module for the regeneration command).
 *
 * The goldens are a HASH, not inline coordinates: the pin answers "did the
 * geometry change," which is the question an upgrade must answer — exact
 * numbers live in git history via the regeneration commit, not in the test.
 */

import { describe, expect, it } from "vitest";
import { applyLayout, applyRoutes, denseBoard, layeredBoard } from "@lucent/core";
import { ELK_LAYOUT_ENGINE } from "../src/diagram/elk/elkLayoutEngine.js";
import { goldenElkHashes, goldenElkWorkspaces } from "./elkGoldenFixtures.js";

describe(
  "golden ELK geometry (doc 18 Phase 4 item 4: the pin is deliberate)",
  { timeout: 30000 },
  () => {
    for (const [name, hash] of Object.entries(goldenElkHashes)) {
      it(`${name}: geometry is byte-stable for the pinned elkjs (0.12.0)`, async () => {
        const ws = goldenElkWorkspaces[name]!();
        const out = await ELK_LAYOUT_ENGINE.layout({ workspace: ws, options: {} });
        expect(geometryHash(out)).toBe(hash);
      });
    }

    it("a changed geometry fails the pin — the guard detects a silent bump", async () => {
      // A mutation of the fixture's semantics (one extra node) must produce a
      // DIFFERENT hash, proving the pin is sensitive to geometry, not a
      // constant accidentally asserted against itself.
      const base = layeredBoard(24);
      const out = await ELK_LAYOUT_ENGINE.layout({ workspace: base, options: {} });
      const baseHash = geometryHash(out);
      const grown = layeredBoard(24);
      grown.nodes["extra-node"] = { id: "extra-node", nodeType: "step", label: "Extra" };
      grown.groups["g-0"]?.children.push("extra-node");
      const out2 = await ELK_LAYOUT_ENGINE.layout({ workspace: grown, options: {} });
      expect(geometryHash(out2)).not.toBe(baseHash);
    });

    it("elkjs is pinned exactly (no caret/tilde): a bump is a deliberate act", async () => {
      const pkg = (await import("../package.json", { with: { type: "json" } })).default as {
        dependencies: Record<string, string>;
      };
      expect(pkg.dependencies.elkjs).toBe("0.12.0");
    });

    it("dense fixtures hold zero overlaps at the golden scale (the quality floor)", async () => {
      const ws = denseBoard(150);
      const out = await ELK_LAYOUT_ENGINE.layout({ workspace: ws, options: {} });
      const { measureVisualMetrics } = await import("@lucent/core");
      const stamped = applyRoutes(applyLayout(ws, out.layout), out.routes);
      const metrics = measureVisualMetrics(stamped);
      expect(metrics.nodeOverlaps).toBe(0);
      expect(metrics.offscreenEntries).toBe(0);
    });
  },
);

/** Stable, order-independent geometry digest: position/size per node id. */
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
  // FNV-1a 32-bit: short, stable, and never typed by a human.
  let h = 0x811c9dc5;
  for (const s of parts.join("|")) {
    h ^= s.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
