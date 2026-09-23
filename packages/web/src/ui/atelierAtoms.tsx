import React, { useState, useEffect, type ReactNode } from "react";
import { Ico, ToolIco } from "./icons.js";
import { useWorkspace, type View } from "../workspace.js";
import type { Tool } from "./ShapeToolbar.js";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationAge,
  notificationTimestamp,
  startUnreadPoll,
  describeNotification,
  type NotificationView,
} from "../notifications.js";

// =================================================================
// NOTIFICATION COUNT STORE (Synchronized across tabs and views)
// =================================================================
export function useNotifCount(): number {
  const read = () => {
    try {
      const v = localStorage.getItem("lucent.v2.notifCount");
      return v === null ? 0 : Math.max(0, parseInt(v, 10) || 0);
    } catch {
      return 0;
    }
  };
  const [count, setCount] = useState<number>(read());
  useEffect(() => {
    const onChange = () => setCount(read());
    window.addEventListener("lucent:notif-count", onChange);
    window.addEventListener("storage", onChange);
    const stopPoll = startUnreadPoll({
      onCount: (c) => {
        setCount(c);
        try {
          localStorage.setItem("lucent.v2.notifCount", String(Math.max(0, c)));
        } catch {
          /* ignore */
        }
      },
      onStopped: () => {},
    });
    return () => {
      window.removeEventListener("lucent:notif-count", onChange);
      window.removeEventListener("storage", onChange);
      stopPoll();
    };
  }, []);
  return count;
}

export function setNotifCount(n: number) {
  try {
    localStorage.setItem("lucent.v2.notifCount", String(Math.max(0, n)));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("lucent:notif-count"));
}

// =================================================================
// PROVENANCE CHIP — "Where did this object come from?"
// =================================================================
export interface ProvenanceRef {
  icon?: ReactNode;
  label: string;
}

export function ProvenanceChip({
  icon,
  label,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px 3px 6px",
        background: "oklch(from var(--paper-2) l c h / 0.7)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: "var(--ink-2)",
        letterSpacing: "0.02em",
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.12s var(--e-out)",
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.borderColor = "var(--ink-3)";
          e.currentTarget.style.color = "var(--ink-0)";
          e.currentTarget.style.transform = "translateY(-1px)";
        }
      }}
      onMouseLeave={(e) => {
        if (onClick) {
          e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.5)";
          e.currentTarget.style.color = "var(--ink-2)";
          e.currentTarget.style.transform = "translateY(0)";
        }
      }}
    >
      {icon && <span style={{ display: "grid", placeItems: "center" }}>{icon}</span>}
      <span>{label}</span>
    </button>
  );
}

// =================================================================
// DECISION CARD & DETAIL MODAL
// =================================================================
export interface DecisionItem {
  id?: string;
  title: string;
  status?: "active" | "review" | "pending" | "superseded" | "open" | "resolved" | "rejected";
  owner?: string;
  author?: string;
  ownerColor?: string;
  date: string;
  evidence?: string;
  from?: ProvenanceRef;
  provenance?: { meetingId: string; turnRange?: [number, number] };
  superseded?: string;
  compact?: boolean;
}

export function DecisionCard({
  title,
  status = "active",
  owner,
  ownerColor,
  date,
  evidence,
  from,
  superseded,
  compact = false,
  onClick,
}: DecisionItem & { onClick?: () => void }) {
  const statusStyle = {
    active: { bg: "oklch(from var(--moss) l c h / 0.12)", fg: "var(--moss)", label: "Active" },
    open: { bg: "oklch(from var(--moss) l c h / 0.12)", fg: "var(--moss)", label: "Open" },
    resolved: { bg: "oklch(from var(--moss) l c h / 0.12)", fg: "var(--moss)", label: "Resolved" },
    superseded: { bg: "oklch(from var(--ink-3) l c h / 0.12)", fg: "var(--ink-2)", label: "Superseded" },
    rejected: { bg: "oklch(from var(--madder) l c h / 0.12)", fg: "var(--madder)", label: "Rejected" },
    review: { bg: "var(--bloom-wash)", fg: "var(--bloom-2)", label: "In review" },
    pending: { bg: "oklch(from var(--saffron) l c h / 0.18)", fg: "oklch(0.5 0.14 65)", label: "Pending" },
  }[status] || { bg: "var(--paper-2)", fg: "var(--ink-2)", label: status };

  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        padding: compact ? "12px 14px" : "16px 18px",
        borderRadius: 14,
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
        boxShadow: "var(--shadow-1)",
        transition: "all 0.15s var(--e-out)",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = "translateY(-1px)";
          e.currentTarget.style.boxShadow = "var(--shadow-2)";
          e.currentTarget.style.borderColor = "var(--ink-3)";
        }
      }}
      onMouseLeave={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = "var(--shadow-1)";
          e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.6)";
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            background: statusStyle.bg,
            color: statusStyle.fg,
            textTransform: "uppercase",
          }}
        >
          {statusStyle.label}
        </span>
        {superseded && (
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            → superseded by{" "}
            <span style={{ color: "var(--bloom-2)", textDecoration: "underline", textDecorationStyle: "dotted" }}>
              {superseded}
            </span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", letterSpacing: "0.02em" }}>
          {date}
        </span>
      </div>

      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: compact ? 15 : 17,
          fontWeight: 500,
          color: "var(--ink-0)",
          letterSpacing: "-0.01em",
          marginBottom: compact ? 6 : 10,
          textDecoration: status === "superseded" ? "line-through" : "none",
          opacity: status === "superseded" ? 0.7 : 1,
        }}
      >
        {title}
      </div>

      {evidence && (
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-2)",
            lineHeight: 1.5,
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            padding: "8px 12px",
            borderLeft: "2px solid var(--bloom-2)",
            background: "oklch(from var(--bloom-1) l c h / 0.05)",
            borderRadius: "0 6px 6px 0",
            marginBottom: 10,
          }}
        >
          "{evidence}"
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {owner && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11.5,
              color: "var(--ink-1)",
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: 999,
                background: ownerColor || "var(--ink-2)",
                color: "white",
                fontFamily: "var(--font-mono)",
                fontSize: 8,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
              }}
            >
              {owner[0]}
            </span>
            {owner}
          </span>
        )}
        {from && <ProvenanceChip icon={from.icon} label={from.label} />}
      </div>
    </div>
  );
}

