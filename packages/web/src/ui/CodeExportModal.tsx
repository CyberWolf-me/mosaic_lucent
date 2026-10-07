import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { exportBoardToCode, type CodeExportFormat, type CodeExportResult, type Workspace } from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import { useToast } from "./Toast.js";
import { Ico } from "./icons.js";

const FORMAT_OPTIONS: { id: CodeExportFormat; label: string; ext: string }[] = [
  { id: "xstate", label: "XState v5 (TS)", ext: ".machine.ts" },
  { id: "prisma", label: "Prisma Schema", ext: ".prisma" },
  { id: "sqlddl", label: "PostgreSQL DDL", ext: ".sql" },
  { id: "compose", label: "Docker Compose", ext: ".yml" },
  { id: "typescript", label: "TypeScript Types", ext: ".types.ts" },
];

export function CodeExportModal({
  onClose,
  sourceWorkspace,
}: {
  onClose: () => void;
  sourceWorkspace?: Workspace;
}) {
  const { workspace: fullWorkspace } = useWorkspace();
  const [useSelection, setUseSelection] = useState<boolean>(
    Boolean(
      sourceWorkspace &&
        sourceWorkspace !== fullWorkspace &&
        Object.keys(sourceWorkspace.nodes).length < Object.keys(fullWorkspace.nodes).length,
    ),
  );
  const workspace = useSelection && sourceWorkspace ? sourceWorkspace : fullWorkspace;
  const { notify } = useToast();
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Recommended format based on diagramKind
  const recommendedFormat = useMemo<CodeExportFormat>(() => {
    if (workspace.diagramKind === "er") return "prisma";
    if (workspace.diagramKind === "architecture") return "compose";
    if (
      workspace.diagramKind === "flowchart" ||
      workspace.diagramKind === "statemachine" ||
      workspace.diagramKind === "journey" ||
      workspace.diagramKind === "process"
    )
      return "xstate";
    return "typescript";
  }, [workspace.diagramKind]);

  const [selectedFormat, setSelectedFormat] = useState<CodeExportFormat>(recommendedFormat);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 140);
  }, [closing, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const exportResult = useMemo<CodeExportResult>(() => {
    return exportBoardToCode(workspace, selectedFormat);
  }, [workspace, selectedFormat]);

  const lineCount = useMemo(() => {
    return exportResult.code.split("\n").length;
  }, [exportResult.code]);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(exportResult.code);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setCopied(true);
      notify(`Copied ${exportResult.fileName} to clipboard.`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = exportResult.code;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        notify(`Copied ${exportResult.fileName} to clipboard.`);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        notify("Failed to copy to clipboard.");
      }
    }
  };

  const handleDownload = () => {
    try {
      const blob = new Blob([exportResult.code], { type: exportResult.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportResult.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      notify(`Downloaded ${exportResult.fileName}.`);
    } catch {
      notify("Failed to initiate file download.");
    }
  };

  return createPortal(
    <>
      <div
        className="modal-scrim"
        onClick={requestClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 300,
          background: "oklch(0.10 0.005 252 / 0.55)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          animation: closing ? "scrim-out 0.15s ease-in both" : "scrim-in 0.18s ease-out backwards",
        }}
      />
      <div
        className="code-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-export-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(920px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-panel, oklch(0.20 0.015 255))",
          border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.4))",
          borderRadius: 14,
          boxShadow: "0 24px 60px oklch(0 0 0 / 0.4), 0 0 0 1px oklch(1 0 0 / 0.05)",
          color: "var(--text-main, oklch(0.95 0.005 255))",
          fontFamily: "var(--font-sans, inherit)",
          animation: closing
            ? "dialog-out 0.14s ease-in both"
            : "dialog-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) backwards",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "var(--accent-subtle, oklch(0.3 0.06 250))",
                  color: "var(--accent-bright, oklch(0.8 0.12 250))",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ico.Code />
              </div>
              <h2
                id="code-export-title"
                style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}
              >
                Export Production Code
              </h2>
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--text-muted, oklch(0.7 0.01 255))",
                lineHeight: 1.45,
              }}
            >
              Compile visual canvas diagrams into production-grade TypeScript state machines, ORM
              schemas, database DDL, or container definitions.
            </p>
          </div>
          <button
            onClick={requestClose}
            aria-label="Close dialog"
            className="icon-btn"
            style={{
              padding: 6,
              borderRadius: 6,
              background: "transparent",
              border: "none",
              color: "var(--text-muted, oklch(0.7 0.01 255))",
              cursor: "pointer",
            }}
          >
            <Ico.X />
          </button>
        </div>

        {/* Format Selector Tabs */}
        <div
          style={{
            padding: "12px 24px",
            borderBottom: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.2))",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            background: "oklch(0.18 0.015 255 / 0.4)",
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: "var(--text-muted, oklch(0.65 0.01 255))",
              marginRight: 4,
            }}
          >
            Format:
          </span>
          {FORMAT_OPTIONS.map((opt) => {
            const active = selectedFormat === opt.id;
            const isRecommended = recommendedFormat === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => setSelectedFormat(opt.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  border: active
                    ? "1px solid var(--accent-bright, oklch(0.7 0.12 250))"
                    : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                  background: active ? "var(--accent-subtle, oklch(0.3 0.06 250))" : "transparent",
                  color: active ? "white" : "var(--text-muted, oklch(0.8 0.01 255))",
                  cursor: "pointer",
                  transition: "all 0.12s ease",
                }}
              >
                <span>{opt.label}</span>
                {isRecommended && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 4,
                      background: active ? "oklch(0.4 0.1 250)" : "oklch(0.3 0.03 255 / 0.6)",
                      color: active ? "white" : "oklch(0.85 0.05 250)",
                    }}
                  >
                    Best Fit
                  </span>
                )}
              </button>
            );
          })}
          {sourceWorkspace && Object.keys(sourceWorkspace.nodes).length < Object.keys(fullWorkspace.nodes).length && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted, oklch(0.65 0.01 255))" }}>Scope:</span>
              <button
                type="button"
                onClick={() => setUseSelection(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  cursor: "pointer",
                  border: useSelection
                    ? "1px solid var(--amber-2)"
                    : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                  background: useSelection ? "var(--amber-2)" : "transparent",
                  color: useSelection ? "var(--ink-0)" : "var(--text-muted, oklch(0.8 0.01 255))",
                  fontWeight: useSelection ? 600 : 400,
                }}
              >
                Selection ({Object.keys(sourceWorkspace.nodes).length} nodes)
              </button>
              <button
                type="button"
                onClick={() => setUseSelection(false)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  cursor: "pointer",
                  border: !useSelection
                    ? "1px solid var(--amber-2)"
                    : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                  background: !useSelection ? "var(--amber-2)" : "transparent",
                  color: !useSelection ? "var(--ink-0)" : "var(--text-muted, oklch(0.8 0.01 255))",
                  fontWeight: !useSelection ? 600 : 400,
                }}
              >
                Entire Board ({Object.keys(fullWorkspace.nodes).length} nodes)
              </button>
            </div>
          )}
        </div>

        {/* Code Metadata Bar */}
        <div
          style={{
            padding: "8px 24px",
            borderBottom: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.2))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "oklch(0.16 0.01 255 / 0.7)",
            fontSize: 12,
            fontFamily: "ui-monospace, monospace",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 600, color: "var(--accent-bright, oklch(0.8 0.12 250))" }}>
              {exportResult.fileName}
            </span>
            <span style={{ color: "var(--text-muted, oklch(0.6 0.01 255))" }}>
              {lineCount} lines · {(new Blob([exportResult.code]).size / 1024).toFixed(1)} KB
            </span>
          </div>
          <span style={{ color: "var(--text-muted, oklch(0.7 0.01 255))", fontSize: 11.5 }}>
            {exportResult.summary}
          </span>
        </div>

        {/* Code View Area */}
        <div
          style={{
            padding: "16px 24px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 320,
            maxHeight: 460,
            overflow: "hidden",
          }}
        >
          <textarea
            readOnly
            value={exportResult.code}
            aria-label="Generated code content"
            style={{
              width: "100%",
              height: "100%",
              flex: 1,
              padding: "14px 16px",
              boxSizing: "border-box",
              borderRadius: 8,
              border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.35))",
              background: "oklch(0.14 0.01 255 / 0.8)",
              outline: "none",
              color: "var(--text-main, oklch(0.92 0.01 255))",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12.5,
              lineHeight: 1.5,
              resize: "none",
              whiteSpace: "pre",
            }}
          />
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "oklch(0.18 0.015 255 / 0.3)",
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-muted, oklch(0.65 0.01 255))" }}>
            Production code generated deterministically from semantic graph.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={requestClose}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                background: "transparent",
                border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                color: "var(--text-muted, oklch(0.8 0.01 255))",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Close
            </button>
            <button
              onClick={handleCopy}
              style={{
                padding: "7px 14px",
                borderRadius: 6,
                background: copied ? "oklch(0.35 0.1 140 / 0.4)" : "oklch(0.24 0.02 255 / 0.7)",
                border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                color: copied ? "oklch(0.9 0.15 140)" : "var(--text-main, white)",
                fontSize: 13,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                transition: "all 0.12s ease",
              }}
            >
              {copied ? <Ico.Check /> : <Ico.Copy />}
              <span>{copied ? "Copied!" : "Copy Code"}</span>
            </button>
            <button
              onClick={handleDownload}
              style={{
                padding: "7px 18px",
                borderRadius: 6,
                background: "var(--accent-bright, oklch(0.65 0.16 250))",
                border: "none",
                color: "white",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 2px 8px oklch(0.65 0.16 250 / 0.35)",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                transition: "all 0.12s ease",
              }}
            >
              <Ico.Download />
              <span>Download File</span>
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
