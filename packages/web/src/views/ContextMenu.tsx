import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Right-click context menu for the board (FigJam/Miro parity). Positioned at the
 * cursor; actions operate on the current selection. Closes on outside click,
 * scroll, or Escape.
 *
 * The enter/exit scale is anchored to the cursor (skill §7: spatial
 * consistency) via an inline transform-origin, and dismissal plays the exit
 * leg before unmounting so the menu returns along its entry path.
 */
export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  // Viewport clamp: keep the ~240px-wide menu on screen; rows are ~32px tall.
  const hasWindow = typeof window !== "undefined";
  const clampedX = hasWindow ? Math.max(8, Math.min(x, window.innerWidth - 240)) : x;
  const clampedY = hasWindow ? Math.max(8, Math.min(y, window.innerHeight - items.length * 32)) : y;

  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(() => {
    const first = items.findIndex((it) => !it.sep && !it.disabled);
    return first >= 0 ? first : 0;
  });
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 120);
  }, [closing, onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const focusAt = (index: number): void => {
    const order = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !it.sep && !it.disabled)
      .map(({ i }) => i);
    if (order.length === 0) return;
    const next = (index + order.length) % order.length;
    const itemIndex = order[next]!;
    setActive(itemIndex);
    btnRefs.current[itemIndex]?.focus();
  };

  useEffect(() => {
    const close = () => requestClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        const order = items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => !it.sep && !it.disabled)
          .map(({ i }) => i);
        const pos = order.indexOf(active);
        const next = order[(pos + 1 + order.length) % order.length];
        if (next !== undefined) {
          setActive(next);
          btnRefs.current[next]?.focus();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const order = items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => !it.sep && !it.disabled)
          .map(({ i }) => i);
        const pos = order.indexOf(active);
        const prev = order[(pos - 1 + order.length) % order.length];
        if (prev !== undefined) {
          setActive(prev);
          btnRefs.current[prev]?.focus();
        }
      } else if (e.key === "Enter") {
        // When focus is on the menu container (not a button yet), Enter
        // activates the current item.
        const t = e.target as HTMLElement | null;
        if (t && t.getAttribute("role") === "menu") {
          e.preventDefault();
          const it = items[active];
          if (it && !it.sep && !it.disabled) {
            it.onClick();
            requestClose();
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [requestClose, items, active]);

  // Initial focus: first enabled item, so ArrowUp/Down continues from there.
  useEffect(() => {
    btnRefs.current[active]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anchor the scale to the cursor: when the menu flips to stay on screen,
  // the origin rides with the click point, not the box corner.
  const origin = `${x - clampedX}px ${y - clampedY}px`;
  return (
    <div
      className={closing ? "context-menu closing" : "context-menu"}
      role="menu"
      aria-label="Board actions"
      style={{ left: clampedX, top: clampedY, transformOrigin: origin }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          focusAt(items.indexOf(items[active]!) + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          focusAt(items.indexOf(items[active]!) - 1);
        } else if (e.key === "Enter") {
          const t = e.target as HTMLElement | null;
          if (t && t.getAttribute("role") === "menu") {
            e.preventDefault();
            const it = items[active];
            if (it && !it.sep && !it.disabled) {
              it.onClick();
              requestClose();
            }
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          requestClose();
        }
      }}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            role="menuitem"
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              it.onClick();
              requestClose();
            }}
            onMouseEnter={() => setActive(i)}
          >
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
