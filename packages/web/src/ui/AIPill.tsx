import { useRef, useState } from "react";
import { Ico } from "./icons.js";
import { AllowanceNote } from "./Paywall.js";
import type { ChatEntry } from "../persistence.js";
import { useWorkspace } from "../workspace.js";

/**
 * Floating conversational pill ported from reference/components/ai_pill.jsx.
 * Wired to real submit/mic callbacks instead of window.__lucentGo.
 */

export interface PillStatus {
  text: string;
}

export function AIPill({
  placeholder = "Ask Lucent to build something…",
  status,
  value = "",
  onChange,
  onSubmit,
  listening = false,
  onToggleMic,
  voiceSupported = true,
  history = [],
  busy = false,
  shifted = false,
  readOnly = false,
}: {
  placeholder?: string;
  status?: PillStatus | null;
  value?: string;
  onChange?: (v: string) => void;
  onSubmit?: () => void;
  listening?: boolean;
  onToggleMic?: () => void;
  voiceSupported?: boolean;
  history?: ChatEntry[];
  busy?: boolean;
  /** Shift left so it clears the right-side review panel while proposing. */
  shifted?: boolean;
  /**
   * Viewing someone else's shared board. The composer becomes a static notice:
   * a viewer's prompt would be refused, so offering the input would invite a
   * failure. The conversation stays readable.
   */
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const bars = useRef(Array.from({ length: 14 }, () => 20 + Math.random() * 60));

  return (
    <div className={`ai-pill-wrap${shifted ? " shifted" : ""}`}>
      {/* The plan warning belongs to the composer rather than to each view that
          mounts one: every AI surface asks the same allowance the same way, and a
          prop would put the warning only where somebody remembered to pass it.
          Reads the live status itself and renders nothing when there is nothing to
          say, which is most of the month. */}
      <AllowanceNote />
      {status && (
        <div className="pill-status">
          <span className="pulse" />
          <span>{status.text}</span>
        </div>
      )}

      {expanded && history.length > 0 && (
        <div
          className="ai-history-bubble"
          style={{
            width: 620,
            maxHeight: 320,
            overflowY: "auto",
            padding: 14,
            backdropFilter: "blur(24px) saturate(1.5)",
            borderRadius: "var(--r-xl)",
            boxShadow: "var(--elev-3)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            position: "relative",
          }}
        >
          <button
            onClick={() => setExpanded(false)}
            title="Collapse"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 22,
              height: 22,
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              color: "var(--ink-3)",
              background: "var(--canvas-2)",
              border: "1px solid var(--stroke-1)",
            }}
          >
            <Ico.Down style={{ transform: "rotate(180deg)" }} />
          </button>
          {history.map((m, i) => (
            <ConvoTurn key={i} entry={m} />
          ))}
        </div>
      )}

      <div className={`ai-pill ${listening ? "listening" : ""}${readOnly ? " read-only" : ""}`}>
        <div className="pill-icon">
          {readOnly ? (
            <Ico.Eye />
          ) : listening ? (
            <Ico.Mic2 style={{ color: "var(--amber-1)" }} />
          ) : (
            <Ico.Sparkle />
          )}
        </div>
        {readOnly ? (
          <span className="pill-notice">
            You're viewing this board. Ask the owner for edit access to change it.
          </span>
        ) : listening ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12 }}>
            <div className="waveform">
              {bars.current.map((h, i) => (
                <span key={i} style={{ animationDelay: `${i * 60}ms`, height: `${h}%` }} />
              ))}
            </div>
            <span style={{ fontSize: 13, color: "var(--ink-1)", fontStyle: "italic" }}>
              Listening…
            </span>
          </div>
        ) : (
          <input
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit?.();
            }}
            placeholder={placeholder}
          />
        )}
        {!readOnly && <span className="kbd">⌘K</span>}
        {!readOnly && (
          <>
            <button
              className={`mic-btn ${listening ? "active" : ""}`}
              onClick={onToggleMic}
              title={voiceSupported ? "Voice" : "Voice not supported in this browser"}
              style={voiceSupported ? undefined : { opacity: 0.45 }}
            >
              <Ico.Mic />
            </button>
            <button className="send-btn" onClick={onSubmit} disabled={busy} title="Send">
              <Ico.Send />
            </button>
          </>
        )}
      </div>
      {history.length > 0 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            fontSize: 11,
            color: "var(--ink-2)",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--stroke-1)",
          }}
          className="ai-msg-count-btn"
        >
          {history.length} messages ↑
        </button>
      )}
    </div>
  );
}

