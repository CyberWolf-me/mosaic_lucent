import type { IconIndex, IconSet } from "./registry.js";

/**
 * Icon search over the registry index (docs/26 §6.2), for the picker. Pure,
 * so ranking is testable without a browser: an exact name beats a prefix,
 * a prefix beats a whole word inside a longer name, which beats a substring.
 * Brands match on slug, title and the aliases Simple Icons records.
 */

export interface IconHit {
  ref: string;
  set: IconSet;
  /** Display name: the brand's title, or the Iconoir name with spaces. */
  name: string;
}

/** Common concepts the picker offers before anything is typed. */
export const SUGGESTED_ICONS = [
  "iconoir:user",
  "iconoir:group",
  "iconoir:database",
  "iconoir:server",
  "iconoir:cloud",
  "iconoir:app-window",
  "iconoir:smartphone-device",
  "iconoir:code-brackets",
  "iconoir:network",
  "iconoir:lock",
  "iconoir:credit-card",
  "iconoir:mail",
  "iconoir:bell",
  "iconoir:data-transfer-both",
  "iconoir:search",
  "iconoir:graph-up",
  "iconoir:sparks",
  "iconoir:page",
  "iconoir:calendar",
  "iconoir:settings",
  "iconoir:warning-triangle",
  "iconoir:check-circle",
  "iconoir:light-bulb",
  "iconoir:rocket",
] as const;

function scoreText(text: string, q: string): number {
  if (!q) return 0;
  if (text === q) return 100;
  if (text.startsWith(q)) return 80;
  if (text.split(/[\s-]+/).includes(q)) return 70;
  if (text.includes(q)) return 45;
  return 0;
}

export function searchIcons(index: IconIndex, query: string, limit = 40): IconHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const kebab = q.replace(/\s+/g, "-");
  const compact = q.replace(/[^a-z0-9]/g, "");
  const scored: Array<IconHit & { score: number }> = [];

  for (const name of index.iconoir.names) {
    const score = Math.max(scoreText(name, kebab), scoreText(name.replace(/-/g, " "), q));
    if (score > 0)
      scored.push({ ref: `iconoir:${name}`, set: "iconoir", name: name.replace(/-/g, " "), score });
  }
  for (const [slug, title, , aka] of index.simple.icons) {
    const score = Math.max(
      scoreText(slug, compact),
      scoreText(title.toLowerCase(), q),
      ...(aka ?? []).map((a) => scoreText(a.toLowerCase(), q) - 5),
    );
    // A brand edges out a concept at the same score: someone typing "stripe"
    // wants the mark, not a striped pattern.
    if (score > 0)
      scored.push({ ref: `simple:${slug}`, set: "simple", name: title, score: score + 1 });
  }

  return scored
    .sort(
      (a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(({ ref, set, name }) => ({ ref, set, name }));
}