export function DecisionDetailModal({
  decision,
  onClose,
  onGoMeeting,
  onGoBoard,
  onUpdateStatus,
}: {
  decision: DecisionItem;
  onClose: () => void;
  onGoMeeting?: () => void;
  onGoBoard?: () => void;
  onUpdateStatus?: (status: "active" | "review" | "pending" | "superseded") => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 200,
          background: "oklch(0.20 0.02 60 / 0.4)",
          backdropFilter: "blur(8px)",
        }}
      />
      <div
        style={{
          position: "fixed",
          zIndex: 201,
          top: "12vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: 620,
          maxWidth: "calc(100vw - 40px)",
          maxHeight: "80vh",
          overflowY: "auto",
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 18,
          boxShadow: "var(--shadow-3)",
          padding: "28px 32px 24px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <span className="mono-caps" style={{ color: "var(--bloom-2)" }}>
            DECISION · {decision.date}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{ padding: 6, color: "var(--ink-3)", cursor: "pointer", border: 0, background: "none" }}
            title="Close"
          >
            <Ico.X />
          </button>
        </div>

        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: "-0.02em",
            lineHeight: 1.2,
            color: "var(--ink-0)",
            textDecoration: decision.status === "superseded" ? "line-through" : "none",
            marginBottom: 16,
          }}
        >
          {decision.title}
        </div>

        {/* Live Lifecycle Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
          <span className="mono-caps" style={{ fontSize: 11, color: "var(--ink-3)", marginRight: 2 }}>
            Status:
          </span>
          {(["active", "review", "superseded"] as const).map((st) => {
            const isSelected =
              decision.status === st ||
              (st === "active" && (decision.status === "open" || decision.status === "active"));
            return (
              <button
                key={st}
                type="button"
                onClick={() => onUpdateStatus?.(st)}
                className="btn-atelier"
                style={{
                  height: 26,
                  fontSize: 11,
                  padding: "0 10px",
                  borderRadius: 6,
                  background: isSelected ? "var(--ink-0)" : "var(--paper-2)",
                  color: isSelected ? "var(--paper-0)" : "var(--ink-1)",
                  fontWeight: isSelected ? 600 : 400,
                  border: 0,
                  cursor: onUpdateStatus ? "pointer" : "default",
                }}
              >
                {st === "active" ? "Active" : st === "review" ? "In Review" : "Superseded"}
              </button>
            );
          })}
        </div>

        {decision.evidence && (
          <div style={{ marginBottom: 22 }}>
            <div className="mono-caps" style={{ marginBottom: 8 }}>
              Evidence · from meeting transcript
            </div>
            <div
              style={{
                padding: "14px 16px",
                borderLeft: "3px solid var(--bloom-2)",
                background: "oklch(from var(--bloom-1) l c h / 0.05)",
                borderRadius: "0 8px 8px 0",
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: 15,
                lineHeight: 1.55,
                color: "var(--ink-0)",
              }}
            >
              &ldquo;{decision.evidence}&rdquo;
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 24, paddingTop: 16, borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.5)" }}>
          {onGoMeeting && (
            <button
              type="button"
              className="btn-atelier ghost"
              onClick={onGoMeeting}
              style={{ flex: 1 }}
            >
              <Ico.Present /> View in Meeting Doc
            </button>
          )}
          {onGoBoard && (
            <button
              type="button"
              className="btn-atelier bloom"
              onClick={onGoBoard}
              style={{ flex: 1 }}
            >
              <Ico.Layers /> Reveal on Canvas
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// =================================================================
// ACTION CARD & PRIORITY CHIP
// =================================================================
export interface ActionItem {
  id?: string;
  title: string;
  owner?: string;
  ownerColor?: string;
  due?: string;
  status?: "todo" | "doing" | "done" | "blocked";
  priority?: "P0" | "P1" | "P2" | "P3";
  project?: string;
  decision?: string;
  external?: string;
  compact?: boolean;
}

export function ActionCard({
  title,
  owner,
  ownerColor = "oklch(0.55 0.14 200)",
  due,
  status = "todo",
  priority,
  project,
  decision,
  external,
  compact = false,
  onToggleStatus,
  onClick,
}: ActionItem & { onToggleStatus?: () => void; onClick?: () => void }) {
  const statusMap = {
    todo: { icon: "○", color: "var(--ink-3)" },
    doing: { icon: "◐", color: "var(--bloom-2)" },
    done: { icon: "●", color: "var(--moss)" },
    blocked: { icon: "⚠", color: "var(--madder)" },
  };
  const s = statusMap[status] || statusMap.todo;
  const overdue = due && due.toUpperCase().includes("OVERDUE");

  return (
    <div
      onClick={onClick}
      style={{
        padding: compact ? "10px 12px" : "14px 16px",
        borderRadius: 12,
        background: "var(--paper-0)",
        border: `1px solid ${overdue ? "oklch(from var(--madder) l c h / 0.4)" : "oklch(from var(--paper-4) l c h / 0.5)"}`,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        transition: "all 0.15s var(--e-out)",
        cursor: onClick ? "pointer" : "default",
        boxShadow: "var(--shadow-1)",
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.background = "var(--paper-1)";
      }}
      onMouseLeave={(e) => {
        if (onClick) e.currentTarget.style.background = "var(--paper-0)";
      }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStatus?.();
        }}
        style={{
          width: 18,
          height: 18,
          borderRadius: 4,
          border: `1.5px solid ${s.color}`,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          marginTop: 2,
          background: status === "done" ? s.color : "transparent",
          color: status === "done" ? "white" : "transparent",
          cursor: "pointer",
        }}
        title={`Status: ${status}`}
      >
        {status === "done" && <Ico.Check style={{ width: 12, height: 12 }} />}
      </button>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: compact ? 13 : 14,
            fontWeight: 500,
            color: "var(--ink-0)",
            textDecoration: status === "done" ? "line-through" : "none",
            opacity: status === "done" ? 0.6 : 1,
            marginBottom: 4,
          }}
        >
          {title}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {owner && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--ink-2)" }}>
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: ownerColor,
                  color: "white",
                  fontFamily: "var(--font-mono)",
                  fontSize: 8,
                  fontWeight: 700,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {owner[0]}
              </span>
              {owner}
            </span>
          )}

          {due && (
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: overdue ? "var(--madder)" : "var(--ink-3)",
                fontWeight: overdue ? 600 : 400,
              }}
            >
              {due}
            </span>
          )}

          {priority && <PriorityChip level={priority} />}
          {project && <ProvenanceChip icon={<Ico.Folder />} label={project} />}
          {decision && <ProvenanceChip icon={<DecisionIcon />} label={decision} />}
          {external && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "2px 6px",
                background: "oklch(0.55 0.14 265 / 0.12)",
                color: "oklch(0.5 0.14 265)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fontWeight: 600,
                borderRadius: 4,
              }}
            >
              <LinearMark /> {external}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function PriorityChip({ level }: { level: "P0" | "P1" | "P2" | "P3" }) {
  const c = {
    P0: "var(--madder)",
    P1: "oklch(0.55 0.16 40)",
    P2: "oklch(0.55 0.14 78)",
    P3: "var(--ink-3)",
  }[level] || "var(--ink-3)";
  return (
    <span
      style={{
        padding: "1px 6px",
        borderRadius: 3,
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 700,
        color: "white",
        background: c,
      }}
    >
      {level}
    </span>
  );
}

// =================================================================
// RISK CHIP & QUESTION CARD
// =================================================================
export function RiskChip({
  severity = "med",
  probability = "med",
  title,
  owner,
  ownerColor = "var(--ink-2)",
}: {
  severity?: "high" | "med" | "low";
  probability?: "high" | "med" | "low";
  title: string;
  owner?: string;
  ownerColor?: string;
}) {
  const sevColor = { high: "var(--madder)", med: "oklch(0.55 0.16 40)", low: "var(--ink-3)" }[severity];
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--paper-0)",
        border: `1px solid oklch(from ${sevColor} l c h / 0.35)`,
        borderLeft: `4px solid ${sevColor}`,
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
      <div style={{ color: sevColor, flexShrink: 0 }}>
        <RiskIcon />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)", marginBottom: 3 }}>
          {title}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 10, color: sevColor, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            {severity} sev · {probability} prob
          </span>
          {owner && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--ink-2)" }}>
              <span style={{ width: 14, height: 14, borderRadius: 999, background: ownerColor, color: "white", fontFamily: "var(--font-mono)", fontSize: 8, fontWeight: 700, display: "grid", placeItems: "center" }}>
                {owner[0]}
              </span>
              {owner}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// =================================================================
// VIDEO TILE (Meeting Overlays)
// =================================================================
export function VideoTile({
  name,
  initials,
  color,
  muted = false,
  speaking = false,
  camera = true,
  size = "md",
  tag,
}: {
  name: string;
  initials: string;
  color: string;
  muted?: boolean;
  speaking?: boolean;
  camera?: boolean;
  size?: "sm" | "md" | "lg";
  tag?: string;
}) {
  const sizes = { sm: { w: 120, h: 78 }, md: { w: 180, h: 110 }, lg: { w: 260, h: 150 } };
  const s = sizes[size];
  return (
    <div
      style={{
        position: "relative",
        width: s.w,
        height: s.h,
        borderRadius: 14,
        background: camera
          ? `radial-gradient(circle at 30% 40%, ${color}, oklch(from ${color} calc(l - 0.2) c h))`
          : "oklch(0.14 0.014 55)",
        border: speaking ? "2px solid var(--bloom-1)" : "1.5px solid oklch(from var(--paper-4) l c h / 0.6)",
        boxShadow: speaking ? "0 0 0 3px var(--bloom-wash), var(--shadow-2)" : "var(--shadow-2)",
        overflow: "hidden",
        transition: "all 0.2s var(--e-out)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          color: "white",
          fontFamily: "var(--font-mono)",
          fontSize: size === "sm" ? 18 : 26,
          fontWeight: 700,
          textShadow: "0 2px 8px rgba(0,0,0,0.4)",
        }}
      >
        {initials}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          padding: "16px 10px 6px",
          background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.65))",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "white",
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {muted && (
          <div style={{ background: "rgba(0,0,0,0.6)", padding: "2px 4px", borderRadius: 999, color: "white", fontSize: 9 }}>
            mic off
          </div>
        )}
      </div>

      {tag && (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            padding: "2px 6px",
            borderRadius: 4,
            background: "rgba(0,0,0,0.6)",
            color: "white",
            fontFamily: "var(--font-mono)",
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
          }}
        >
          {tag}
        </div>
      )}
    </div>
  );
}

// =================================================================
// APPROVAL CARD (Review Queue)
// =================================================================
export interface ChangeItem {
  count: number;
  label: string;
  color?: string;
}

export function ApprovalCard({
  kind = "decision",
  title,
  summary,
  from,
  when,
  changes,
  onApprove,
  onReject,
  onEdit,
}: {
  kind?: "decision" | "action" | "risk" | "question" | "edit";
  title: string;
  summary?: string;
  from?: ProvenanceRef;
  when: string;
  changes?: ChangeItem[];
  onApprove?: () => void;
  onReject?: () => void;
  onEdit?: () => void;
}) {
  const kindMap = {
    decision: { icon: <DecisionIcon />, label: "Decision", color: "var(--bloom-2)" },
    action: { icon: <ActionIcon />, label: "Action", color: "var(--moss)" },
    risk: { icon: <RiskIcon />, label: "Risk", color: "var(--madder)" },
    question: { icon: <QuestionIcon />, label: "Question", color: "oklch(0.55 0.16 40)" },
    edit: { icon: <Ico.Sparkle />, label: "Canvas edit", color: "var(--saffron)" },
  }[kind] || { icon: <Ico.Sparkle />, label: kind, color: "var(--ink-2)" };

  return (
    <div
      style={{
        padding: 18,
        borderRadius: 14,
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `oklch(from ${kindMap.color} l c h / 0.14)`,
            color: kindMap.color,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          {kindMap.icon}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className="mono-caps" style={{ color: kindMap.color, fontSize: 10, letterSpacing: "0.08em" }}>
              PROPOSED · {kindMap.label}
            </span>
            <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
              · {when}
            </span>
          </div>
          <div
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 17,
              fontWeight: 500,
              color: "var(--ink-0)",
              letterSpacing: "-0.01em",
              lineHeight: 1.3,
            }}
          >
            {title}
          </div>
          {summary && (
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, marginTop: 6 }}>
              {summary}
            </div>
          )}
        </div>
      </div>

      {changes && changes.length > 0 && (
        <div
          style={{
            padding: "8px 12px",
            background: "oklch(from var(--paper-2) l c h / 0.6)",
            borderRadius: 8,
            marginBottom: 12,
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          {changes.map((c, i) => (
            <span
              key={i}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: c.color || "var(--ink-2)",
                letterSpacing: "0.02em",
              }}
            >
              <span style={{ fontWeight: 700 }}>{c.count}</span> {c.label}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {from && <ProvenanceChip icon={from.icon} label={from.label} />}
        <div style={{ flex: 1 }} />
        {onEdit && (
          <button type="button" className="btn-atelier ghost" style={{ height: 30, fontSize: 12 }} onClick={onEdit}>
            Edit
          </button>
        )}
        {onReject && (
          <button type="button" className="btn-atelier danger" style={{ height: 30, fontSize: 12 }} onClick={onReject}>
            Reject
          </button>
        )}
        {onApprove && (
          <button
            type="button"
            className="btn-atelier bloom"
            style={{ height: 30, fontSize: 12, padding: "0 14px" }}
            onClick={onApprove}
          >
            Approve
          </button>
        )}
      </div>
    </div>
  );
}

// =================================================================
// SECTION HEADER & FILTER BAR
// =================================================================
export function SectionHeader({
  eyebrow,
  title,
  meta,
  actions,
}: {
  eyebrow?: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      {eyebrow && <div className="mono-caps" style={{ marginBottom: 6 }}>{eyebrow}</div>}
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1
          className="section-header-title"
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 32,
            fontWeight: 400,
            color: "var(--ink-0)",
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            margin: 0,
          }}
        >
          {title}
        </h1>
        {meta && (
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, color: "var(--ink-2)" }}>
            {meta}
          </div>
        )}
        <div style={{ flex: 1 }} />
        {actions && <div style={{ display: "flex", gap: 8, alignItems: "center" }}>{actions}</div>}
      </div>
    </div>
  );
}

export interface FilterItem {
  id: string;
  label: string;
  count?: number;
}

export function FilterBar({
  filters,
  active,
  onChange,
  extra,
}: {
  filters: FilterItem[];
  active: string;
  onChange: (id: string) => void;
  extra?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 20, alignItems: "center", flexWrap: "wrap" }}>
      {filters.map((f) => {
        const isActive = active === f.id;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onChange(f.id)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12.5,
              fontWeight: 500,
              background: isActive ? "var(--ink-0)" : "oklch(from var(--paper-2) l c h / 0.6)",
              color: isActive ? "var(--paper-0)" : "var(--ink-1)",
              border: `1px solid ${isActive ? "var(--ink-0)" : "oklch(from var(--paper-4) l c h / 0.5)"}`,
              transition: "all 0.12s var(--e-out)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
          >
            {f.label}
            {f.count !== undefined && (
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: isActive ? "oklch(from var(--paper-0) l c h / 0.2)" : "oklch(from var(--paper-3) l c h / 0.9)",
                  color: isActive ? "var(--paper-0)" : "var(--ink-2)",
                }}
              >
                {f.count}
              </span>
            )}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      {extra}
    </div>
  );
}

// =================================================================
// STAT CARD
// =================================================================
export function StatCard({
  label,
  value,
  delta,
  color = "var(--ink-0)",
  sub,
  onClick,
}: {
  label: string;
  value: string | number;
  delta?: string;
  color?: string;
  sub?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className="stat-card"
      onClick={onClick}
      style={{
        padding: "16px 18px",
        borderRadius: 14,
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        cursor: onClick ? "pointer" : "default",
        transition: "transform 0.14s var(--e-out), box-shadow 0.14s var(--e-out)",
        boxShadow: "var(--shadow-1)",
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = "translateY(-2px)";
          e.currentTarget.style.boxShadow = "var(--shadow-2)";
        }
      }}
      onMouseLeave={(e) => {
        if (onClick) {
          e.currentTarget.style.transform = "translateY(0)";
          e.currentTarget.style.boxShadow = "var(--shadow-1)";
        }
      }}
    >
      <div className="mono-caps" style={{ marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 32,
            fontWeight: 400,
            color: color,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          {value}
        </div>
        {delta && (
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: delta.startsWith("+") ? "var(--moss)" : delta.startsWith("-") ? "var(--madder)" : "var(--ink-3)",
            }}
          >
            {delta}
          </span>
        )}
      </div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// =================================================================
// SHARE POPOVER
// =================================================================
export function SharePopover({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
      <div
        style={{
          position: "fixed",
          top: 62,
          right: 20,
          zIndex: 201,
          width: 340,
          padding: 18,
          background: "oklch(from var(--paper-0) l c h / 0.98)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 14,
          boxShadow: "var(--shadow-3)",
          backdropFilter: "blur(24px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Ico.Share />
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)" }}>Share workspace</div>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={onClose} style={{ padding: 4, color: "var(--ink-3)", cursor: "pointer" }}>
            <Ico.X />
          </button>
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            padding: "8px 10px",
            background: "var(--paper-2)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
            borderRadius: 8,
            marginBottom: 12,
          }}
        >
          <span
            className="mono"
            style={{
              flex: 1,
              fontSize: 11.5,
              color: "var(--ink-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            lucent.app/w/e-commerce-x8j2
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText("https://lucent.app/w/e-commerce-x8j2");
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            style={{
              fontSize: 11.5,
              padding: "5px 12px",
              borderRadius: 6,
              background: copied ? "oklch(from var(--moss) l c h / 0.15)" : "var(--ink-0)",
              color: copied ? "var(--moss)" : "var(--paper-0)",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              cursor: "pointer",
            }}
          >
            {copied ? (
              <>
                <Ico.Check /> Copied
              </>
            ) : (
              "Copy"
            )}
          </button>
        </div>
        <div className="mono-caps" style={{ marginBottom: 8, color: "var(--ink-3)", fontSize: 10 }}>
          People with access · 3
        </div>
        {[
          { name: "Alex Kim", role: "Owner", color: "oklch(0.55 0.16 25)" },
          { name: "Sarah Chen", role: "Editor", color: "oklch(0.55 0.11 220)" },
          { name: "John Torres", role: "Editor", color: "oklch(0.55 0.14 148)" },
        ].map((p) => (
          <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 999,
                background: p.color,
                color: "white",
                display: "grid",
                placeItems: "center",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
              }}
            >
              {p.name
                .split(" ")
                .map((s) => s[0])
                .join("")}
            </div>
            <div style={{ flex: 1, fontSize: 12.5, color: "var(--ink-0)" }}>{p.name}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
              {p.role}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn-atelier ghost"
            style={{ height: 32, fontSize: 12, flex: 1 }}
          >
            <Ico.Plus /> Invite
          </button>
          <button
            type="button"
            className="btn-atelier ghost"
            style={{ height: 32, fontSize: 12 }}
          >
            Anyone with link
          </button>
        </div>
      </div>
    </>
  );
}

// =================================================================
// PROFILE MENU
// =================================================================
export function ProfileMenu({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings?: (section?: string) => void;
}) {
  const { setView } = useWorkspace();
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200 }} />
      <div
        style={{
          position: "fixed",
          top: 56,
          right: 20,
          zIndex: 201,
          width: 260,
          padding: 6,
          background: "oklch(from var(--paper-0) l c h / 0.98)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 12,
          boxShadow: "var(--shadow-3)",
          backdropFilter: "blur(24px)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 10px 12px",
            borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
            marginBottom: 4,
          }}
        >
          <div
            className="avatar"
            style={{
              width: 32,
              height: 32,
              borderRadius: 999,
              background: "oklch(0.55 0.16 25)",
              color: "white",
              display: "grid",
              placeItems: "center",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
            }}
          >
            AK
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-0)" }}>Alex Kim</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
              alex@northbeam.co
            </div>
          </div>
        </div>
        {[
          { icon: <HomeIcon />, label: "Home", action: () => setView("home" as View) },
          { icon: <BellIcon />, label: "Notifications", action: () => setView("dashboard" as View), k: "⌘I" },
          { icon: <Ico.Sparkle />, label: "Review queue", action: () => setView("review" as View), k: "⌘R" },
          {
            icon: <Ico.Settings />,
            label: "Admin · settings",
            action: () => (onOpenSettings ? onOpenSettings("account") : setView("admin" as View)),
            k: "⌘,",
          },
        ].map((m) => (
          <button
            key={m.label}
            type="button"
            onClick={() => {
              m.action();
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 10px",
              borderRadius: 7,
              color: "var(--ink-1)",
              fontSize: 12.5,
              textAlign: "left",
              cursor: "pointer",
              background: "transparent",
              border: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-2)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ color: "var(--ink-3)", display: "grid", placeItems: "center" }}>
              {m.icon}
            </span>
            <span style={{ flex: 1 }}>{m.label}</span>
            {m.k && (
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {m.k}
              </span>
            )}
          </button>
        ))}
        <div style={{ height: 1, background: "oklch(from var(--paper-4) l c h / 0.4)", margin: "4px 0" }} />
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.removeItem("lucent.token");
              localStorage.removeItem("lucent.user");
            } catch {}
            window.location.href = "/login";
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "8px 10px",
            borderRadius: 7,
            color: "var(--madder)",
            fontSize: 12.5,
            textAlign: "left",
            cursor: "pointer",
            background: "transparent",
            border: 0,
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "oklch(from var(--madder) l c h / 0.08)")
          }
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Ico.X />
          Sign out
        </button>
      </div>
    </>
  );
}

// =================================================================
// ATELIER NOTIFICATION POPOVER
// =================================================================
export function AtelierNotificationPopover({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<NotificationView[]>([]);
  const [status, setStatus] = useState<"loading" | "idle" | "error">("loading");
  const notifCount = useNotifCount();

  const load = async () => {
    setStatus("loading");
    const res = await fetchNotifications({ limit: 20 });
    if (!res.ok) {
      setStatus("error");
      return;
    }
    setStatus("idle");
    setRows(res.value.notifications.map(describeNotification));
    setNotifCount(res.value.unread);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onMarkRead = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, read: true } : r)));
    const res = await markNotificationRead(id);
    if (res.ok) {
      setNotifCount(res.value.count);
    }
  };

  const onMarkAllRead = async () => {
    setRows((prev) => prev.map((r) => ({ ...r, read: true })));
    setNotifCount(0);
    const res = await markAllNotificationsRead();
    if (res.ok) {
      setNotifCount(res.value.count);
    }
  };

  const now = Date.now();

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 90,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 68,
          bottom: 20,
          width: 380,
          maxHeight: 500,
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
          borderRadius: 16,
          boxShadow: "var(--shadow-3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          zIndex: 100,
        }}
        role="dialog"
        aria-label="Notifications"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 16px 12px",
            borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink-0)" }}>
            Notifications
          </span>
          {notifCount > 0 && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 999,
                background: "var(--madder)",
                color: "white",
                fontWeight: 700,
              }}
            >
              {notifCount}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onMarkAllRead}
            disabled={notifCount === 0}
            style={{
              border: 0,
              background: "none",
              color: notifCount > 0 ? "var(--bloom-2)" : "var(--ink-3)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: notifCount > 0 ? "pointer" : "default",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            Mark all read
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 0,
              background: "none",
              color: "var(--ink-3)",
              cursor: "pointer",
              padding: 4,
              display: "grid",
              placeItems: "center",
            }}
            title="Close notifications"
          >
            <Ico.X style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ overflowY: "auto", flex: 1, padding: "8px 10px" }}>
          {status === "loading" && rows.length === 0 && (
            <div
              style={{
                padding: "36px 16px",
                textAlign: "center",
                color: "var(--ink-3)",
                fontSize: 12,
              }}
            >
              Loading notifications…
            </div>
          )}

          {status === "error" && rows.length === 0 && (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--madder)",
                fontSize: 12,
              }}
            >
              Failed to load notifications.
            </div>
          )}

          {status === "idle" && rows.length === 0 && (
            <div
              style={{
                padding: "44px 20px",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ color: "var(--ink-3)", opacity: 0.4, display: "grid", placeItems: "center" }}>
                <BellIcon />
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink-1)" }}>
                No notifications
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", maxWidth: 220 }}>
                Invites, mentions, and collaborator updates will appear here.
              </div>
            </div>
          )}

          {rows.map((row) => (
            <div
              key={row.id}
              onClick={() => {
                void onMarkRead(row.id);
                if (row.href) {
                  window.location.assign(row.href);
                }
              }}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                background: row.read ? "transparent" : "oklch(from var(--bloom-2) l c h / 0.05)",
                border: "1px solid",
                borderColor: row.read
                  ? "transparent"
                  : "oklch(from var(--bloom-2) l c h / 0.15)",
                marginBottom: 6,
                cursor: row.href ? "pointer" : "default",
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                transition: "background 0.1s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-1)")}
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = row.read
                  ? "transparent"
                  : "oklch(from var(--bloom-2) l c h / 0.05)")
              }
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: row.read ? "transparent" : "var(--bloom-2)",
                  marginTop: 6,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 2,
                  }}
                >
                  <span
                    className="mono-caps"
                    style={{ fontSize: 9.5, color: "var(--ink-2)", fontWeight: 600 }}
                  >
                    {row.category}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink-3)" }}>·</span>
                  <span
                    className="mono"
                    style={{ fontSize: 9.5, color: "var(--ink-3)" }}
                    title={notificationTimestamp(row.createdAt)}
                  >
                    {notificationAge(row.createdAt, now)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-0)",
                    fontWeight: row.read ? 400 : 600,
                    lineHeight: 1.35,
                  }}
                >
                  {row.title}
                </div>
                {row.body && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-2)",
                      marginTop: 3,
                      lineHeight: 1.4,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.body}
                  </div>
                )}
              </div>
              {!row.read && (
                <button
                  type="button"
                  title="Mark as read"
                  onClick={(e) => void onMarkRead(row.id, e)}
                  style={{
                    border: 0,
                    background: "none",
                    color: "var(--ink-3)",
                    cursor: "pointer",
                    padding: 4,
                    borderRadius: 4,
                    display: "grid",
                    placeItems: "center",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--bloom-2)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}
                >
                  <Ico.Check style={{ width: 13, height: 13 }} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// =================================================================
// GLOBAL RAIL NAVIGATION (Atelier 7-area rail)
// =================================================================
export function GlobalRail({
  active,
  onOpenSettings,
}: {
  active: View | "home" | "review" | "integrations" | "notif" | "ask" | "board" | "meeting" | "intel" | "exec" | "history" | "system" | "ia";
  onOpenSettings?: (section?: string) => void;
}) {
  const { setView } = useWorkspace();
  const notifCount = useNotifCount();
  const [notifOpen, setNotifOpen] = useState(false);

  const items: Array<{ id: string; view: View; icon: ReactNode; label: string }> = [
    { id: "home", view: "home" as View, icon: <HomeIcon />, label: "Home" },
    { id: "workspace", view: "workspace" as View, icon: <Ico.Folder />, label: "Workspace" },
    { id: "board", view: "main" as View, icon: <Ico.Layers />, label: "Board" },
    { id: "meeting", view: "meeting_board" as View, icon: <Ico.Present />, label: "Meeting" },
    { id: "intel", view: "decisions" as View, icon: <IntelIcon />, label: "Intelligence" },
    { id: "exec", view: "projects" as View, icon: <ActionIcon />, label: "Execution" },
    { id: "history", view: "history" as View, icon: <Ico.History />, label: "History" },
  ];

  const bottomItems: Array<{
    id: string;
    view: View;
    icon: ReactNode;
    label: string;
    badge?: number | null;
    onClick?: () => void;
  }> = [
    {
      id: "ask",
      view: "knowledge" as View,
      icon: <Ico.Search />,
      label: "Ask · Search",
      onClick: () => window.dispatchEvent(new CustomEvent("lucent:open-command-overlay")),
    },
    {
      id: "notif",
      view: "notif" as View,
      icon: <BellIcon />,
      label: "Notifications",
      badge: notifCount > 0 ? notifCount : null,
      onClick: () => setNotifOpen((prev) => !prev),
    },
    {
      id: "admin",
      view: "admin" as View,
      icon: <Ico.Settings />,
      label: "Admin",
      onClick: () => (onOpenSettings ? onOpenSettings("admin") : setView("admin")),
    },
  ];

  return (
    <div
      style={{
        position: "absolute",
        top: 68,
        bottom: 56,
        left: 12,
        width: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: "10px 0",
        background: "oklch(from var(--paper-0) l c h / 0.85)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        borderRadius: 18,
        backdropFilter: "blur(20px)",
        zIndex: 30,
        boxShadow: "var(--shadow-2)",
      }}
      role="navigation"
      aria-label="Main Navigation"
    >
      <button
        type="button"
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: "var(--bloom-2)",
          color: "white",
          display: "grid",
          placeItems: "center",
          boxShadow: "0 4px 12px -3px var(--bloom-glow)",
          marginBottom: 6,
          border: 0,
          cursor: "pointer",
        }}
        title="New · ⌘N"
        onClick={() => setView("canvas")}
      >
        <Ico.Plus />
      </button>

      {items.map((it) => {
        const isActive = active === it.id || active === it.view;
        return (
          <button
            key={it.id}
            type="button"
            className={`rail-btn ${isActive ? "active" : ""}`}
            title={it.label}
            aria-label={it.label}
            onClick={() => setView(it.view)}
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              color: isActive ? "var(--paper-0)" : "var(--ink-2)",
              background: isActive ? "var(--ink-0)" : "transparent",
              transition: "all 0.12s var(--e-out)",
              position: "relative",
              border: 0,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => !isActive && (e.currentTarget.style.background = "var(--paper-2)")}
            onMouseLeave={(e) => !isActive && (e.currentTarget.style.background = "transparent")}
          >
            {it.icon}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {bottomItems.map((it) => {
        const isActive = active === it.id;
        return (
          <button
            key={it.id}
            type="button"
            className={`rail-btn ${isActive ? "active" : ""}`}
            title={it.label}
            aria-label={it.label}
            onClick={() => (it.onClick ? it.onClick() : setView(it.view))}
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              color: isActive ? "var(--paper-0)" : "var(--ink-2)",
              background: isActive ? "var(--ink-0)" : "transparent",
              transition: "all 0.12s var(--e-out)",
              position: "relative",
              border: 0,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => !isActive && (e.currentTarget.style.background = "var(--paper-2)")}
            onMouseLeave={(e) => !isActive && (e.currentTarget.style.background = "transparent")}
          >
            {it.icon}
            {it.badge && (
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  minWidth: 15,
                  height: 15,
                  borderRadius: 999,
                  background: "var(--madder)",
                  color: "white",
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "0 4px",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--paper-0)",
                }}
              >
                {it.badge}
              </span>
            )}
          </button>
        );
      })}

      {notifOpen && <AtelierNotificationPopover onClose={() => setNotifOpen(false)} />}
    </div>
  );
}

// =================================================================
// APP SHELL (Container with TopBar and GlobalRail)
// =================================================================
export interface AtelierCrumb {
  label: string;
  view?: View;
  onClick?: () => void;
  current?: boolean;
}

export function AtelierAppShell({
  activeArea,
  crumbs = [],
  actions,
  children,
  hideRail = false,
  onOpenSettings,
}: {
  activeArea: View | "home" | "review" | "integrations" | "notif" | "ask" | "board" | "meeting" | "intel" | "exec" | "history" | "system" | "ia";
  crumbs?: AtelierCrumb[];
  actions?: ReactNode;
  children: ReactNode;
  hideRail?: boolean;
  onOpenSettings?: (section?: string) => void;
}) {
  const { setView } = useWorkspace();
  const [shareOpen, setShareOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // Share ("share this workspace") and Present ("start a meeting on this board")
  // are board-scoped actions. On Home / Workspace / Intelligence / Execution /
  // History / Admin / Notifications etc. they read as "share what?" — so the
  // default top-bar cluster only shows them where a board is the subject. Any
  // screen that genuinely needs its own actions passes an explicit `actions`.
  const showBoardActions = activeArea === "board" || activeArea === "meeting";

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "var(--paper-1)" }}>
      {/* Paper background texture and grain */}
      <div className="paper-bg" />
      <div className="paper-grain" />

      {/* Top Bar */}
      <header
        className="top-bar"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 56,
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          zIndex: 20,
          gap: 14,
          background: "linear-gradient(180deg, oklch(from var(--paper-1) l c h / 0.85), oklch(from var(--paper-1) l c h / 0.4))",
          backdropFilter: "blur(20px) saturate(1.4)",
          WebkitBackdropFilter: "blur(20px) saturate(1.4)",
          borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
        }}
      >
        <button
          type="button"
          className="brand"
          onClick={() => setView("home" as View)}
          title="Lucent Home"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            cursor: "pointer",
            background: "none",
            border: 0,
            padding: 0,
          }}
        >
          <div className="brand-mark" />
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 16,
              fontWeight: 500,
              color: "var(--ink-0)",
              letterSpacing: "-0.01em",
            }}
          >
            Lucent
          </span>
        </button>

        <span className="crumb-sep" style={{ color: "var(--ink-3)", fontSize: 13 }}>
          ·
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {c.onClick || c.view ? (
                <button
                  type="button"
                  className={`crumb ${c.current ? "current" : ""}`}
                  onClick={c.onClick ?? (() => c.view && setView(c.view))}
                  style={{
                    fontSize: 13,
                    color: c.current ? "var(--ink-0)" : "var(--ink-2)",
                    fontWeight: c.current ? 500 : 400,
                    cursor: "pointer",
                    background: "none",
                    border: 0,
                    padding: "4px 8px",
                    borderRadius: 6,
                  }}
                >
                  {c.label}
                </button>
              ) : (
                <span
                  className={`crumb ${c.current ? "current" : ""}`}
                  style={{
                    fontSize: 13,
                    color: c.current ? "var(--ink-0)" : "var(--ink-2)",
                    fontWeight: c.current ? 500 : 400,
                    padding: "4px 6px",
                  }}
                >
                  {c.label}
                </span>
              )}
              {i < crumbs.length - 1 && (
                <span className="crumb-sep" style={{ color: "var(--ink-3)", fontSize: 12 }}>
                  /
                </span>
              )}
            </React.Fragment>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {actions || (
            <>
              {showBoardActions && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setShareOpen(true)}
                    title="Share this workspace"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 12px",
                      borderRadius: 8,
                      fontSize: 12.5,
                      color: "var(--ink-1)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                      background: "var(--paper-0)",
                      cursor: "pointer",
                    }}
                  >
                    <Ico.Share /> Share
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setView("meeting" as View)}
                    title="Present · start meeting"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "6px 12px",
                      borderRadius: 8,
                      fontSize: 12.5,
                      color: "var(--ink-1)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                      background: "var(--paper-0)",
                      cursor: "pointer",
                    }}
                  >
                    <Ico.Present /> Present
                  </button>
                  <div style={{ width: 4 }} />
                </>
              )}
              <button
                type="button"
                className="avatar"
                onClick={() => setProfileOpen((p) => !p)}
                title="Profile"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  background: "oklch(0.55 0.16 25)",
                  color: "white",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  border: "2px solid var(--paper-0)",
                  boxShadow: "var(--shadow-1)",
                  cursor: "pointer",
                }}
              >
                AK
              </button>
            </>
          )}
        </div>
        {shareOpen && <SharePopover onClose={() => setShareOpen(false)} />}
        {profileOpen && (
          <ProfileMenu
            onClose={() => setProfileOpen(false)}
            onOpenSettings={onOpenSettings}
          />
        )}
      </header>

      {/* Global Navigation Rail */}
      {!hideRail && <GlobalRail active={activeArea} onOpenSettings={onOpenSettings} />}

      {/* Content Area */}
      <main
        style={{
          position: "absolute",
          top: 56,
          left: hideRail ? 0 : 84,
          right: 0,
          bottom: 0,
          overflow: "auto",
        }}
        tabIndex={-1}
      >
        {children}
      </main>
    </div>
  );
}

