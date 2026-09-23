import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { StatementFields } from "@lucent/core";
import { TopBar, LeftRail, type Crumb } from "./Chrome.js";
import { StatementGlyph } from "./StatementGlyph.js";
import { KIND_LABEL, KIND_TINT, statusLabel, statementIsHistory } from "../statementUi.js";

/**
 * The Atelier kit: the handful of pieces every page is built from, so a
 * decision, an empty state, or a page title looks the same on every surface.
 * Styles live in lucent.css (section 2). Nothing here renders sample data —
 * a component with nothing real to show renders an EmptyState instead.
 */

/** A full page: top bar, rail, and a scrolling content column. */
export function Page({
  crumbs,
  meta,
  actions,
  onOpenSettings,
  width = "default",
  children,
}: {
  crumbs: Crumb[];
  meta?: ReactNode;
  actions?: ReactNode;
  onOpenSettings: (section?: string) => void;
  /** "wide" for two-pane pages; "narrow" for reading columns. */
  width?: "narrow" | "default" | "wide";
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-backdrop" aria-hidden>
        <div className="paper-bg" />
        <div className="paper-grain" />
      </div>
      <TopBar crumbs={crumbs} meta={meta} actions={actions} onOpenSettings={onOpenSettings} />
      <LeftRail onOpenSettings={onOpenSettings} />
      <div className="page" tabIndex={-1}>
        <div className={`page-inner page-${width}`}>{children}</div>
      </div>
    </>
  );
}

/** Eyebrow (mono caps), a serif title, an italic lede, and actions. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {lede && <p className="page-lede">{lede}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

/** A mono-caps section label with an optional count and glyph. */
export function SectionLabel({
  children,
  count,
  glyph,
  action,
}: {
  children: ReactNode;
  count?: number;
  glyph?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="section-label">
      {glyph}
      <span>{children}</span>
      {count !== undefined && <span className="section-count">{count}</span>}
      {action && <span className="section-action">{action}</span>}
    </div>
  );
}

export interface FilterItem<T extends string> {
  id: T;
  label: string;
  count?: number;
}

/** The one filter pattern: pills with counts (audit M11 standardised it). */
export function FilterChips<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: FilterItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the group. */
  label: string;
}) {
  return (
    <div className="filter-chips" role="radiogroup" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="radio"
          aria-checked={value === it.id}
          className={`filter-chip ${value === it.id ? "on" : ""}`}
          onClick={() => onChange(it.id)}
        >
          {it.label}
          {it.count !== undefined && <span className="filter-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A paper card. `interactive` adds hover lift and a pointer. */
export function Card({
  interactive = false,
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div className={`card ${interactive ? "interactive" : ""} ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** A number that matters, what it counts, and (optionally) where it leads. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: number | string;
  sub?: ReactNode;
  /** A statement kind to tint the value by, or "alert" for madder. */
  tone?: StatementFields["kind"] | "alert";
  onClick?: () => void;
}) {
  const color =
    tone === "alert" ? "var(--madder)" : tone ? KIND_TINT[tone] : "var(--ink-0)";
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className="stat-tile interactive" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="stat-tile">{body}</div>
  );
}

/**
 * The honest empty state: what this surface is for, and the one action that
 * would fill it. Never sample rows.
 */
export function EmptyState({
  glyph,
  title,
  body,
  action,
  compact = false,
}: {
  glyph?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      {glyph && <div className="empty-glyph">{glyph}</div>}
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/** Glyph + kind + status in the kind's own vocabulary ("Decision · Decided"). */
export function KindBadge({
  kind,
  status,
  showKind = true,
}: {
  kind: StatementFields["kind"];
  status?: StatementFields["status"];
  showKind?: boolean;
}) {
  return (
    <span
      className={`kind-badge ${status && statementIsHistory(status) ? "history" : ""}`}
      style={{ ["--kind" as string]: KIND_TINT[kind] }}
    >
      <StatementGlyph kind={kind} size={11} />
      {showKind && <span className="kind-badge-kind">{KIND_LABEL[kind].one}</span>}
      {status && <span className="kind-badge-status">{statusLabel(kind, status)}</span>}
    </span>
  );
}

/**
 * Where something came from — a meeting turn, a revision, a node. Clickable
 * when there is somewhere to go; the whole product promise ("who said it,
 * when, in which words") is this chip being one click from the source.
 */
export function ProvenanceChip({
  icon,
  label,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      {icon ?? <span aria-hidden>✦</span>}
      <span className="prov-label">{label}</span>
    </>
  );
  return onClick ? (
    <button type="button" className="prov-chip" title={title} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className="prov-chip static" title={title}>
      {content}
    </span>
  );
}

/** Initials on a colour derived from the name, so a person keeps a colour. */
export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";
  return (
    <span
      className="avatar-chip"
      title={name}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.4)),
        background: `oklch(0.55 0.12 ${hueFor(name)})`,
      }}
    >
      {initials}
    </span>
  );
}

/** A stable hue per name (0–360), avoiding the madder band used for alerts. */
export function hueFor(name: string): number {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 40 + (h % 280);
}

/** Atelier buttons, as a component so variants stay in one vocabulary. */
export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "bloom" | "danger" | "quiet";
  size?: "sm" | "md";
}) {
  return (
    <button type="button" className={`btn-atelier ${variant} ${size} ${className}`} {...rest}>
      {children}
    </button>
  );
}
