import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * UX-7 design-system consolidation: the smallest shared primitives that let
 * every surface speak the same dialog/menu/field/badge language.
 *
 * Each primitive reuses the existing CSS classes (modal-scrim,
 * confirm-dialog, context-menu, auth-field, auth-input, billing-badge) so no
 * new visual language is introduced — consolidation, not a redesign.
 */

/**
 * Modal dialog: scrim + centred panel, Escape to close, focus in + back out.
 *
 * Dismissal plays the exit leg before unmounting (skill §7: symmetric
 * paths) — `onClose` fires ~130ms after the request so the materialize
 * animation can run in reverse instead of vanishing mid-frame.
 */
export function Dialog({
  onClose,
  label,
  title,
  children,
  className,
}: {
  onClose: () => void;
  /** Accessible name for the dialog (falls back to `title`). */
  label?: string;
  /** Optional heading rendered in the confirm-dialog title slot. */
  title?: string;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  const heading = title ?? label ?? "Dialog";
  const dialogRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(0);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 130);
  }, [closing, onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    // Initial focus: the first focusable control, else the dialog itself.
    const target =
      el?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? el;
    target?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Return focus to whatever opened the dialog.
      prev?.focus();
    };
  }, [requestClose]);

  const panelCls = `${className ? `confirm-dialog ${className}` : "confirm-dialog"}${closing ? " closing" : ""}`;
  return (
    <>
      <div className={closing ? "modal-scrim closing" : "modal-scrim"} onClick={requestClose} />
      <div
        ref={dialogRef}
        className={panelCls}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
      >
        {title ? <div className="confirm-title">{title}</div> : null}
        {children}
      </div>
    </>
  );
}

/**
 * Popup menu: ArrowUp/Down move, Enter activates, Escape closes, outside click closes.
 *
 * `origin` anchors the enter/exit scale to the trigger (skill §7) — pass the
 * button edge the menu drops from (e.g. "top center"). Defaults to the top
 * edge; the board context menu sets its own cursor-relative origin inline.
 */
export function Menu({
  onClose,
  children,
  label,
  className,
  style,
  origin,
}: {
  onClose: () => void;
  children: ReactNode;
  label?: string;
  className?: string;
  style?: CSSProperties;
  origin?: string;
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);

  const items = (): HTMLElement[] => {
    const root = rootRef.current;
    if (!root) return [];
    // Prefer explicit menuitems; fall back to any enabled button so plain
    // button children still navigate.
    const explicit = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (explicit.length > 0) return explicit.filter((el) => !(el as HTMLButtonElement).disabled);
    return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled])"));
  };

  const focusAt = (index: number): void => {
    const list = items();
    if (list.length === 0) return;
    const next = (index + list.length) % list.length;
    list[next]?.focus();
  };

  const activeIndex = (): number => items().indexOf(document.activeElement as HTMLElement);

  // Click-outside closes (mousedown so a press that starts outside never
  // lands inside the menu).
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label ?? "Menu"}
      tabIndex={-1}
      className={className ? `context-menu ${className}` : "context-menu"}
      style={origin ? { ...style, transformOrigin: origin } : style}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusAt(activeIndex() + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          focusAt(activeIndex() <= 0 ? items().length - 1 : activeIndex() - 1);
        } else if (e.key === "Enter") {
          // Buttons activate natively on Enter when focused; when focus is
          // still on the menu container, activate the first item.
          const t = e.target as HTMLElement;
          if (t === e.currentTarget) {
            e.preventDefault();
            (items()[0] as HTMLButtonElement | undefined)?.click();
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Labelled field: outer .field wrapper reusing the auth-field/input styling. */
export function Field({
  label,
  value,
  onChange,
  id,
  type,
  placeholder,
  disabled,
  autoFocus,
  required,
  name,
}: {
  label: string;
  value?: string;
  onChange?: (v: string) => void;
  id?: string;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  name?: string;
}): React.ReactElement {
  const autoId = useId();
  const inputId = id ?? `field-${autoId}`;
  return (
    <div className="field auth-field">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="field-input auth-input"
        type={type ?? "text"}
        value={value ?? ""}
        name={name}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        required={required}
        onChange={(e) => onChange?.(e.currentTarget.value)}
      />
    </div>
  );
}

export type BadgeTone = "default" | "info" | "success" | "warn" | "error";

/** Inline status span. The word does the work; the tone tint only confirms it. */
export function Badge({
  tone = "default",
  children,
  className,
}: {
  tone?: BadgeTone | string;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  const cls = className ? `badge badge-${tone} ${className}` : `badge badge-${tone}`;
  return (
    <span className={cls} data-tone={tone}>
      {children}
    </span>
  );
}

export type SyncDirection = "outbound" | "inbound" | "send" | "review" | string;

/**
 * The external-sync call to action. Single-verb contract: outbound always
 * reads "Send N to X", inbound always "Review N from X" — no synonyms, so
 * the button is recognisable everywhere it appears.
 */
export function SyncCTA({
  direction,
  count,
  provider,
  onClick,
  disabled,
  className,
}: {
  direction: SyncDirection;
  count: number;
  provider: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}): React.ReactElement {
  const d = String(direction).toLowerCase();
  const inbound = d.includes("inbound") || d.includes("review") || d.includes("from");
  // Single verb contract: exactly these two sentences, never Push/Sync/Apply.
  const text = inbound ? `Review ${count} from ${provider}` : `Send ${count} to ${provider}`;
  return (
    <button
      type="button"
      className={className ?? "btn primary"}
      onClick={onClick}
      disabled={disabled}
      aria-label={text}
    >
      {text}
    </button>
  );
}
