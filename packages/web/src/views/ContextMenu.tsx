import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Right-click context menu for the board (FigJam/Miro parity). Positioned at the
 * cursor; actions operate on the current selection. Closes on outside click,
 * scroll, or Escape.
 *
 * The enter/exit scale is anchored to the cursor (skill §7: spatial
 * consistency) via an inline transform-origin, and dismissal plays the exit
 * leg before unmounting so the menu returns along its entry path.
 *
 * Long choices (the eighteen diagram families) open as a DRILL-IN panel: the
 * item's `submenu` replaces the rows in place, with a Back row on top. A
 * flyout would need hover-intent timing and a second positioned layer; the
 * drill-in is one list, one cursor, and the same keyboard model at every depth
 * (ArrowRight/Enter opens, ArrowLeft/Escape goes back).
 */
export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  /** Tooltip — a diagram family carries its registry summary here. */
  title?: string;
  /** A non-interactive section heading (a family category). Never focused. */
  header?: boolean;
  /** Rows shown in place of this menu when the item is chosen; `onClick` is not run. */
  submenu?: MenuItem[];
  /** Radio state among alternatives (the current diagram kind); drawn as a dot. */
  checked?: boolean;
}

/** A rendered row: a caller's item, or the Back row a drill-in level adds. */
type Row = MenuItem & { back?: boolean };

/**
 * The items at a drill-in `path` (indices into each level's items), and the
 * item that opened the deepest valid level. Resolved from the CURRENT items on
 * every render rather than stored: the canvas rebuilds its items each render,
 * and a stored submenu array would keep the old closures — choosing a kind
 * would apply it to the board as it was when the menu opened. A path that no
 * longer resolves stops at the deepest level that still does.
 */
export function menuLevel(
  items: readonly MenuItem[],
  path: readonly number[],
): { items: readonly MenuItem[]; parent: MenuItem | null; depth: number } {
  let level = items;
  let parent: MenuItem | null = null;
  let depth = 0;
  for (const index of path) {
    const next = level[index];
    if (!next?.submenu || next.disabled) break;
    parent = next;
    level = next.submenu;
    depth++;
  }
  return { items: level, parent, depth };
}

/** Whether a row takes the keyboard cursor. */
function focusable(row: Row): boolean {
  return !row.sep && !row.header && !row.disabled;
}

/** Approximate row heights (CSS: 32px items, 9px separators), for the clamp. */
function rowHeight(row: Row): number {
  return row.sep ? 9 : row.header ? 26 : 32;
}

