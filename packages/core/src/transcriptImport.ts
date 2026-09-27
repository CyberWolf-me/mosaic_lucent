/**
 * Reading a meeting transcript someone exported from another tool (docs/28
 * S12): Zoom's and Teams' WebVTT, subtitle SRT, and the plain text Google
 * Meet, Otter and most note tools export. The result is turns — who spoke,
 * what they said, and when into the meeting — for the same meeting store
 * native capture writes to, so nothing downstream can tell the difference.
 *
 * Speakers are taken as the file names them and never guessed: a line with
 * no speaker the format can read is "Speaker". Pure and framework-free, so
 * the browser previews exactly what the import will hold.
 */

export type TranscriptFormat = "vtt" | "srt" | "text";

export interface ImportedTurn {
  speaker: string;
  text: string;
  /** When into the meeting it was said, when the file says. */
  offsetMs: number | null;
}

export interface ParsedTranscript {
  format: TranscriptFormat;
  /** Which tool it looks like it came from, when the file says enough to tell. */
  source: "zoom" | "teams" | "meet" | "otter" | null;
  turns: ImportedTurn[];
  speakers: string[];
  /** From the first line to the last, when the file has times. */
  durationMs: number | null;
}

/** The meeting store's limits (server/meetings.ts), so the preview can say so first. */
export const IMPORT_MAX_TURNS = 500;
export const IMPORT_MAX_TURN_CHARS = 2000;
const MAX_FILE_CHARS = 2_000_000;
const UNKNOWN_SPEAKER = "Speaker";

/** "01:02:03.456", "02:03,456", "1:02:03", "02:03" → ms. */
function timeMs(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  const ms = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return ((h * 60 + min) * 60 + s) * 1000 + ms;
}

const TIMING = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

/** "Ada Lovelace: text" — a name-like prefix, not a URL or a clock. */
function splitSpeaker(line: string): { speaker: string | null; text: string } {
  const m = line.match(/^\s*([^:\n]{1,60}?)\s*:\s+(.+)$/);
  if (m && !/^\d+$/.test(m[1]!) && !/https?$/i.test(m[1]!) && /\p{L}/u.test(m[1]!)) {
    return { speaker: m[1]!.trim(), text: m[2]!.trim() };
  }
  return { speaker: null, text: line.trim() };
}

function stripTags(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** WebVTT and SRT: cues with a timing line, then text. */
function parseCues(content: string, format: "vtt" | "srt"): ImportedTurn[] {
  const blocks = content.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const out: ImportedTurn[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timingAt = lines.findIndex((l) => TIMING.test(l));
    if (timingAt < 0) continue;
    const start = timeMs(lines[timingAt]!.match(TIMING)![1]!);
    const body = lines.slice(timingAt + 1).join(" ");
    if (!body.trim()) continue;
    // Teams: <v Ada Lovelace>text</v>
    const voice = body.match(/<v(?:\.[^\s>]+)?\s+([^>]+)>/);
    let speaker: string | null = voice ? voice[1]!.trim() : null;
    let text = stripTags(body);
    if (!speaker) {
      const split = splitSpeaker(text);
      speaker = split.speaker;
      text = split.text;
    }
    if (!text) continue;
    out.push({ speaker: speaker ?? UNKNOWN_SPEAKER, text, offsetMs: start });
  }
  void format;
  return out;
}

/**
 * Plain text, in the shapes tools export:
 *   Ada Lovelace: text                       (a speaker on each line)
 *   [00:01:02] Ada Lovelace: text            (with a clock)
 *   Ada Lovelace  0:03  /  Ada Lovelace (00:00:03)   then the words below (Otter, Meet)
 *   00:01:02 on its own line, setting the time of what follows
 */
function parseText(content: string): { turns: ImportedTurn[]; source: ParsedTranscript["source"] } {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const out: ImportedTurn[] = [];
  let clock: number | null = null;
  let header: { speaker: string; offsetMs: number | null } | null = null;
  let headerStyle = false;
  const clockPrefix = /^\s*[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?\s*[-–—]?\s*/;
  const headerLine =
    /^\s*([^\d:\n][^:\n]{0,59}?)\s*(?:\s{2,}|\s*\(|\s+[-–—|·]\s+)(\d{1,2}:\d{2}(?::\d{2})?)\)?\s*$/;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const alone = line.match(/^[[(]?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\])]?$/);
    if (alone) {
      clock = timeMs(alone[1]!);
      continue;
    }
    const head = line.match(headerLine);
    if (head && /\p{L}/u.test(head[1]!)) {
      header = { speaker: head[1]!.trim(), offsetMs: timeMs(head[2]!) };
      headerStyle = true;
      continue;
    }
    let rest = line;
    let at = clock;
    const prefixed = rest.match(clockPrefix);
    if (prefixed && prefixed[0].length < rest.length) {
      at = timeMs(prefixed[1]!);
      rest = rest.slice(prefixed[0].length);
    }
    const split = splitSpeaker(rest);
    if (split.speaker) {
      out.push({ speaker: split.speaker, text: split.text, offsetMs: at });
      header = null;
    } else if (header) {
      out.push({ speaker: header.speaker, text: split.text, offsetMs: header.offsetMs ?? at });
    } else {
      out.push({ speaker: UNKNOWN_SPEAKER, text: split.text, offsetMs: at });
    }
  }
  return { turns: out, source: headerStyle ? "otter" : null };
}

