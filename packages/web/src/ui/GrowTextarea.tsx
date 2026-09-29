import { useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";

/**
 * A prompt field that grows with its text, the way ChatGPT and Claude do:
 * one line to start, taller as you type, then a scrollbar once it reaches
 * `maxHeight` so it never eats the screen. Enter sends; Shift+Enter (or
 * Alt/Ctrl+Enter) makes a newline. It reports when it crosses one line so a
 * pill-shaped container can relax its corners.
 *
 * It replaces the single-line `<input>`s the composer used, where a long
 * prompt scrolled sideways through a slot that showed one line at a time.
 */
export function GrowTextarea({
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  className,
  ariaLabel,
  autoFocus,
  maxHeight = 200,
  onMultilineChange,
  style,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Tallest the field grows before it scrolls, in px. */
  maxHeight?: number;
  /** Fires when the text crosses from one line to more, and back. */
  onMultilineChange?: (multiline: boolean) => void;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wasMulti = useRef(false);
  // Read the latest callback without making it a resize dependency.
  const notifyMulti = useRef(onMultilineChange);
  notifyMulti.current = onMultilineChange;

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Measure the content's natural height from zero, then clamp.
    el.style.height = "0px";
    const full = el.scrollHeight;
    const next = Math.min(full, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = full > maxHeight ? "auto" : "hidden";
    const multi = full - padV > lineHeight * 1.5;
    if (multi !== wasMulti.current) {
      wasMulti.current = multi;
      notifyMulti.current?.(multi);
    }
  };

  // Before paint, so the field never flashes at the wrong height.
  useLayoutEffect(resize, [value, maxHeight]);
  // And once more after mount for fonts that settle late.
  useEffect(() => {
    const t = setTimeout(resize, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <textarea
      id={id}
      ref={ref}
      rows={1}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      className={className}
      placeholder={placeholder}
      aria-label={ariaLabel}
      style={{ resize: "none", ...style }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // A newline: Shift/Alt/Ctrl+Enter, or an IME candidate being chosen.
        if (e.shiftKey || e.altKey || e.ctrlKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (!disabled) onSubmit?.();
      }}
    />
  );
}