// =================================================================
// ICONS & PROVIDER MARKS
// =================================================================
export function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12l9-9 9 9M5 10v10h14V10" />
    </svg>
  );
}

export function IntelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="7" r="2.5" />
      <circle cx="12" cy="17" r="2.5" />
      <path d="M7 9.5L11 15M17 9.5L13 15M9 7h6" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export function DecisionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3L21 12 12 21 3 12z" />
    </svg>
  );
}

export function RiskIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17v0.5" />
    </svg>
  );
}

export function QuestionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9c.5-2 5-2 5 0 0 2-3 2-3 4M11 17v0.5" />
    </svg>
  );
}

export function ActionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16M4 12h10M4 19h16" />
      <path d="M18 10l3 2-3 2" />
    </svg>
  );
}

export function LinearMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 100 100" fill="currentColor">
      <path d="M3.4 63.7c-.2 1 .3 2 1.1 2.7L34 95.6c.7.8 1.7 1.3 2.7 1.1C58.1 93 74.8 76.3 78.9 55.1c.2-1-.3-2-1.1-2.7L48.3 22.9c-.7-.8-1.7-1.3-2.7-1.1C24.4 25.9 7.7 42.6 3.4 63.7z" />
      <path d="M8.5 41.5c-.5.9-.4 2 .3 2.8l46.9 46.9c.8.7 1.9.8 2.8.3 5.6-3.3 10.6-7.5 14.7-12.6.6-.8.6-2-.2-2.7L23.4 26.9c-.7-.7-1.9-.8-2.7-.2-5.1 4.1-9.3 9.1-12.2 14.8z" />
    </svg>
  );
}

