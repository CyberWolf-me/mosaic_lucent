import type { Workspace } from "@lucent/core";
import { preloadAssetData } from "../assets.js";
import { nodeIconRefs } from "../icons/exportSvg.js";
import { preloadIcons } from "../icons/registry.js";

/**
 * Everything the synchronous SVG export needs fetched first: the icon buckets
 * its nodes show (culled cards never loaded theirs) and the bytes of stored
 * images (a static file can't fetch them later). Callers await this, then
 * call buildBoardSvg.
 */
export async function preloadExportData(ws: Workspace): Promise<void> {
  const imageRefs = Object.values(ws.shapes)
    .filter((s) => s.kind === "image" && !s.hidden && s.src)
    .map((s) => s.src!);
  await Promise.all([
    preloadIcons(nodeIconRefs(Object.values(ws.nodes))),
    preloadAssetData(imageRefs),
  ]);
}
