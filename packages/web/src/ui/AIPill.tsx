import { voicePhaseLabel, type VoicePhase } from "../voiceConversation.js";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Ico, ToolIco } from "./icons.js";
import { Menu } from "./primitives.js";
import { GrowTextarea } from "./GrowTextarea.js";
import { AllowanceNote } from "./Paywall.js";
import type { ChatEntry } from "../persistence.js";
import type { AskCitation } from "../boards.js";
import { useWorkspace, useWorkspaceOptional } from "../workspace.js";
import { useSettings, type ModelTier } from "../settings.js";
import { StatementGlyph } from "./StatementGlyph.js";
import { KIND_LABEL } from "../statementUi.js";
import { isEmptyEffect, type TurnEffect } from "../turnEffect.js";
import {
  filterSlashCommands,
  parseSlashCommand,
  type SlashCommandDef,
  type StatementKind,
} from "@lucent/core";

function SlashIcon({ icon }: { icon: SlashCommandDef["icon"] }) {
  switch (icon) {
    case "layers":
      return <Ico.Layers />;
    case "shield":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "alert-triangle":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case "git-commit":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <line x1="1.05" y1="12" x2="7" y2="12" />
          <line x1="17" y1="12" x2="22.95" y2="12" />
        </svg>
      );
    case "minimize":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
        </svg>
      );
    case "globe":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    default:
      return <Ico.Sparkle />;
  }
}

/**
 * The board's composer: a paper card docked at the bottom of the canvas, in
 * the same Atelier language as the empty-board hero and Home's composer.
 *
 * Mode reads as an index tab on the card's edge rather than a toggle inside
 * it, so the card always says which way a turn goes — Build changes the
 * board, Ask only reads it. The footer names what a Build turn will look at
 * (the whole board, or the selection), then the pace, voice, and a send
 * button labelled with the verb it performs.
 */

export interface PillStatus {
  text: string;
}

export type PillMode = "build" | "ask";

/** UX-2 generation phase: the machine-readable half of the pill status. */
export type AIPhase = "understanding" | "constructing" | "validating" | "applying";

/**
 * What a Build turn reads besides the words: the selection the canvas sends
 * with the request (Phase C), so "this" and "these" resolve. Empty `names`
 * means nothing is selected and the model works from the whole board.
 */
export interface ComposerScope {
  names: string[];
}

// What is actually happening, in the user's terms — the old labels
// ("Designing architecture…") named a diagram kind the request may not be.
const PHASE_LABEL: Record<AIPhase, string> = {
  understanding: "Reading your request…",
  constructing: "Building the model…",
  validating: "Checking every change…",
  applying: "Placing it on the board…",
};

const VOICE_CHIP: Record<VoicePhase, string> = {
  idle: "Talk",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Answering",
};

/** The three model tiers, as a pace rather than a product name. */
const TIERS: Array<{ id: ModelTier; label: string; detail: string; bars: number }> = [
  { id: "fast", label: "Fast", detail: "Quickest — best for small edits", bars: 1 },
  {
    id: "balanced",
    label: "Balanced",
    detail: "Sound structure, quick enough to talk to",
    bars: 2,
  },
  {
    id: "reasoning",
    label: "Think",
    detail: "Reasons it through first — slower",
    bars: 3,
  },
];

/** Three rising bars, filled up to the tier: the pace at a glance. */
function PaceGlyph({ bars }: { bars: number }) {
  return (
    <svg className="ai-pace" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4.25}
          y={9 - i * 3}
          width="2.5"
          height={3 + i * 3}
          rx="1"
          fill="currentColor"
          opacity={i < bars ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/** A dashed marquee: the canvas's own selection mark. */
function ScopeGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
      <rect
        x="1.5"
        y="1.5"
        width="11"
        height="11"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2.4 1.8"
      />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" />
    </svg>
  );
}

