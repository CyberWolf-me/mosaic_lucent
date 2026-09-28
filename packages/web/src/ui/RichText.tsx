import type { ReactNode } from "react";
import { parseRichText, type Block, type Inline } from "../richText.js";

/**
 * A shape's text with its minimal markup drawn (docs/26 §6.4, richText.ts):
 * headings, lists, code blocks and inline marks. Links open in a new tab and
 * never start a drag of the shape they sit in.
 */
function renderInline(nodes: Inline[], key = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.kind) {
      case "text":
        return n.text;
      case "code":
        return (
          <code key={k} className="rt-code">
            {n.text}
          </code>
        );
      case "bold":
        return <strong key={k}>{renderInline(n.children, `${k}-`)}</strong>;
      case "italic":
        return <em key={k}>{renderInline(n.children, `${k}-`)}</em>;
      case "strike":
        return <s key={k}>{renderInline(n.children, `${k}-`)}</s>;
      case "link":
        return (
          <a
            key={k}
            className="rt-link"
            href={n.href}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {renderInline(n.children, `${k}-`)}
          </a>
        );
    }
  });
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.kind) {
    case "blank":
      return <div key={i} className="rt-blank" />;
    case "heading":
      return (
        <div key={i} className={`rt-h rt-h${b.level}`}>
          {renderInline(b.inline)}
        </div>
      );
    case "bullet":
      return (
        <div key={i} className="rt-li">
          <span className="rt-mark" aria-hidden>
            •
          </span>
          <span>{renderInline(b.inline)}</span>
        </div>
      );
    case "numbered":
      return (
        <div key={i} className="rt-li">
          <span className="rt-mark">{b.n}.</span>
          <span>{renderInline(b.inline)}</span>
        </div>
      );
    case "code":
      return (
        <pre key={i} className="rt-pre" data-lang={b.lang ?? undefined}>
          <code>{b.text}</code>
        </pre>
      );
    default:
      return <div key={i}>{renderInline(b.inline)}</div>;
  }
}

export function RichText({ text }: { text: string }) {
  return <span className="rich-text">{parseRichText(text).map(renderBlock)}</span>;
}
