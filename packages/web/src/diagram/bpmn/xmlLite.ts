/**
 * A deliberately small XML reader for the BPMN subset (docs/19). Not an XML
 * framework: it parses well-formed element/attribute/text structure — enough
 * for BPMN's strictly nested model — and throws a positioned `XmlError` on
 * malformed input instead of guessing. Namespaces are kept as raw prefixed
 * names ("bpmn:task"); the adapter resolves them against the `xmlns`
 * attributes, which is all the subset mapping needs.
 *
 * Its input is untrusted (a file a user picked, text they pasted), so it is
 * hardened by construction rather than by configuration:
 *
 *   - NO DTDs. A `<!DOCTYPE` or `<!ENTITY` anywhere is refused outright, so
 *     there is no entity expansion ("billion laughs") and no external entity
 *     (XXE) — the only XML mechanisms that make a parser read beyond the text.
 *     Only the five predefined entities and character references decode;
 *     anything else stays literal text.
 *   - Nothing is ever fetched: schemaLocation, `<import location>`, XInclude
 *     are just attributes and elements to this reader.
 *   - Bounded work: a length cap, an element cap and a depth cap, and a scan
 *     that is linear in the input (sticky regexes, no `slice` per token), so
 *     a hostile 2 MB paste costs one pass, not a quadratic one.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Decoded, trimmed text content (BPMN's flowNodeRef carries ids as text). */
  text?: string;
}

export interface XmlLimits {
  /** Longest source accepted, in characters (UTF-16 units — about as many bytes). */
  maxLength: number;
  /** Most elements in one document. */
  maxElements: number;
  /** Deepest element nesting. BPMN nests ~10 deep; 100 is generous. */
  maxDepth: number;
}

export const XML_LIMITS: XmlLimits = {
  maxLength: 2_000_000,
  maxElements: 100_000,
  maxDepth: 100,
};

/** A malformed or refused document: `reason` is the human part, `at` the offset. */
export class XmlError extends Error {
  constructor(
    readonly reason: string,
    readonly at: number,
  ) {
    super(`xml parse at ${at}: ${reason}`);
    this.name = "XmlError";
  }
}

// XML names: a letter, underscore or colon, then name characters. Admitting
// every non-ASCII character covers the letters XML allows without a table.
const NAME = /(?:[A-Za-z_:]|[\u{80}-\u{10FFFF}])(?:[\w.:-]|[\u{80}-\u{10FFFF}])*/uy;
// One pass over the five predefined entities and character references. A
// single pass matters: sequential replaces double-decode "&#38;lt;" into "<".
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Whether `code` is a character XML 1.0 allows in a document. */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

