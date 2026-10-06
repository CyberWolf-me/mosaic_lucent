import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  specToOps,
  classifySpec,
  sqlDdlToOps,
  prismaToOps,
  openApiToOps,
  composeToOps,
  type SpecFormat,
  type Operation,
} from "@lucent/core";
import { useWorkspace } from "../workspace.js";
import { useToast } from "./Toast.js";
import { Ico } from "./icons.js";

export type SupportedSpecFormat = "sqlddl" | "prisma" | "openapi" | "compose";

const SAMPLES: Record<SupportedSpecFormat, { label: string; text: string }> = {
  sqlddl: {
    label: "SQL DDL (E-Commerce)",
    text: `-- Core E-Commerce Schema
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(100),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  total_cents INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id),
  product_id UUID NOT NULL,
  quantity INT NOT NULL,
  unit_price INT NOT NULL
);

CREATE TABLE products (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  price_cents INT NOT NULL,
  stock_count INT NOT NULL
);`,
  },
  prisma: {
    label: "Prisma Schema (Blog & Auth)",
    text: `// Blog & Authentication Data Model
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())
}

model Profile {
  id     String  @id @default(uuid())
  bio    String?
  userId String  @unique
  user   User    @relation(fields: [userId], references: [id])
}

model Post {
  id        String   @id @default(uuid())
  title     String
  content   String?
  published Boolean  @default(false)
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
  tags      Tag[]
}

model Tag {
  id    String @id @default(uuid())
  name  String @unique
  posts Post[]
}`,
  },
  openapi: {
    label: "OpenAPI 3.0 (Petstore & Orders)",
    text: `{
  "openapi": "3.0.0",
  "info": {
    "title": "Petstore Microservice",
    "version": "1.0.0"
  },
  "paths": {
    "/pets": {
      "get": {
        "summary": "List all pets",
        "tags": ["Pets"],
        "responses": {
          "200": {
            "description": "A paged array of pets",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/Pet"
                }
              }
            }
          }
        }
      },
      "post": {
        "summary": "Create a pet",
        "tags": ["Pets"],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Pet"
              }
            }
          }
        }
      }
    },
    "/orders": {
      "post": {
        "summary": "Place order",
        "tags": ["Orders"],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/Order"
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "Pet": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "name": { "type": "string" },
          "tag": { "type": "string" }
        }
      },
      "Order": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "petId": { "type": "integer" },
          "quantity": { "type": "integer" }
        }
      }
    }
  }
}`,
  },
  compose: {
    label: "Docker Compose (Web Stack)",
    text: `version: "3.8"
services:
  gateway:
    image: nginx:alpine
    ports:
      - "80:80"
    depends_on:
      - api
      - web

  web:
    image: node:20-alpine
    ports:
      - "3000:3000"

  api:
    image: python:3.11-slim
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
      - queue

  postgres:
    image: postgres:16
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  queue:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"`,
  },
};

