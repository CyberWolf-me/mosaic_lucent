import { useEffect, useMemo, useState } from "react";
import { brandInk } from "./brandInk.js";
import { IconSvg } from "./Icon.js";
import { loadIconIndex, useIcon, type IconIndex } from "./registry.js";
import { SUGGESTED_ICONS, searchIcons, type IconHit } from "./search.js";

/**
 * Search and pick from the icon registry (docs/26 §6.2): Iconoir concepts and
 * Simple Icons brand marks. Shared by the node inspector (a node's icon) and
 * the canvas (an icon placed as an editable vector, §6.3). The name index
 * (~50 KB gzipped) loads on the first keystroke, not with the board.
 */
export function IconPicker({
  selected,
  lead,
  onChoose,
  onClose,
  placeholder = "Search icons and brands — database, stripe…",
}: {
  selected?: string | undefined;
  /** An icon to show first among the suggestions (e.g. the label's own). */
  lead?: string | null | undefined;
  onChoose: (ref: string) => void;
  onClose?: () => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<IconIndex | null>(null);

  useEffect(() => {
    if (query && !index) void loadIconIndex().then(setIndex);
  }, [query, index]);

  const hits = useMemo(
    () => (index && query.trim() ? searchIcons(index, query, 36) : null),
    [index, query],
  );
  const suggestions = useMemo<IconHit[]>(
    () =>
      [...new Set([...(lead ? [lead] : []), ...SUGGESTED_ICONS])].map((ref) => ({
        ref,
        set: ref.startsWith("simple:") ? "simple" : "iconoir",
        name: ref.slice(ref.indexOf(":") + 1).replace(/-/g, " "),
      })),
    [lead],
  );

  return (
    <div className="ni-icon-picker">
      <input
        className="ni-icon-search"
        autoFocus
        aria-label="Search icons and brands"
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits?.[0]) onChoose(hits[0].ref);
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose?.();
          }
        }}
      />
      <div className="ni-icon-grid" role="listbox" aria-label="Icons">
        {(hits ?? suggestions).map((hit) => (
          <IconChoice key={hit.ref} hit={hit} selected={hit.ref === selected} onChoose={onChoose} />
        ))}
      </div>
      {query.trim() && !index && <p className="ni-none">Loading the library…</p>}
      {hits && hits.length === 0 && (
        <p className="ni-none">No icon or brand matches “{query.trim()}”.</p>
      )}
    </div>
  );
}

function IconChoice({
  hit,
  selected,
  onChoose,
}: {
  hit: IconHit;
  selected: boolean;
  onChoose: (ref: string) => void;
}) {
  const glyph = useIcon(hit.ref);
  const ink = glyph?.set === "simple" ? brandInk(glyph.hex) : undefined;
  return (
    <button
      className={`ni-icon-choice${selected ? " is-selected" : ""}`}
      role="option"
      aria-selected={selected}
      aria-label={hit.name}
      title={hit.set === "simple" ? `${hit.name} (brand)` : hit.name}
      onClick={() => onChoose(hit.ref)}
      style={ink ? { color: ink } : undefined}
    >
      {glyph ? <IconSvg glyph={glyph} size={18} /> : <span className="ni-icon-loading" />}
    </button>
  );
}
