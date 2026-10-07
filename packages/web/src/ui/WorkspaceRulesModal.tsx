import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  parseWorkspaceRules,
  serializeWorkspaceRules,
  formatWorkspaceRulesPrompt,
  WORKSPACE_RULE_TEMPLATES,
  type WorkspaceRules,
} from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import { Ico } from "./icons.js";

export function WorkspaceRulesModal({ onClose }: { onClose: () => void }) {
  const { rules, setRules } = useWorkspace();
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);

  const [form, setForm] = useState<WorkspaceRules>(() => parseWorkspaceRules(rules));

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

  const applyTemplate = (templateId: string) => {
    const tmpl = WORKSPACE_RULE_TEMPLATES.find((t) => t.id === templateId);
    if (!tmpl) return;
    setForm({ ...tmpl.rules });
    setActiveTemplate(tmpl.id);
  };

  const clearRules = () => {
    setForm({});
    setActiveTemplate(null);
  };

  const formattedPrompt = formatWorkspaceRulesPrompt(form);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(formattedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  const handleSave = () => {
    // If all fields are empty, save as empty string
    const hasAnyContent = Object.values(form).some(
      (val) => typeof val === "string" && val.trim().length > 0,
    );
    if (!hasAnyContent) {
      setRules("");
    } else {
      setRules(serializeWorkspaceRules(form));
    }
    requestClose();
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
        className="workspace-rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-rules-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(720px, calc(100vw - 32px))",
          maxHeight: "min(88vh, 850px)",
          display: "flex",
          flexDirection: "column",
          background: "oklch(from var(--canvas-1) l c h / 0.98)",
          border: "1px solid var(--stroke-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--elev-4)",
          backdropFilter: "blur(24px)",
          animation: closing
            ? "dialog-out 0.15s cubic-bezier(0.4, 0, 1, 1) both"
            : "dialog-in 0.18s cubic-bezier(0, 0, 0.2, 1) backwards",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "18px 24px 14px",
            borderBottom: "1px solid var(--stroke-1)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: "var(--accent-tint, oklch(0.55 0.18 250 / 0.15))",
                  color: "var(--accent, oklch(0.65 0.20 250))",
                }}
              >
                <Ico.Shield />
              </span>
              <h2
                id="workspace-rules-title"
                style={{
                  fontSize: 16,
                  fontWeight: 650,
                  margin: 0,
                  letterSpacing: "-0.01em",
                }}
              >
                Workspace Architectural Rules & Durable Context
              </h2>
            </div>
            <p
              style={{
                fontSize: 12,
                color: "var(--ink-3)",
                margin: "4px 0 0",
                lineHeight: 1.45,
              }}
            >
              Persistent technical stack and architectural constraints that steer AI diagramming
              without retyping them on every prompt.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={requestClose}
            aria-label="Close rules dialog"
            style={{ padding: 6 }}
          >
            <Ico.X />
          </button>
        </div>

        {/* Templates Bar */}
        <div
          style={{
            padding: "10px 24px",
            background: "var(--canvas-0)",
            borderBottom: "1px solid var(--stroke-1)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            overflowX: "auto",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-4)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              whiteSpace: "nowrap",
            }}
          >
            Presets:
          </span>
          {WORKSPACE_RULE_TEMPLATES.map((tmpl) => (
            <button
              key={tmpl.id}
              type="button"
              className={`rule-template-chip ${activeTemplate === tmpl.id ? "active" : ""}`}
              onClick={() => applyTemplate(tmpl.id)}
              title={tmpl.description}
            >
              {tmpl.title}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="rule-preview-toggle-btn ghost-button"
            onClick={() => setShowPreview(!showPreview)}
            style={{
              padding: "4px 8px",
              fontSize: 11,
              fontWeight: 550,
              cursor: "pointer",
            }}
          >
            <span>{showPreview ? "Hide Preview" : "Show Live Prompt Injection Preview"}</span>
            {formattedPrompt ? (
              <span style={{ fontSize: 10, color: "var(--ink-4)", marginLeft: 4 }}>
                ({formattedPrompt.length} chars)
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="rule-template-clear-btn"
            onClick={clearRules}
            title="Reset all rules to empty"
          >
            Clear
          </button>
        </div>

        {/* Live Prompt Preview Drawer */}
        {showPreview && (
          <div
            className="rule-preview-content"
            style={{
              padding: "10px 24px",
              background: "var(--canvas-elevated, var(--canvas-0))",
              borderBottom: "1px solid var(--stroke-1)",
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              color: "var(--ink-2)",
              maxHeight: 180,
              overflowY: "auto",
              flexShrink: 0,
            }}
          >
            {formattedPrompt ? (
              <>
                <div style={{ color: "var(--ink-4)", marginBottom: 4 }}>
                  &lt;workspace-rules&gt;
                </div>
                {formattedPrompt}
                <div style={{ color: "var(--ink-4)", marginTop: 4 }}>&lt;/workspace-rules&gt;</div>
              </>
            ) : (
              <span style={{ color: "var(--ink-4)", fontStyle: "italic" }}>
                No architectural rules configured yet. Fill out fields or pick a preset above.
              </span>
            )}
          </div>
        )}

        {/* Scrollable Form Body */}
        <div
          style={{
            padding: "16px 24px 32px",
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div className="rule-field-group">
            <label className="rule-field-label">Cloud & Infrastructure Stack</label>
            <input
              type="text"
              className="rule-field-input"
              placeholder="e.g. Google Cloud Platform (GCP), AWS, Kubernetes (EKS)"
              value={form.cloudStack ?? ""}
              onChange={(e) => {
                setForm({ ...form, cloudStack: e.target.value });
                setActiveTemplate(null);
              }}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="rule-field-group">
              <label className="rule-field-label">Languages & Frameworks</label>
              <input
                type="text"
                className="rule-field-input"
                placeholder="e.g. Go 1.22, TypeScript, Next.js, gRPC"
                value={form.languagesAndFrameworks ?? ""}
                onChange={(e) => {
                  setForm({ ...form, languagesAndFrameworks: e.target.value });
                  setActiveTemplate(null);
                }}
              />
            </div>
            <div className="rule-field-group">
              <label className="rule-field-label">Databases & Storage</label>
              <input
                type="text"
                className="rule-field-input"
                placeholder="e.g. PostgreSQL 16, Redis 7, S3 / Cloud Storage"
                value={form.databasesAndStorage ?? ""}
                onChange={(e) => {
                  setForm({ ...form, databasesAndStorage: e.target.value });
                  setActiveTemplate(null);
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="rule-field-group">
              <label className="rule-field-label">Architectural Patterns</label>
              <input
                type="text"
                className="rule-field-input"
                placeholder="e.g. Event-Driven Microservices, CQRS, Hexagonal"
                value={form.architecturalPatterns ?? ""}
                onChange={(e) => {
                  setForm({ ...form, architecturalPatterns: e.target.value });
                  setActiveTemplate(null);
                }}
              />
            </div>
            <div className="rule-field-group">
              <label className="rule-field-label">Security & Authentication</label>
              <input
                type="text"
                className="rule-field-input"
                placeholder="e.g. OAuth 2.0 / OIDC, mTLS, JWT, Zero Trust"
                value={form.securityAndAuth ?? ""}
                onChange={(e) => {
                  setForm({ ...form, securityAndAuth: e.target.value });
                  setActiveTemplate(null);
                }}
              />
            </div>
          </div>

          <div className="rule-field-group">
            <label className="rule-field-label">Naming Conventions</label>
            <input
              type="text"
              className="rule-field-input"
              placeholder="e.g. kebab-case services (auth-service), snake_case DB columns"
              value={form.namingConventions ?? ""}
              onChange={(e) => {
                setForm({ ...form, namingConventions: e.target.value });
                setActiveTemplate(null);
              }}
            />
          </div>

          <div className="rule-field-group">
            <label className="rule-field-label warning">
              Prohibited Patterns (AI MUST NEVER USE)
            </label>
            <input
              type="text"
              className="rule-field-input warning"
              placeholder="e.g. No MongoDB; no synchronous multi-hop chains; no unauthenticated endpoints"
              value={form.prohibitedPatterns ?? ""}
              onChange={(e) => {
                setForm({ ...form, prohibitedPatterns: e.target.value });
                setActiveTemplate(null);
              }}
            />
          </div>

          <div className="rule-field-group">
            <label className="rule-field-label">Custom Architectural Instructions</label>
            <textarea
              className="rule-field-textarea"
              rows={3}
              placeholder="Freeform constraints or domain guidelines (e.g. Every payment state change must emit a Kafka event. Favor managed services over VMs.)"
              value={form.customInstructions ?? ""}
              onChange={(e) => {
                setForm({ ...form, customInstructions: e.target.value });
                setActiveTemplate(null);
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 24px",
            borderTop: "1px solid var(--stroke-1)",
            background: "var(--canvas-0)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className="icon-btn"
            onClick={handleCopyPrompt}
            disabled={!formattedPrompt}
            style={{ fontSize: 11 }}
            title="Copy compiled prompt text to clipboard"
          >
            {copied ? "Copied Prompt!" : "Copy Prompt Text"}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="btn-atelier" onClick={requestClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-atelier primary"
              onClick={handleSave}
              style={{ fontWeight: 600 }}
            >
              Save Rules
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