export function JiraMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.53 2C11.53 4.62 13.66 6.75 16.28 6.75H18.20V8.61C18.21 11.24 20.34 13.37 22.97 13.37V2.71C22.97 2.32 22.65 2 22.26 2H11.53M6.77 6.8C6.77 9.42 8.9 11.55 11.53 11.55H13.44V13.41C13.45 16.04 15.58 18.17 18.21 18.17V7.5C18.21 7.11 17.89 6.79 17.5 6.79H6.77M2 11.6C2 14.22 4.13 16.35 6.75 16.35H8.67V18.21C8.68 20.84 10.81 22.97 13.44 22.97V12.3C13.44 11.91 13.12 11.6 12.73 11.6H2Z" />
    </svg>
  );
}

export function GithubMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.9.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}

export function SlackMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <rect x="10" y="2" width="4" height="12" rx="2" fill="#e01e5a" />
      <rect x="10" y="14" width="4" height="8" rx="2" fill="#e01e5a" />
      <rect x="2" y="10" width="12" height="4" rx="2" fill="#36c5f0" />
      <rect x="14" y="10" width="8" height="4" rx="2" fill="#36c5f0" />
    </svg>
  );
}

export function FigmaMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" fill="#1abcfe" />
      <path d="M8 4h4v8H8a4 4 0 010-8z" fill="#f24e1e" />
      <path d="M12 4h4a4 4 0 010 8h-4V4z" fill="#ff7262" />
      <path d="M8 12h4v8a4 4 0 01-4-4v-4z" fill="#0acf83" />
      <path d="M8 12a4 4 0 100 8" fill="#a259ff" />
    </svg>
  );
}