export function SpecImportModal({ onClose }: { onClose: () => void }) {
  const { applyManual } = useWorkspace();
  const { notify } = useToast();
  const [closing, setClosing] = useState(false);
  const [specText, setSpecText] = useState("");
  const [forcedFormat, setForcedFormat] = useState<SupportedSpecFormat | "auto">("auto");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 140);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing]);

  // Detected format
  const detectedFormat = useMemo<SpecFormat | null>(() => {
    if (!specText.trim()) return null;
    return classifySpec(specText);
  }, [specText]);

  const effectiveFormat: SupportedSpecFormat | null =
    forcedFormat === "auto"
      ? detectedFormat === "unknown"
        ? null
        : detectedFormat
      : forcedFormat;

  // Calculate operations based on format
  const preview = useMemo(() => {
    if (!specText.trim() || !effectiveFormat) {
      return { ops: [] as Operation[], nodeCount: 0, edgeCount: 0, groupCount: 0, error: null };
    }

    try {
      let ops: Operation[] = [];
      if (effectiveFormat === "sqlddl") ops = sqlDdlToOps(specText);
      else if (effectiveFormat === "prisma") ops = prismaToOps(specText);
      else if (effectiveFormat === "openapi") ops = openApiToOps(specText);
      else if (effectiveFormat === "compose") ops = composeToOps(specText);

      const nodeCount = ops.filter((o) => o.op === "CREATE_NODE").length;
      const edgeCount = ops.filter((o) => o.op === "CONNECT_NODES").length;
      const groupCount = ops.filter((o) => o.op === "CREATE_GROUP").length;

      return { ops, nodeCount, edgeCount, groupCount, error: null };
    } catch (err: any) {
      return {
        ops: [] as Operation[],
        nodeCount: 0,
        edgeCount: 0,
        groupCount: 0,
        error: err?.message ?? "Failed to parse specification",
      };
    }
  }, [specText, effectiveFormat]);

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (text) {
        setSpecText(text);
        // Hint format from extension if available
        const lower = file.name.toLowerCase();
        if (lower.endsWith(".sql")) setForcedFormat("sqlddl");
        else if (lower.endsWith(".prisma")) setForcedFormat("prisma");
        else if (lower.endsWith(".json") || lower.endsWith(".yaml") || lower.endsWith(".yml")) {
          if (lower.includes("compose")) setForcedFormat("compose");
          else setForcedFormat("auto");
        }
      }
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file) handleFileUpload(file);
    }
  };

  const handleImport = () => {
    if (preview.ops.length === 0) return;
    const formatName = effectiveFormat ? effectiveFormat.toUpperCase() : "SPEC";
    const label = `Import ${formatName} (${preview.nodeCount} nodes, ${preview.edgeCount} connectors)`;
    const ok = applyManual(preview.ops, label);
    if (ok) {
      notify(`Imported ${formatName} into canvas with ${preview.nodeCount} entities.`);
      requestClose();
    } else {
      notify("Failed to apply specification operations to board.");
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
        className="spec-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spec-import-title"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 301,
          width: "min(880px, calc(100vw - 32px))",
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
                id="spec-import-title"
                style={{ margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}
              >
                Import Code & Specifications
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
              Parse OpenAPI 3.0 / Swagger, SQL DDL, Prisma schemas, or Docker Compose into
              fully structured, editable visual canvas diagrams.
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

        {/* Format Selector & Sample Buttons */}
        <div
          style={{
            padding: "12px 24px",
            borderBottom: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.2))",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: "oklch(0.18 0.015 255 / 0.4)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted, oklch(0.65 0.01 255))", marginRight: 4 }}>
              Format:
            </span>
            {(["auto", "sqlddl", "prisma", "openapi", "compose"] as const).map((fmt) => {
              const active = forcedFormat === fmt;
              const label =
                fmt === "auto"
                  ? detectedFormat && detectedFormat !== "unknown"
                    ? `Auto (${detectedFormat.toUpperCase()})`
                    : "Auto-detect"
                  : fmt === "openapi"
                  ? "OpenAPI / Swagger"
                  : fmt === "sqlddl"
                  ? "SQL DDL"
                  : fmt === "prisma"
                  ? "Prisma"
                  : "Docker Compose";
              return (
                <button
                  key={fmt}
                  onClick={() => setForcedFormat(fmt)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: active ? 600 : 400,
                    border: active
                      ? "1px solid var(--accent-bright, oklch(0.7 0.12 250))"
                      : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                    background: active
                      ? "var(--accent-subtle, oklch(0.3 0.06 250))"
                      : "transparent",
                    color: active ? "white" : "var(--text-muted, oklch(0.8 0.01 255))",
                    cursor: "pointer",
                    transition: "all 0.12s ease",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted, oklch(0.65 0.01 255))" }}>
              Samples:
            </span>
            {(["sqlddl", "prisma", "openapi", "compose"] as SupportedSpecFormat[]).map((fmt) => (
              <button
                key={fmt}
                onClick={() => {
                  setSpecText(SAMPLES[fmt].text);
                  setForcedFormat(fmt);
                }}
                style={{
                  padding: "3px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.25))",
                  background: "transparent",
                  color: "var(--text-muted, oklch(0.75 0.01 255))",
                  cursor: "pointer",
                }}
                title={`Load sample ${SAMPLES[fmt].label}`}
              >
                {fmt.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Main Body: Editor & Dropzone */}
        <div
          style={{
            padding: "16px 24px",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 280,
            overflowY: "auto",
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <div
            style={{
              position: "relative",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              borderRadius: 8,
              border: dragOver
                ? "2px dashed var(--accent-bright, oklch(0.75 0.14 250))"
                : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.4))",
              background: dragOver
                ? "oklch(0.24 0.03 250 / 0.4)"
                : "oklch(0.14 0.01 255 / 0.7)",
              transition: "border-color 0.15s, background-color 0.15s",
            }}
          >
            <textarea
              value={specText}
              onChange={(e) => setSpecText(e.target.value)}
              placeholder="Paste SQL CREATE TABLE statements, Prisma schema, OpenAPI 3.0/Swagger JSON or YAML, or Docker Compose yaml here... Or drag and drop a file."
              aria-label="Specification code content"
              style={{
                width: "100%",
                height: 260,
                padding: "14px 16px",
                boxSizing: "border-box",
                background: "transparent",
                border: "none",
                outline: "none",
                color: "var(--text-main, oklch(0.92 0.01 255))",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                fontSize: 12.5,
                lineHeight: 1.5,
                resize: "vertical",
              }}
            />

            {/* Drop / upload hint footer */}
            <div
              style={{
                padding: "8px 14px",
                borderTop: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.2))",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontSize: 11.5,
                color: "var(--text-muted, oklch(0.65 0.01 255))",
              }}
            >
              <span>Tip: You can drag & drop .sql, .prisma, .json, or .yaml files directly here.</span>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 8px",
                  borderRadius: 4,
                  border: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                  background: "oklch(0.22 0.015 255 / 0.5)",
                  color: "var(--text-main, inherit)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                <Ico.Upload /> Browse File
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".sql,.prisma,.json,.yaml,.yml"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFileUpload(f);
                }}
              />
            </div>
          </div>

          {/* Live Preview / Stats Bar */}
          {specText.trim().length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderRadius: 8,
                background: preview.error
                  ? "oklch(0.25 0.06 25 / 0.4)"
                  : preview.nodeCount > 0
                  ? "oklch(0.22 0.04 150 / 0.3)"
                  : "oklch(0.20 0.015 255 / 0.5)",
                border: preview.error
                  ? "1px solid oklch(0.5 0.15 25 / 0.5)"
                  : preview.nodeCount > 0
                  ? "1px solid oklch(0.45 0.1 150 / 0.4)"
                  : "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
                fontSize: 12.5,
              }}
            >
              {preview.error ? (
                <span style={{ color: "oklch(0.8 0.15 25)" }}>Error: {preview.error}</span>
              ) : preview.nodeCount > 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ fontWeight: 600, color: "oklch(0.88 0.1 150)" }}>
                    ✓ Ready to construct:
                  </span>
                  <span>
                    <strong>{preview.nodeCount}</strong> nodes
                  </span>
                  <span>
                    <strong>{preview.edgeCount}</strong> connectors
                  </span>
                  {preview.groupCount > 0 && (
                    <span>
                      <strong>{preview.groupCount}</strong> API groups
                    </span>
                  )}
                  <span style={{ color: "var(--text-muted, oklch(0.7 0.01 255))" }}>
                    Target:{" "}
                    {effectiveFormat === "sqlddl" || effectiveFormat === "prisma"
                      ? "Entity Relationship (ER)"
                      : "Architecture"}
                  </span>
                </div>
              ) : (
                <span style={{ color: "var(--text-muted, oklch(0.65 0.01 255))" }}>
                  No entities detected yet. Please ensure the syntax matches the selected format.
                </span>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border-subtle, oklch(0.35 0.02 255 / 0.3))",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            background: "oklch(0.18 0.015 255 / 0.3)",
          }}
        >
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
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={preview.nodeCount === 0 || !!preview.error}
            style={{
              padding: "7px 18px",
              borderRadius: 6,
              background:
                preview.nodeCount > 0 && !preview.error
                  ? "var(--accent-bright, oklch(0.65 0.16 250))"
                  : "oklch(0.3 0.02 255 / 0.3)",
              border: "none",
              color: preview.nodeCount > 0 && !preview.error ? "white" : "oklch(0.55 0.01 255)",
              fontSize: 13,
              fontWeight: 600,
              cursor: preview.nodeCount > 0 && !preview.error ? "pointer" : "not-allowed",
              boxShadow:
                preview.nodeCount > 0 && !preview.error
                  ? "0 2px 8px oklch(0.65 0.16 250 / 0.35)"
                  : "none",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              transition: "all 0.12s ease",
            }}
          >
            <Ico.Code /> Import to Canvas
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