function TierPicker() {
  const [settings, updateSettings] = useSettings();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = TIERS.find((t) => t.id === settings.modelTier) ?? TIERS[1]!;
  const close = useCallback(() => setOpen(false), []);

  // Keyboard users land on the current tier, not on the menu's frame.
  useEffect(() => {
    if (open) wrapRef.current?.querySelector<HTMLElement>(".ai-tier-item.on")?.focus();
  }, [open]);

  return (
    <div
      className="ai-tier"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`ai-chip${open ? " pressed" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Pace: ${current.label}`}
        title={`${current.label} — ${current.detail}`}
        // The menu closes on any outside mousedown; this one is the toggle's.
        onMouseDown={(e) => {
          if (open) e.stopPropagation();
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <PaceGlyph bars={current.bars} />
        <span className="ai-chip-label is-optional">{current.label}</span>
      </button>
      {open && (
        <Menu onClose={close} label="Pace" className="ai-tier-menu" origin="bottom left">
          <div className="ai-tier-head">Pace</div>
          {TIERS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === current.id}
              className={`ai-tier-item${t.id === current.id ? " on" : ""}`}
              onClick={() => {
                updateSettings({ modelTier: t.id });
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <PaceGlyph bars={t.bars} />
              <span className="ai-tier-text">
                <span className="ai-tier-name">{t.label}</span>
                <span className="ai-tier-detail">{t.detail}</span>
              </span>
              <Ico.Check className="ai-tier-check" />
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}

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
  onToggleVoiceAgent,
  voiceAgentActive = false,
  history = [],
  busy = false,
  shifted = false,
  readOnly = false,
  phase = null,
  progressNote = null,
  onCancel,
  voicePhase = "idle",
  clarification = null,
  onSelectClarification,
  streamThinking,
  scope,
}: {
  /** Mode-aware callers pass one; the default stays the Build wording. */
  placeholder?: string;
  status?: PillStatus | null;
  value?: string;
  onChange?: (v: string) => void;
  onSubmit?: () => void;
  /**
   * Stage C1's Build/Ask split. Both this and onModeChange must be present for
   * the mode tabs to render — the pill stays presentation-only, so a mount
   * that passes neither (BoardView, the document views) has no tabs.
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
  onToggleVoiceAgent?: () => void;
  voiceAgentActive?: boolean;
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
  /** UX-2 cancel. While busy the send button becomes Stop; the workspace owns the abort. */
  onCancel?: () => void;
  /** A voice conversation with Lucent, and where it is (voiceConversation.ts). */
  voicePhase?: VoicePhase;
  /** Clarification question and options when intent is ambiguous. */
  clarification?: import("@lucent/core").ClarificationChoice | null;
  /** Callback when user selects a clarification option. */
  onSelectClarification?: (choice: string) => void;
  /** Live streaming chain-of-thought tokens while AI is reasoning. */
  streamThinking?: string;
  /**
   * What a Build turn reads besides the words. Only the canvas passes it —
   * it is the mount whose submit actually sends the selection.
   */
  scope?: ComposerScope;
}) {
  const ws = useWorkspaceOptional();
  const liveThinking = streamThinking ?? ws?.streamThinking ?? "";
  const [expanded, setExpanded] = useState(false);
  const bars = useRef(Array.from({ length: 5 }, () => 35 + Math.random() * 65));
  const inputId = useId();
  const logId = useId();
  const hasMode = mode !== undefined && onModeChange !== undefined;
  const askMode = hasMode && mode === "ask";
  const phaseText = phase
    ? `${PHASE_LABEL[phase]}${progressNote ? ` — ${progressNote}` : ""}`
    : null;
  const statusText = phaseText ?? status?.text ?? null;
  const conversing = voicePhase !== "idle";
  const voiceLine = voicePhaseLabel(voicePhase);
  const turns = history.filter((m) => m.role === "user").length;
  const showLog = expanded && history.length > 0;
  const verb = !hasMode ? "Send" : askMode ? "Ask" : "Build";

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  // Slash commands popover logic
  const isSlashActive =
    !readOnly && value.startsWith("/") && !value.includes(" ") && value !== dismissedQuery;
  const slashSuggestions = isSlashActive ? filterSlashCommands(value) : [];
  const showSlashMenu = slashSuggestions.length > 0;
  const activeIndex = showSlashMenu
    ? Math.min(Math.max(0, selectedIndex), slashSuggestions.length - 1)
    : 0;

  // Active recognized slash command badge when typed with arguments
  const activeSlashCmd = !showSlashMenu && value.startsWith("/") ? parseSlashCommand(value) : null;

  const handleSelectSlashCommand = (cmd: SlashCommandDef) => {
    onChange?.(`${cmd.command} `);
    setDismissedQuery(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSlashMenu) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % slashSuggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + slashSuggestions.length) % slashSuggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const chosen = slashSuggestions[activeIndex];
      if (chosen) {
        handleSelectSlashCommand(chosen);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedQuery(value);
    }
  };

  // Ask has one wording on every lens — the canvas's per-lens placeholders
  // all describe edits, which Ask never makes.
  const fieldPlaceholder = listening
    ? "Listening… say it the way you'd explain it to a colleague"
    : askMode
      ? "Ask about this board — what was decided, who owns what, and why…"
      : (placeholder ?? "Describe a change — add, connect, regroup… or type / for commands");

  const scopeChip = (() => {
    if (!scope) return null;
    if (askMode) {
      return {
        on: false,
        text: "Board & history",
        title: "Ask reads this board and its history. It never changes anything.",
      };
    }
    const [first, ...rest] = scope.names;
    if (!first) {
      return {
        on: false,
        text: "Whole board",
        title: "Nothing selected — Lucent works from the whole board. Select objects to aim it.",
      };
    }
    return {
      on: true,
      text: rest.length ? `${first} +${rest.length}` : first,
      title: `Lucent reads your selection — ${scope.names.join(", ")} — so “this” and “these” mean what you picked.`,
    };
  })();

  return (
    <div className={`ai-pill-wrap${shifted ? " shifted" : ""}`}>
      {/* The plan warning belongs to the composer rather than to each view that
          mounts one: every AI surface asks the same allowance the same way, and a
          prop would put the warning only where somebody remembered to pass it.
          Reads the live status itself and renders nothing when there is nothing
          to say, which is most of the month. */}
      <AllowanceNote />
      {statusText && (
        <div className="pill-status" role="status" aria-live="polite">
          <span className="pulse" />
          <span>{statusText}</span>
        </div>
      )}

      {busy && liveThinking && (
        <div className="live-thinking-accordion" role="status" aria-live="polite">
          <div className="live-thinking-header">
            <span className="live-thinking-pulse" />
            <span className="live-thinking-title">Thinking…</span>
          </div>
          <div className="live-thinking-body">{liveThinking}</div>
        </div>
      )}

      {voiceLine && (
        <div className={`voice-phase is-${voicePhase}`} role="status" aria-live="polite">
          <span className="voice-phase-dot" aria-hidden />
          {voiceLine}
        </div>
      )}

      {clarification && (
        <div className="clarification-bar" role="region" aria-label="Clarification options">
          <div className="clarification-question">
            <Ico.Sparkle />
            <span>{clarification.question}</span>
          </div>
          <div className="clarification-options">
            {clarification.options.map((opt, i) => (
              <button
                key={i}
                type="button"
                className="hero-chip"
                onClick={() => onSelectClarification?.(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}
      {showSlashMenu && (
        <div className="slash-menu" role="listbox" aria-label="AI Slash Commands">
          <div className="slash-menu-head">
            <span className="slash-menu-title">AI Command Presets</span>
            <div className="slash-menu-hints">
              <span>↑↓ Navigate</span>
              <span>↵ Select</span>
              <span>Esc Close</span>
            </div>
          </div>
          <div className="slash-list">
            {slashSuggestions.map((cmd, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <div
                  key={cmd.id}
                  className={`slash-item${isSelected ? " selected" : ""}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelectSlashCommand(cmd)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="slash-item-icon">
                    <SlashIcon icon={cmd.icon} />
                  </div>
                  <div className="slash-item-body">
                    <div className="slash-item-header">
                      <span className="slash-item-cmd">{cmd.command}</span>
                      <span className={`slash-item-cat cat-${cmd.category}`}>{cmd.category}</span>
                    </div>
                    <span className="slash-item-desc">{cmd.description}</span>
                  </div>
                  <span className="slash-item-action">{cmd.placeholder ? "Fill" : "Run"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {activeSlashCmd?.definition && (
        <div className="slash-active-badge" role="status">
          <SlashIcon icon={activeSlashCmd.definition.icon} />
          <span className="badge-cmd">{activeSlashCmd.definition.command}</span>
          <span className="badge-desc">{activeSlashCmd.definition.description}</span>
          {!activeSlashCmd.args && activeSlashCmd.definition.placeholder && (
            <span className="badge-placeholder">· {activeSlashCmd.definition.placeholder}</span>
          )}
          <button
            type="button"
            className="badge-clear-btn"
            onClick={() => onChange?.(activeSlashCmd.args || "")}
            title="Clear command"
            aria-label="Clear slash command"
          >
            <Ico.X style={{ width: 12, height: 12 }} />
          </button>
        </div>
      )}

      <div className="ai-dock">
        {((hasMode && !readOnly) || history.length > 0) && (
          <div className="ai-tabs">
            {hasMode && !readOnly && (
              <div className="ai-tabs-modes" role="group" aria-label="Build or Ask mode">
                <button
                  type="button"
                  className={`ai-tab${mode === "build" ? " active" : ""}`}
                  onClick={() => onModeChange("build")}
                  title="Describe what to build — Lucent changes the board"
                  aria-pressed={mode === "build"}
                  aria-label="Build mode"
                >
                  Build
                </button>
                <button
                  type="button"
                  className={`ai-tab${mode === "ask" ? " active" : ""}`}
                  onClick={() => onModeChange("ask")}
                  title="Ask about the board and its history — read-only, with citations"
                  aria-pressed={mode === "ask"}
                  aria-label="Ask mode"
                >
                  Ask
                </button>
              </div>
            )}
            {history.length > 0 && (
              <button
                type="button"
                className={`ai-tab ai-tab-log${showLog ? " open" : ""}`}
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={showLog}
                aria-controls={logId}
                title={showLog ? "Hide the conversation" : "Show the conversation"}
              >
                Conversation <span className="ai-tab-count">{turns}</span>
                <ToolIco.ChevronUp className="ai-tab-chev" />
              </button>
            )}
          </div>
        )}

        <div
          className={`ai-pill${listening ? " listening" : ""}${readOnly ? " read-only" : ""}${askMode ? " ask" : ""}`}
        >
          {showLog && (
            <div className="ai-log" id={logId} role="log" aria-label="Conversation">
              {history.map((m, i) => (
                <ConvoTurn key={i} entry={m} onCitation={onCitation} />
              ))}
            </div>
          )}
          {readOnly ? (
            <div className="ai-pill-readonly-row">
              <Ico.Eye />
              <span className="pill-notice">
                You're viewing this board. Ask the owner for edit access to change it.
              </span>
            </div>
          ) : (
            <>
              <div className="ai-pill-input-row">
                <label htmlFor={inputId} className="sr-only">
                  Ask Lucent
                </label>
                <GrowTextarea
                  id={inputId}
                  value={value}
                  onChange={(v) => onChange?.(v)}
                  onKeyDown={handleKeyDown}
                  onSubmit={() => onSubmit?.()}
                  maxHeight={168}
                  placeholder={fieldPlaceholder}
                />
              </div>

              <div className="ai-pill-toolbar">
                <div className="ai-pill-toolbar-left">
                  {scopeChip && (
                    <>
                      <span
                        className={`ai-scope${scopeChip.on ? " on" : ""}`}
                        title={scopeChip.title}
                      >
                        {askMode ? <Ico.History /> : <ScopeGlyph />}
                        <span className="ai-scope-text">{scopeChip.text}</span>
                      </span>
                      <span className="ai-sep" aria-hidden />
                    </>
                  )}
                  {!askMode && (
                    <button
                      type="button"
                      className="ai-chip slash-trigger-btn"
                      title="Browse AI commands — or type / in the box"
                      aria-label="Browse AI commands"
                      onClick={() => {
                        setDismissedQuery(null);
                        onChange?.("/");
                      }}
                    >
                      <span className="ai-slash" aria-hidden>
                        /
                      </span>
                      <span className="ai-chip-label is-optional">Commands</span>
                    </button>
                  )}
                  <TierPicker />
                </div>

                <div className="ai-pill-toolbar-right">
                  <button
                    type="button"
                    className={`ai-chip ai-talk${listening || conversing ? " on" : ""}`}
                    onClick={onToggleMic}
                    disabled={!voiceSupported && !conversing}
                    title={
                      conversing
                        ? listening && value.trim()
                          ? "Send what you said"
                          : "End the voice conversation"
                        : voiceSupported
                          ? "Talk with Lucent — it answers out loud and keeps listening"
                          : "Voice isn't supported in this browser"
                    }
                    aria-label={
                      conversing
                        ? listening && value.trim()
                          ? "Send what you said"
                          : "End the voice conversation"
                        : "Talk with Lucent"
                    }
                    aria-pressed={conversing}
                  >
                    {listening ? (
                      <span className="ai-wave" aria-hidden>
                        {bars.current.map((h, i) => (
                          <span
                            key={i}
                            style={{ animationDelay: `${i * 90}ms`, height: `${h}%` }}
                          />
                        ))}
                      </span>
                    ) : (
                      <Ico.Mic2 />
                    )}
                    <span className="ai-chip-label">
                      {VOICE_CHIP[listening && voicePhase === "idle" ? "listening" : voicePhase]}
                    </span>
                  </button>

                  {onToggleVoiceAgent && (
                    <button
                      type="button"
                      className={`ai-chip icon${voiceAgentActive ? " on" : ""}`}
                      onClick={onToggleVoiceAgent}
                      title={
                        voiceAgentActive
                          ? "End the live call"
                          : "Live call — a duplex voice call with Lucent (needs the voice-agent worker)"
                      }
                      aria-label={voiceAgentActive ? "End the live call" : "Live call"}
                      aria-pressed={voiceAgentActive}
                    >
                      <Ico.Phone />
                    </button>
                  )}

                  {busy && onCancel ? (
                    <button
                      type="button"
                      className="btn-atelier ai-send stop"
                      onClick={onCancel}
                      aria-label="Cancel generation"
                    >
                      <span className="ai-stop-mark" aria-hidden />
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-atelier primary ai-send"
                      onClick={onSubmit}
                      disabled={busy || !value.trim()}
                      title={`${verb} — Enter`}
                    >
                      {verb}
                      <Ico.Arrow />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
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
        {!isUser && entry.thinking && (
          <details className="thinking-accordion">
            <summary className="thinking-summary">
              <span className="thinking-summary-label">
                Thought{" "}
                {entry.telemetry?.latencyMs
                  ? `for ${(entry.telemetry.latencyMs / 1000).toFixed(1)}s`
                  : "trace"}
                {entry.telemetry?.reasoningTokens
                  ? ` (${entry.telemetry.reasoningTokens} tokens)`
                  : ""}
              </span>
              <span className="thinking-summary-chevron">▾</span>
            </summary>
            <div className="thinking-content">{entry.thinking}</div>
          </details>
        )}
        {!isUser && entry.effect && !isEmptyEffect(entry.effect) && (
          <EffectLine effect={entry.effect} />
        )}
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
        {/* ADR 0048: how well the answer is supported — counted from the
            evidence that survived, never the model's own estimate. */}
        {!isUser && entry.confidence && (
          <div className={`answer-confidence is-${entry.confidence.level}`}>
            {entry.confidence.level === "none"
              ? "No evidence — nothing on this board supports this answer."
              : entry.confidence.reason}
          </div>
        )}
        {!isUser && entry.telemetry && (
          <div
            className="telemetry-badge"
            title={`Provider: ${entry.telemetry.provider}\nModel: ${entry.telemetry.model}\nLatency: ${entry.telemetry.latencyMs}ms\nPrompt Tokens: ${entry.telemetry.promptTokens ?? "—"}\nCompletion Tokens: ${entry.telemetry.completionTokens ?? "—"}${entry.telemetry.reasoningTokens ? `\nReasoning Tokens: ${entry.telemetry.reasoningTokens}` : ""}`}
          >
            <span className="telemetry-model">{entry.telemetry.model}</span>
            <span className="telemetry-sep">·</span>
            <span className="telemetry-stat">{(entry.telemetry.latencyMs / 1000).toFixed(1)}s</span>
            {entry.telemetry.completionTokens !== undefined && (
              <>
                <span className="telemetry-sep">·</span>
                <span className="telemetry-stat">{entry.telemetry.completionTokens} tok</span>
              </>
            )}
            {Boolean(entry.telemetry.reasoningTokens) && (
              <>
                <span className="telemetry-sep">·</span>
                <span className="telemetry-stat reasoning-tok">
                  {entry.telemetry.reasoningTokens} think
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const EFFECT_ORDER: StatementKind[] = [
  "decision",
  "proposal",
  "question",
  "action",
  "requirement",
  "risk",
];

/**
 * What the turn did to the board, under the reply: counts from the ops that
 * were applied, and the statements it introduced by kind — so the
 * conversation reads as a log of what the board learned.
 */
function EffectLine({ effect }: { effect: TurnEffect }) {
  const parts: string[] = [];
  if (effect.created) parts.push(`added ${effect.created}`);
  if (effect.connected) parts.push(`connected ${effect.connected}`);
  if (effect.changed) parts.push(`changed ${effect.changed}`);
  if (effect.resolved) parts.push(`moved ${effect.resolved} forward`);
  if (effect.removed) parts.push(`removed ${effect.removed}`);
  const kinds = EFFECT_ORDER.filter((k) => (effect.statements[k] ?? 0) > 0);
  return (
    <div className="turn-effect" aria-label="What this changed">
      {parts.length > 0 && <span className="turn-effect-counts">{parts.join(" · ")}</span>}
      {kinds.map((k) => {
        const n = effect.statements[k] ?? 0;
        return (
          <span key={k} className="turn-effect-kind" style={{ color: `var(--kind-${k})` }}>
            <StatementGlyph kind={k} size={10} />
            {n} {(n === 1 ? KIND_LABEL[k].one : KIND_LABEL[k].many).toLowerCase()}
          </span>
        );
      })}
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
  const { revealNodes } = useWorkspace();
  if (!onCitation) return null;
  const nodes = citations.filter((c) => c.kind === "node").map((c) => c.id);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {nodes.length > 1 && (
        <button
          className="citation-chip"
          onClick={() => revealNodes(nodes)}
          title="Select every node this answer cites, on the canvas"
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            padding: "3px 9px",
            borderRadius: 999,
            border: "1px solid var(--amber-2)",
            background: "transparent",
            color: "var(--ink-1)",
          }}
        >
          Show all {nodes.length} on canvas
        </button>
      )}
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
