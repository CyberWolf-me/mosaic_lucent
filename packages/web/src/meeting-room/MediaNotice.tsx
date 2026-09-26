/**
 * A non-fatal media problem in a live call, on screen where the person is
 * looking (docs/28 F18). The call carries on; the notice says what failed
 * and what to do, and can be dismissed.
 */
export function MediaNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 8,
        background: "rgba(245, 158, 11, 0.14)",
        border: "1px solid rgba(245, 158, 11, 0.35)",
        color: "#fcd34d",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontSize: 14,
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
