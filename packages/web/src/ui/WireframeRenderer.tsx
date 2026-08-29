import type { Wireframe, WireframeElement } from "@lucent/core";

/**
 * Renders a semantic Wireframe (a nested element tree from @lucent/core) into a
 * flexbox layout. The AI emits structure only; this component owns all visual
 * styling and spacing. Unknown kinds fall back to a labelled block so the model
 * can invent element kinds without breaking the renderer.
 */

const CONTAINER_KINDS = new Set([
  "screen",
  "row",
  "column",
  "card",
  "nav",
  "header",
  "sidebar",
  "section",
  "list",
]);

export function WireframeRenderer({ wireframe }: { wireframe: Wireframe }) {
  return <WFElement el={wireframe.root} depth={0} />;
}

function WFElement({ el, depth }: { el: WireframeElement; depth: number }) {
  const kind = el.kind.toLowerCase();
  const weight = el.weight ?? 1;

  if (CONTAINER_KINDS.has(kind)) {
    const direction: "row" | "column" =
      el.direction ?? (kind === "row" || kind === "nav" || kind === "header" ? "row" : "column");
    return (
      <div
        className={`wf-el wf-${kind}`}
        style={{ flex: weight, display: "flex", flexDirection: direction, gap: 12, minWidth: 0 }}
      >
        {(kind === "card" || kind === "section" || kind === "sidebar") && el.label && (
          <div className="wf-region-label">{el.label}</div>
        )}
        {el.children?.map((child, i) => <WFElement key={i} el={child} depth={depth + 1} />)}
      </div>
    );
  }

  switch (kind) {
    case "heading":
      return <div className="wf-heading">{el.label ?? "Heading"}</div>;
    case "text":
      return <div className="wf-text">{el.label ?? "Text"}</div>;
    case "field":
    case "input":
      return (
        <label className="wf-field" style={{ flex: weight }}>
          {el.label && <span className="wf-field-label">{el.label}</span>}
          <span className="wf-input">{el.placeholder ?? "\u00a0"}</span>
        </label>
      );
    case "button":
      return (
        <button className={`wf-button ${el.variant ?? "secondary"}`} style={{ flex: weight }}>
          {el.label ?? "Button"}
        </button>
      );
    case "checkbox":
      return (
        <label className="wf-checkbox">
          <span className="wf-box" />
          {el.label ?? "Option"}
        </label>
      );
    case "image":
      return (
        <div className="wf-image" style={{ flex: weight }}>
          {el.label ?? "Image"}
        </div>
      );
    case "divider":
      return <div className="wf-divider" />;
    default:
      return (
        <div className="wf-el wf-fallback" style={{ flex: weight }}>
          {el.label ?? el.kind}
        </div>
      );
  }
}
