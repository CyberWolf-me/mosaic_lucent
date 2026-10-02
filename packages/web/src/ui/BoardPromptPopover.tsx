import { useState } from "react";

/**
 * A small board-anchored input popover for the shape toolbar's image-gen and
 * embed buttons. It replaces the browser's native `window.prompt()`, which the
 * browser pins to the top of the window — detached from the board and
 * unstyleable (see AuthView's note on why native prompts were dropped). This
 * mirrors the `.vectors-pop` affordance: a styled popover anchored over the
 * canvas, Enter to submit, Esc to close, and `stopPropagation` on keys so the
 * canvas's single-key tool shortcuts don't fire while you type.
 */
const COPY = {
  image: {
    title: "Generate an image",
    placeholder: "Describe an image for Lucent to generate…",
    cta: "Generate",
    max: 1000,
  },
  embed: {
    title: "Embed a link",
    placeholder: "Paste a GIF, YouTube/Vimeo, or web link…",
    cta: "Embed",
    max: 2000,
  },
} as const;

export function BoardPromptPopover({
  kind,
  onSubmit,
  onClose,
}: {
  kind: "image" | "embed";
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const copy = COPY[kind];
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    onClose();
  };
  return (
    <div className="board-prompt-pop" role="dialog" aria-label={copy.title}>
      <div className="board-prompt-head">
        <span>{copy.title}</span>
        <button
          className="board-prompt-close"
          onClick={onClose}
          aria-label="Close"
          title="Close · Esc"
        >
          ×
        </button>
      </div>
      <input
        className="board-prompt-input"
        autoFocus
        type={kind === "embed" ? "url" : "text"}
        maxLength={copy.max}
        aria-label={copy.title}
        placeholder={copy.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Keep typing out of the canvas's single-key tool shortcuts.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <button className="board-prompt-go" onClick={submit} disabled={text.trim().length === 0}>
        {copy.cta}
      </button>
    </div>
  );
}
