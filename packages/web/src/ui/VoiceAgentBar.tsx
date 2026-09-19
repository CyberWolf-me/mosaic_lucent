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
        return "#f59e0b"; // amber
      case "agent_speaking":
        return "#8b5cf6"; // purple / indigo
      case "listening":
        return muted ? "#6b7280" : "#10b981"; // gray or green
      case "error":
        return "#ef4444"; // red
      default:
        return "#10b981";
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
        animation: "fadeIn 0.2s ease-out",
      }}
    >
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
        @keyframes waveform {
          0% { height: 3px; }
          100% { height: 14px; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translate(-50%, 8px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>
      {/* Active Speech Subtitle Banner */}
      {transcript && transcript.trim().length > 0 && (
        <div
          style={{
            background: "rgba(17, 24, 39, 0.85)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255, 255, 255, 0.12)",
            borderRadius: 12,
            padding: "8px 16px",
            color: "#f3f4f6",
            fontSize: 13,
            lineHeight: "1.4",
            textAlign: "center",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
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
          background: "rgba(15, 23, 42, 0.92)",
          backdropFilter: "blur(16px)",
          border: `1px solid ${state === "agent_speaking" ? "rgba(139, 92, 246, 0.4)" : "rgba(255, 255, 255, 0.15)"}`,
          borderRadius: 999,
          boxShadow: `0 12px 36px rgba(0, 0, 0, 0.35)${state === "agent_speaking" ? ", 0 0 20px rgba(139, 92, 246, 0.25)" : ""}`,
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
                  ? "pulse 1.5s infinite"
                  : "none",
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: "#e2e8f0",
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
                  background: "#a78bfa",
                  borderRadius: 2,
                  display: "inline-block",
                  animation: `waveform 0.8s infinite ease-in-out alternate ${i * 0.1}s`,
                }}
              />
            ))}
          </div>
        )}

        <div style={{ width: 1, height: 16, background: "rgba(255, 255, 255, 0.15)" }} />

        {/* Mute/Unmute Mic Button */}
        <button
          onClick={onToggleMute}
          title={muted ? "Unmute microphone" : "Mute microphone"}
          style={{
            background: muted ? "rgba(239, 68, 68, 0.2)" : "rgba(255, 255, 255, 0.1)",
            border: `1px solid ${muted ? "rgba(239, 68, 68, 0.4)" : "rgba(255, 255, 255, 0.15)"}`,
            color: muted ? "#f87171" : "#f1f5f9",
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
            background: "#dc2626",
            border: "1px solid #ef4444",
            color: "#ffffff",
            width: 30,
            height: 30,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(220, 38, 38, 0.4)",
            transition: "all 0.15s ease",
          }}
        >
          <Ico.PhoneOff />
        </button>
      </div>
    </div>
  );
}
