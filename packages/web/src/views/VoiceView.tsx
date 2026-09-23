import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { useSettings } from "../settings.js";
import { Ico } from "../ui/icons.js";
import { GlobalRail } from "../ui/atelierAtoms.js";
import { getSttProvider, isAnyVoiceSupported } from "../stt/index.js";
import type { VoiceSession } from "../stt/index.js";

/**
 * Screen 05 — Voice (full-screen live session).
 *
 * Replaces the embedded v2 prototype iframe with a native screen wired to the
 * real STT provider stack (browser / whisper / livekit / hosted). Left panel is
 * the live transcript; right panel is the live capture the user can apply to the
 * board through the same `send()` pipeline the canvas composer uses, so a spoken
 * idea becomes real, validated board operations.
 */

interface Utterance {
  speaker: string;
  text: string;
  time: string;
}

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Lightweight live preview of proper-noun-ish entities in the transcript. */
function extractEntities(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const key = m.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out.slice(0, 6);
}

export function VoiceView({
  onOpenSettings: _onOpenSettings,
}: {
  onOpenSettings?: (section?: string) => void;
}) {
  const { send, setView } = useWorkspace() as unknown as {
    send: (text: string) => Promise<void>;
    setView: (v: View) => void;
  };
  const [settings] = useSettings();
  const supported = isAnyVoiceSupported();

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [applying, setApplying] = useState(false);

  const sessionRef = useRef<VoiceSession | null>(null);
  const sessionIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startedAtRef = useRef<number>(Date.now());

  const stopSession = useCallback(() => {
    sessionIdRef.current++;
    sessionRef.current?.stop();
    sessionRef.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const startSession = useCallback(() => {
    if (!supported || sessionRef.current) return;
    const id = ++sessionIdRef.current;
    const provider = getSttProvider(settings.sttProvider);
    provider.configure?.({
      url: settings.livekitUrl,
      tokenUrl: settings.livekitTokenUrl,
      room: settings.livekitRoom,
    });
    const session = provider.start({
      onStart: () => {
        if (sessionIdRef.current !== id) return;
        setListening(true);
        startedAtRef.current = Date.now();
      },
      onInterim: (t) => {
        if (sessionIdRef.current !== id) return;
        setInterim(t);
      },
      onFinal: (t, meta) => {
        if (sessionIdRef.current !== id) return;
        const cleaned = t.trim();
        if (!cleaned) return;
        setUtterances((prev) => [
          ...prev,
          {
            speaker: meta?.speaker ?? "You",
            text: cleaned,
            time: clock(Math.floor((Date.now() - startedAtRef.current) / 1000)),
          },
        ]);
        setInterim("");
      },
      onError: () => {
        if (sessionIdRef.current !== id) return;
        stopSession();
      },
    });
    if (session) sessionRef.current = session;
  }, [supported, settings, stopSession]);

  // Auto-start on mount; tear the session down on unmount.
  useEffect(() => {
    startSession();
    return () => stopSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer runs while listening.
  useEffect(() => {
    if (!listening) return;
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [listening]);

  // Keep the transcript scrolled to the newest line.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [utterances, interim]);

  const fullTranscript = utterances.map((u) => u.text).join(" ").trim();
  const captured = (fullTranscript + (interim ? ` ${interim}` : "")).trim();
  const entities = extractEntities(captured);

  const applyToBoard = async () => {
    const text = fullTranscript || interim.trim();
    if (!text) return;
    setApplying(true);
    stopSession();
    setView("canvas" as View);
    void send(text);
  };

  const stopAndReview = () => {
    stopSession();
    setView("review" as View);
  };

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--paper-1)" }}>
      <div className="paper-bg" />
      <div className="paper-grain" />
      <GlobalRail active="meeting" />

      <VoiceTopBar
        listening={listening}
        elapsed={elapsed}
        onStop={stopAndReview}
      />

      <div style={{ position: "absolute", top: 48, bottom: 0, left: 84, right: 0, display: "flex" }}>
        <VoiceTranscript
          scrollRef={scrollRef}
          utterances={utterances}
          interim={interim}
          listening={listening}
          supported={supported}
          elapsed={elapsed}
        />
        <VoiceExtraction
          captured={captured}
          entities={entities}
          listening={listening}
          applying={applying}
          onToggleMic={listening ? stopSession : startSession}
          onDiscard={() => {
            setUtterances([]);
            setInterim("");
          }}
          onApply={() => void applyToBoard()}
        />
      </div>
    </div>
  );
}

function VoiceTopBar({
  listening,
  elapsed,
  onStop,
}: {
  listening: boolean;
  elapsed: number;
  onStop: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 48,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 20px",
        zIndex: 40,
        background: "oklch(from var(--paper-1) l c h / 0.9)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
      }}
    >
      <div
        className="brand"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-serif)",
          fontSize: 14,
          fontWeight: 500,
        }}
      >
        <div className="brand-mark" style={{ width: 22, height: 22 }} />
        Lucent
      </div>
      <span style={{ color: "var(--ink-3)" }}>·</span>
      <span className="crumb current" style={{ whiteSpace: "nowrap" }}>
        Voice
      </span>
      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px 5px 8px",
          background: `oklch(from var(--madder) l c h / ${listening ? 0.1 : 0.06})`,
          border: "1px solid oklch(from var(--madder) l c h / 0.3)",
          borderRadius: 999,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--madder)",
          letterSpacing: "0.03em",
          fontWeight: 600,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: "var(--madder)",
            animation: listening ? "pulse-bloom 1.4s ease-in-out infinite" : "none",
            opacity: listening ? 1 : 0.4,
          }}
        />
        {listening ? "LIVE" : "PAUSED"} · {clock(elapsed)}
      </div>

      <button className="icon-btn" onClick={onStop} title="Stop voice session · review extractions">
        <Ico.X /> Stop
      </button>
    </div>
  );
}

