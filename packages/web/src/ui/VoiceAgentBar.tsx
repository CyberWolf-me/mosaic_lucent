import React from "react";
import { Ico } from "./icons.js";
import type { VoiceAgentState } from "../stt/voiceAgentSession.js";

export interface VoiceAgentBarProps {
  state: VoiceAgentState;
  muted: boolean;
  transcript?: string;
  onToggleMute: () => void;
  onDisconnect: () => void;
}

export function VoiceAgentBar({
  state,
  muted,
  transcript,
  onToggleMute,
  onDisconnect,
}: VoiceAgentBarProps) {
  if (state === "idle" || state === "disconnected") return null;

  const getStatusText = () => {
    switch (state) {
      case "connecting":
        return "Connecting Voice Agent…";
      case "agent_speaking":
        return "Lucent Speaking…";
      case "listening":
        return muted ? "Microphone Muted" : "Listening to you…";
      case "error":
        return "Connection issue";
      default:
        return "Live Call";
    }
  };

  const getStatusColor = () => {
    switch (state) {
      case "connecting":
        return "var(--amber-1)";
      case "agent_speaking":
        return "var(--amber-2)";
      case "listening":
        return muted ? "var(--ink-3)" : "var(--sig-green)";
      case "error":
        return "var(--sig-red)";
      default:
        return "var(--sig-green)";
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        bottom: 90,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        maxWidth: 580,
        width: "90%",
        pointerEvents: "auto",
        animation: "voice-fade-in 0.2s ease-out",
      }}
    >
      {/* Active Speech Subtitle Banner */}
      {transcript && transcript.trim().length > 0 && (
        <div
          style={{
            background: "oklch(from var(--canvas-2) l c h / 0.9)",
            backdropFilter: "blur(16px)",
            border: "1px solid var(--stroke-2)",
            borderRadius: 12,
            padding: "8px 16px",
            color: "var(--ink-0)",
            fontSize: 13,
            lineHeight: "1.4",
            textAlign: "center",
            boxShadow: "var(--elev-3)",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {transcript}
        </div>
      )}

      {/* Main Voice Agent Control Pill */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 14px",
          background: "oklch(from var(--canvas-2) l c h / 0.92)",
          backdropFilter: "blur(16px)",
          border: `1px solid ${state === "agent_speaking" ? "var(--amber-2)" : "var(--stroke-2)"}`,
          borderRadius: 999,
          boxShadow: `var(--elev-3)${state === "agent_speaking" ? ", 0 0 20px var(--amber-glow)" : ""}`,
        }}
      >
        {/* Pulsing Status Orb / Audio Bars */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: getStatusColor(),
              display: "inline-block",
              boxShadow: `0 0 8px ${getStatusColor()}`,
              animation:
                state === "agent_speaking" || (state === "listening" && !muted)
                  ? "voice-pulse 1.5s infinite"
                  : "none",
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: "var(--ink-0)",
              fontFamily: "var(--font-sans)",
            }}
          >
            {getStatusText()}
          </span>
        </div>

        {/* Audio Waveform Animation (Visible while speaking) */}
        {state === "agent_speaking" && (
          <div style={{ display: "flex", alignItems: "center", gap: 3, height: 14 }}>
            {[1, 2, 3, 4, 3, 2, 1].map((h, i) => (
              <span
                key={i}
                style={{
                  width: 2.5,
                  height: `${h * 3.5}px`,
                  background: "var(--amber-1)",
                  borderRadius: 2,
                  display: "inline-block",
                  animation: `wave 0.8s infinite ease-in-out alternate ${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        )}

        <div style={{ width: 1, height: 16, background: "var(--stroke-1)" }} />

        {/* Mute/Unmute Mic Button */}
        <button
          onClick={onToggleMute}
          title={muted ? "Unmute microphone" : "Mute microphone"}
          style={{
            background: muted ? "oklch(0.72 0.15 25 / 0.18)" : "var(--canvas-3)",
            border: `1px solid ${muted ? "var(--sig-red)" : "var(--stroke-1)"}`,
            color: muted ? "var(--sig-red)" : "var(--ink-1)",
            width: 30,
            height: 30,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          {muted ? <Ico.MicOff /> : <Ico.Mic />}
        </button>

        {/* End Call Button */}
        <button
          onClick={onDisconnect}
          title="End Voice Call"
          style={{
            background: "var(--sig-red)",
            border: "1px solid var(--sig-red)",
            color: "var(--canvas-0)",
            width: 30,
            height: 30,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            boxShadow: "0 2px 8px oklch(0.72 0.15 25 / 0.35)",
            transition: "all 0.15s ease",
          }}
        >
          <Ico.PhoneOff />
        </button>
      </div>
    </div>
  );
}
