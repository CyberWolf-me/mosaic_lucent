import * as z from "zod/v4";
import type { JsonSchema } from "@lucent/core";
import type { TokenUsage } from "./provider.js";

/**
 * Stickies → themes (docs/27 D2): the fifth thing a provider can be asked to
 * do. A workshop wall of sticky notes is sorted into titled themes — Miro's
 * most-used AI move, done Lucent's way:
 *
 * - The model decides only MEANING: which notes share a theme and what to
 *   call it, by index. It never sees an id it could misspell and never
 *   places anything — the client lays the themes out deterministically
 *   (LLMs are poor at space; docs/03).
 * - Every note lands exactly once. Out-of-range or repeated indices are
 *   dropped, and a note the model left out goes to "Other" — so a sort can
 *   rearrange a wall but never lose a note.
 * - The result is a proposal the person reviews, and one undo away after.
 */

export interface ThemesRequest {
  /** The notes' text, in the order the caller will map indices back. */
  items: Array<{ text: string }>;
  /** Optional steer from the person: "by customer segment", "pains vs gains". */
  hint?: string;
  /** Upper bound on themes (clamped to 2…THEME_LIMITS.themes). */
  maxThemes?: number;
}

/** What the model returns: themes of note indices. */
export interface ThemesDraft {
  themes: Array<{ title: string; items: number[] }>;
}

export interface ThemesResult extends ThemesDraft {
  model?: string;
  usage?: TokenUsage;
}

/** The finished sort: every note in exactly one theme. */
export interface Themes {
  themes: Array<{ title: string; items: number[] }>;
  /** "model" when a provider sorted them, "fallback" for the offline sorter. */
  by: "model" | "fallback";
  model?: string;
}

export const THEME_LIMITS = { items: 200, itemChars: 280, themes: 12, title: 48 } as const;
export const OTHER_THEME = "Other";

export const THEMES_TOOL_NAME = "sort_into_themes";
export const THEMES_TOOL_DESCRIPTION =
  "Sort the sticky notes into themes: each theme has a short title and the indices of the notes that belong to it. Every note in exactly one theme.";

const themesArgsSchema = z.object({
  themes: z
    .array(
      z.object({
        title: z
          .string()
          .min(1)
          .max(60)
          .describe("A short, specific theme title (2–4 words) in the notes' own language."),
        items: z
          .array(z.number().int().min(0))
          .max(THEME_LIMITS.items)
          .describe("Indices of the notes in this theme."),
      }),
    )
    .max(THEME_LIMITS.themes),
});

export const themesArgumentsSchema = themesArgsSchema;

export function themesToolParametersJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(themesArgsSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export function anthropicThemesToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  return {
    name: THEMES_TOOL_NAME,
    description: THEMES_TOOL_DESCRIPTION,
    input_schema: themesToolParametersJsonSchema(),
  };
}

export function openAiThemesToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  return {
    type: "function",
    function: {
      name: THEMES_TOOL_NAME,
      description: THEMES_TOOL_DESCRIPTION,
      parameters: themesToolParametersJsonSchema(),
    },
  };
}

/** Parse tool arguments (object or JSON text) or a prose reply's JSON object. */
export function parseThemesDraft(raw: string | object): ThemesDraft {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end < start) throw new Error("No JSON object found in model response");
    try {
      value = JSON.parse(raw.slice(start, end + 1));
    } catch (err) {
      throw new Error(`Model response was not valid JSON: ${(err as Error).message}`);
    }
  }
  const parsed = themesArgsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Themes did not match the schema: ${parsed.error.message}`);
  return parsed.data;
}

export function themeCap(request: ThemesRequest): number {
  return Math.min(THEME_LIMITS.themes, Math.max(2, Math.floor(request.maxThemes ?? 8)));
}

/**
 * The finished sort, from a draft. Each note at most once (the first theme to
 * claim it keeps it), indices in range and non-empty, titles trimmed and
 * merged when they repeat, empty themes dropped, themes past the cap folded
 * into "Other" — and every note the draft left out lands in "Other" too.
 */
export function assembleThemes(
  request: ThemesRequest,
  draft: ThemesDraft,
  by: Themes["by"],
  model?: string,
): Themes {
  const count = request.items.length;
  const cap = themeCap(request);
  const placed = new Set<number>();
  const themes: Themes["themes"] = [];
  const other: number[] = [];
  for (const t of draft.themes) {
    const title = t.title.replace(/\s+/g, " ").trim().slice(0, THEME_LIMITS.title) || OTHER_THEME;
    const items: number[] = [];
    for (const i of t.items) {
      if (i >= count || placed.has(i) || !request.items[i]!.text.trim()) continue;
      placed.add(i);
      items.push(i);
    }
    if (items.length === 0) continue;
    if (title.toLowerCase() === OTHER_THEME.toLowerCase()) {
      other.push(...items);
      continue;
    }
    const same = themes.find((x) => x.title.toLowerCase() === title.toLowerCase());
    if (same) same.items.push(...items);
    else themes.push({ title, items });
  }
  // Past the cap, a theme's notes go to Other rather than vanish.
  const kept = themes.slice(0, cap - 1);
  for (const t of themes.slice(cap - 1)) other.push(...t.items);
  for (let i = 0; i < count; i++) {
    if (!placed.has(i) && request.items[i]!.text.trim()) other.push(i);
  }
  if (other.length) kept.push({ title: OTHER_THEME, items: other.sort((a, b) => a - b) });
  return { themes: kept, by, ...(model ? { model } : {}) };
}

// ---------------------------------------------------------------------------
// The offline sorter
// ---------------------------------------------------------------------------

const STOP = new Set(
  (
    "the a an and or but of to in on for with at by from as is are was were be been being it its this " +
    "that these those we our us you your they their them i me my he she his her not no yes do does did " +
    "have has had can could should would will shall may might must need needs want wants make makes more " +
    "less very really also just like get gets got use uses using one two new all any some so than then " +
    "there here what when where who why how which into out up down over about too only still even much " +
    "many most lot lots thing things way ways good bad better best"
  ).split(" "),
);

/** Content words, lowercased, light plural folding. */
function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return [...out];
}

/**
 * Sorting without a model (none configured, the board's AI boundary refuses,
 * or the model failed): repeatedly take the word shared by the most unsorted
 * notes and make it a theme. Plain, deterministic, and honest about being
 * keywords — the UI says so.
 */
export function fallbackThemes(request: ThemesRequest): ThemesDraft {
  const cap = themeCap(request);
  const bags = request.items.map((it) => terms(it.text));
  const left = new Set(request.items.map((_, i) => i).filter((i) => bags[i]!.length > 0));
  const themes: ThemesDraft["themes"] = [];
  while (themes.length < cap - 1 && left.size > 1) {
    const df = new Map<string, number[]>();
    for (const i of left) for (const t of bags[i]!) df.set(t, [...(df.get(t) ?? []), i]);
    let best: [string, number[]] | null = null;
    for (const entry of df) {
      if (entry[1].length < 2) continue;
      if (!best || entry[1].length > best[1].length) best = entry;
    }
    if (!best) break;
    const [word, items] = best;
    themes.push({ title: word.charAt(0).toUpperCase() + word.slice(1), items });
    items.forEach((i) => left.delete(i));
  }
  return { themes };
}