export function NotionMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3.5 3.7L15.5 3l6 3v13.5l-6 1.5-12-1.5V3.7z" fillOpacity="0.05" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8v8M8 8l6 8V8" strokeWidth="1.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ZoomMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="#0b5cff">
      <rect x="2" y="6" width="16" height="12" rx="2" />
      <path d="M18 10l4-2v8l-4-2z" />
    </svg>
  );
}

export function DriveMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24">
      <path d="M6 20l3-5h12l-3 5H6z" fill="#4285f4" />
      <path d="M9 3l-6 12 3 5 6-12-3-5z" fill="#0f9d58" />
      <path d="M9 3h6l6 12h-6z" fill="#f4b400" />
    </svg>
  );
}

export function GmeetMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24">
      <rect x="2" y="6" width="14" height="12" rx="2" fill="#00832d" />
      <path d="M16 10l6-2v8l-6-2z" fill="#0066da" />
    </svg>
  );
}

// =================================================================
// ATELIER BOARD TOOLBAR (Miro-style 5-cluster top toolbar)
// =================================================================
export function ToolCluster({ children, last }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        paddingRight: last ? 0 : 6,
        marginRight: last ? 0 : 2,
        borderRight: last ? "none" : "1px solid oklch(from var(--paper-4) l c h / 0.5)",
      }}
    >
      {children}
    </div>
  );
}

