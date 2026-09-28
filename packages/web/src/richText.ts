/**
 * Minimal rich text for shape text (docs/26 §6.4): a small, safe markdown
 * subset, read from the plain text a shape already stores — so nothing in the
 * schema changes, an old board reads the same, and editing stays typing.
 *
 *   # Heading          - bullet        1. numbered
 *   **bold**  *italic*  `code`  ~~struck~~  [a link](https://…)  https://…
 *   ```                ← a code block, whitespace kept, until the next ```
 *
 * Pure: the canvas renders the blocks; the export takes `plainText`. A link is
 * a link only for http, https and mailto — anything else stays words.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline[] }
  | { kind: "bullet"; inline: Inline[] }
  | { kind: "numbered"; n: number; inline: Inline[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "blank" };

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"']+$/i;

export function safeHref(url: string): string | null {
  return SAFE_URL.test(url) ? url : null;
}

/** Markers, in the order they're tried at each position. */
const PAIRS: Array<{ open: string; close: string; kind: "bold" | "italic" | "strike" }> = [
  { open: "**", close: "**", kind: "bold" },
  { open: "__", close: "__", kind: "bold" },
  { open: "~~", close: "~~", kind: "strike" },
  { open: "*", close: "*", kind: "italic" },
  { open: "_", close: "_", kind: "italic" },
];

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", text: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // `code` — nothing inside is read as markup.
    if (rest[0] === "`") {
      const end = rest.indexOf("`", 1);
      if (end > 1) {
        flush();
        out.push({ kind: "code", text: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }
    // [words](url)
    if (rest[0] === "[") {
      const m = rest.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)/);
      const href = m ? safeHref(m[2]!) : null;
      if (m && href) {
        flush();
        out.push({ kind: "link", href, children: parseInline(m[1]!) });
        i += m[0].length;
        continue;
      }
    }
    // A bare URL, at a word's start.
    if ((i === 0 || /\s|\(/.test(text[i - 1]!)) && /^(https?:\/\/|mailto:)/i.test(rest)) {
      const m = rest.match(/^(https?:\/\/|mailto:)[^\s<>"')]+/i);
      if (m) {
        // A sentence's full stop isn't part of the address.
        const url = m[0].replace(/[.,;:!?]+$/, "");
        flush();
        out.push({ kind: "link", href: url, children: [{ kind: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    const pair = PAIRS.find((p) => rest.startsWith(p.open));
    if (pair) {
      const body = rest.slice(pair.open.length);
      const end = body.indexOf(pair.close);
      // A marker needs something inside that doesn't start or end with a space
      // ("2 * 3 * 4" stays arithmetic), and `_` only at a word's edge
      // (snake_case_names stay whole).
      const inner = end > 0 ? body.slice(0, end) : "";
      const wordEdge =
        pair.open[0] !== "_" ||
        ((i === 0 || !/\w/.test(text[i - 1]!)) && !/\w/.test(body[end + pair.close.length] ?? ""));
      if (inner && inner.trim() === inner && wordEdge) {
        flush();
        out.push({ kind: pair.kind, children: parseInline(inner) });
        i += pair.open.length + end + pair.close.length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

export function parseRichText(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      blocks.push({ kind: "code", lang: fence[1] || null, text: body.join("\n") });
      // An unclosed fence runs to the end.
      i = j;
      continue;
    }
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        inline: parseInline(heading[2]!),
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (bullet) {
      blocks.push({ kind: "bullet", inline: parseInline(bullet[1]!) });
      continue;
    }
    const numbered = line.match(/^\s*(\d{1,3})[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push({ kind: "numbered", n: Number(numbered[1]), inline: parseInline(numbered[2]!) });
      continue;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(line) });
  }
  return blocks;
}

/** Does the text use any of the markup (so plain text keeps its plain path)? */
export function hasRichText(text: string): boolean {
  return /```|\*\*|__|~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/|mailto:|^\s*(#{1,3}\s|[-*•]\s|\d{1,3}[.)]\s)|(^|[\s(])[*_][^\s*_]/m.test(
    text,
  );
}

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.kind === "text" || n.kind === "code" ? n.text : inlineText(n.children)))
    .join("");
}

/** The words without the markup — what an export or a screen reader gets. */
export function plainText(text: string): string {
  return parseRichText(text)
    .map((b) => {
      switch (b.kind) {
        case "blank":
          return "";
        case "code":
          return b.text;
        case "bullet":
          return `• ${inlineText(b.inline)}`;
        case "numbered":
          return `${b.n}. ${inlineText(b.inline)}`;
        default:
          return inlineText(b.inline);
      }
    })
    .join("\n");
}
