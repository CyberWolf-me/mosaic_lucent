import type { ConversationState } from "../meeting-voice.js";

/**
 * A debug voice-state HUD (docs/26 §7 verification). Renders the live state of
 * the meeting voice loop — STT, TTS, the conversational lease, and the turn
 * count — so the LISTENING → SPEAKING → LISTENING transitions (and the STT
 * "reset" bug) are visible at a glance instead of inferred from the transcript.
 *
 * Purely presentational: it takes a snapshot and draws it, so it renders the
 * same whether driven by the live meeting or a test. It is opt-in — the meeting
 * view mounts it only when `?voicehud=1` is in the URL — so it never shows in
 * the ordinary product surface (the Atelier "no debug chrome" rule).
 */

export interface VoiceHudSnapshot {
  recording: boolean;
  /** STT lifecycle: idle | connecting | listening | transcribing. */
  sttStatus: string;
  ttsSpeaking: boolean;
  /** The conversational-lease FSM state. */
  conversation: ConversationState;
  /** Seconds left on the active lease (0 when dormant). */
  leaseRemainingSec: number;
  /** The speaker the lease is bound to, if any. */
  leaseSpeaker?: string;
  /** The most recent transcribed speaker. */
  lastSpeaker?: string;
  turnCount: number;
  /** Microphone hardware state. */
  micStatus?: "ACTIVE" | "MUTED" | "STANDBY";
  /** Voice Activity Detection (VAD) speech presence verdict. */
  vadStatus?: "SPEECH" | "SILENCE" | "DETECTING" | "OFF";
  /** Recent transcribed text snippet. */
  lastTranscript?: string;
  /** Echo suppression status (protects mic against hearing Lucent's own speaker audio). */
  echoSuppressionActive?: boolean;
}

/** A coarse, human label for what the loop is doing right now. */
export function voiceMacroState(
  s: VoiceHudSnapshot,
): "SPEAKING" | "PROCESSING" | "LISTENING" | "IDLE" {
  if (s.ttsSpeaking || s.conversation === "ai_responding") return "SPEAKING";
  if (s.conversation === "invoked") return "PROCESSING";
  if (s.recording) return "LISTENING";
  return "IDLE";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ color: "#8a8a94" }}>{label}</span>
      <span style={{ color: "#e6e6ea", fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function VoiceStateHud({ snapshot }: { snapshot: VoiceHudSnapshot }) {
  const macro = voiceMacroState(snapshot);
  const macroColor =
    macro === "SPEAKING"
      ? "#ff8f4f"
      : macro === "PROCESSING"
        ? "#ffcf4f"
        : macro === "LISTENING"
          ? "#43c59e"
          : "#8a8a94";
  return (
    <aside
      className="voice-hud"
      aria-label="Voice state debug HUD"
      data-macro={macro}
      style={{
        position: "fixed",
        top: 64,
        right: 16,
        zIndex: 1300,
        width: 220,
        padding: "10px 12px",
        background: "rgba(16, 18, 24, 0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 10,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11.5,
        lineHeight: 1.7,
        color: "#e6e6ea",
        boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <span style={{ letterSpacing: 0.5, color: "#8a8a94" }}>VOICE STATE</span>
        <span style={{ color: macroColor, fontWeight: 700 }} data-testid="voice-macro">
          {macro}
        </span>
      </div>
      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.10)",
          paddingTop: 6,
          display: "grid",
          gap: 2,
        }}
      >
        <Row label="MIC" value={snapshot.micStatus ?? (snapshot.recording ? "ACTIVE" : "STANDBY")} />
        <Row label="VAD" value={snapshot.vadStatus ?? (snapshot.recording ? "DETECTING" : "OFF")} />
        <Row label="STT" value={snapshot.recording ? snapshot.sttStatus.toUpperCase() : "OFF"} />
        <Row label="TTS" value={snapshot.ttsSpeaking ? "SPEAKING" : "IDLE"} />
        <Row
          label="Echo"
          value={(snapshot.echoSuppressionActive ?? snapshot.ttsSpeaking) ? "SUPPRESSED" : "PASS"}
        />
        <Row label="Lease" value={snapshot.conversation.toUpperCase()} />
        <Row
          label="Window"
          value={snapshot.leaseRemainingSec > 0 ? `${snapshot.leaseRemainingSec}s` : "—"}
        />
        <Row label="Speaker" value={snapshot.leaseSpeaker ?? snapshot.lastSpeaker ?? "—"} />
        <Row label="Turn" value={String(snapshot.turnCount)} />
        {snapshot.lastTranscript && (
          <Row
            label="Snippet"
            value={
              snapshot.lastTranscript.length > 20
                ? snapshot.lastTranscript.slice(0, 18) + "…"
                : snapshot.lastTranscript
            }
          />
        )}
      </div>
    </aside>
  );
}