export function ToolBtn({
  icon,
  active,
  tip,
  bloom,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  active?: boolean;
  tip: string;
  bloom?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={tip}
      aria-label={tip}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 34,
        height: 34,
        borderRadius: 8,
        display: "grid",
        placeItems: "center",
        background: active ? "var(--ink-0)" : "transparent",
        color: active ? "var(--paper-0)" : bloom ? "var(--bloom-2)" : "var(--ink-1)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        border: 0,
        padding: 0,
        transition: "all 0.12s var(--e-out)",
      }}
      onMouseEnter={(e) => !active && !disabled && (e.currentTarget.style.background = "var(--paper-2)")}
      onMouseLeave={(e) => !active && !disabled && (e.currentTarget.style.background = "transparent")}
    >
      {icon}
    </button>
  );
}

export function AtelierBoardToolbar({
  activeTool = "select",
  onSelectTool,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  onGenImage,
  onEmbed,
  hidden = false,
}: {
  activeTool?: Tool;
  onSelectTool?: (t: Tool) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onGenImage?: () => void;
  onEmbed?: () => void;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 68,
        left: "calc(50% + 42px)",
        transform: "translateX(-50%)",
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 6px",
        background: "oklch(from var(--paper-0) l c h / 0.94)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
        borderRadius: 12,
        boxShadow: "var(--shadow-2)",
        backdropFilter: "blur(20px)",
      }}
      role="toolbar"
      aria-label="Board editing tools"
    >
      <ToolCluster>
        <ToolBtn
          icon={<ToolIco.Select />}
          active={activeTool === "select"}
          tip="Select · V"
          onClick={() => onSelectTool?.("select")}
        />
        <ToolBtn
          icon={<ToolIco.Hand />}
          active={activeTool === "hand"}
          tip="Hand / Pan · H"
          onClick={() => onSelectTool?.("hand")}
        />
      </ToolCluster>

      <ToolCluster>
        <ToolBtn
          icon={<ToolIco.Rect />}
          active={activeTool === "rect"}
          tip="Rectangle · R"
          onClick={() => onSelectTool?.("rect")}
        />
        <ToolBtn
          icon={<ToolIco.Ellipse />}
          active={activeTool === "ellipse"}
          tip="Ellipse · O"
          onClick={() => onSelectTool?.("ellipse")}
        />
        <ToolBtn
          icon={<ToolIco.Diamond />}
          active={activeTool === "diamond"}
          tip="Diamond · D"
          onClick={() => onSelectTool?.("diamond")}
        />
        <ToolBtn
          icon={<ToolIco.Connect />}
          active={activeTool === "arrow"}
          tip="Arrow / Connect · A"
          onClick={() => onSelectTool?.("arrow")}
        />
      </ToolCluster>

      <ToolCluster>
        <ToolBtn
          icon={<ToolIco.Sticky />}
          active={activeTool === "sticky"}
          tip="Sticky note · S"
          onClick={() => onSelectTool?.("sticky")}
        />
        <ToolBtn
          icon={<ToolIco.Text />}
          active={activeTool === "text"}
          tip="Text · T"
          onClick={() => onSelectTool?.("text")}
        />
        <ToolBtn
          icon={<ToolIco.Pen />}
          active={activeTool === "pen"}
          tip="Pen drawing · P"
          onClick={() => onSelectTool?.("pen")}
        />
      </ToolCluster>

      <ToolCluster>
        {onGenImage && (
          <ToolBtn
            icon={<ToolIco.Sparkle />}
            tip="Generate image with AI"
            bloom
            onClick={onGenImage}
          />
        )}
        <ToolBtn
          icon={<ToolIco.Frame />}
          active={activeTool === "frame"}
          tip="Frame · F"
          onClick={() => onSelectTool?.("frame")}
        />
        {onEmbed && (
          <ToolBtn
            icon={<ToolIco.Media />}
            tip="Embed media / link"
            onClick={onEmbed}
          />
        )}
        <ToolBtn
          icon={<ToolIco.Comment />}
          active={activeTool === "comment"}
          tip="Comment · C"
          onClick={() => onSelectTool?.("comment")}
        />
      </ToolCluster>

      <ToolCluster last>
        <ToolBtn
          icon={<Ico.Undo />}
          tip="Undo · ⌘Z"
          disabled={!canUndo}
          onClick={onUndo}
        />
        <ToolBtn
          icon={<Ico.Redo />}
          tip="Redo · ⇧⌘Z"
          disabled={!canRedo}
          onClick={onRedo}
        />
      </ToolCluster>
    </div>
  );
}

