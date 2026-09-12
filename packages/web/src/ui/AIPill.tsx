import { useId, useRef, useState } from "react";
import { Ico } from "./icons.js";
import { AllowanceNote } from "./Paywall.js";
import type { ChatEntry } from "../persistence.js";
import type { AskCitation } from "../boards.js";
import { useWorkspace } from "../workspace.js";

/**
 * Floating conversational pill ported from reference/components/ai_pill.jsx.
 * Wired to real submit/mic callbacks instead of window.__lucentGo.
 */

export interface PillStatus {
  text: string;
}

export type PillMode = "build" | "ask";

/** UX-2 generation phase: the machine-readable half of the pill status. */
export type AIPhase = "understanding" | "constructing" | "validating" | "applying";

const PHASE_LABEL: Record<AIPhase, string> = {
  understanding: "Understanding…",
  constructing: "Constructing…",
  validating: "Validating…",
  applying: "Applying…",
};

export function AIPill({
  placeholder,
  status,
  value = "",
  onChange,
  onSubmit,
  mode,
  onModeChange,
  onCitation,
  listening = false,
  onToggleMic,
  voiceSupported = true,
  history = [],
  busy = false,
  shifted = false,
  readOnly = false,
  phase = null,
  progressNote = null,
  onCancel,
}: {
  /** Mode-aware callers pass one; the default stays the Build wording. */
  placeholder?: string;
  status?: PillStatus | null;
  value?: string;
  onChange?: (v: string) => void;
  onSubmit?: () => void;
  /**
   * Stage C1's Build/Ask split. Both this and onModeChange must be present for
   * the toggle to render — the pill stays presentation-only, so a mount that
   * passes neither (BoardView, the document views) keeps its exact old shape.
   * Build = "change my workspace" (operations); Ask = "understand my
   * workspace" (answers + citations, never a mutation).
   */
  mode?: PillMode;
  onModeChange?: (mode: PillMode) => void;
  /** Citation click → jump to evidence. The workspace owns the navigation. */
  onCitation?: (citation: AskCitation & { turnRange?: [number, number] }) => void;
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
  /**
   * UX-2 generation phase. Null when idle — the pill then renders `status`
   * (or nothing), exactly as before.
   */
  phase?: AIPhase | null;
  /** UX-2 machine progress alongside the phase ("12 characters received"). */
  progressNote?: string | null;
  /** UX-2 cancel. Rendered only while busy; the workspace owns the abort. */
  onCancel?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bars = useRef(Array.from({ length: 14 }, () => 20 + Math.random() * 60));
  const inputId = useId();
  const hasMode = mode !== undefined && onModeChange !== undefined;
  const askMode = hasMode && mode === "ask";
  const phaseText = phase
    ? `${PHASE_LABEL[phase]}${progressNote ? ` — ${progressNote}` : ""}`
    : null;
  const statusText = phaseText ?? status?.text ?? null;

  return (
    <div className={`ai-pill-wrap${shifted ? " shifted" : ""}`}>
      {/* The plan warning belongs to the composer rather than to each view that
          mounts one: every AI surface asks the same allowance the same way, and a
          prop would put the warning only where somebody remembered to pass it.
          Reads the live status itself and renders nothing when there is nothing
          to say, which is most of the month. */}
      <AllowanceNote />
      {statusText && (
        <div className="pill-status">
          <span className="pulse" />
          <span>{statusText}</span>
          {busy && onCancel && (
            <button
              type="button"
              aria-label="Cancel generation"
              onClick={onCancel}
              style={{
                marginLeft: 4,
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid var(--stroke-2)",
                background: "transparent",
                color: "var(--ink-1)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          )}
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
            <ConvoTurn key={i} entry={m} onCitation={onCitation} />
          ))}
        </div>
      )}

      <div className={`ai-pill ${listening ? "listening" : ""}${readOnly ? " read-only" : ""}`}>
        <div className="pill-icon">
          {readOnly ? (
            <Ico.Eye />
          ) : listening ? (
            <Ico.Mic2 style={{ color: "var(--amber-1)" }} />
          ) : askMode ? (
            <Ico.History />
          ) : (
            <Ico.Sparkle />
          )}
        </div>
        {/* Build/Ask: the one toggle the reviewer's model asked for — Build
            mutates, Ask reads. Rendered as the app's established segmented
            control, only for mounts that own a mode. */}
        {hasMode && !readOnly && (
          <div className="segmented" style={{ flexShrink: 0 }} role="radiogroup" aria-label="Build or Ask mode">
            <button
              className={mode === "build" ? "active" : ""}
              onClick={() => onModeChange!("build")}
              title="Describe what to build — Lucent changes the board"
              aria-pressed={mode === "build"}
              aria-label="Build mode"
            >
              Build
            </button>
            <button
              className={mode === "ask" ? "active" : ""}
              onClick={() => onModeChange!("ask")}
              title="Ask about the board and its history — read-only, with citations"
              aria-pressed={mode === "ask"}
              aria-label="Ask mode"
            >
              Ask
            </button>
          </div>
        )}
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
          <>
            <label htmlFor={inputId} className="sr-only">
              Ask Lucent
            </label>
            <input
              id={inputId}
              value={value}
              onChange={(e) => onChange?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit?.();
              }}
              placeholder={
                placeholder ??
                (askMode ? "Ask about this board's history…" : "Ask Lucent to build something…")
              }
            />
          </>
        )}
        {!readOnly && <span className="kbd">⌘K</span>}
        {!readOnly && (
          <>
            <button
              className={`mic-btn ${listening ? "active" : ""}`}
              onClick={onToggleMic}
              title={voiceSupported ? "Voice" : "Voice not supported in this browser"}
              aria-label={listening ? "Stop voice input" : "Start voice input"}
              aria-pressed={listening}
              style={voiceSupported ? undefined : { opacity: 0.45 }}
            >
              <Ico.Mic />
            </button>
            <button
              className="send-btn"
              onClick={onSubmit}
              disabled={busy}
              title="Send"
              aria-label="Send message"
            >
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

function ConvoTurn({
  entry,
  onCitation,
}: {
  entry: ChatEntry;
  onCitation?: (citation: AskCitation & { turnRange?: [number, number] }) => void;
}) {
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
        {/* The generation-retry affordance: only `error` entries whose
            failure arm recorded the prompt carry it (see RetryAction). */}
        {isError && entry.retryPrompt && <RetryAction prompt={entry.retryPrompt} />}
        {/* Partial-application report (M1): what the validator refused while
            applying the rest. Visible but quiet — a mono list under the
            answer, not a modal — so a skipped relationship reads as a known
            gap, not a mystery. The ask-again affordance sends a targeted
            fix request rather than regenerating the whole batch. */}
        {!isUser && entry.skippedOps && entry.skippedOps.length > 0 && (
          <SkippedOpsList skipped={entry.skippedOps} />
        )}
        {/* Citations (Stage C1): the evidence an Ask answer points at, each a
            jump to where the evidence lives. Only entries the server resolved
            against real state ever carry them. */}
        {!isUser && entry.citations && entry.citations.length > 0 && (
          <CitationList citations={entry.citations} onCitation={onCitation} />
        )}
      </div>
    </div>
  );
}

/**
 * The citation chips under an Ask reply. Node → canvas, meeting → transcript,
 * revision → history view; the navigation itself is the workspace's (the pill
 * stays presentation-only), passed down as `onCitation`.
 */
function CitationList({
  citations,
  onCitation,
}: {
  citations: NonNullable<ChatEntry["citations"]>;
  onCitation?: (citation: AskCitation & { turnRange?: [number, number] }) => void;
}) {
  if (!onCitation) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {citations.map((c, i) => (
        <button
          key={i}
          className="citation-chip"
          onClick={() => onCitation(c)}
          title={c.why ?? c.detail ?? c.label}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            padding: "3px 9px",
            borderRadius: 999,
            border: "1px solid var(--stroke-2)",
            background: "oklch(from var(--canvas-2) l c h / 0.7)",
            color: "var(--ink-1)",
          }}
        >
          <span style={{ color: "var(--amber-2)", fontSize: 10 }}>✦</span>
          {c.label}
        </button>
      ))}
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

/**
 * The one-click generation-retry affordance: re-sends the failed request's
 * original prompt against the SAME board (found live, 2026-09-10: transient
 * provider 502s left an empty board behind a transient toast; the failure
 * persisted in chat, but re-running meant retyping the whole request). Only
 * renders on entries whose `retryPrompt` the failure arm set — plan/quota/
 * auth refusals carry no prompt because retrying would not help.
 */
function RetryAction({ prompt }: { prompt: string }) {
  const { send } = useWorkspace() as unknown as { send: (message: string) => Promise<void> };
  return (
    <button
      className="btn amber"
      style={{ marginTop: 8, padding: "0 12px", height: 28, fontSize: 12 }}
      onClick={() => void send(prompt)}
    >
      <Ico.Sparkle /> Try again
    </button>
  );
}
