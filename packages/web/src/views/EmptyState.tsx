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
    <div className="empty-hero">
      <div className="empty-ambient-glow" />

      <div className="empty-badge">
        <span className="empty-badge-dot" />
        Lucent · Studio ready
      </div>

      <h1 className="empty-title">
        What are you thinking about?
      </h1>

      <p className="empty-sub">
        Describe an idea, a system, a flow. Lucent turns your words into an editable visual workspace
        you can shape as you talk.
      </p>

      {failedAttempt && (
        <div
          role="alert"
          style={{
            width: 640,
            maxWidth: "100%",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            border: "1px solid var(--sig-red)",
            borderRadius: "var(--r-lg)",
            background: "oklch(from var(--canvas-2) l c h / 0.85)",
            backdropFilter: "blur(16px)",
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

      <div className="empty-omnibar">
        <label className="sr-only" htmlFor="empty-state-prompt">
          Describe what you want to build
        </label>
        <input
          id="empty-state-prompt"
          className="empty-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="e.g. I'm building an e-commerce platform. Customers browse, add to cart, checkout, pay with Stripe…"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {onStartVoiceCall && (
            <button
              className={`icon-btn voice-call-btn ${voiceAgentActive ? "active" : ""}`}
              style={{
                background: voiceAgentActive
                  ? "linear-gradient(135deg, var(--sig-violet), oklch(0.55 0.18 280))"
                  : "oklch(from var(--sig-violet) l c h / 0.12)",
                color: voiceAgentActive ? "var(--canvas-0)" : "var(--sig-violet)",
                border: "1px solid oklch(from var(--sig-violet) l c h / 0.35)",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                boxShadow: voiceAgentActive ? "0 0 16px oklch(from var(--sig-violet) l c h / 0.4)" : undefined,
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
              background: listening ? "oklch(from var(--sig-red) l c h / 0.18)" : "var(--canvas-3)",
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
            style={{ flex: "none", padding: "0 18px", height: 34 }}
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
          maxWidth: 720,
          marginTop: 4,
        }}
      >
        {suggestions.map((s, i) => (
          <button
            key={i}
            className="empty-chip"
            onClick={() => onChange(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {onBlankBoard && (
        <button
          className="empty-blank-btn"
          onClick={onBlankBoard}
        >
          or start with a blank board <Ico.Arrow />
        </button>
      )}
    </div>
  );
}
