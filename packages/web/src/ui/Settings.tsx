import { useEffect, useState } from "react";
import { Ico, ToolIco } from "./icons.js";
import { useSettings, type Accent, type GridStyle, type Theme } from "../settings.js";
import { getSessionUser } from "../session.js";
import { sttProviderStatus } from "../stt/index.js";
import {
  exportFormatChips,
  fetchBilling,
  fetchOrgs,
  fetchOrgPolicy,
  formatMonth,
  limitNote,
  limitTitle,
  meterFor,
  ORG_PROVIDER_MODES,
  patchOrgProviderMode,
  planState,
  preferredOrg,
  providerPolicySentence,
  resetLabel,
} from "../billing.js";
import type {
  BillingPeriod,
  BillingResult,
  BillingSnapshot,
  LimitRow,
  OrgPolicyResult,
  OrgProviderMode,
  OrgSummary,
} from "../billing.js";
import { buildSupportReport, formatSupportReport } from "../support.js";
import {
  TOKEN_EXPIRY_CHOICES,
  beginEnrollment,
  confirmEnrollment,
  createToken,
  disableTwoFactor,
  groupedSecret,
  listMyTokens,
  revokeMyToken,
  scopeLabel,
  twoFactorStatus,
  type ApiTokenView,
  type TwoFactorStatus,
} from "../security.js";
import { loadOrgs as loadOrgList } from "../orgs.js";
import { useWorkspaceOptional } from "../workspace.js";
import {
  fetchOrg,
  inviteToOrg,
  listOrgInvites,
  loadOrgs,
  revokeOrgInvite,
  type OrgDetail,
  type OrgInvite,
  type OrgSummary as OrgMembership,
} from "../orgs.js";

/** Profile menu, preferences modal, and shape toolbar. Ported from settings.jsx. */

/** Segmented-control copy for the owner's provider-policy modes (docs/24 C). */
const PROVIDER_MODE_LABELS: Record<OrgProviderMode, string> = {
  any: "Any",
  "byo-forbidden": "No BYO keys",
  "self-hosted-only": "Self-hosted",
};
const PROVIDER_MODE_HINTS: Record<OrgProviderMode, string> = {
  any: "Any provider the deployment allows, including personal API keys",
  "byo-forbidden":
    "Personal API keys are refused; only the configured provider serves this workspace",
  "self-hosted-only":
    "Only an in-process model or a provider the operator declares self-hosted may serve this workspace",
};