function SpeakerChip({
  initials,
  color,
  size = 26,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        color: "white",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: size * 0.4,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function Waveform({ bars = 5, active = true }: { bars?: number; active?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: 16 }}>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: active ? "100%" : "30%",
            background: "var(--bloom-2)",
            borderRadius: 2,
            animation: active ? `wave ${0.8 + (i % 4) * 0.12}s ease-in-out infinite` : "none",
            animationDelay: `${i * 90}ms`,
          }}
        />
      ))}
    </div>
  );
}

const SPEAKER_COLOR: Record<string, string> = {
  You: "oklch(0.55 0.16 25)",
  Alex: "oklch(0.55 0.16 25)",
  Sarah: "oklch(0.55 0.11 220)",
  Lucent: "var(--bloom-2)",
};

function speakerColor(name: string): string {
  return SPEAKER_COLOR[name] ?? "oklch(0.5 0.14 265)";
}

function VoiceTranscript({
  scrollRef,
  utterances,
  interim,
  listening,
  supported,
  elapsed,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  utterances: Utterance[];
  interim: string;
  listening: boolean;
  supported: boolean;
  elapsed: number;
}) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div
        style={{
          padding: "20px 40px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.3)",
        }}
      >
        <div className="mono-caps">In this session</div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px 3px 3px",
            background: "oklch(from var(--paper-2) l c h / 0.7)",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          <SpeakerChip initials="Y" color={speakerColor("You")} size={22} />
          You
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: listening ? "var(--moss)" : "var(--ink-3)",
              marginLeft: 4,
            }}
          />
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "20px 30px 40px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div className="mono-caps" style={{ marginBottom: 10, color: "var(--ink-3)" }}>
            {supported
              ? `Live transcript · ${utterances.length} utterance${utterances.length === 1 ? "" : "s"} so far`
              : "Voice input isn't supported in this browser"}
          </div>

          {!supported && (
            <div
              style={{
                padding: 16,
                borderRadius: "var(--r-md)",
                background: "oklch(from var(--paper-0) l c h / 0.6)",
                border: "1px dashed oklch(from var(--paper-4) l c h / 0.7)",
                fontSize: 13.5,
                color: "var(--ink-2)",
                lineHeight: 1.55,
              }}
            >
              Try Chrome or Edge for the built-in Web Speech engine, or choose on-device Whisper in
              Settings → Voice. You can still describe your idea by typing on the board.
            </div>
          )}

          {utterances.map((u, i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "10px 0" }}>
              <SpeakerChip initials={u.speaker.charAt(0).toUpperCase()} color={speakerColor(u.speaker)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-0)" }}>
                    {u.speaker}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                    {u.time}
                  </span>
                </div>
                <div style={{ fontSize: 15, color: "var(--ink-1)", lineHeight: 1.55 }}>{u.text}</div>
              </div>
            </div>
          ))}

          {(interim || (listening && utterances.length === 0)) && (
            <div
              style={{
                display: "flex",
                gap: 12,
                padding: "10px 14px",
                borderRadius: "var(--r-md)",
                background: "oklch(from var(--bloom-1) l c h / 0.06)",
                border: "1px dashed var(--bloom-wash-2)",
                marginTop: 4,
              }}
            >
              <SpeakerChip initials="Y" color={speakerColor("You")} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-0)" }}>You</span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                    {clock(elapsed)} · speaking
                  </span>
                  <div style={{ marginLeft: 6 }}>
                    <Waveform bars={5} active={listening} />
                  </div>
                </div>
                <div
                  style={{
                    fontSize: 15.5,
                    color: "var(--ink-0)",
                    lineHeight: 1.55,
                    fontFamily: "var(--font-serif)",
                    fontStyle: "italic",
                  }}
                >
                  &ldquo;{interim || "Speak naturally — describe components, architecture, or flows"}
                  <span
                    style={{
                      display: "inline-block",
                      width: 2,
                      height: 20,
                      background: "var(--bloom-2)",
                      marginLeft: 2,
                      verticalAlign: -3,
                      animation: "pulse-bloom 1s ease-in-out infinite",
                    }}
                  />
                  &rdquo;
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VoiceExtraction({
  captured,
  entities,
  listening,
  applying,
  onToggleMic,
  onDiscard,
  onApply,
}: {
  captured: string;
  entities: string[];
  listening: boolean;
  applying: boolean;
  onToggleMic: () => void;
  onDiscard: () => void;
  onApply: () => void;
}) {
  const hasCapture = captured.length > 0;
  return (
    <div
      style={{
        width: 380,
        borderLeft: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
        background: "oklch(from var(--paper-0) l c h / 0.55)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "16px 18px 12px",
          borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: "var(--bloom-1)",
            boxShadow: "0 0 10px var(--bloom-glow)",
            animation: listening ? "pulse-bloom 1.4s ease-in-out infinite" : "none",
          }}
        />
        <div style={{ fontSize: 13.5, fontWeight: 500, fontFamily: "var(--font-serif)" }}>
          Live capture
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
        <div
          style={{
            padding: 14,
            marginBottom: 14,
            background: "oklch(from var(--bloom-1) l c h / 0.05)",
            border: "1px solid var(--bloom-wash-2)",
            borderRadius: "var(--r-md)",
          }}
        >
          <div className="mono-caps" style={{ color: "var(--bloom-2)", marginBottom: 8 }}>
            Transcript
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: hasCapture ? "var(--ink-0)" : "var(--ink-3)",
              lineHeight: 1.5,
              fontFamily: "var(--font-serif)",
              fontStyle: hasCapture ? "normal" : "italic",
            }}
          >
            {hasCapture ? captured : "Waiting for speech…"}
          </div>
        </div>

        {entities.length > 0 && (
          <>
            <div className="mono-caps" style={{ marginBottom: 8 }}>
              Entities mentioned
            </div>
            {entities.map((e, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "9px 12px",
                  marginBottom: 6,
                  borderRadius: "var(--r-md)",
                  background: "oklch(from var(--paper-1) l c h / 0.7)",
                  border: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-0)" }}>{e}</span>
              </div>
            ))}
          </>
        )}
      </div>

      <div style={{ padding: "0 18px 14px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="btn ghost"
            onClick={onDiscard}
            disabled={!hasCapture || applying}
            style={{ height: 32, fontSize: 12, flex: 1 }}
          >
            Discard
          </button>
          <button
            className="btn bloom"
            onClick={onApply}
            disabled={!hasCapture || applying}
            style={{ height: 32, fontSize: 12, flex: 1 }}
          >
            <Ico.Check /> Apply on board
          </button>
        </div>
      </div>

      <div
        style={{
          padding: "14px 18px",
          borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={onToggleMic}
          title={listening ? "Pause listening" : "Resume listening"}
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: "var(--bloom-2)",
            color: "white",
            display: "grid",
            placeItems: "center",
            border: 0,
            cursor: "pointer",
            boxShadow: "0 4px 16px -4px var(--bloom-glow), 0 0 0 4px var(--bloom-wash)",
          }}
        >
          {listening ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ height: 26 }}>
            <BigMiniWave active={listening} />
          </div>
        </div>
      </div>
    </div>
  );
}

function BigMiniWave({ active }: { active: boolean }) {
  const bars = 42;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: "100%" }}>
      {Array.from({ length: bars }).map((_, i) => {
        const dist = Math.abs(i - bars / 2) / (bars / 2);
        const base = 1 - dist * dist;
        return (
          <span
            key={i}
            style={{
              flex: 1,
              height: `${20 + base * 70}%`,
              background: "var(--bloom-2)",
              borderRadius: 1.5,
              opacity: active ? 0.5 + base * 0.5 : 0.25,
              animation: active ? `wave ${0.9 + (i % 5) * 0.14}s ease-in-out infinite` : "none",
              animationDelay: `${(i * 40) % 900}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
