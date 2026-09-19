/**
 * A deliberately small XML reader for the BPMN subset (docs/19). Not an XML
 * framework: it parses well-formed element/attribute/text structure — enough
 * for BPMN's strictly nested model — and throws a positioned error on
 * malformed input instead of guessing. Namespaces are kept as raw prefixed
 * names ("bpmn:task"), which is all the subset mapping needs.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Decoded, trimmed text content (BPMN's flowNodeRef carries ids as text). */
  text?: string;
}

export function parseXml(src: string): XmlElement {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`xml parse at ${i}: ${why}`);
  };

  const decode = (raw: string): string =>
    raw
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");

  const name = (): string => {
    const m = /^[^\s/>=]+/.exec(src.slice(i));
    if (!m) fail("expected a name");
    const hit = m![0]; // m cannot be null past fail() — its `never` return is not seen through the closure
    i += hit.length;
    return hit;
  };

  const skip = (): void => {
    while (/\s/.test(src[i] ?? "")) i++;
  };

  const parseAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skip();
      const c = src[i];
      if (c === ">" || c === "/" || c === undefined) return attrs;
      const key = name();
      skip();
      if (src[i] !== "=") fail(`expected = after attribute "${key}"`);
      i++;
      skip();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`expected a quoted value for "${key}"`);
      i++;
      const end = src.indexOf(quote ?? ">", i);
      if (end < 0) fail("unterminated attribute value");
      attrs[key] = decode(src.slice(i, end));
      i = end + 1;
    }
  };

  const element = (): XmlElement => {
    if (src[i] !== "<") fail("expected <");
    i++;
    if (src.startsWith("?", i) || src.startsWith("!", i)) {
      // Declaration / comment / DOCTYPE: skip to the closing bracket.
      const close = src.indexOf(">", i);
      if (close < 0) fail("unterminated declaration");
      i = close + 1;
      // Declarations are not elements; the caller sees only real markup.
      while (src[i] !== "<") {
        if (i >= src.length) fail("unterminated document");
        if (src.startsWith("<!--", i)) {
          const c = src.indexOf("-->", i);
          if (c < 0) fail("unterminated comment");
          i = c + 3;
        } else i++;
      }
      return element();
    }
    const el: XmlElement = { name: name(), attrs: parseAttrs(), children: [] };
    skip();
    if (src[i] === "/") {
      i += 2;
      return el;
    }
    if (src[i] !== ">") fail(`expected > or /> after <${el.name}`);
    i++;
    let textRaw = "";
    for (;;) {
      const next = src.indexOf("<", i);
      if (next < 0) fail(`unterminated <${el.name}>`);
      textRaw += src.slice(i, next);
      i = next;
      if (src.startsWith("<!--", i)) {
        const c = src.indexOf("-->", i);
        if (c < 0) fail("unterminated comment");
        i = c + 3;
        continue;
      }
      if (src.startsWith("</", i)) {
        i += 2;
        const close = name();
        if (close !== el.name) fail(`mismatched close: </${close}> for <${el.name}>`);
        skip();
        if (src[i] !== ">") fail("expected > after close tag");
        i++;
        const text = decode(textRaw).trim();
        if (text) el.text = text;
        return el;
      }
      el.children.push(element());
    }
  };

  skip();
  const doc = element();
  skip();
  if (i < src.length) fail("trailing content after the root element");
  return doc;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}
