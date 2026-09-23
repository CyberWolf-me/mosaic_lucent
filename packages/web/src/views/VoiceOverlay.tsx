import { useEffect } from "react";
import { Ico } from "../ui/icons.js";

/**
 * Atelier Live Voice Listening Overlay.
 * Shows the live interim and final speech transcript passed down while voice
 * listening is active, with animated audio wave bars and direct Submit/Cancel controls.
 */
export function VoiceOverlay({
  transcript = "",
  onSubmit,
  onCancel,
}: {
  transcript?: string;
  onSubmit?: () => void;
  onCancel?: () => void;
}) {
  useEffect(() => {
    if (!onSubmit && !onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      // The composer owns Enter/Escape while it has focus (it submits the
      // same transcript); handling them here too sent the turn twice.
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      if (e.key === "Escape" && onCancel) {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && !e.shiftKey && onSubmit && transcript.trim()) {
        e.preventDefault();
        onSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [transcript, onSubmit, onCancel]);

  return (
    <>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 100%, oklch(0.65 0.18 260 / 0.10) 0%, transparent 60%)",
          pointerEvents: "none",
          animation: "atelier-voice-breathe 3s ease-in-out infinite",
          zIndex: 30,
        }}
      />
      <style>{`
        @keyframes atelier-voice-breathe { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
        @keyframes atelier-pulse-recording { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
        @keyframes atelier-wave-1 { 0%, 100% { height: 6px; } 50% { height: 18px; } }
        @keyframes atelier-wave-2 { 0%, 100% { height: 14px; } 50% { height: 6px; } }
        @keyframes atelier-wave-3 { 0%, 100% { height: 8px; } 50% { height: 20px; } }
        @keyframes atelier-wave-4 { 0%, 100% { height: 16px; } 50% { height: 8px; } }
        @keyframes atelier-cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
      `}</style>

      <div
        role="dialog"
        aria-label="Voice transcription overlay"
        style={{
          position: "absolute",
          bottom: 112,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 35,
          width: 580,
          maxWidth: "calc(100vw - 40px)",
          padding: "18px 22px 16px",
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.8)",
          borderRadius: 18,
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          animation: "pop-in 0.2s var(--e-out)",
        }}
      >
        {/* Header: Recording Indicator + Audio Waveform */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              background: "oklch(from var(--madder) l c h / 0.1)",
              border: "1px solid oklch(from var(--madder) l c h / 0.25)",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "var(--madder)",
                boxShadow: "0 0 6px var(--madder)",
                animation: "atelier-pulse-recording 1.2s ease-in-out infinite",
              }}
            />
            <span
              className="mono-caps"
              style={{ fontSize: 10, color: "var(--madder)", fontWeight: 600 }}
            >
              LIVE · LISTENING
            </span>
          </div>

          {/* Mini Waveform Bars */}
          <div style={{ display: "flex", alignItems: "center", gap: 3, height: 20 }}>
            <span
              style={{
                width: 3,
                borderRadius: 2,
                background: "var(--bloom-2)",
                animation: "atelier-wave-1 0.8s ease-in-out infinite",
              }}
            />
            <span
              style={{
                width: 3,
                borderRadius: 2,
                background: "var(--bloom-2)",
                animation: "atelier-wave-2 0.7s ease-in-out infinite",
              }}
            />
            <span
              style={{
                width: 3,
                borderRadius: 2,
                background: "var(--bloom-2)",
                animation: "atelier-wave-3 0.9s ease-in-out infinite",
              }}
            />
            <span
              style={{
                width: 3,
                borderRadius: 2,
                background: "var(--bloom-2)",
                animation: "atelier-wave-4 0.75s ease-in-out infinite",
              }}
            />
          </div>

          <div style={{ flex: 1 }} />

          <button
            type="button"
            onClick={onCancel}
            title="Stop listening (Escape)"
            style={{
              border: 0,
              background: "none",
              cursor: "pointer",
              padding: 4,
              color: "var(--ink-3)",
              display: "grid",
              placeItems: "center",
              borderRadius: 6,
            }}
          >
            <Ico.X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Live Transcript Content */}
        <div
          style={{
            minHeight: 46,
            fontSize: 15,
            lineHeight: 1.55,
            fontFamily: transcript ? "inherit" : "var(--font-serif)",
            fontStyle: transcript ? "normal" : "italic",
            color: transcript ? "var(--ink-0)" : "var(--ink-3)",
            wordBreak: "break-word",
          }}
        >
          {transcript ? (
            <>
              &ldquo;{transcript}
              <span
                style={{
                  display: "inline-block",
                  width: 2,
                  height: 15,
                  background: "var(--bloom-2)",
                  verticalAlign: "text-bottom",
                  marginLeft: 3,
                  animation: "atelier-cursor-blink 0.9s steps(2) infinite",
                }}
              />
              &rdquo;
            </>
          ) : (
            "Speak naturally — describing components, architecture, or flows…"
          )}
        </div>

        {/* Action Controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 8,
            borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
          }}
        >
          <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Press <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "var(--paper-2)" }}>↵</kbd> to submit or <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "var(--paper-2)" }}>Esc</kbd> to cancel
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="btn-atelier ghost"
              onClick={onCancel}
              style={{ height: 28, fontSize: 11.5, padding: "0 10px" }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-atelier primary"
              onClick={onSubmit}
              disabled={!transcript.trim()}
              style={{
                height: 28,
                fontSize: 11.5,
                padding: "0 12px",
                opacity: transcript.trim() ? 1 : 0.5,
              }}
            >
              <Ico.Check style={{ width: 13, height: 13 }} />
              Submit
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
