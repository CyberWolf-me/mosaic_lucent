import { useEffect, useState } from "react";
import type { VectorData } from "@lucent/core";
import { IconPicker } from "../icons/IconPicker.js";
import { loadIconIndex } from "../icons/registry.js";
import { VectorSvg } from "./VectorSvg.js";
import {
  VECTOR_STYLES,
  brandInPrompt,
  generateVectors,
  type GeneratedVariation,
  type VectorStyle,
} from "./generate.js";

/**
 * Icons & vectors (docs/26 §6.3): the library (every registry icon, placed as
 * an editable vector) and generation (a prompt → variations, drawn by the
 * workspace's vector provider — Recraft — and sanitized on the server).
 * Everything it places is an ordinary `vector` shape.
 */

/** Ask the panel to open on Generate with a prompt (the inspector's "More like this"). */
export const VECTORS_OPEN_EVENT = "lucent:vectors-open";
export function openVectorsPanel(prompt?: string): void {
  window.dispatchEvent(new CustomEvent(VECTORS_OPEN_EVENT, { detail: { prompt } }));
}

export function VectorsPanel({
  boardId,
  initialPrompt,
  onPlaceIcon,
  onPlaceVector,
  onClose,
}: {
  boardId: string | null;
  initialPrompt?: string | undefined;
  onPlaceIcon: (ref: string) => void;
  onPlaceVector: (vector: VectorData, width: number, height: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"library" | "generate">(initialPrompt ? "generate" : "library");
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [style, setStyle] = useState<VectorStyle>("icon");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brand, setBrand] = useState<{ slug: string; title: string } | null>(null);
  const [results, setResults] = useState<GeneratedVariation[]>([]);
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
      setTab("generate");
    }
  }, [initialPrompt]);

  const generate = async () => {
    const text = prompt.trim();
    if (text.length < 2 || busy) return;
    setError(null);
    setBrand(null);
    // Another company's logo is the library's job, not a generator's —
    // and Recraft's terms forbid it.
    const found = brandInPrompt(text, await loadIconIndex());
    if (found) {
      setBrand(found);
      return;
    }
    setBusy(true);
    setResults([]);
    const r = await generateVectors({ prompt: text, style, n: 3, boardId });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setResults(r.variations);
    setProvider(r.provider);
  };

  return (
    <div className="vectors-pop" role="dialog" aria-label="Icons and vectors">
      <div className="vectors-pop-head">
        <div className="vectors-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>
            Library
          </button>
          <button role="tab" aria-selected={tab === "generate"} onClick={() => setTab("generate")}>
            Generate
          </button>
        </div>
        <button className="vectors-close" onClick={onClose} aria-label="Close" title="Close · Esc">
          ×
        </button>
      </div>

      {tab === "library" ? (
        <>
          <p className="vectors-pop-hint">
            Places an editable vector. Paste or drop an SVG to import one; right-click an image to
            trace it, or pen strokes to smooth them.
          </p>
          <IconPicker onChoose={onPlaceIcon} onClose={onClose} />
        </>
      ) : (
        <div className="vectors-gen">
          <textarea
            className="vectors-prompt"
            autoFocus
            rows={2}
            maxLength={1000}
            aria-label="Describe the vector"
            placeholder="Describe it — a friendly robot mascot, a checkout icon set…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void generate();
              if (e.key === "Escape") onClose();
            }}
          />
          <div className="vectors-styles" role="radiogroup" aria-label="Style">
            {VECTOR_STYLES.map((s) => (
              <button
                key={s.id}
                role="radio"
                aria-checked={style === s.id}
                className={style === s.id ? "is-on" : ""}
                onClick={() => setStyle(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            className="vectors-go"
            onClick={() => void generate()}
            disabled={busy || prompt.trim().length < 2}
          >
            {busy ? "Drawing three variations…" : "Generate 3 variations"}
          </button>

          {brand && (
            <div className="vectors-note">
              <p>
                {brand.title}&rsquo;s logo is their trademark, so Lucent won&rsquo;t generate an
                imitation. The real mark is in the library.
              </p>
              <button onClick={() => onPlaceIcon(`simple:${brand.slug}`)}>
                Place the {brand.title} mark
              </button>
            </div>
          )}
          {error && <p className="vectors-error">{error}</p>}
          {busy && (
            <div className="vectors-results" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="vectors-tile is-loading" />
              ))}
            </div>
          )}
          {results.length > 0 && (
            <>
              <div className="vectors-results">
                {results.map((v, i) => (
                  <button
                    key={i}
                    className="vectors-tile"
                    onClick={() => onPlaceVector(v.vector, v.width, v.height)}
                    title="Place on the board"
                    aria-label={`Place variation ${i + 1}`}
                  >
                    <VectorSvg vector={v.vector} />
                  </button>
                ))}
              </div>
              <p className="vectors-pop-hint">
                {provider === "mock"
                  ? "Offline stand-in: this server has no Recraft key, so these are placeholders."
                  : "Drawn by Recraft and checked by Lucent. Click one to place it; each is fully editable."}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