export function parseXml(src: string, limits: Partial<XmlLimits> = {}): XmlElement {
  const lim: XmlLimits = { ...XML_LIMITS, ...limits };
  const n = src.length;
  // A byte-order mark is not content.
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (why: string, at: number = i): never => {
    throw new XmlError(why, at);
  };
  if (n > lim.maxLength) fail(`the document is longer than ${lim.maxLength} characters`, 0);

  const decode = (raw: string): string =>
    raw.indexOf("&") < 0
      ? raw
      : raw.replace(ENTITY, (_whole, ent: string) => {
          if (ent.charCodeAt(0) !== 35 /* # */) return PREDEFINED[ent]!;
          const code =
            ent.charCodeAt(1) === 120 /* x */
              ? parseInt(ent.slice(2), 16)
              : parseInt(ent.slice(1), 10);
          if (!isXmlChar(code)) fail(`invalid character reference &${ent};`);
          return String.fromCodePoint(code);
        });

  const readName = (): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) return fail("expected a name");
    i = NAME.lastIndex;
    return m[0];
  };

  const skipWs = (): void => {
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === 0x20 || c === 0x9 || c === 0xa || c === 0xd) i++;
      else return;
    }
  };

  /**
   * Consume one comment or processing instruction at `i`; refuse any DTD
   * markup. False when `i` holds neither (an element, text, CDATA…).
   */
  const skipMisc = (): boolean => {
    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      if (close < 0) fail("unterminated comment");
      i = close + 3;
      return true;
    }
    if (src.startsWith("<?", i)) {
      const close = src.indexOf("?>", i + 2);
      if (close < 0) fail("unterminated processing instruction");
      i = close + 2;
      return true;
    }
    if (
      src.charCodeAt(i + 1) === 33 /* ! */ &&
      /^<!(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i.test(src.slice(i, i + 10))
    ) {
      fail("DOCTYPE and entity declarations are not accepted");
    }
    return false;
  };

  let elementCount = 0;
  /** Parse `<name attrs` through `>` or `/>`; `i` sits on the `<`. */
  const openTag = (depth: number): { el: XmlElement; selfClosing: boolean } => {
    if (++elementCount > lim.maxElements) fail(`more than ${lim.maxElements} elements`);
    if (depth > lim.maxDepth) fail(`elements nested deeper than ${lim.maxDepth} levels`);
    i++; // "<"
    const name = readName();
    // Null-prototype: an attribute named "__proto__" is just an attribute.
    const attrs = Object.create(null) as Record<string, string>;
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === ">") {
        i++;
        return { el: { name, attrs, children: [] }, selfClosing: false };
      }
      if (c === "/") {
        if (src[i + 1] !== ">") fail(`expected /> to close <${name}`);
        i += 2;
        return { el: { name, attrs, children: [] }, selfClosing: true };
      }
      if (c === undefined) fail(`unterminated <${name}`);
      const key = readName();
      skipWs();
      if (src[i] !== "=") fail(`expected = after attribute "${key}"`);
      i++;
      skipWs();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`expected a quoted value for "${key}"`);
      const end = src.indexOf(quote as string, i + 1);
      if (end < 0) fail("unterminated attribute value");
      attrs[key] = decode(src.slice(i + 1, end));
      i = end + 1;
    }
  };

  // Prolog: whitespace, the XML declaration, comments, PIs — never a DTD.
  for (;;) {
    skipWs();
    if (!skipMisc()) break;
  }
  if (src[i] !== "<") fail("expected the root element");

  const first = openTag(1);
  const root = first.el;
  if (!first.selfClosing) {
    // Iterative, not recursive: the depth cap bounds the stack either way,
    // but a loop keeps the element cap the only thing a deep document costs.
    const stack: Array<{ el: XmlElement; text: string[] }> = [{ el: root, text: [] }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const lt = src.indexOf("<", i);
      if (lt < 0) fail(`unterminated <${top.el.name}>`);
      if (lt > i) top.text.push(decode(src.slice(i, lt)));
      i = lt;
      if (src.startsWith("</", i)) {
        i += 2;
        const close = readName();
        if (close !== top.el.name) fail(`mismatched close: </${close}> for <${top.el.name}>`);
        skipWs();
        if (src[i] !== ">") fail("expected > after close tag");
        i++;
        const text = top.text.join("").trim();
        if (text) top.el.text = text;
        stack.pop();
        continue;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const close = src.indexOf("]]>", i + 9);
        if (close < 0) fail("unterminated CDATA section");
        // CDATA is literal: no entity decoding.
        top.text.push(src.slice(i + 9, close));
        i = close + 3;
        continue;
      }
      if (skipMisc()) continue;
      if (src[i + 1] === "!") fail("unsupported markup declaration");
      const child = openTag(stack.length + 1);
      top.el.children.push(child.el);
      if (!child.selfClosing) stack.push({ el: child.el, text: [] });
    }
  }

  // Epilog: only whitespace, comments and PIs may follow the root.
  for (;;) {
    skipWs();
    if (!skipMisc()) break;
  }
  if (i < n) fail("trailing content after the root element");
  return root;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  // Line breaks and tabs as references, so an attribute value keeps them
  // (a parser normalizes a literal newline in an attribute to a space).
  "\n": "&#10;",
  "\r": "&#13;",
  "\t": "&#9;",
};

/**
 * Escape text for an XML attribute or element. Characters XML 1.0 cannot
 * carry at all (C0 controls, U+FFFE/U+FFFF, lone surrogates) are dropped:
 * a label holding one would otherwise make the whole export unreadable.
 */
export function escapeXml(text: string): string {
  return (
    text
      // In `u` mode a surrogate range matches only LONE surrogates: a valid
      // pair is one code point above U+FFFF and passes through.
      // eslint-disable-next-line no-control-regex -- dropping control characters is the point
      .replace(/[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]/gu, "")
      .replace(/[&<>"'\n\r\t]/g, (c) => ESCAPES[c]!)
  );
}
