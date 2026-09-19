/**
 * Golden ELK geometry fixtures (doc 18 Phase 4 item 4): three representative
 * boards at a readable scale, generated once against elkjs 0.12.0 and pinned
 * by hash in elkGolden.test.ts.
 *
 * REGENERATION (a deliberate act — an elkjs bump is never silent):
 *   npx tsx scripts/regen-elk-goldens.ts
 * writes the new hashes to this file; the regeneration commit then carries
 * the before/after in its message, and ADR 0039's clause 4 gate (benchmark
 * re-run) applies before the bump merges.
 *
 * Representative shapes (per the Phase 2 comparison's families):
 *  - layered chain: the flowchart/architecture workhorse;
 *  - dense fan-in: the family ELK won by the widest margin;
 *  - compound: groups as ELK containers (the mapping the adapter must hold).
 */

import { createWorkspace, denseBoard, layeredBoard, type Workspace } from "@lucent/core";

export const goldenElkWorkspaces: Record<string, () => Workspace> = {
  "layered-40": () => layeredBoard(40),
  "dense-150": () => denseBoard(150),
};

/** Groups attached to the layered fixture so the compound mapping is pinned. */
export function compoundBoard(): Workspace {
  const ws = layeredBoard(24);
  // Re-home the board's nodes into two kinded regions — the compound path.
  const ids = Object.keys(ws.nodes);
  const half = Math.floor(ids.length / 2);
  ws.groups["region-alpha"] = {
    id: "region-alpha",
    label: "Alpha",
    children: ids.slice(0, half),
    kind: "flowchart",
  };
  ws.groups["region-beta"] = {
    id: "region-beta",
    label: "Beta",
    children: ids.slice(half),
    kind: "flowchart",
  };
  for (const [_i, id] of ids.slice(0, half).entries()) ws.nodes[id]!.groupId = "region-alpha";
  for (const id of ids.slice(half)) ws.nodes[id]!.groupId = "region-beta";
  return ws;
}
goldenElkWorkspaces["compound-24"] = compoundBoard;

/**
 * The pinned hashes (FNV-1a 32-bit over sorted node geometry). Generated
 * once; the test regenerates nothing — an elkjs bump that changes geometry
 * fails HERE, and the regeneration command is the only path forward.
 */
export const goldenElkHashes: Record<string, string> = {
  "layered-40": "e9026034",
  "dense-150": "d9d33149",
  "compound-24": "80fde347",
};

/** An empty workspace's fixtures stay importable for negative-path tests. */
export const emptyGolden = (): Workspace => createWorkspace({ id: "wk-empty-golden", name: "Empty" });