// =================================================================
// ATELIER NODE INSPECTOR (Right-side panel for selected node)
// =================================================================
export function AtelierNodeInspector({
  node,
  connectedNodes = [],
  onClose,
  onRename,
  onDelete,
  onComment,
  onExplain,
  onSelectNode,
}: {
  node: {
    id: string;
    label: string;
    nodeType?: string;
    description?: string;
    sub?: string;
  };
  connectedNodes?: Array<{
    id: string;
    label: string;
    direction: "in" | "out";
  }>;
  onClose: () => void;
  onRename?: (newLabel: string) => void;
  onDelete?: () => void;
  onComment?: () => void;
  onExplain?: (label: string) => void;
  onSelectNode?: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.label);

  useEffect(() => {
    setDraft(node.label);
    setEditing(false);
  }, [node.id, node.label]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== node.label) {
      onRename?.(trimmed);
    } else {
      setDraft(node.label);
    }
  };

  return (
    <div
      className="right-panel"
      style={{
        top: 68,
        bottom: 60,
        width: 340,
        zIndex: 28,
      }}
      role="region"
      aria-label="Node Inspector"
    >
      <div className="panel-head" style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(node.label);
                  setEditing(false);
                }
              }}
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--ink-0)",
                background: "var(--paper-2)",
                border: "1px solid var(--bloom-2)",
                borderRadius: 6,
                padding: "2px 6px",
                width: "100%",
                outline: "none",
              }}
            />
          ) : (
            <div
              className="panel-title"
              onDoubleClick={() => setEditing(true)}
              title="Double-click to rename"
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
            >
              <span>{node.label}</span>
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="Rename node"
                style={{
                  background: "none",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--ink-3)",
                  padding: 2,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <ToolIco.Text style={{ width: 12, height: 12 }} />
              </button>
            </div>
          )}
          <div className="panel-sub">
            {node.nodeType || "node"} · {node.id}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close inspector"
          style={{
            background: "none",
            border: 0,
            cursor: "pointer",
            color: "var(--ink-3)",
            padding: 4,
            display: "grid",
            placeItems: "center",
            borderRadius: 6,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--ink-0)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--ink-3)")}
        >
          <Ico.X />
        </button>
      </div>

      <div className="panel-body">
        <div style={{ display: "grid", gap: 14 }}>
          {node.description && (
            <div>
              <div className="mono-caps" style={{ marginBottom: 4 }}>Description</div>
              <div style={{ fontSize: 13, color: "var(--ink-1)", lineHeight: 1.45 }}>
                {node.description}
              </div>
            </div>
          )}

          <div>
            <div className="mono-caps" style={{ marginBottom: 6 }}>Connected With</div>
            {connectedNodes.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-3)", fontStyle: "italic" }}>
                No direct connections
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {connectedNodes.map((c) => (
                  <button
                    key={c.id + c.direction}
                    type="button"
                    onClick={() => onSelectNode?.(c.id)}
                    title={`Select ${c.label}`}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      background: "oklch(from var(--paper-2) l c h / 0.8)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      fontSize: 11.5,
                      color: "var(--ink-1)",
                      fontFamily: "var(--font-mono)",
                      cursor: "pointer",
                      transition: "all 0.12s var(--e-out)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--bloom-2)";
                      e.currentTarget.style.color = "var(--bloom-2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.5)";
                      e.currentTarget.style.color = "var(--ink-1)";
                    }}
                  >
                    {c.direction === "in" ? "← " : "→ "}
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: "oklch(from var(--bloom-1) l c h / 0.06)",
              border: "1px solid var(--bloom-wash-2)",
            }}
          >
            <div className="mono-caps" style={{ color: "var(--bloom-2)", marginBottom: 6 }}>
              <Ico.Sparkle style={{ display: "inline", verticalAlign: -2, marginRight: 4 }} />
              Lucent notes
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--ink-0)",
                lineHeight: 1.5,
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
              }}
            >
              Ask Lucent to explain this node, break it into sub-steps, or explore architectural alternatives.
            </div>
            {onExplain && (
              <button
                type="button"
                className="btn-atelier ghost"
                onClick={() => onExplain(node.label)}
                style={{ marginTop: 10, height: 28, fontSize: 12, width: "100%" }}
              >
                <Ico.Sparkle /> Explain node
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="panel-foot">
        {onComment && (
          <button
            type="button"
            className="btn-atelier ghost"
            onClick={onComment}
            style={{ flex: 1 }}
          >
            <Ico.Comment /> Comment
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="btn-atelier ghost"
            onClick={onDelete}
            title="Delete node"
            style={{ color: "var(--madder)" }}
          >
            <Ico.X /> Delete
          </button>
        )}
        <button
          type="button"
          className="btn-atelier bloom"
          onClick={onClose}
          style={{ padding: "0 16px" }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

// =================================================================
// ATELIER EMPTY STATE (Blank Page Moment)
// =================================================================
export function AtelierEmptyState({
  value = "",
  onChange,
  onSubmit,
  onBlankBoard,
  onSpeak,
  onStartVoiceCall,
  voiceAgentActive,
  listening,
}: {
  value?: string;
  onChange?: (val: string) => void;
  onSubmit: (prompt: string) => void;
  onBlankBoard: () => void;
  onSpeak?: () => void;
  onStartVoiceCall?: () => void;
  voiceAgentActive?: boolean;
  listening?: boolean;
}) {
  const suggestions = [
    "Design an e-commerce checkout flow",
    "Architect a real-time chat app",
    "Map the user journey for onboarding",
    "Draft a Kubernetes deployment",
  ];

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          textAlign: "center",
          maxWidth: 640,
          pointerEvents: "auto",
          padding: "0 20px",
          marginTop: -60,
        }}
      >
        <div className="mono-caps" style={{ marginBottom: 20, color: "var(--ink-3)" }}>
          Fig. 01 · Untitled · a blank page
        </div>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 52,
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            color: "var(--ink-0)",
            fontWeight: 400,
          }}
        >
          What should we <em style={{ color: "var(--bloom-2)", fontStyle: "italic" }}>build?</em>
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 15.5,
            color: "var(--ink-2)",
            lineHeight: 1.55,
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
          }}
        >
          Describe your idea. Lucent will draft an editable, semantic canvas.
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 32,
            justifyContent: "center",
          }}
        >
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange?.(s);
                onSubmit(s);
              }}
              style={{
                padding: "9px 16px",
                borderRadius: 999,
                background: "oklch(from var(--paper-0) l c h / 0.75)",
                border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                fontSize: 12.5,
                color: "var(--ink-1)",
                transition: "all 0.14s var(--e-out)",
                backdropFilter: "blur(12px)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--paper-0)";
                e.currentTarget.style.borderColor = "var(--ink-3)";
                e.currentTarget.style.color = "var(--ink-0)";
                e.currentTarget.style.transform = "translateY(-1px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "oklch(from var(--paper-0) l c h / 0.75)";
                e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.6)";
                e.currentTarget.style.color = "var(--ink-1)";
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              <Ico.Sparkle style={{ color: "var(--bloom-2)" }} />
              {s}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 24 }}>
          <button
            type="button"
            onClick={onBlankBoard}
            style={{
              padding: "6px 14px",
              borderRadius: 8,
              background: "transparent",
              border: "1px dashed oklch(from var(--paper-4) l c h / 0.8)",
              fontSize: 12,
              color: "var(--ink-2)",
              cursor: "pointer",
              transition: "all 0.12s var(--e-out)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--ink-2)";
              e.currentTarget.style.color = "var(--ink-0)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.8)";
              e.currentTarget.style.color = "var(--ink-2)";
            }}
          >
            + Start with a blank board
          </button>
        </div>
      </div>
    </div>
  );
}