/** Up to two initials from a display name, falling back to the email's first letter. */
function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function RowToggle({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
      <div style={{ flex: 1 }}>
        <div className="label">{label}</div>
        <div className="desc" style={{ marginBottom: 0 }}>
          {desc}
        </div>
      </div>
      <div
        className={`switch ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        // A focusable role="switch" that only responds to clicks is a keyboard
        // dead end; Space/Enter must toggle it too.
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onChange(!value);
          }
        }}
        role="switch"
        aria-checked={value}
        aria-label={label}
        tabIndex={0}
      />
    </div>
  );
}

/** One limit and its meter. Everything shown is `meterFor`'s; nothing is derived here. */
function LimitMeter({ row, period }: { row: LimitRow; period: BillingPeriod }) {
  const meter = meterFor(row);
  const title = limitTitle(row);
  const note = limitNote(row);
  const reset = resetLabel(row, period);
  return (
    <div className={`billing-limit tone-${meter.tone}`}>
      <div className="billing-limit-head">
        <span className="billing-limit-title">{title}</span>
        <span className="billing-limit-value mono">{meter.value}</span>
      </div>
      {/* A bar only where there is a ratio to draw. An unlimited or uncounted row
          gets its words alone: an empty track would read as a ceiling nobody has
          spent, which is precisely the wrong thing to tell a Team customer. */}
      {meter.percent !== null && meter.now !== null && meter.max !== null && (
        <div
          className="billing-meter"
          role="progressbar"
          aria-label={`${title} used`}
          aria-valuemin={0}
          aria-valuenow={meter.now}
          aria-valuemax={meter.max}
          aria-valuetext={`${meter.value} — ${meter.status}`}
        >
          <span className="billing-meter-fill" style={{ width: `${meter.percent}%` }} />
        </div>
      )}
      <div className="billing-limit-foot">
        {/* The status line is the bar's text equivalent, and the hatched fill on a
            spent row is its second non-colour signal, so none of this depends on
            being able to tell amber from red. */}
        <span className="billing-limit-status">{meter.status}</span>
        {reset !== null && <span className="billing-limit-reset">{reset}</span>}
      </div>
      {note !== null && <div className="billing-limit-note">{note}</div>}
    </div>
  );
}

/** The loaded snapshot. Split out so every failure state stays in one flat list below. */
function BillingBody({ billing, orgName }: { billing: BillingSnapshot; orgName: string | null }) {
  const state = planState(billing.plan);
  const chips = exportFormatChips(billing.exportFormats);
  return (
    <>
      <div className="setting-row">
        <div className="billing-plan">
          <div>
            {orgName !== null && <div className="billing-plan-org">{orgName}</div>}
            <div className="billing-plan-name">
              {billing.plan.name}
              <span className={`billing-badge ${state.kind}`}>{state.badge}</span>
            </div>
          </div>
          {/* The affordance is a link to the server's own `upgradeUrl` and nothing
              more: there is no checkout in this build, and hardcoding
              /settings/billing would break the first deployment that hosts its
              billing somewhere else. No url, no link. */}
          {billing.upgradeUrl !== null && (
            <a
              className={`btn ${state.action === "manage" ? "ghost" : "amber"}`}
              href={billing.upgradeUrl}
            >
              {state.actionLabel}
            </a>
          )}
        </div>
        <div className="desc" style={{ marginBottom: 0 }}>
          {state.detail}
        </div>
      </div>

      <div className="setting-row">
        <div className="label">Usage in {formatMonth(billing.period.start)}</div>
        <div className="desc">
          Metered allowances reset at 00:00 UTC on the 1st. Standing ceilings — boards, seats,
          storage — apply for as long as the plan does.
        </div>
        {billing.limits.length > 0 ? (
          <div className="billing-limits">
            {billing.limits.map((row) => (
              <LimitMeter key={row.key} row={row} period={billing.period} />
            ))}
          </div>
        ) : (
          <div className="desc" style={{ marginBottom: 0 }}>
            This server didn't report any limits for this workspace.
          </div>
        )}
      </div>

      {chips.length > 0 && (
        <div className="setting-row">
          <div className="label">Export formats</div>
          <div className="desc">
            What this plan can produce. Locked formats stay listed so it's clear what a plan would
            add.
          </div>
          <div className="billing-formats">
            {chips.map((chip) => (
              <span key={chip.format} className={`billing-format ${chip.allowed ? "on" : "off"}`}>
                {chip.allowed ? <Ico.Check /> : <Ico.Lock />}
                {chip.label}
                <span className="sr-only">
                  {chip.allowed ? " included in this plan" : " not included in this plan"}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** A state with nothing to draw, said in the pane's own voice rather than an alert. */
function BillingNotice({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="setting-row">
      <div className="label">{label}</div>
      <div className="desc" style={{ marginBottom: 0 }}>
        {desc}
      </div>
    </div>
  );
}

/**
 * Plan, this month's spend, and how close each ceiling is (M4).
 *
 * Two round trips rather than one, because `/api/orgs/:id/billing` needs an org
 * in its path and nothing in the client tracks a current org yet — `GET /api/orgs`
 * is where the browser learns one. The switcher then appears only for people in
 * more than one workspace, so somebody in a personal org plus a paid team org is
 * never quietly shown only the free one.
 *
 * Every figure below is the server's and every sentence is `billing.ts`'s. This
 * component decides layout and nothing else, which is what keeps the logic that
 * must not confuse "unlimited" with "nothing left" testable without a DOM.
 */
function BillingPane() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [result, setResult] = useState<BillingResult | null>(null);

  useEffect(() => {
    // `live` guards the late resolve: Escape closes this modal, and a setState on
    // an unmounted pane is a console warning bought for nothing.
    let live = true;
    void fetchOrgs().then((r) => {
      if (!live) return;
      if (r.kind !== "ok") {
        // `signedOut` and `error` mean the same thing whichever request found
        // them, so they render through the same states as a billing failure.
        setResult(r);
        return;
      }
      setOrgs(r.orgs);
      const first = preferredOrg(r.orgs);
      if (first === null) {
        // Every signup gets a personal org, so this is near unreachable — but an
        // empty pane looks broken, and "no plan for no workspace" is not one of
        // the billing states.
        setResult({
          kind: "error",
          message: "This account isn't in a workspace yet, so there's no plan to show.",
        });
        return;
      }
      setOrgId(first.id);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    let live = true;
    setResult(null);
    void fetchBilling(orgId).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [orgId]);

  const orgName = orgs.find((o) => o.id === orgId)?.name ?? null;
  return (
    <>
      <h2>Plan & usage</h2>
      <div className="subtitle">
        What this workspace is on, what it has spent this month, and how close each ceiling is.
      </div>
      {orgs.length > 1 && (
        <div className="setting-row">
          <div className="label">Workspace</div>
          <div className="desc">Each workspace carries its own plan and its own usage.</div>
          <div className="segmented" role="group" aria-label="Workspace">
            {orgs.map((org) => (
              <button
                key={org.id}
                className={org.id === orgId ? "active" : ""}
                aria-pressed={org.id === orgId}
                onClick={() => setOrgId(org.id)}
              >
                {org.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {result === null && (
        <div className="setting-row">
          <div className="desc" style={{ marginBottom: 0 }}>
            Loading your plan…
          </div>
        </div>
      )}
      {/* 503 is a fact about the deployment, not a failure and not a Free plan:
          this server has no billing wired up, so nothing is metered or enforced
          and there are no limits to draw. */}
      {result?.kind === "unconfigured" && (
        <BillingNotice
          label="Billing isn't configured for this deployment"
          desc="This Lucent server runs without a billing integration, so there are no plans, limits, or usage to show — and nothing is being metered or enforced."
        />
      )}
      {result?.kind === "unavailable" && (
        <BillingNotice
          label="No plan for this workspace"
          desc="This workspace's billing isn't available to you. Your access to it may have changed — try reopening Preferences."
        />
      )}
      {result?.kind === "signedOut" && (
        <BillingNotice
          label="Sign in to see your plan"
          desc="Plans and usage belong to a workspace, so this needs an account."
        />
      )}
      {result?.kind === "error" && (
        <BillingNotice label="Couldn't load your plan" desc={result.message} />
      )}
      {result?.kind === "ok" && <BillingBody billing={result.billing} orgName={orgName} />}
    </>
  );
}

export function SettingsModal({
  initialSection = "appearance",
  onClose,
}: {
  initialSection?: string;
  onClose: () => void;
}) {
  const [section, setSection] = useState(initialSection);
  const [s, setS] = useSettings();
  // Read the real session rather than showing a placeholder identity. Read once
  // on mount: sign-in happens in the profile menu, which remounts this modal.
  const [account] = useState(() => getSessionUser());
  const accountInitials = account ? initialsFor(account.name || account.email) : "";
  // Recomputed on each render so editing the LiveKit fields updates the hint.
  const livekitStatus = sttProviderStatus().find((p) => p.id === "livekit");

  // docs/23 S3 / docs/24 Phase C: the workspace's provider policy — a fact
  // that lives server-side (the org's settings), not a client preference. It
  // decides what the "where your board content goes" text says and, for an
  // owner, what the segmented control below can set. A null policy means we
  // could not read it (offline, signed out, or a server that predates the
  // setting), and the text falls back to the honest deployment-level answer.
  const [orgPolicy, setOrgPolicy] = useState<OrgPolicyResult | null>(null);
  const [orgIdForPolicy, setOrgIdForPolicy] = useState<string | null>(null);
  const [orgNameForPolicy, setOrgNameForPolicy] = useState<string | null>(null);
  useEffect(() => {
    if (!account) return;
    let live = true;
    void fetchOrgs().then(async (r) => {
      if (!live || r.kind !== "ok") return;
      const org = preferredOrg(r.orgs);
      if (!org) return;
      const policy = await fetchOrgPolicy(org.id, org.role);
      if (!live) return;
      setOrgIdForPolicy(org.id);
      setOrgNameForPolicy(org.name);
      setOrgPolicy(policy);
    });
    return () => {
      live = false;
    };
  }, [account]);

  const applyProviderMode = (mode: OrgProviderMode) => {
    if (orgIdForPolicy === null || orgPolicy === null) return;
    // No optimistic write: a mode-only PATCH PRESERVES the stored name filter
    // on the server (the nested merge), so only the response can say what the
    // policy now is. A failed write (only an owner can write, and the guard
    // hides non-owners as 404) leaves the last truth on screen.
    void patchOrgProviderMode(orgIdForPolicy, mode).then((plane) => {
      if (plane === null) return;
      setOrgPolicy({ ...orgPolicy, providerPolicy: plane.providerPolicy, plane });
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections: { id: string; label: string; icon: React.ReactNode }[] = [
    { id: "account", label: "Account", icon: <ToolIco.User /> },
    { id: "security", label: "Security", icon: <Ico.Lock /> },
    { id: "appearance", label: "Appearance", icon: <ToolIco.Palette /> },
    { id: "canvas", label: "Canvas", icon: <ToolIco.Rect /> },
    { id: "ai", label: "AI & voice", icon: <ToolIco.Settings /> },
    { id: "shortcuts", label: "Shortcuts", icon: <ToolIco.Kbd /> },
    { id: "team", label: "Team", icon: <ToolIco.Team /> },
    { id: "billing", label: "Plan & usage", icon: <Ico.Book /> },
    { id: "support", label: "Support", icon: <ToolIco.User /> },
  ];

  const themes: { id: Theme; name: string; hint: string }[] = [
    { id: "dark", name: "Dark", hint: "Default · Canvas hero" },
    { id: "light", name: "Light", hint: "Creamy · Warm luminous" },
    { id: "system", name: "System", hint: "Match device" },
  ];
  // The Atelier accent axis: every option re-points --bloom-* (atelier.css
  // html[data-accent=…]), so selection, focus, CTAs and connectors recolor as
  // one system. The old amber/violet/cyan/rose/mono set only moved --amber-*
  // and left the cobalt bloom behind — a split palette — so it was retired.
  const palettes: { id: Accent; name: string; color: string }[] = [
    {
      id: "bloom",
      name: "Cobalt",
      color: "linear-gradient(135deg, oklch(0.62 0.20 258), oklch(0.42 0.22 262))",
    },
    {
      id: "madder",
      name: "Madder",
      color: "linear-gradient(135deg, oklch(0.64 0.20 22), oklch(0.48 0.21 24))",
    },
    {
      id: "moss",
      name: "Moss",
      color: "linear-gradient(135deg, oklch(0.60 0.15 148), oklch(0.46 0.14 150))",
    },
    {
      id: "saffron",
      name: "Saffron",
      color: "linear-gradient(135deg, oklch(0.75 0.16 78), oklch(0.60 0.15 68))",
    },
    {
      id: "graphite",
      name: "Graphite",
      color: "linear-gradient(135deg, oklch(0.50 0.010 60), oklch(0.34 0.010 60))",
    },
  ];
  const grids: { id: GridStyle; label: string }[] = [
    { id: "dots", label: "Dots" },
    { id: "lines", label: "Lines" },
    { id: "off", label: "Off" },
  ];

  return (
    <>
      <div className="modal-scrim" onClick={onClose} />
      <div className="settings-modal" role="dialog" aria-label="Preferences">
        <nav className="settings-nav">
          <div className="brand-block">
            <div className="brand-mark" style={{ width: 18, height: 18 }} />
            Preferences
          </div>
          {sections.map((sec) => (
            <button
              key={sec.id}
              className={section === sec.id ? "active" : ""}
              onClick={() => setSection(sec.id)}
            >
              {sec.icon} {sec.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button
            onClick={onClose}
            aria-label="Close preferences"
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              width: 30,
              height: 30,
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              color: "var(--ink-2)",
              background: "oklch(from var(--paper-2) l c h / 0.8)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
              cursor: "pointer",
              zIndex: 1,
              transition: "all 0.1s var(--e-out)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--ink-0)";
              e.currentTarget.style.background = "var(--paper-2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--ink-2)";
              e.currentTarget.style.background = "oklch(from var(--paper-2) l c h / 0.8)";
            }}
          >
            <Ico.X />
          </button>

          {section === "appearance" && (
            <>
              <h2>Appearance</h2>
              <div className="subtitle">
                Lucent adapts across dark, light, and your accent of choice. All changes save
                instantly.
              </div>
              <div className="setting-row">
                <div className="label">Theme</div>
                <div className="desc">
                  Dark keeps the canvas the visual hero. Light uses a warm cream — luminous, not
                  stark.
                </div>
                <div className="theme-cards">
                  {themes.map((t) => (
                    <button
                      key={t.id}
                      className={`theme-card ${s.theme === t.id ? "active" : ""}`}
                      onClick={() => setS({ theme: t.id })}
                    >
                      <div className={`preview ${t.id}`} />
                      <div className="name">{t.name}</div>
                      <div className="hint">{t.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div className="label">Accent palette</div>
                <div className="desc">
                  Used for AI illumination, selection, and generation states.
                </div>
                <div className="palette-row">
                  {palettes.map((p) => (
                    <button
                      key={p.id}
                      className={`swatch ${s.accent === p.id ? "active" : ""}`}
                      onClick={() => setS({ accent: p.id })}
                    >
                      <span className="dot" style={{ background: p.color }} /> {p.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <RowToggle
                  label="Reduce motion"
                  desc="Minimize entrance animations and transitions."
                  value={s.motion === "reduced"}
                  onChange={(v) => setS({ motion: v ? "reduced" : "full" })}
                />
              </div>
            </>
          )}

          {section === "canvas" && (
            <>
              <h2>Canvas</h2>
              <div className="subtitle">How the workspace looks and behaves.</div>
              <div className="setting-row">
                <div className="label">Grid style</div>
                <div className="desc">Applies to every workspace.</div>
                <div className="segmented">
                  {grids.map((g) => (
                    <button
                      key={g.id}
                      className={s.gridStyle === g.id ? "active" : ""}
                      onClick={() => setS({ gridStyle: g.id })}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <div className="label">Board style</div>
                <div className="desc">
                  Clean is precise (Miro/FigJam). Sketch is hand-drawn (Excalidraw) — great for
                  thinking freely.
                </div>
                <div className="segmented">
                  <button
                    className={s.boardStyle === "clean" ? "active" : ""}
                    onClick={() => setS({ boardStyle: "clean" })}
                  >
                    Clean
                  </button>
                  <button
                    className={s.boardStyle === "sketch" ? "active" : ""}
                    onClick={() => setS({ boardStyle: "sketch" })}
                  >
                    Sketch
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <RowToggle
                  label="Autosave"
                  desc="Persist every change automatically."
                  value={s.autosave}
                  onChange={(v) => setS({ autosave: v })}
                />
              </div>
              <div className="setting-row">
                <RowToggle
                  label="AI activity indicators"
                  desc="Show subtle amber pulse when Lucent is thinking or drawing."
                  value={s.activityIndicators}
                  onChange={(v) => setS({ activityIndicators: v })}
                />
              </div>
              <div className="setting-row">
                <RowToggle
                  label="ELK layout engine (experimental)"
                  desc="Use Eclipse Layout Kernel in a Web Worker for orthogonal layered layout. When off (default), Lucent preserves its native layout engine with smooth curved connectors."
                  value={s.elkLayout}
                  onChange={(v) => setS({ elkLayout: v })}
                />
              </div>
            </>
          )}

          {section === "ai" && (
            <>
              <h2>AI &amp; voice</h2>
              <div className="subtitle">How Lucent listens and responds.</div>
              <div className="setting-row">
                <RowToggle
                  label="Voice confirmation sound"
                  desc="A soft chime when voice input starts and ends."
                  value={s.aiSound}
                  onChange={(v) => setS({ aiSound: v })}
                />
              </div>
              <div className="setting-row">
                <div className="label">Speech-to-text engine</div>
                <div className="desc">How the mic turns your voice into text.</div>
                <div className="segmented">
                  <button
                    className={s.sttProvider === "browser" ? "active" : ""}
                    onClick={() => setS({ sttProvider: "browser" })}
                  >
                    Browser (live)
                  </button>
                  <button
                    className={s.sttProvider === "whisper" ? "active" : ""}
                    onClick={() => setS({ sttProvider: "whisper" })}
                  >
                    On-device Whisper
                  </button>
                  <button
                    className={s.sttProvider === "livekit" ? "active" : ""}
                    onClick={() => setS({ sttProvider: "livekit" })}
                  >
                    LiveKit
                  </button>
                  <button
                    className={s.sttProvider === "hosted" ? "active" : ""}
                    onClick={() => setS({ sttProvider: "hosted" })}
                  >
                    Hosted (speakers)
                  </button>
                </div>
                <div className="desc" style={{ marginTop: 8, marginBottom: 0 }}>
                  {s.sttProvider === "browser" && (
                    <>
                      <strong>Audio leaves your device.</strong> The browser engine streams your
                      voice to your browser vendor's cloud speech service. Chrome/Edge only.
                    </>
                  )}
                  {s.sttProvider === "whisper" && (
                    <>
                      Runs entirely on your device — nothing is uploaded. First use downloads a
                      small model. No live interim words.
                    </>
                  )}
                  {s.sttProvider === "livekit" && (
                    <>
                      Realtime transcription through a LiveKit room, for shared or meeting audio.
                      Audio goes to your LiveKit server and its transcription agent.
                    </>
                  )}
                  {s.sttProvider === "hosted" && (
                    <>
                      <strong>Audio leaves your device.</strong> The mic streams to this
                      deployment's configured speech service, which returns speaker-labelled turns
                      for shared-mic meetings. Refused honestly (never silently empty) when the
                      server has none configured or your org forbids it.
                    </>
                  )}
                </div>
              </div>
              {s.sttProvider === "livekit" && (
                <div className="setting-row">
                  <div className="label">LiveKit voice</div>
                  <div className="desc">
                    Realtime transcription runs through this deployment's LiveKit — your server
                    mints a short-lived access token and tells the browser where to connect, so the
                    browser never holds a LiveKit API secret. Nothing to set up here.
                  </div>
                  {livekitStatus?.reason && (
                    <div
                      className="desc"
                      style={{ marginTop: 8, marginBottom: 0, color: "var(--amber-1)" }}
                    >
                      {livekitStatus.reason}
                    </div>
                  )}
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: "pointer", fontSize: 13 }}>
                      Advanced — bring your own LiveKit
                    </summary>
                    <div className="desc" style={{ marginTop: 8 }}>
                      Point at your own LiveKit server, token endpoint, or room (self-hosted or a
                      third-party token server). Leave the URL blank to use this deployment's.
                    </div>
                    <label className="sr-only" htmlFor="livekit-url">
                      LiveKit server URL
                    </label>
                    <input
                      id="livekit-url"
                      className="auth-input"
                      style={{ maxWidth: 380, marginTop: 8, marginBottom: 8 }}
                      placeholder="wss://your-project.livekit.cloud"
                      value={s.livekitUrl}
                      onChange={(e) => setS({ livekitUrl: e.target.value })}
                    />
                    <label className="sr-only" htmlFor="livekit-token-url">
                      Token endpoint
                    </label>
                    <input
                      id="livekit-token-url"
                      className="auth-input"
                      style={{ maxWidth: 380, marginBottom: 8 }}
                      placeholder="/api/livekit/token"
                      value={s.livekitTokenUrl}
                      onChange={(e) => setS({ livekitTokenUrl: e.target.value })}
                    />
                    <label className="sr-only" htmlFor="livekit-room">
                      Room name
                    </label>
                    <input
                      id="livekit-room"
                      className="auth-input"
                      style={{ maxWidth: 380 }}
                      placeholder="lucent-voice"
                      value={s.livekitRoom}
                      onChange={(e) => setS({ livekitRoom: e.target.value })}
                    />
                  </details>
                </div>
              )}
              <div className="setting-row">
                <div className="label">Voice language</div>
                <div className="desc">Used for transcription and voice commands.</div>
                <div className="segmented">
                  <button className="active">English</button>
                  <button>Spanish</button>
                  <button>Auto-detect</button>
                </div>
              </div>
              <div className="setting-row">
                <div className="label">Approval threshold</div>
                <div className="desc">
                  Always reviews everything. Large changes auto-applies small edits. Never
                  auto-applies, but destructive and external actions are still reviewed.
                </div>
                <div className="segmented" role="radiogroup" aria-label="Approval threshold">
                  <button
                    className={s.approvalThreshold === "always" ? "active" : ""}
                    aria-pressed={s.approvalThreshold === "always"}
                    title="Always — review everything"
                    aria-label="Always — review everything"
                    onClick={() => setS({ approvalThreshold: "always" })}
                  >
                    Always
                  </button>
                  <button
                    className={s.approvalThreshold === "large" ? "active" : ""}
                    aria-pressed={s.approvalThreshold === "large"}
                    title="Large changes — auto-apply small edits"
                    aria-label="Large changes — auto-apply small edits"
                    onClick={() => setS({ approvalThreshold: "large" })}
                  >
                    Large changes
                  </button>
                  <button
                    className={s.approvalThreshold === "never" ? "active" : ""}
                    aria-pressed={s.approvalThreshold === "never"}
                    title="Never — auto-apply, still review destructive/external"
                    aria-label="Never — auto-apply, still review destructive/external"
                    onClick={() => setS({ approvalThreshold: "never" })}
                  >
                    Never
                  </button>
                </div>
              </div>
            </>
          )}

          {section === "account" && (
            <>
              <h2>Account</h2>
              <div className="subtitle">Your Lucent profile and workspace.</div>
              {account ? (
                <>
                  <div
                    className="setting-row"
                    style={{ display: "flex", alignItems: "center", gap: 16 }}
                  >
                    <div className="avatar" style={{ width: 56, height: 56, fontSize: 16 }}>
                      {accountInitials}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="label" style={{ fontSize: 15 }}>
                        {account.name}
                      </div>
                      <div className="desc mono" style={{ marginBottom: 0, fontSize: 11 }}>
                        {account.email}
                      </div>
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="label">Display name</div>
                    <div className="desc">Shown to collaborators.</div>
                    <label className="sr-only" htmlFor="account-display-name">
                      Display name
                    </label>
                    <input
                      id="account-display-name"
                      defaultValue={account.name}
                      style={{
                        width: "100%",
                        maxWidth: 320,
                        padding: "9px 12px",
                        background: "var(--paper-1)",
                        border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                        borderRadius: 8,
                        fontSize: 13,
                        color: "var(--ink-0)",
                      }}
                    />
                  </div>
                  <div className="setting-row">
                    <div className="label">Where your board content goes</div>
                    <div className="desc">
                      Boards are stored by this Lucent server, not by us, and are never sold or used
                      to train our own models — we don't train any. What a prompt does at the AI
                      provider is governed by whichever provider this deployment is configured to
                      use
                      {orgPolicy === null ? (
                        <>
                          : set <span className="mono">LUCENT_AI_BASE_URL</span> to one whose terms
                          match your policy. Lucent does not add a no-training guarantee on top of
                          the provider's own.
                        </>
                      ) : (
                        <>
                          , and — for this workspace — by the AI-provider policy your administrator
                          set: {providerPolicySentence(orgPolicy.providerPolicy)}.
                        </>
                      )}
                    </div>
                  </div>
                  {orgPolicy !== null && orgPolicy.canEdit && (
                    <div className="setting-row">
                      <div className="label">AI provider policy</div>
                      <div className="desc">
                        {orgNameForPolicy
                          ? `Applies to every board in ${orgNameForPolicy}, including boards created before the change. `
                          : "Applies to every board in this workspace, including boards created before the change. "}
                        A workspace policy can restrict which AI providers process its content, but
                        it can never widen what this deployment itself allows.
                        {orgPolicy.providerPolicy.allow !== null && (
                          <>
                            {" "}
                            Provider names are pinned to{" "}
                            <span className="mono">
                              {orgPolicy.providerPolicy.allow.join(", ")}
                            </span>{" "}
                            (set by the operator's API).
                          </>
                        )}
                      </div>
                      <div className="segmented" role="radiogroup" aria-label="AI provider policy">
                        {ORG_PROVIDER_MODES.map((mode) => (
                          <button
                            key={mode}
                            className={orgPolicy.providerPolicy.mode === mode ? "active" : ""}
                            aria-pressed={orgPolicy.providerPolicy.mode === mode}
                            title={PROVIDER_MODE_HINTS[mode]}
                            aria-label={PROVIDER_MODE_LABELS[mode]}
                            onClick={() => applyProviderMode(mode)}
                          >
                            {PROVIDER_MODE_LABELS[mode]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="setting-row">
                  <div className="label">You're working offline</div>
                  <div className="desc">
                    Sign in from the profile menu to sync boards to an account. Until then,
                    everything stays in this browser.
                  </div>
                </div>
              )}
            </>
          )}

          {section === "shortcuts" && (
            <>
              <h2>Keyboard shortcuts</h2>
              <div className="subtitle">Muscle memory for people who like it fast.</div>
              {[
                {
                  title: "Global",
                  rows: [
                    ["Command menu", ["⌘", "K"]],
                    ["Preferences", ["⌘", ","]],
                    ["Undo", ["⌘", "Z"]],
                    ["Redo", ["⌘", "⇧", "Z"]],
                  ] as [string, string[]][],
                },
                {
                  title: "Selection",
                  rows: [
                    ["Next object", ["Tab"]],
                    ["Previous object", ["⇧", "Tab"]],
                    ["Edit / rename", ["↩"]],
                    ["Select all", ["⌘", "A"]],
                    ["Add to selection", ["⇧", "click"]],
                    ["Marquee select", ["drag"]],
                    ["Delete selection", ["⌫"]],
                    ["Clear selection", ["Esc"]],
                  ] as [string, string[]][],
                },
                {
                  title: "Editing",
                  rows: [
                    ["Copy", ["⌘", "C"]],
                    ["Cut", ["⌘", "X"]],
                    ["Paste", ["⌘", "V"]],
                    ["Duplicate", ["⌘", "D"]],
                    ["Group", ["⌘", "G"]],
                    ["Ungroup", ["⌘", "⇧", "G"]],
                    ["Bring forward", ["⌘", "]"]],
                    ["Send backward", ["⌘", "["]],
                    ["Bring to front", ["⌘", "⇧", "]"]],
                    ["Send to back", ["⌘", "⇧", "["]],
                    ["Nudge", ["←", "→", "↑", "↓"]],
                    ["Nudge 10px", ["⇧", "arrow"]],
                  ] as [string, string[]][],
                },
                {
                  title: "View",
                  rows: [
                    ["Zoom in", ["⌘", "+"]],
                    ["Zoom out", ["⌘", "-"]],
                    ["Reset zoom", ["⌘", "0"]],
                    ["Fit board", ["⇧", "1"]],
                    ["Fit selection", ["⇧", "2"]],
                    ["Pan", ["⇧", "drag"]],
                  ] as [string, string[]][],
                },
                {
                  title: "Tools",
                  rows: [
                    ["Select", ["V"]],
                    ["Hand", ["H"]],
                    ["Rectangle", ["R"]],
                    ["Ellipse", ["O"]],
                    ["Diamond", ["D"]],
                    ["Text", ["T"]],
                    ["Sticky", ["S"]],
                    ["Connect", ["A"]],
                    ["Pen", ["P"]],
                    ["Frame", ["F"]],
                    ["Comment", ["C"]],
                  ] as [string, string[]][],
                },
                {
                  title: "Direct manipulation",
                  rows: [
                    ["Duplicate by dragging", ["⌥", "drag"]],
                    ["Rename a node", ["double-click"]],
                    ["Edit shape text", ["double-click"]],
                    ["Resize a shape", ["drag corner"]],
                    ["Rotate a shape", ["drag the top knob"]],
                    ["Rotate in 15° steps", ["⇧", "drag knob"]],
                  ] as [string, string[]][],
                },
              ].map((g) => (
                <div key={g.title} className="setting-row">
                  <div className="label" style={{ marginBottom: 12 }}>
                    {g.title}
                  </div>
                  <div
                    style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 20px" }}
                  >
                    {g.rows.map(([label, keys], i) => (
                      <span key={i} style={{ display: "contents" }}>
                        <div style={{ fontSize: 12.5, color: "var(--ink-1)" }}>{label}</div>
                        <div style={{ display: "flex", gap: 4 }}>
                          {keys.map((k, j) => (
                            <span
                              key={j}
                              style={{
                                padding: "3px 7px",
                                minWidth: 22,
                                textAlign: "center",
                                fontFamily: "var(--font-mono)",
                                fontSize: 10.5,
                                color: "var(--ink-1)",
                                background: "var(--canvas-3)",
                                border: "1px solid var(--stroke-1)",
                                borderRadius: 4,
                              }}
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {section === "team" && <TeamPane />}
          {section === "security" && <SecurityPane />}

          {section === "billing" && <BillingPane />}

          {section === "support" && <SupportPane />}
        </div>
      </div>
    </>
  );
}

/**
 * The team pane: the current workspace's real members, and — for an owner —
 * a working invite (POST /api/orgs/:id/invites) with the pending list and
 * revoke. It replaced a pane that said "4 people in Personal" to everyone and
 * whose Send invite button did nothing.
 */
/**
 * Two-step verification (docs/26 A6): set it up with any authenticator app,
 * see how many recovery codes are left, turn it off with a code. A workspace
 * can require it; the server refuses turning it off while one does.
 */
function SecurityPane() {
  const [status, setStatus] = useState<TwoFactorStatus | "loading" | "signed-out" | "failed">(() =>
    getSessionUser() ? "loading" : "signed-out",
  );
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    const next = await twoFactorStatus();
    setStatus(next ?? "failed");
  };
  useEffect(() => {
    if (getSessionUser()) void refresh();
  }, []);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await beginEnrollment();
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setSetup({ secret: r.secret, otpauthUri: r.otpauthUri });
    setCode("");
  };
  const finish = async () => {
    if (!setup) return;
    setBusy(true);
    setError(null);
    const r = await confirmEnrollment(setup.secret, code);
    setBusy(false);
    if (!r.ok) {
      return setError(
        r.error === "code did not match"
          ? "That code didn't match — check the app's clock and try the newest code."
          : r.error,
      );
    }
    setSetup(null);
    setCode("");
    setRecovery(r.recoveryCodes);
    await refresh();
  };
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    const r = await disableTwoFactor(code);
    setBusy(false);
    if (!r.ok) {
      return setError(r.error === "code did not match" ? "That code didn't match." : r.error);
    }
    setTurningOff(false);
    setCode("");
    await refresh();
  };
  const copyCodes = async () => {
    if (!recovery) return;
    try {
      await navigator.clipboard.writeText(recovery.join("\n"));
      setCopied(true);
    } catch {
      /* the codes stay on screen to copy by hand */
    }
  };

  return (
    <>
      <h2>Security</h2>
      <div className="subtitle">Two-step verification, and tokens for scripts and agents.</div>
      {status === "signed-out" && (
        <div className="setting-row">
          <div className="desc">Sign in to protect your account with two-step verification.</div>
        </div>
      )}
      {status === "loading" && <div className="subtitle">Loading…</div>}
      {status === "failed" && (
        <div className="subtitle" role="alert">
          Couldn&apos;t read your security settings. Check your connection and reopen this pane.
        </div>
      )}
      {typeof status === "object" && !status.available && (
        <div className="setting-row">
          <div className="desc">This Lucent server doesn&apos;t offer two-step verification.</div>
        </div>
      )}

      {recovery && (
        <div className="setting-row security-recovery">
          <div className="label">Save your recovery codes</div>
          <div className="desc">
            Each one signs you in once if you lose your phone. They won&apos;t be shown again — keep
            them somewhere safe, like a password manager.
          </div>
          <ul className="security-codes mono" aria-label="Recovery codes">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="security-actions">
            <button className="btn ghost" type="button" onClick={() => void copyCodes()}>
              {copied ? "Copied" : "Copy codes"}
            </button>
            <button className="btn primary" type="button" onClick={() => setRecovery(null)}>
              I&apos;ve saved them
            </button>
          </div>
        </div>
      )}

      {typeof status === "object" && status.available && !recovery && (
        <div className="setting-row">
          <div className="label">
            Two-step verification{" "}
            <span className={`security-state ${status.enabled ? "on" : "off"}`}>
              {status.enabled ? "On" : "Off"}
            </span>
          </div>
          {status.enabled ? (
            <div className="desc">
              Signing in asks for a code from your authenticator app as well as your password
              {status.enrolledAt
                ? ` — on since ${new Date(status.enrolledAt).toLocaleDateString()}`
                : ""}
              . {status.recoveryCodesLeft} recovery code
              {status.recoveryCodesLeft === 1 ? "" : "s"} left.
            </div>
          ) : (
            <div className="desc">
              Sign in with a code from an authenticator app as well as your password. Some
              workspaces require it before you can open their boards.
            </div>
          )}

          {!status.enabled && !setup && (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => void start()}
            >
              Set up two-step verification
            </button>
          )}

          {setup && (
            <form
              className="security-setup"
              onSubmit={(e) => {
                e.preventDefault();
                void finish();
              }}
            >
              <ol>
                <li>
                  Add Lucent to an authenticator app (1Password, Google Authenticator, Authy…) with
                  this key:
                  <div className="security-secret mono" aria-label="Setup key">
                    {groupedSecret(setup.secret)}
                  </div>
                  <a className="security-link" href={setup.otpauthUri}>
                    Open in an authenticator app on this device
                  </a>
                </li>
                <li>
                  Enter the 6-digit code it shows:
                  <div className="team-invite">
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="123 456"
                      aria-label="Code from your authenticator app"
                    />
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={busy || code.trim().length < 6}
                    >
                      {busy ? "Checking…" : "Turn on"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={() => {
                        setSetup(null);
                        setError(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </li>
              </ol>
            </form>
          )}

          {status.enabled && !turningOff && (
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setTurningOff(true);
                setError(null);
                setCode("");
              }}
            >
              Turn off
            </button>
          )}
          {status.enabled && turningOff && (
            <form
              className="team-invite"
              onSubmit={(e) => {
                e.preventDefault();
                void turnOff();
              }}
            >
              <input
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Code or recovery code"
                aria-label="Code to turn off two-step verification"
              />
              <button className="btn primary" type="submit" disabled={busy || !code.trim()}>
                Turn off
              </button>
              <button className="btn ghost" type="button" onClick={() => setTurningOff(false)}>
                Keep it on
              </button>
            </form>
          )}
          {error && (
            <div className="team-note error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
      {status !== "signed-out" && <ApiTokensSection />}
    </>
  );
}

/** When a token was last used, or that it hasn't been. */
function tokenMeta(t: ApiTokenView): string {
  const day = (at: number) => new Date(at).toLocaleDateString();
  return [
    t.orgName ?? "",
    scopeLabel(t.scopes),
    t.lastUsedAt ? `last used ${day(t.lastUsedAt)}` : "never used",
    t.expiresAt === null
      ? "never expires"
      : t.expiresAt < Date.now()
        ? `expired ${day(t.expiresAt)}`
        : `expires ${day(t.expiresAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Personal API tokens (docs/26 A6): for a script or an agent — Lucent's MCP
 * server reads one from LUCENT_MCP_TOKEN. Each acts as you in one workspace;
 * the token is shown once, when it's made.
 */
function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenView[] | null>(null);
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [write, setWrite] = useState(false);
  const [days, setDays] = useState<number | null>(90);
  const [made, setMade] = useState<(ApiTokenView & { token: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async () => setTokens(await listMyTokens());
  useEffect(() => {
    void refresh();
    void loadOrgList().then(({ orgs: list, current }) => {
      const open = list.filter((o) => !o.blocked);
      setOrgs(open);
      setOrgId((current && !current.blocked ? current.id : open[0]?.id) ?? "");
    });
  }, []);

  const chosen = orgs.find((o) => o.id === orgId);
  const canWrite = chosen ? chosen.role !== "viewer" : false;

  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await createToken({
      name: name.trim(),
      orgId,
      scopes: write && canWrite ? ["read", "write"] : ["read"],
      expiresInDays: days,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setMade(r);
    setCopied(false);
    setName("");
    await refresh();
  };
  const revoke = async (id: string) => {
    const r = await revokeMyToken(id);
    if (!r.ok) setError(r.error);
    await refresh();
  };
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.token);
      setCopied(true);
    } catch {
      /* it stays on screen to copy by hand */
    }
  };

  return (
    <div className="setting-row">
      <div className="label">API tokens</div>
      <div className="desc">
        For a script or an agent — Lucent&apos;s MCP server reads one from{" "}
        <span className="mono">LUCENT_MCP_TOKEN</span>. A token acts as you in one workspace:{" "}
        <em>Read</em> only reads; <em>Read &amp; write</em> can change boards, but never share them
        or change the workspace. It can&apos;t manage your account.
      </div>

      {made && (
        <div className="security-made" role="status">
          <div className="security-made-title">
            Copy “{made.name}” now — it won&apos;t be shown again.
          </div>
          <div className="security-secret mono" aria-label="New API token">
            {made.token}
          </div>
          <div className="security-actions">
            <button className="btn ghost" type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy token"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {orgs.length > 0 && (
        <form
          className="security-token-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What it's for — e.g. Claude Desktop"
            aria-label="Token name"
            maxLength={80}
          />
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Workspace">
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={write && canWrite ? "write" : "read"}
            onChange={(e) => setWrite(e.target.value === "write")}
            aria-label="Access"
          >
            <option value="read">Read</option>
            {canWrite && <option value="write">Read &amp; write</option>}
          </select>
          <select
            value={days === null ? "never" : String(days)}
            onChange={(e) => setDays(e.target.value === "never" ? null : Number(e.target.value))}
            aria-label="Expires"
          >
            {TOKEN_EXPIRY_CHOICES.map((c) => (
              <option key={c.label} value={c.days === null ? "never" : String(c.days)}>
                {c.days === null ? "Never expires" : `Expires in ${c.label}`}
              </option>
            ))}
          </select>
          <button className="btn primary" type="submit" disabled={busy || !name.trim() || !orgId}>
            Create token
          </button>
        </form>
      )}
      {error && (
        <div className="team-note error" role="alert">
          {error}
        </div>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="security-tokens" aria-label="Your API tokens">
          {tokens.map((t) => (
            <li key={t.id}>
              <div className="team-member-who">
                <div className="team-member-name">
                  {t.name} <span className="mono security-prefix">{t.prefix}…</span>
                </div>
                <div className="team-member-email">{tokenMeta(t)}</div>
              </div>
              <button
                className="btn ghost"
                type="button"
                aria-label={`Revoke ${t.name}`}
                onClick={() => void revoke(t.id)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamPane() {
  const [org, setOrg] = useState<OrgMembership | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [invites, setInvites] = useState<OrgInvite[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = async () => {
    if (!getSessionUser()) {
      setStatus("signed-out");
      return;
    }
    try {
      const { current } = await loadOrgs();
      setOrg(current);
      if (!current) {
        setStatus("ready");
        return;
      }
      const d = await fetchOrg(current.id);
      setDetail(d);
      setInvites(d?.role === "owner" ? await listOrgInvites(current.id) : []);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const isOwner = detail?.role === "owner";

  const send = async () => {
    if (!org || !email.includes("@")) return;
    setSending(true);
    setNote(null);
    const res = await inviteToOrg(org.id, email.trim(), role);
    setSending(false);
    if (!res.ok) {
      setNote({ tone: "error", text: res.error });
      return;
    }
    setNote({ tone: "ok", text: `Invite sent to ${email.trim()}. It expires in 7 days.` });
    setEmail("");
    setInvites(await listOrgInvites(org.id));
  };

  const revoke = async (id: string) => {
    if (!org) return;
    const res = await revokeOrgInvite(org.id, id);
    if (!res.ok) setNote({ tone: "error", text: res.error });
    setInvites(await listOrgInvites(org.id));
  };

  return (
    <>
      <h2>Workspace members</h2>
      {status === "loading" && <div className="subtitle">Loading members…</div>}
      {status === "signed-out" && (
        <div className="subtitle">Sign in to see who is in your workspace and invite people.</div>
      )}
      {status === "error" && (
        <div className="subtitle" role="alert">
          Couldn't load your workspace. Check your connection and reopen this pane.
        </div>
      )}
      {status === "ready" && !org && (
        <div className="subtitle">You aren't a member of any workspace yet.</div>
      )}
      {status === "ready" && org && (
        <>
          <div className="subtitle">
            {detail
              ? `${detail.members.length} ${detail.members.length === 1 ? "person" : "people"} in ${org.name}.`
              : org.name}
          </div>
          {detail && (
            <div className="setting-row">
              {detail.members.map((m) => (
                <div key={m.userId} className="team-member">
                  <div className="avatar" aria-hidden>
                    {initialsFor(m.name || m.email)}
                  </div>
                  <div className="team-member-who">
                    <div className="team-member-name">{m.name || m.email}</div>
                    <div className="team-member-email">{m.email}</div>
                  </div>
                  <span className="team-member-role">{m.role}</span>
                </div>
              ))}
            </div>
          )}
          {isOwner ? (
            <div className="setting-row">
              <div className="label" style={{ marginBottom: 10 }}>
                Invite by email
              </div>
              <form
                className="team-invite"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  aria-label="Email to invite"
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
                  aria-label="Role"
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="btn primary"
                  type="submit"
                  disabled={sending || !email.includes("@")}
                >
                  {sending ? "Sending…" : "Send invite"}
                </button>
              </form>
              {note && (
                <div
                  className={`team-note ${note.tone}`}
                  role={note.tone === "error" ? "alert" : "status"}
                >
                  {note.text}
                </div>
              )}
              {invites.length > 0 && (
                <div className="team-pending">
                  <div className="label">Pending invites</div>
                  {invites.map((i) => (
                    <div key={i.id} className="team-member">
                      <div className="team-member-who">
                        <div className="team-member-name">{i.email}</div>
                        <div className="team-member-email">
                          {i.role} · expires {new Date(i.expiresAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button className="btn ghost" type="button" onClick={() => void revoke(i.id)}>
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="setting-row">
              <div className="subtitle" style={{ margin: 0 }}>
                Only the workspace's owners can invite people.
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * The support channel (G2): a copyable diagnostic report describing the
 * session — never the board. The paste target is whatever channel the
 * deployment uses (email, a support inbox, a community forum); the product's
 * job is to make the attachment complete and safe, not to own the transport.
 */
function SupportPane() {
  // The workspace read is inside the pane, not the modal: the modal mounts
  // outside WorkspaceProvider on some entry paths (the auth screen's ⌘,,
  // an org page), and a pane that reads context it might not have is a
  // crash, not a settings page. useWorkspaceOptional returns null there —
  // a diagnostics report without the board section is still copyable
  // support material, which beats a blank settings page. Inside the
  // provider (the normal path) the board section reports as always.
  const ws = useWorkspaceOptional();
  const [copied, setCopied] = useState(false);

  const report = buildSupportReport({
    nodes: Object.keys(ws?.workspace.nodes ?? {}).length,
    edges: Object.keys(ws?.workspace.edges ?? {}).length,
    shapes: Object.keys(ws?.workspace.shapes ?? {}).length,
    comments: Object.keys(ws?.workspace.comments ?? {}).length,
    boardId: ws?.boardId ?? null,
    syncStatus: ws?.syncStatus ?? "offline",
    syncRole: ws?.syncRole ?? null,
    busy: ws?.busy ?? false,
    streamChars: ws?.streamChars ?? 0,
    provider: "configured-at-runtime",
  });
  const text = formatSupportReport(report);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail (document not focused, permission). The
      // textarea below is the always-works fallback; leave it selected.
    }
  };

  return (
    <div className="settings-support">
      <h3>Report a problem</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Copy this into your support request. It describes your session — build, connection, object
        counts — and never your board contents.
      </p>
      <textarea
        readOnly
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 220,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 11.5,
          padding: 10,
          borderRadius: 8,
          border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
          background: "var(--paper-1)",
          color: "var(--ink-1)",
        }}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn primary" style={{ padding: "0 18px" }} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy report"}
        </button>
      </div>
    </div>
  );
}