const HEADER_STYLE: React.CSSProperties = {
  padding: "8px 12px 4px",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};

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
  const [path, setPath] = useState<number[]>([]);
  const level = menuLevel(items, path);
  // A drill-in level leads with Back and a rule, so row index = item index + 2.
  const offset = level.depth > 0 ? 2 : 0;
  const rows: Row[] =
    level.depth > 0
      ? [
          { label: `‹ ${level.parent?.label ?? "Back"}`, onClick: () => {}, back: true },
          { label: "", onClick: () => {}, sep: true },
          ...level.items,
        ]
      : [...level.items];

  // Viewport clamp: keep the ~240px-wide menu on screen, and the whole list
  // inside the window (it scrolls past that — see maxHeight below).
  const hasWindow = typeof window !== "undefined";
  const height = rows.reduce((h, r) => h + rowHeight(r), 12);
  const clampedX = hasWindow ? Math.max(8, Math.min(x, window.innerWidth - 240)) : x;
  const clampedY = hasWindow
    ? Math.max(8, Math.min(y, window.innerHeight - Math.min(height, window.innerHeight - 16)))
    : y;

  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [active, setActive] = useState(() => {
    const first = items.findIndex((it) => focusable(it));
    return first >= 0 ? first : 0;
  });
  // Set when a drill-in or Back changes the rows: the next render moves focus.
  const focusPending = useRef(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 120);
  }, [closing, onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const order = rows.map((r, i) => (focusable(r) ? i : -1)).filter((i) => i >= 0);

  const move = (delta: number): void => {
    if (order.length === 0) return;
    const pos = order.indexOf(active);
    const next = order[(pos + delta + order.length) % order.length]!;
    setActive(next);
    btnRefs.current[next]?.focus();
  };

  /** Open the submenu of the item at `rowIndex`. */
  const openAt = (rowIndex: number): void => {
    const row = rows[rowIndex];
    if (!row?.submenu || row.disabled) return;
    const nextPath = [...path, rowIndex - offset];
    const next = menuLevel(items, nextPath);
    // Back row + rule come first; the cursor lands on the first real choice.
    const first = next.items.findIndex((it) => focusable(it));
    setPath(nextPath);
    setActive(first >= 0 ? first + 2 : 0);
    focusPending.current = true;
  };

  /** Return to the parent level, with the cursor on the item that opened this one. */
  const back = (): void => {
    if (path.length === 0) return;
    const opener = path[path.length - 1]!;
    const parentPath = path.slice(0, -1);
    setPath(parentPath);
    setActive(opener + (parentPath.length > 0 ? 2 : 0));
    focusPending.current = true;
  };

  const activate = (rowIndex: number): void => {
    const row = rows[rowIndex];
    if (!row || !focusable(row)) return;
    if (row.back) back();
    else if (row.submenu) openAt(rowIndex);
    else {
      row.onClick();
      requestClose();
    }
  };

  /**
   * One keyboard model for both listeners: the container's (focus inside the
   * menu) and the window's (focus left where the right-click happened).
   * Returns whether the key was handled.
   */
  const handleKey = (key: string, target: EventTarget | null): boolean => {
    switch (key) {
      case "ArrowDown":
        move(1);
        return true;
      case "ArrowUp":
        move(-1);
        return true;
      case "ArrowRight":
        if (rows[active]?.submenu) {
          openAt(active);
          return true;
        }
        return false;
      case "ArrowLeft":
        if (path.length > 0) {
          back();
          return true;
        }
        return false;
      case "Escape":
        // Escape backs out of a drill-in first, then closes — the way it
        // leaves a nested menu everywhere else.
        if (path.length > 0) back();
        else requestClose();
        return true;
      case "Enter": {
        // A focused row's own button handles Enter as a click; this covers
        // focus on the menu container itself (not a row yet).
        const t = target as HTMLElement | null;
        if (t && t.getAttribute("role") === "menu") {
          activate(active);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  };

  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;

  useEffect(() => {
    const close = () => requestClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    const onKey = (e: KeyboardEvent) => {
      if (handleKeyRef.current(e.key, e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [requestClose]);

  // Initial focus: first enabled item, so ArrowUp/Down continues from there.
  useEffect(() => {
    btnRefs.current[active]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a drill-in or Back, focus follows the cursor into the new rows.
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    btnRefs.current[active]?.focus();
  });

  // Anchor the scale to the cursor: when the menu flips to stay on screen,
  // the origin rides with the click point, not the box corner.
  const origin = `${x - clampedX}px ${y - clampedY}px`;
  return (
    <div
      className={closing ? "context-menu closing" : "context-menu"}
      role="menu"
      aria-label={level.parent?.label ?? "Board actions"}
      style={{
        left: clampedX,
        top: clampedY,
        transformOrigin: origin,
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (handleKey(e.key, e.target)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {rows.map((it, i) => {
        // Keyed by depth so a level's rows mount fresh (and replay their
        // entrance) instead of morphing out of the previous level's.
        const key = `${level.depth}-${i}`;
        if (it.sep) return <div key={key} className="ctx-sep" role="separator" />;
        if (it.header) {
          return (
            <div key={key} role="presentation" style={HEADER_STYLE}>
              {it.label}
            </div>
          );
        }
        const radio = it.checked !== undefined;
        return (
          <button
            key={key}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            role={radio ? "menuitemradio" : "menuitem"}
            {...(radio ? { "aria-checked": it.checked } : {})}
            {...(it.submenu ? { "aria-haspopup": "menu" as const } : {})}
            className={`ctx-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            title={it.title}
            onClick={() => activate(i)}
            onMouseEnter={() => setActive(i)}
          >
            {radio && (
              <span aria-hidden="true" style={{ display: "inline-block", width: 14 }}>
                {it.checked ? "●" : ""}
              </span>
            )}
            {it.label}
            {it.submenu && (
              <span
                aria-hidden="true"
                style={{ float: "right", marginLeft: 12, color: "var(--ink-3)" }}
              >
                ›
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