function ConvoTurn({ entry }: { entry: ChatEntry }) {
  const isUser = entry.role === "user";
  const isError = entry.role === "error";
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          background: isUser
            ? "var(--canvas-3)"
            : "linear-gradient(135deg, var(--amber-2), var(--amber-3))",
          color: isUser ? "var(--ink-1)" : "var(--canvas-0)",
        }}
      >
        {isUser ? <Ico.User /> : <Ico.Sparkle />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 3,
          }}
        >
          {isUser ? "You" : "Lucent"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: isError ? "var(--sig-red)" : isUser ? "var(--ink-0)" : "var(--ink-1)",
            lineHeight: 1.5,
          }}
        >
          {entry.text}
        </div>
        {!isUser && entry.suggestNewBoard && entry.originPrompt && (
          <NewBoardAction prompt={entry.originPrompt} />
        )}
        {/* Partial-application report (M1): what the validator refused while
            applying the rest. Visible but quiet — a mono list under the
            answer, not a modal — so a skipped relationship reads as a known
            gap, not a mystery. The ask-again affordance sends a targeted
            fix request rather than regenerating the whole batch. */}
        {!isUser && entry.skippedOps && entry.skippedOps.length > 0 && (
          <SkippedOpsList skipped={entry.skippedOps} />
        )}
      </div>
    </div>
  );
}

/** The skipped-ops report rendered under an AI reply. */
function SkippedOpsList({ skipped }: { skipped: NonNullable<ChatEntry["skippedOps"]> }) {
  const { send, setView } = useWorkspace() as unknown as {
    send: (message: string) => Promise<void>;
    setView: (view: string) => void;
  };
  return (
    <div
      style={{
        marginTop: 8,
        border: "1px solid var(--stroke-2)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "oklch(from var(--canvas-2) l c h / 0.6)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--amber-2)",
          marginBottom: 4,
        }}
      >
        {skipped.length} change{skipped.length > 1 ? "s" : ""} skipped
      </div>
      {skipped.map((s, i) => (
        <div
          key={i}
          style={{ fontSize: 11.5, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}
        >
          {s.op} — {s.reason}
        </div>
      ))}
      <button
        className="icon-btn"
        style={{ marginTop: 8, height: 26, padding: "0 10px" }}
        onClick={() => {
          setView("canvas");
          void send(
            `Some operations from your last batch were skipped by validation. ` +
              `Fix only these: ${skipped.map((s) => `${s.op} (${s.reason})`).join("; ")}. ` +
              `Do not regenerate the rest of the board — only emit corrected operations for what was skipped.`,
          );
        }}
      >
        <Ico.Sparkle /> Fix these
      </button>
    </div>
  );
}

/**
 * The one-click parallel-diagram affordance: opens a fresh board and runs the
 * original prompt against it, leaving the board the user was reading exactly
 * as it was. Lives here rather than in the entry body so the entry stays
 * presentation-only and the action owns its own wiring.
 */
function NewBoardAction({ prompt }: { prompt: string }) {
  const { startNewBoardFor } = useWorkspace();
  return (
    <button
      className="btn amber"
      style={{ marginTop: 8, padding: "0 12px", height: 28, fontSize: 12 }}
      onClick={() => startNewBoardFor(prompt)}
    >
      <Ico.Layers /> Build this on a new board
    </button>
  );
}