/** One speaker's run of short lines becomes one turn — kept under the store's cap. */
function mergeRuns(turns: ImportedTurn[]): ImportedTurn[] {
  const out: ImportedTurn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker && last.text.length + t.text.length + 1 <= 1200) {
      last.text = `${last.text} ${t.text}`;
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/** A turn longer than the store allows is split at sentence ends. */
function splitLong(turns: ImportedTurn[]): ImportedTurn[] {
  const out: ImportedTurn[] = [];
  for (const t of turns) {
    if (t.text.length <= IMPORT_MAX_TURN_CHARS) {
      out.push(t);
      continue;
    }
    let rest = t.text;
    while (rest.length > IMPORT_MAX_TURN_CHARS) {
      const window = rest.slice(0, IMPORT_MAX_TURN_CHARS);
      const cut = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
      );
      const at = cut > IMPORT_MAX_TURN_CHARS / 2 ? cut + 1 : window.lastIndexOf(" ");
      const end = at > 0 ? at : IMPORT_MAX_TURN_CHARS;
      out.push({ ...t, text: rest.slice(0, end).trim() });
      rest = rest.slice(end).trim();
    }
    if (rest) out.push({ ...t, text: rest });
  }
  return out;
}

function sourceOf(content: string, filename: string | undefined, turns: ImportedTurn[]) {
  const name = (filename ?? "").toLowerCase();
  if (/<v\s/.test(content)) return "teams" as const;
  if (
    name.includes("zoom") ||
    /^WEBVTT[\s\S]{0,200}\n\d+\n\d{2}:\d{2}:\d{2}\.\d{3} -->/.test(content)
  ) {
    return turns.some((t) => t.speaker !== UNKNOWN_SPEAKER) ? ("zoom" as const) : null;
  }
  if (name.includes("meet") || /transcript/i.test(content.slice(0, 200))) return "meet" as const;
  return null;
}

/** Read a transcript file, or say why it can't be read. */
export function parseTranscript(
  content: string,
  filename?: string,
): ParsedTranscript | { error: string } {
  if (content.length > MAX_FILE_CHARS)
    return { error: "That file is too large to import (2 MB of text at most)." };
  const text = content.replace(/^\uFEFF/, "");
  if (!text.trim()) return { error: "That file is empty." };
  const lower = (filename ?? "").toLowerCase();
  let format: TranscriptFormat;
  let raw: ImportedTurn[];
  let source: ParsedTranscript["source"] = null;
  if (/^WEBVTT/.test(text) || lower.endsWith(".vtt")) {
    format = "vtt";
    raw = parseCues(text, "vtt");
  } else if (lower.endsWith(".srt") || /^\s*\d+\s*\n\s*[\d:,]+\s*-->/.test(text)) {
    format = "srt";
    raw = parseCues(text, "srt");
  } else {
    format = "text";
    const parsed = parseText(text);
    raw = parsed.turns;
    source = parsed.source;
  }
  const turns = splitLong(mergeRuns(raw.filter((t) => t.text.trim() !== "")));
  if (turns.length === 0) return { error: "Lucent couldn't find anything said in that file." };
  const speakers = [...new Set(turns.map((t) => t.speaker))];
  const times = turns.map((t) => t.offsetMs).filter((n): n is number => n !== null);
  const durationMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : null;
  return {
    format,
    source: source ?? sourceOf(text, filename, turns),
    turns,
    speakers,
    durationMs,
  };
}

/**
 * The turns as the meeting store takes them: `at` is the meeting's start plus
 * each turn's offset (or, with no times, a second apart, in order). Capped at
 * the store's limit — `dropped` says how many didn't fit.
 */
export function transcriptTurns(
  parsed: ParsedTranscript,
  startedAt: number,
): { turns: Array<{ speaker: string; text: string; at: number }>; dropped: number } {
  let last = startedAt;
  const all = parsed.turns.map((t, i) => {
    const at = t.offsetMs !== null ? startedAt + t.offsetMs : startedAt + i * 1000;
    last = Math.max(last, at);
    return { speaker: t.speaker.slice(0, 200), text: t.text, at: last };
  });
  return {
    turns: all.slice(0, IMPORT_MAX_TURNS),
    dropped: Math.max(0, all.length - IMPORT_MAX_TURNS),
  };
}
