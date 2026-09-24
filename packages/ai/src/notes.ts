import * as z from "zod/v4";
import type { JsonSchema } from "@lucent/core";
import type { TokenUsage } from "./provider.js";

/**
 * Meeting notes, Granola's way (docs/27 N1): the fourth thing a provider can
 * be asked to do. During a meeting a person types terse notes; afterwards
 * the model ENHANCES them into a structured note.
 *
 * The contract that makes the note trustworthy:
 * - The person's own lines are never rewritten. The model only says which
 *   section each of their lines belongs in (by index); the server copies the
 *   text verbatim (`assembleNotes`).
 * - Every line the model adds cites the transcript turns it came from. A
 *   line without a valid citation is dropped — shown as the person's own or
 *   not at all (docs/27 §4).
 * - Sections come from the meeting-type template, not from the model.
 */

export type NoteTemplateId =
  | "general"
  | "one_on_one"
  | "standup"
  | "design_review"
  | "customer_call"
  | "retro";

export interface NoteTemplate {
  id: NoteTemplateId;
  name: string;
  /** Section titles, in order, each with what belongs there. */
  sections: Array<{ title: string; guide: string }>;
}

export const NOTE_TEMPLATES: Record<NoteTemplateId, NoteTemplate> = {
  general: {
    id: "general",
    name: "General",
    sections: [
      {
        title: "Summary",
        guide: "Two or three lines: what the meeting was for and where it landed.",
      },
      {
        title: "Decisions",
        guide: "What was decided or agreed, and anything explicitly rejected.",
      },
      { title: "Action items", guide: "Who does what, by when if said." },
      { title: "Open questions", guide: "What was raised and not answered." },
      { title: "Notes", guide: "Anything else worth keeping." },
    ],
  },
  one_on_one: {
    id: "one_on_one",
    name: "1:1",
    sections: [
      { title: "Updates", guide: "What each person shared about their work." },
      { title: "Blockers & support", guide: "What is in the way, and what help was offered." },
      { title: "Feedback", guide: "Feedback given in either direction." },
      { title: "Action items", guide: "Who does what, by when if said." },
    ],
  },
  standup: {
    id: "standup",
    name: "Standup",
    sections: [
      { title: "Done", guide: "What was finished since last time, by person." },
      { title: "Next", guide: "What each person is doing next." },
      { title: "Blockers", guide: "What is blocked, and on whom." },
    ],
  },
  design_review: {
    id: "design_review",
    name: "Design review",
    sections: [
      { title: "Proposal", guide: "What was presented, in a line or two." },
      { title: "Feedback", guide: "Concerns and suggestions, attributed." },
      { title: "Decisions", guide: "What was approved, changed or rejected." },
      { title: "Risks", guide: "Risks and unknowns raised." },
      { title: "Action items", guide: "Who does what, by when if said." },
    ],
  },
  customer_call: {
    id: "customer_call",
    name: "Customer call",
    sections: [
      { title: "Context", guide: "Who the customer is and why they are talking to us." },
      { title: "Needs & pain points", guide: "What they need, in their words." },
      { title: "Objections & questions", guide: "Concerns they raised." },
      { title: "Commitments", guide: "What we promised, and by when." },
      { title: "Next steps", guide: "Agreed follow-ups on both sides." },
    ],
  },
  retro: {
    id: "retro",
    name: "Retro",
    sections: [
      { title: "Went well", guide: "What worked." },
      { title: "To improve", guide: "What did not, and why." },
      { title: "Actions", guide: "Concrete changes, with owners." },
    ],
  },
};

export const NOTE_TEMPLATE_IDS = Object.keys(NOTE_TEMPLATES) as NoteTemplateId[];

export function isNoteTemplateId(v: unknown): v is NoteTemplateId {
  return typeof v === "string" && v in NOTE_TEMPLATES;
}

/** One line the person typed, stamped with the transcript turn count when typed. */
export interface NoteLine {
  text: string;
  /** Turns captured when the line was typed: the line refers to what came before it. */
  turn: number;
}

export interface NotesRequest {
  template: NoteTemplateId;
  title?: string;
  /** YYYY-MM-DD, so "Friday" can be resolved in action items. */
  today?: string;
  transcript: Array<{ speaker: string; text: string }>;
  notes: NoteLine[];
}

