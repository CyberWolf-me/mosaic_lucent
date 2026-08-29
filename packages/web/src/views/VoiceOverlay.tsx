import { Ico } from "../ui/icons.js";

/** Live listening overlay, ported from reference/screen_voice.jsx. Shows the
 * live interim transcript passed down from the AI pill's message value while
 * push-to-talk is active. */
export function VoiceOverlay({ transcript = "" }: { transcript?: string }) {
  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 100%, oklch(0.82 0.15 75 / 0.08) 0%, transparent 55%)",
          pointerEvents: "none",
          animation: "breathe 3s ease-in-out infinite",
        }}
      />
      <style>{`@keyframes breathe { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } } @keyframes blink { 50% { opacity: 0; } }`}</style>

      <div
        style={{
          position: "absolute",
          bottom: 108,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 35,
          maxWidth: 640,
          padding: "14px 20px",
          background: "oklch(from var(--canvas-2) l c h / 0.9)",
          backdropFilter: "blur(24px)",
          border: "1px solid oklch(0.82 0.15 75 / 0.35)",
          borderRadius: "var(--r-xl)",
          boxShadow: "0 0 0 4px oklch(0.82 0.15 75 / 0.06), var(--elev-3)",
          display: "flex",
          gap: 12,
          alignItems: "flex-start",
        }}
      >
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            flexShrink: 0,
            background: "var(--canvas-3)",
            color: "var(--ink-1)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Ico.User />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--amber-1)",
              marginBottom: 4,
              display: "flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "var(--amber-1)",
                boxShadow: "0 0 8px var(--amber-glow)",
                animation: "pulse-amber 1.2s ease-in-out infinite",
              }}
            />
            Transcribing…
          </div>
          <div
            style={{
              fontSize: 15,
              color: transcript ? "var(--ink-0)" : "var(--ink-3)",
              lineHeight: 1.5,
            }}
          >
            "{transcript || "Listening — start speaking"}
            <span
              style={{
                display: "inline-block",
                width: 2,
                height: 15,
                background: "var(--amber-1)",
                verticalAlign: "text-bottom",
                marginLeft: 2,
                animation: "blink 1s steps(2) infinite",
              }}
            />
            "
          </div>
        </div>
      </div>
    </>
  );
}
