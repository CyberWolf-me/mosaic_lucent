import React, { useState, useRef, useEffect } from "react";
import type { Node } from "@lucent/core";
import { Ico } from "./icons.js";

export const SEMANTIC_NODE_TYPES = [
  { type: "service", label: "Service", dot: "violet" },
  { type: "database", label: "Database", dot: "blue" },
  { type: "process", label: "Process", dot: "blue" },
  { type: "decision", label: "Decision", dot: "amber" },
  { type: "queue", label: "Queue", dot: "amber" },
  { type: "system", label: "System", dot: "green" },
  { type: "actor", label: "Actor", dot: "blue" },
  { type: "cache", label: "Cache", dot: "red" },
] as const;

export interface NodeAiToolbarProps {
  node: Node;
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
  onElaborate: () => void;
  onErrorHandling: () => void;
  onConvertType: (newType: string) => void;
  onExplain: () => void;
  onCustomPrompt: (prompt: string) => void;
  onClose?: () => void;
}

export function NodeAiToolbar({
  node,
  x,
  y,
  w,
  h,
  onElaborate,
  onErrorHandling,
  onConvertType,
  onExplain,
  onCustomPrompt,
  onClose,
}: NodeAiToolbarProps) {
  const [showTypeMenu, setShowTypeMenu] = useState(false);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customText, setCustomText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Position: centered horizontally above the node card; flip below if too close to top
  const isNearTop = y < 54;
  const topPos = isNearTop ? y + h + 8 : y - 44;
  const leftPos = x + w / 2;

  useEffect(() => {
    if (showCustomInput) {
      inputRef.current?.focus();
    }
  }, [showCustomInput]);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        setShowTypeMenu(false);
      }
    };
    if (showTypeMenu) {
      document.addEventListener("pointerdown", handleOutsideClick);
      return () => document.removeEventListener("pointerdown", handleOutsideClick);
    }
  }, [showTypeMenu]);

  const handleSubmitCustom = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customText.trim();
    if (!trimmed) return;
    onCustomPrompt(trimmed);
    setCustomText("");
    setShowCustomInput(false);
  };

  return (
    <div
      className="node-ai-toolbar"
      role="toolbar"
      aria-label={`AI actions for ${node.label}`}
      style={{
        position: "absolute",
        left: leftPos,
        top: topPos,
        transform: "translateX(-50%)",
        zIndex: 45,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 6px",
        background: "oklch(from var(--canvas-1) l c h / 0.94)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid var(--stroke-2)",
        borderRadius: "9999px",
        boxShadow: "0 6px 20px -3px oklch(0 0 0 / 0.18), 0 2px 6px -1px oklch(0 0 0 / 0.10)",
        pointerEvents: "auto",
        userSelect: "none",
        whiteSpace: "nowrap",
        animation: "pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1) backwards",
      }}
    >
      {/* Sparkle Badge */}
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px 2px 6px",
          borderRadius: 9999,
          background: "var(--accent-tint, oklch(0.55 0.18 250 / 0.15))",
          color: "var(--accent, oklch(0.65 0.20 250))",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "-0.01em",
        }}
      >
        <Ico.Sparkle />
        <span>AI</span>
      </span>

      {!showCustomInput ? (
        <>
          {/* 1. Elaborate Action */}
          <button
            type="button"
            className="node-ai-btn"
            onClick={onElaborate}
            title={`Decompose "${node.label}" into granular sub-processes`}
            aria-label="Elaborate node"
          >
            <Ico.Plus />
            <span>Elaborate</span>
          </button>

          {/* 2. Error Handling Action */}
          <button
            type="button"
            className="node-ai-btn"
            onClick={onErrorHandling}
            title={`Add decision gate and failure handling path to "${node.label}"`}
            aria-label="Add error handling"
          >
            <Ico.Shield />
            <span>Error Path</span>
          </button>

          {/* 3. Convert Type Menu */}
          <div style={{ position: "relative" }} ref={menuRef}>
            <button
              type="button"
              className={`node-ai-btn ${showTypeMenu ? "active" : ""}`}
              onClick={() => setShowTypeMenu(!showTypeMenu)}
              title="Change semantic node type"
              aria-label="Convert node type"
              aria-expanded={showTypeMenu}
            >
              <span>Type: {node.nodeType}</span>
              <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
            </button>

            {showTypeMenu && (
              <div
                className="node-ai-type-dropdown"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  minWidth: 140,
                  padding: 4,
                  background: "oklch(from var(--canvas-1) l c h / 0.98)",
                  backdropFilter: "blur(18px)",
                  border: "1px solid var(--stroke-2)",
                  borderRadius: "var(--r-md, 8px)",
                  boxShadow: "var(--elev-3)",
                  zIndex: 50,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {SEMANTIC_NODE_TYPES.map(({ type, label }) => {
                  const isCurrent = node.nodeType.toLowerCase() === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      className={`node-ai-dropdown-item ${isCurrent ? "current" : ""}`}
                      onClick={() => {
                        onConvertType(type);
                        setShowTypeMenu(false);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "5px 10px",
                        border: 0,
                        borderRadius: 6,
                        background: isCurrent
                          ? "var(--accent-tint, oklch(0.55 0.18 250 / 0.12))"
                          : "transparent",
                        color: isCurrent ? "var(--accent, oklch(0.65 0.20 250))" : "var(--ink-1)",
                        fontSize: 12,
                        fontWeight: isCurrent ? 600 : 500,
                        cursor: "pointer",
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <span>{label}</span>
                      {isCurrent && <Ico.Check />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 4. Explain Action */}
          <button
            type="button"
            className="node-ai-btn"
            onClick={onExplain}
            title={`Explain "${node.label}" in diagram context`}
            aria-label="Explain node"
          >
            <span>Explain</span>
          </button>

          {/* 5. Custom prompt toggle */}
          <button
            type="button"
            className="node-ai-btn node-ai-btn-ghost"
            onClick={() => setShowCustomInput(true)}
            title="Type custom AI instruction for this node"
            aria-label="Custom AI prompt for node"
          >
            <span>Custom…</span>
          </button>
        </>
      ) : (
        /* Custom Instruction Form */
        <form
          onSubmit={handleSubmitCustom}
          style={{ display: "flex", alignItems: "center", gap: 4 }}
        >
          <input
            ref={inputRef}
            type="text"
            className="node-ai-input"
            placeholder={`Ask AI about "${node.label}"…`}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setShowCustomInput(false);
              }
            }}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              fontFamily: "inherit",
              background: "var(--canvas-0)",
              border: "1px solid var(--stroke-2)",
              borderRadius: 9999,
              color: "var(--ink-0)",
              outline: "none",
              width: 200,
            }}
          />
          <button
            type="submit"
            className="node-ai-btn node-ai-btn-send"
            disabled={!customText.trim()}
            title="Execute custom instruction"
            aria-label="Send custom instruction"
            style={{ padding: "4px 8px", borderRadius: 9999 }}
          >
            <Ico.Send />
          </button>
          <button
            type="button"
            className="node-ai-btn"
            onClick={() => setShowCustomInput(false)}
            title="Cancel"
            aria-label="Cancel custom instruction"
            style={{ padding: "4px 6px" }}
          >
            <Ico.X />
          </button>
        </form>
      )}

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="node-ai-close-btn"
          title="Dismiss toolbar"
          aria-label="Dismiss AI toolbar"
          style={{
            marginLeft: 2,
            padding: 2,
            background: "transparent",
            border: 0,
            color: "var(--ink-3)",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ico.X />
        </button>
      )}
    </div>
  );
}
