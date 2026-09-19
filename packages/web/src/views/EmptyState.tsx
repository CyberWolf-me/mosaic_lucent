import { Ico } from "../ui/icons.js";
import { useToast } from "../ui/Toast.js";

/** The "magic moment" hero, ported from reference/screen_empty.jsx. */
export function EmptyState({
  value,
  onChange,
  onSubmit,
  onSpeak,
  onBlankBoard,
  failedAttempt,
  onStartVoiceCall,
  voiceAgentActive,
  listening,
  onGenImage,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onSpeak: () => void;
  onBlankBoard?: () => void;
  onStartVoiceCall?: () => void;
  voiceAgentActive?: boolean;
  listening?: boolean;
  onGenImage?: () => void;
  failedAttempt?: { text: string; retryPrompt?: string } | null;
}) {
  const { notify } = useToast();
  const suggestions = [
    "An e-commerce platform with Stripe payments",
    "The architecture for a real-time chat app",
    "A user journey for SaaS onboarding",
    "Mind map for a new product launch",
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        padding: "0 40px",
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 640,
          height: 640,
          background: "radial-gradient(circle, oklch(0.82 0.15 75 / 0.06) 0%, transparent 60%)",
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--amber-1)",
            boxShadow: "0 0 10px var(--amber-glow)",
          }}
        />
        Lucent · Session ready
      </div>

      <h1
        style={{
          fontSize: 48,
          letterSpacing: "-0.028em",
          fontVariationSettings: "'wght' 400",
          textAlign: "center",
          lineHeight: 1.05,
          maxWidth: 720,
          background: "linear-gradient(180deg, oklch(0.99 0 0), oklch(0.72 0.006 60))",
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}
      >
        What are you thinking about?
      </h1>

      <p
        style={{
          fontSize: 14,
          color: "var(--ink-2)",
          maxWidth: 460,
          textAlign: "center",
          lineHeight: 1.55,
        }}
      >
        Describe an idea, a system, a flow. Lucent turns your words into a visual workspace you can
        shape as you talk.
      </p>

      {failedAttempt && (
        <div
          role="alert"
          style={{
            width: 620,
            maxWidth: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            border: "1px solid var(--sig-red)",
            borderRadius: "var(--r-lg)",
            background: "oklch(from var(--canvas-2) l c h / 0.85)",
          }}
        >
          <span style={{ color: "var(--sig-red)", fontSize: 15 }}>⚠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: "var(--ink-0)", lineHeight: 1.45 }}>
              That didn't work — the board is still empty, your request wasn't lost.
            </div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                marginTop: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "pre-wrap",
              }}
            >
              {failedAttempt.text}
            </div>
          </div>
          {failedAttempt.retryPrompt && (
            <button
              className="btn amber"
              style={{ flex: "none", height: 30, padding: "0 14px", fontSize: 12 }}
              onClick={() => {
                if (failedAttempt.retryPrompt) onChange(failedAttempt.retryPrompt);
              }}
              title="Put the request back in the box, ready to send again"
            >
              Try again
            </button>
          )}
        </div>
      )}

      <div
        style={{
          width: 620,
          marginTop: 12,
          background: "oklch(from var(--canvas-2) l c h / 0.75)",
          backdropFilter: "blur(20px) saturate(1.5)",
          border: "1px solid var(--stroke-2)",
          borderRadius: "var(--r-xl)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          boxShadow: "var(--elev-2)",
        }}
      >
        <label className="sr-only" htmlFor="empty-state-prompt">
          Describe what you want to build
        </label>
        <input
          id="empty-state-prompt"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="e.g. I'm building an e-commerce platform. Customers browse, add to cart, checkout, pay with Stripe…"
          style={{
            fontSize: 15,
            color: "var(--ink-0)",
            width: "100%",
            padding: "2px 4px",
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {onStartVoiceCall && (
            <button
              className={`icon-btn voice-call-btn ${voiceAgentActive ? "active" : ""}`}
              style={{
                background: voiceAgentActive
                  ? "linear-gradient(135deg, #8b5cf6, #6366f1)"
                  : "rgba(139, 92, 246, 0.15)",
                color: voiceAgentActive ? "#ffffff" : "#a78bfa",
                border: "1px solid rgba(139, 92, 246, 0.45)",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                boxShadow: voiceAgentActive ? "0 0 12px rgba(139, 92, 246, 0.5)" : undefined,
              }}
              onClick={onStartVoiceCall}
              title="Live Duplex Voice Call (Talk conversationally with Lucent AI co-pilot)"
            >
              <Ico.Phone style={{ width: 14, height: 14 }} />
              {voiceAgentActive ? "In Call…" : "Live Call"}
            </button>
          )}
          <button
            className={`icon-btn ${listening ? "active" : ""}`}
            style={{
              background: listening ? "rgba(239, 68, 68, 0.2)" : "var(--canvas-3)",
              color: listening ? "var(--sig-red)" : "inherit",
              border: listening ? "1px solid var(--sig-red)" : undefined,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
            onClick={onSpeak}
            title={listening ? "Listening… click to submit" : "Voice Dictation (transcribe speech into prompt)"}
          >
            <Ico.Mic2 /> {listening ? "Listening…" : "Speak"}
          </button>
          {onGenImage && (
            <button
              className="icon-btn"
              style={{ background: "var(--canvas-3)", display: "inline-flex", alignItems: "center", gap: 6 }}
              onClick={onGenImage}
              title="Generate reference image or logo with AI"
            >
              <Ico.Sparkle /> Image / Logo
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() =>
              notify(
                "File attachments are coming soon — describe it in words for now.",
                <Ico.Attach />,
              )
            }
          >
            <Ico.Attach /> Attach
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
            Enter to send
          </span>
          <button
            className="btn amber"
            style={{ flex: "none", padding: "0 16px", height: 34 }}
            onClick={onSubmit}
          >
            Begin <Ico.Arrow />
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 700,
          marginTop: 6,
        }}
      >
        {suggestions.map((s, i) => (
          <button
            key={i}
            onClick={() => onChange(s)}
            style={{
              fontSize: 12,
              color: "var(--ink-2)",
              padding: "6px 12px",
              border: "1px solid var(--stroke-1)",
              borderRadius: 999,
              background: "oklch(from var(--canvas-1) l c h / 0.5)",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {onBlankBoard && (
        <button
          onClick={onBlankBoard}
          style={{
            fontSize: 12.5,
            color: "var(--ink-2)",
            marginTop: 4,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          or start with a blank board <Ico.Arrow />
        </button>
      )}
    </div>
  );
}