/** What the model returns: placement of the person's lines, and cited additions. */
export interface NotesDraft {
  sections: Array<{
    title: string;
    /** Indices into the person's notes that belong in this section. */
    userLines: number[];
    items: Array<{ text: string; turns: [number, number] }>;
  }>;
}

export interface NotesResult extends NotesDraft {
  model?: string;
  usage?: TokenUsage;
}

/** One line of the finished note. */
export interface NoteItem {
  text: string;
  source: "user" | "ai";
  /** AI lines: the transcript turns it came from (inclusive). */
  turns?: [number, number];
  /** User lines: which of their raw lines this is. */
  line?: number;
}

export interface EnhancedNote {
  template: NoteTemplateId;
  sections: Array<{ title: string; items: NoteItem[] }>;
  generatedAt: number;
  /** "model" when a provider wrote it, "fallback" for the offline enhancer. */
  by: "model" | "fallback";
  model?: string;
}

export const NOTES_TOOL_NAME = "write_meeting_notes";
export const NOTES_TOOL_DESCRIPTION =
  "Return the enhanced meeting note: for each template section, which of the person's own note lines belong there (by index) and the lines you add, each citing the transcript turns it came from.";

const notesArgsSchema = z.object({
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(80).describe("A section title from the template, exactly."),
        userLines: z
          .array(z.number().int().min(0))
          .max(200)
          .describe(
            "Indices of the person's own lines that belong in this section. Each index at most once.",
          ),
        items: z
          .array(
            z.object({
              text: z
                .string()
                .min(1)
                .max(400)
                .describe("One concise line you add, grounded in the transcript. No preamble."),
              turns: z
                .tuple([z.number().int().min(0), z.number().int().min(0)])
                .describe(
                  "First and last transcript turn index this line is based on (inclusive).",
                ),
            }),
          )
          .max(20),
      }),
    )
    .max(12),
});

export const notesArgumentsSchema = notesArgsSchema;

export function notesToolParametersJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(notesArgsSchema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export function anthropicNotesToolDefinition(): {
  name: string;
  description: string;
  input_schema: JsonSchema;
} {
  return {
    name: NOTES_TOOL_NAME,
    description: NOTES_TOOL_DESCRIPTION,
    input_schema: notesToolParametersJsonSchema(),
  };
}

export function openAiNotesToolDefinition(): {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
} {
  return {
    type: "function",
    function: {
      name: NOTES_TOOL_NAME,
      description: NOTES_TOOL_DESCRIPTION,
      parameters: notesToolParametersJsonSchema(),
    },
  };
}

/** Parse tool arguments (object or JSON text) or a prose reply's JSON object. */
export function parseNotesDraft(raw: string | object): NotesDraft {
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
  const parsed = notesArgsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Notes did not match the schema: ${parsed.error.message}`);
  return parsed.data as NotesDraft;
}

/**
 * The finished note, built by the server from a draft. Never trusts the draft
 * with the person's words: their lines are copied verbatim from their notes,
 * each at most once, and any not placed go to the last section. Model lines
 * survive only with a citation inside the transcript and at most 30 turns
 * wide; duplicates are dropped; empty sections disappear.
 */
export function assembleNotes(
  request: NotesRequest,
  draft: NotesDraft,
  by: EnhancedNote["by"],
  now: number,
  model?: string,
): EnhancedNote {
  const template = NOTE_TEMPLATES[request.template];
  const turnCount = request.transcript.length;
  const placed = new Set<number>();
  const byTitle = new Map(draft.sections.map((s) => [s.title.trim().toLowerCase(), s]));
  const seen = new Set<string>();
  const sections = template.sections.map(({ title }) => {
    const d = byTitle.get(title.toLowerCase());
    const items: NoteItem[] = [];
    for (const i of d?.userLines ?? []) {
      const line = request.notes[i];
      if (!line || placed.has(i) || !line.text.trim()) continue;
      placed.add(i);
      items.push({ text: line.text.trim(), source: "user", line: i });
    }
    for (const it of d?.items ?? []) {
      const [a, b] = it.turns;
      const text = it.text.trim();
      const key = text.toLowerCase();
      if (!text || a > b || b >= turnCount || b - a > 30 || seen.has(key)) continue;
      seen.add(key);
      items.push({ text, source: "ai", turns: [a, b] });
    }
    return { title, items };
  });
  const unplaced = request.notes
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => !placed.has(i) && line.text.trim());
  if (unplaced.length) {
    const last = sections[sections.length - 1]!;
    last.items.unshift(
      ...unplaced.map(({ line, i }) => ({
        text: line.text.trim(),
        source: "user" as const,
        line: i,
      })),
    );
  }
  return {
    template: request.template,
    sections: sections.filter((s) => s.items.length > 0),
    generatedAt: now,
    by,
    ...(model ? { model } : {}),
  };
}

/**
 * Re-enhancing must not eat the person's edits. An added line they rewrote
 * is theirs (source "user") but lives only in the previous note, not in the
 * typed lines the enhancer reads — so it is carried into the new note: same
 * section when the template still has it, else the last section, and never
 * twice.
 */
export function keepEdits(previous: EnhancedNote | null, next: EnhancedNote): EnhancedNote {
  const edits = (previous?.sections ?? []).flatMap((s) =>
    s.items
      .filter((i) => i.source === "user" && i.line === undefined)
      .map((i) => ({ title: s.title.toLowerCase(), text: i.text })),
  );
  if (edits.length === 0) return next;
  const titles = NOTE_TEMPLATES[next.template].sections.map((t) => t.title);
  const order = titles.map((t) => t.toLowerCase());
  const sections = next.sections.map((s) => ({ ...s, items: [...s.items] }));
  const seen = new Set(sections.flatMap((s) => s.items.map((i) => i.text.toLowerCase())));
  const homeFor = (key: string) => {
    let s = sections.find((x) => x.title.toLowerCase() === key);
    if (!s) {
      s = { title: titles[order.indexOf(key)]!, items: [] };
      sections.push(s);
    }
    return s;
  };
  for (const e of edits) {
    const key = e.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A section the template no longer has sends the line to the last one.
    const home = homeFor(order.includes(e.title) ? e.title : order[order.length - 1]!);
    home.items.push({ text: e.text, source: "user" });
  }
  // Revived sections take their template position.
  const rank = (title: string) => {
    const r = order.indexOf(title.toLowerCase());
    return r < 0 ? order.length : r;
  };
  sections.sort((a, b) => rank(a.title) - rank(b.title));
  return { ...next, sections };
}

const CUES: Array<[RegExp, string[]]> = [
  [
    /\b(decided|agreed|we'?ll go with|let'?s go with|we are not doing|we'?re not doing|approved)\b/i,
    ["decisions", "commitments", "decisions"],
  ],
  [
    /\b(i'?ll|i will|you'?ll|can you|action|todo|to-do|follow up|next step|by (monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b/i,
    ["action items", "actions", "next steps", "next", "commitments"],
  ],
  [
    /\?\s*$|\b(open question|not sure|unclear|do we know)\b/i,
    ["open questions", "objections & questions", "blockers & support"],
  ],
  [
    /\b(risk|worried|concern|might break|blocked|blocker)\b/i,
    ["risks", "blockers", "blockers & support", "to improve"],
  ],
];

function sectionFor(text: string, template: NoteTemplate): string | undefined {
  const titles = template.sections.map((s) => s.title.toLowerCase());
  for (const [re, wanted] of CUES) {
    if (!re.test(text)) continue;
    const hit = wanted.find((w) => titles.includes(w));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The offline enhancer (no model configured, or the mock): the person's lines
 * placed by cue words, plus transcript turns that carry a clear decision,
 * action, question or risk cue — quoted, and cited to their own turn. Honest
 * and plain, never invented.
 */
export function fallbackNotesDraft(request: NotesRequest): NotesDraft {
  const template = NOTE_TEMPLATES[request.template];
  const sections = template.sections.map((s) => ({
    title: s.title,
    userLines: [] as number[],
    items: [] as NotesDraft["sections"][number]["items"],
  }));
  const find = (title: string | undefined) =>
    title ? sections.find((s) => s.title.toLowerCase() === title) : undefined;
  request.notes.forEach((line, i) => {
    (find(sectionFor(line.text, template)) ?? sections[sections.length - 1]!).userLines.push(i);
  });
  request.transcript.forEach((turn, i) => {
    const target = find(sectionFor(turn.text, template));
    if (!target || target.items.length >= 6) return;
    const text = turn.text.trim().replace(/\s+/g, " ");
    target.items.push({
      text: `${turn.speaker}: ${text.length > 200 ? `${text.slice(0, 197)}…` : text}`,
      turns: [i, i],
    });
  });
  return { sections };
}
