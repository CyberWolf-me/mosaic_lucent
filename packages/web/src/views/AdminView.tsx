import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../http.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
  FilterBar,
  StatCard,
} from "../ui/atelierAtoms.js";
import { useWorkspace, type View } from "../workspace.js";

interface OrgMember {
  userId: string;
  role: string;
  email: string;
  name: string;
}

interface OrgSummary {
  id: string;
  name: string;
  createdAt: number;
  members: OrgMember[];
  role: string;
}

interface AuditEntry {
  id: string;
  orgId: string;
  actorId: string;
  action: string;
  subject: string | null;
  ip: string | null;
  at: number;
  metadata: unknown;
}

export function AdminView({ onBack }: { onBack?: () => void }) {
  const { setView } = useWorkspace();
  const [section, setSection] = useState<string>("members");
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const meRes = await apiFetch("/api/auth/me");
        const meBody = (await meRes.json()) as { memberships?: Array<{ orgId: string }> };
        const memberships = meBody.memberships ?? [];
        const first = memberships[0];
        if (!first) {
          return;
        }
        const orgRes = await apiFetch(`/api/orgs/${encodeURIComponent(first.orgId)}`);
        if (cancelled) return;
        if (orgRes.status === 200) {
          setOrg((await orgRes.json()) as OrgSummary);
        }

        const auditRes = await apiFetch(`/api/orgs/${encodeURIComponent(first.orgId)}/audit`);
        if (!cancelled && auditRes.status === 200) {
          setAudit(((await auditRes.json()) as { entries?: AuditEntry[] }).entries ?? []);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const orgName = org?.name ?? "Northbeam";

  return (
    <AtelierAppShell
      activeArea="admin"
      crumbs={[
        { label: orgName, onClick: () => setView("workspace" as View) },
        { label: "Admin", current: true },
      ]}
      actions={
        onBack ? (
          <button
            type="button"
            className="icon-btn"
            style={{ height: 32 }}
            onClick={onBack}
          >
            <Ico.Left /> Back to Canvas
          </button>
        ) : undefined
      }
    >
      <div style={{ display: "flex", height: "100%", minHeight: "calc(100vh - 56px)" }}>
        {/* Left admin sidebar */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            borderRight: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            padding: "24px 12px",
            overflowY: "auto",
          }}
        >
          <div className="mono-caps" style={{ padding: "0 12px", marginBottom: 10 }}>
            Organization
          </div>
          <AdminNavItem
            label="Members · 14"
            active={section === "members"}
            onClick={() => setSection("members")}
            icon={<TeamIcon2 />}
          />
          <AdminNavItem
            label="Teams · 4"
            active={section === "teams"}
            onClick={() => setSection("teams")}
            icon={<TeamIcon2 />}
          />
          <AdminNavItem
            label="Roles"
            active={section === "roles"}
            onClick={() => setSection("roles")}
            icon={<Ico.User />}
          />
          <AdminNavItem
            label="Guests · 2"
            active={section === "guests"}
            onClick={() => setSection("guests")}
            icon={<Ico.User />}
          />

          <div className="mono-caps" style={{ padding: "20px 12px 10px" }}>
            Security
          </div>
          <AdminNavItem
            label="Authentication · SSO"
            active={section === "sso"}
            onClick={() => setSection("sso")}
            icon={<AuthIcon2 />}
          />
          <AdminNavItem
            label="Sessions · MFA"
            active={section === "sessions"}
            onClick={() => setSection("sessions")}
            icon={<AuthIcon2 />}
          />
          <AdminNavItem
            label="AI policies"
            active={section === "ai"}
            onClick={() => setSection("ai")}
            icon={<Ico.Sparkle />}
          />
          <AdminNavItem
            label="Classification"
            active={section === "classification"}
            onClick={() => setSection("classification")}
            icon={<Ico.Layers />}
          />
          <AdminNavItem
            label="Audit log"
            active={section === "audit"}
            onClick={() => setSection("audit")}
            icon={<Ico.History />}
          />

          <div className="mono-caps" style={{ padding: "20px 12px 10px" }}>
            Data
          </div>
          <AdminNavItem
            label="Retention"
            active={section === "retention"}
            onClick={() => setSection("retention")}
            icon={<Ico.History />}
          />
          <AdminNavItem
            label="Integrations"
            onClick={() => setView("integrations" as View)}
            icon={<Ico.Layers />}
          />
          <AdminNavItem
            label="Data export"
            active={section === "export"}
            onClick={() => setSection("export")}
            icon={<Ico.Folder />}
          />
          <AdminNavItem
            label="Data deletion"
            active={section === "deletion"}
            onClick={() => setSection("deletion")}
            icon={<Ico.X />}
          />

          <div className="mono-caps" style={{ padding: "20px 12px 10px" }}>
            Billing
          </div>
          <AdminNavItem
            label="Plan · Team"
            active={section === "billing"}
            onClick={() => setSection("billing")}
            icon={<Ico.Book />}
          />
          <AdminNavItem
            label="Usage"
            active={section === "usage"}
            onClick={() => setSection("usage")}
            icon={<Ico.Book />}
          />
          <AdminNavItem
            label="Invoices"
            active={section === "invoices"}
            onClick={() => setSection("invoices")}
            icon={<Ico.Book />}
          />
        </div>

        {/* Right detail container */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 40px 60px" }}>
          {error && (
            <div
              style={{
                padding: "12px 16px",
                borderRadius: 8,
                background: "oklch(from var(--madder) l c h / 0.1)",
                color: "var(--madder)",
                marginBottom: 20,
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          {section === "members" && <AdminMembers serverMembers={org?.members} />}
          {section === "teams" && <AdminMembers serverMembers={org?.members} />}
          {section === "roles" && <AdminRoles />}
          {section === "guests" && (
            <AdminStub
              title="Guests"
              desc="External collaborators granted limited access to specific workspaces."
              kind="Guest access"
            />
          )}
          {section === "sso" && (
            <AdminStub
              title="Authentication · SSO"
              desc="Configure SAML 2.0 or OIDC with your identity provider."
              kind="Identity provider"
            />
          )}
          {section === "sessions" && (
            <AdminStub
              title="Sessions · MFA"
              desc="Active device sessions and multi-factor enrolment."
              kind="Session policy"
            />
          )}
          {section === "ai" && <AdminAI />}
          {section === "classification" && (
            <AdminStub
              title="Classification"
              desc="Internal / Confidential / Restricted labels and policies."
              kind="Data classification"
            />
          )}
          {section === "audit" && <AdminAudit serverAudit={audit} />}
          {section === "retention" && (
            <AdminStub
              title="Retention"
              desc="How long AI conversation context, transcripts, and audit trails are kept."
              kind="Retention policy"
            />
          )}
          {section === "export" && (
            <AdminStub
              title="Data export"
              desc="Export your entire organization's data as a signed archive."
              kind="Export request"
            />
          )}
          {section === "deletion" && (
            <AdminStub
              title="Data deletion"
              desc="Permanently delete an object, workspace, or the entire organization (audited)."
              kind="Deletion request"
              danger
            />
          )}
          {section === "billing" && <AdminBilling />}
          {section === "usage" && (
            <AdminStub
              title="Usage"
              desc="Detailed breakdown by member and project."
              kind="Usage report"
            />
          )}
          {section === "invoices" && (
            <AdminStub
              title="Invoices"
              desc="Past invoices, receipts, and billing history."
              kind="Invoice"
            />
          )}
        </div>
      </div>
    </AtelierAppShell>
  );
}

function AdminNavItem({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 12px",
        borderRadius: 6,
        fontSize: 12.5,
        color: active ? "var(--ink-0)" : "var(--ink-1)",
        background: active ? "var(--paper-2)" : "transparent",
        fontWeight: active ? 500 : 400,
        textAlign: "left",
        border: 0,
        cursor: "pointer",
        transition: "background 0.12s var(--e-out)",
      }}
      onMouseEnter={(e) => !active && (e.currentTarget.style.background = "var(--paper-2)")}
      onMouseLeave={(e) => !active && (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ color: "var(--ink-3)", display: "grid", placeItems: "center" }}>{icon}</span>
      {label}
    </button>
  );
}

function TeamIcon2() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="9" r="3" />
      <circle cx="16" cy="11" r="2.5" />
      <path d="M3 20c1-3 3-4.5 5-4.5s4 1.5 5 4.5M14 20c1-2.5 2-3.5 3-4" />
    </svg>
  );
}

function AuthIcon2() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 0 1 10 10c0 5.5-4.5 10-10 10S2 17.5 2 12a10 10 0 0 1 10-10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function SCIMIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M12 3v18M3 12h18" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

interface MemberRow {
  name: string;
  email: string;
  role: string;
  color: string;
  last: string;
  guest?: boolean;
}

const DEMO_MEMBERS: MemberRow[] = [
  { name: "Alex Kim", email: "alex@northbeam.co", role: "Owner", color: "oklch(0.55 0.16 25)", last: "now" },
  { name: "Sarah Chen", email: "sarah@northbeam.co", role: "Admin", color: "oklch(0.55 0.11 220)", last: "2h ago" },
  { name: "John Torres", email: "john@northbeam.co", role: "Editor", color: "oklch(0.55 0.14 148)", last: "1h ago" },
  { name: "Kim Park", email: "kim@northbeam.co", role: "Editor", color: "oklch(0.55 0.16 300)", last: "yesterday" },
  { name: "Marco Rossi", email: "marco@northbeam.co", role: "Editor", color: "oklch(0.55 0.14 200)", last: "3 days ago" },
  { name: "Ana López", email: "ana@northbeam.co", role: "Editor", color: "oklch(0.55 0.16 40)", last: "yesterday" },
  { name: "Guest · Stripe", email: "partner@stripe.com", role: "Guest", color: "oklch(0.6 0.005 60)", last: "Sep 15", guest: true },
];

function AdminMembers({ serverMembers }: { serverMembers?: OrgMember[] }) {
  const [filter, setFilter] = useState("all");

  const combinedMembers: MemberRow[] = (() => {
    if (!serverMembers || serverMembers.length === 0) return DEMO_MEMBERS;
    // Map server members into rows, and ensure demo members complete the roster
    const mapped: MemberRow[] = serverMembers.map((m) => ({
      name: m.name || m.email.split("@")[0] || "Member",
      email: m.email,
      role: m.role.charAt(0).toUpperCase() + m.role.slice(1),
      color: m.role === "owner" ? "oklch(0.55 0.16 25)" : "oklch(0.55 0.11 220)",
      last: "now",
    }));
    const existingEmails = new Set(mapped.map((m) => m.email.toLowerCase()));
    const extra = DEMO_MEMBERS.filter((m) => !existingEmails.has(m.email.toLowerCase()));
    return [...mapped, ...extra];
  })();

  const filtered = combinedMembers.filter((m) => {
    if (filter === "all") return true;
    if (filter === "admin") return m.role === "Owner" || m.role === "Admin";
    if (filter === "editor") return m.role === "Editor";
    if (filter === "guest") return m.role === "Guest" || m.guest;
    if (filter === "invite") return false;
    return true;
  });

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 24 · Admin"
        title="Members"
        meta="14 members · 2 guests · 1 pending invite"
        actions={
          <>
            <button type="button" className="icon-btn">
              <SCIMIcon /> SCIM · syncing
            </button>
            <button type="button" className="icon-btn primary">
              <Ico.Plus /> Invite
            </button>
          </>
        }
      />
      <FilterBar
        filters={[
          { id: "all", label: "All", count: combinedMembers.length },
          { id: "admin", label: "Admins", count: combinedMembers.filter((m) => m.role === "Owner" || m.role === "Admin").length },
          { id: "editor", label: "Editors", count: combinedMembers.filter((m) => m.role === "Editor").length },
          { id: "guest", label: "Guests", count: combinedMembers.filter((m) => m.role === "Guest" || m.guest).length },
          { id: "invite", label: "Pending", count: 1 },
        ]}
        active={filter}
        onChange={setFilter}
      />
      <div
        style={{
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 100px 100px 40px",
            padding: "10px 16px",
            borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            background: "oklch(from var(--paper-2) l c h / 0.5)",
          }}
          className="mono-caps"
        >
          <span>Name</span>
          <span>Role</span>
          <span>Last active</span>
          <span>MFA</span>
          <span />
        </div>
        {filtered.map((m, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 100px 100px 40px",
              padding: "10px 16px",
              borderBottom:
                i < filtered.length - 1 ? "1px solid oklch(from var(--paper-4) l c h / 0.4)" : "none",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 999,
                  background: m.color,
                  color: "white",
                  display: "grid",
                  placeItems: "center",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                {m.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {m.email}
                </div>
              </div>
            </div>
            <div>
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  background:
                    m.role === "Owner"
                      ? "var(--ink-0)"
                      : m.role === "Admin"
                        ? "var(--bloom-wash-2)"
                        : m.role === "Guest"
                          ? "oklch(from var(--ink-3) l c h / 0.2)"
                          : "oklch(from var(--paper-3) l c h / 0.9)",
                  color:
                    m.role === "Owner"
                      ? "var(--paper-0)"
                      : m.role === "Admin"
                        ? "var(--bloom-2)"
                        : "var(--ink-1)",
                }}
              >
                {m.role}
              </span>
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {m.last}
            </span>
            <span>{!m.guest && <Ico.Check style={{ color: "var(--moss)", width: 14, height: 14 }} />}</span>
            <span style={{ color: "var(--ink-3)", textAlign: "right", cursor: "pointer" }}>⋯</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminRoles() {
  return (
    <>
      <SectionHeader eyebrow="Fig. 24 · Admin · Roles" title="Roles &amp; permissions" />
      <div style={{ display: "grid", gap: 12 }}>
        {[
          { role: "Owner", scope: "Everything · billing · deletion · policies", count: 1 },
          { role: "Admin", scope: "Members · integrations · classification", count: 2 },
          { role: "Editor", scope: "Boards · meetings · actions · comments", count: 8 },
          { role: "Commenter", scope: "View + comment · no editing", count: 2 },
          { role: "Viewer", scope: "View only", count: 1 },
          { role: "Guest", scope: "Limited · per invitation", count: 1 },
        ].map((r, i) => (
          <div
            key={i}
            style={{
              padding: "14px 16px",
              background: "var(--paper-0)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                background: "var(--ink-0)",
                color: "var(--paper-0)",
                fontSize: 12,
                fontWeight: 600,
                minWidth: 100,
                textAlign: "center",
              }}
            >
              {r.role}
            </div>
            <span style={{ flex: 1, fontSize: 12.5, color: "var(--ink-2)" }}>{r.scope}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {r.count} member{r.count === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminAI() {
  return (
    <>
      <SectionHeader
        eyebrow="Fig. 24 · Admin · AI policies"
        title="AI governance"
        meta="What Lucent's AI is allowed to do, and where the data flows."
      />
      <div style={{ display: "grid", gap: 14 }}>
        <PolicyCard
          label="Approved providers"
          desc="Which model providers Lucent can call for this organization."
          value={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <ProviderChip name="Anthropic" model="Claude 3.5 Sonnet" allowed />
              <ProviderChip name="OpenAI" model="GPT-4o" allowed />
              <ProviderChip name="Google" model="Gemini 1.5" blocked />
            </div>
          }
        />
        <PolicyCard
          label="Data egress"
          desc="Which classifications are allowed to be sent to external providers."
          value={
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span
                className="mono"
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  background: "var(--moss)",
                  color: "white",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                INTERNAL
              </span>
              <span
                className="mono"
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  background: "var(--saffron)",
                  color: "oklch(0.2 0.04 60)",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                CONFIDENTIAL
              </span>
              <span
                className="mono"
                style={{
                  padding: "3px 10px",
                  borderRadius: 4,
                  background: "oklch(from var(--madder) l c h / 0.2)",
                  color: "var(--madder)",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                RESTRICTED · blocked
              </span>
            </div>
          }
        />
        <PolicyCard
          label="Auto-approval"
          desc="Which AI actions can execute without a human in the loop."
          value={
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <PolicyPill label="Draft board · always require review" />
              <PolicyPill label="Meeting intelligence · always require review" />
              <PolicyPill label="Comments only · auto-approved" on />
              <PolicyPill label="Layout / geometry · auto-approved" on />
            </div>
          }
        />
        <PolicyCard
          label="Retention"
          desc="How long AI conversation context and audit trails are kept."
          value={
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-1)" }}>
              Prompts &amp; responses · <b>90 days</b> · Audit trail · <b>7 years</b> · Transcripts · <b>2 years</b>
            </span>
          }
        />
      </div>
    </>
  );
}

function PolicyCard({
  label,
  desc,
  value,
}: {
  label: string;
  desc: string;
  value: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "18px 20px",
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        borderRadius: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ink-0)" }}>{label}</div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={{ fontSize: 11.5, color: "var(--bloom-2)", background: "none", border: 0, cursor: "pointer" }}
        >
          Edit
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 12 }}>
        {desc}
      </div>
      {value}
    </div>
  );
}

function ProviderChip({
  name,
  model,
  allowed,
  blocked,
}: {
  name: string;
  model: string;
  allowed?: boolean;
  blocked?: boolean;
}) {
  return (
    <div
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        background: allowed ? "oklch(from var(--moss) l c h / 0.1)" : "oklch(from var(--madder) l c h / 0.08)",
        border: `1px solid ${allowed ? "oklch(from var(--moss) l c h / 0.3)" : "oklch(from var(--madder) l c h / 0.3)"}`,
        color: allowed ? "var(--moss)" : "var(--madder)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        fontWeight: 600,
        textDecoration: blocked ? "line-through" : "none",
      }}
    >
      {name} · {model}
    </div>
  );
}

function PolicyPill({ label, on }: { label: string; on?: boolean }) {
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        background: on ? "oklch(from var(--moss) l c h / 0.12)" : "oklch(from var(--paper-3) l c h / 0.7)",
        color: on ? "var(--moss)" : "var(--ink-2)",
        border: `1px solid ${on ? "oklch(from var(--moss) l c h / 0.3)" : "oklch(from var(--paper-4) l c h / 0.5)"}`,
        fontSize: 11.5,
        fontWeight: 500,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
      }}
    >
      {on && <Ico.Check style={{ width: 11, height: 11 }} />}
      {label}
    </span>
  );
}

const DEMO_AUDIT_LINES = [
  "[2026-09-20 14:38:12] alex@northbeam.co  · action.approve · decision \"Payment Service goes behind the gateway\" · provider=Anthropic model=claude-sonnet-4.5 confidence=0.94",
  "[2026-09-20 14:32:04] LUCENT_SYSTEM      · ai.extract       · decision proposed from meeting \"Checkout design review\" utterance@14:28",
  "[2026-09-20 14:12:00] alex@northbeam.co  · meeting.start    · Checkout design review · participants=3 · classification=INTERNAL",
  "[2026-09-20 11:04:33] LUCENT_SYSTEM      · integration.sync · Linear · LIN-476 status=Blocked · linked action id=a_67f",
  "[2026-09-20 09:22:41] sarah@northbeam.co · board.edit       · E-commerce platform · 3 nodes added · 2 edges",
  "[2026-09-20 09:14:00] alex@northbeam.co  · session.start    · SSO · Google · MFA=TOTP · ip=203.0.113.42",
  "[2026-09-19 18:44:12] LUCENT_SYSTEM      · retention.purge  · prompts>90d · 1,204 records",
  "[2026-09-19 16:02:08] admin@northbeam.co · policy.edit      · ai.provider blocked=Google (gemini-1.5)",
  "[2026-09-19 11:28:56] john@northbeam.co  · export.decisions · scope=\"Payment launch\" · format=JSON · size=42kb",
];

function AdminAudit({ serverAudit }: { serverAudit?: AuditEntry[] }) {
  const [filter, setFilter] = useState("all");

  const lines = (() => {
    if (serverAudit && serverAudit.length > 0) {
      return serverAudit.map((e) => {
        const time = new Date(e.at).toISOString().replace("T", " ").substring(0, 19);
        const actor = (e.actorId.length > 18 ? e.actorId.substring(0, 18) : e.actorId).padEnd(20, " ");
        const act = e.action.padEnd(16, " ");
        const subj = e.subject ? ` · ${e.subject}` : "";
        const ip = e.ip ? ` · ip=${e.ip}` : "";
        return `[${time}] ${actor} · ${act}${subj}${ip}`;
      });
    }
    return DEMO_AUDIT_LINES;
  })();

  const filtered = lines.filter((l) => {
    if (filter === "all") return true;
    if (filter === "ai") return l.includes("ai.") || l.includes("action.approve");
    if (filter === "auth") return l.includes("session.") || l.includes("SSO");
    if (filter === "perm") return l.includes("policy.") || l.includes("role");
    if (filter === "export") return l.includes("export.");
    return true;
  });

  return (
    <>
      <SectionHeader
        eyebrow="Fig. 24 · Admin · Audit"
        title="Audit log"
        meta="Every AI action, every human approval, every sync."
      />
      <FilterBar
        filters={[
          { id: "all", label: "All" },
          { id: "ai", label: "AI actions" },
          { id: "auth", label: "Auth" },
          { id: "perm", label: "Permissions" },
          { id: "export", label: "Data export" },
        ]}
        active={filter}
        onChange={setFilter}
      />
      <div
        style={{
          background: "oklch(0.14 0.014 55)",
          borderRadius: 12,
          padding: "18px 22px",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.7,
          overflowX: "auto",
        }}
      >
        {filtered.map((line, i) => (
          <div
            key={i}
            style={{
              padding: "4px 0",
              borderBottom:
                i < filtered.length - 1 ? "1px solid oklch(0.22 0.014 55)" : "none",
            }}
          >
            <span style={{ color: "oklch(0.55 0.012 60)" }}>{line.substring(0, 22)}</span>
            <span style={{ color: "oklch(0.7 0.05 60)" }}>{line.substring(22, 42)}</span>
            <span style={{ color: "oklch(0.72 0.15 300)" }}>{line.substring(42, 60)}</span>
            <span style={{ color: "oklch(0.9 0.008 82)" }}>{line.substring(60)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminBilling() {
  return (
    <>
      <SectionHeader
        eyebrow="Fig. 24 · Admin · Billing"
        title="Team plan"
        meta="$40 / member / month · 14 members"
        actions={<button type="button" className="icon-btn primary">Upgrade plan</button>}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 14,
          marginBottom: 24,
        }}
      >
        <StatCard label="AI tokens this month" value="2.4M" delta="+18%" sub="of 5M included" />
        <StatCard label="Meeting minutes" value="612" delta="+42h" sub="unlimited" />
        <StatCard label="Storage" value="18GB" sub="of 100GB" />
        <StatCard label="Members · seats" value="14 / 20" />
      </div>
      <div
        style={{
          padding: "20px 22px",
          background: "var(--paper-0)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
          borderRadius: 12,
        }}
      >
        <div className="mono-caps" style={{ marginBottom: 12 }}>
          Usage · September
        </div>
        <UsageChart />
      </div>
    </>
  );
}

function UsageChart() {
  const bars = Array.from(
    { length: 20 },
    (_, i) => 20 + Math.round(Math.abs(Math.sin(i * 0.6)) * 60) + i * 2,
  );
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
        {bars.map((h, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: `${h}%`,
              background: "linear-gradient(180deg, var(--bloom-1), var(--bloom-2))",
              borderRadius: "3px 3px 0 0",
              opacity: 0.6 + (i / bars.length) * 0.4,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 12,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: "var(--ink-3)",
        }}
      >
        <span>Sep 1</span>
        <div style={{ flex: 1 }} />
        <span>Sep 10</span>
        <div style={{ flex: 1 }} />
        <span>Sep 20 · today</span>
      </div>
    </div>
  );
}

function AdminStub({
  title,
  desc,
  kind,
  danger,
}: {
  title: string;
  desc: string;
  kind: string;
  danger?: boolean;
}) {
  return (
    <>
      <SectionHeader eyebrow={`Fig. 24 · Admin · ${title}`} title={title} meta={desc} />
      <div
        style={{
          padding: "48px 32px",
          background: "var(--paper-0)",
          border: `1px dashed ${danger ? "oklch(from var(--madder) l c h / 0.4)" : "oklch(from var(--paper-4) l c h / 0.6)"}`,
          borderRadius: 14,
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            background: danger ? "oklch(from var(--madder) l c h / 0.1)" : "var(--paper-2)",
            color: danger ? "var(--madder)" : "var(--ink-2)",
            display: "grid",
            placeItems: "center",
            margin: "0 auto 14px",
          }}
        >
          <Ico.Settings />
        </div>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 20,
            fontWeight: 500,
            color: "var(--ink-0)",
            marginBottom: 6,
          }}
        >
          {kind} configuration
        </div>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--ink-2)",
            maxWidth: 420,
            margin: "0 auto",
            lineHeight: 1.55,
          }}
        >
          This detail view is scaffolded and connects to the organization governance layer.
          SAML SSO, SCIM 2.0 provisioning, and classification policies apply to all members.
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 20 }}>
          <button type="button" className="btn-atelier ghost">
            Learn more
          </button>
          <button
            type="button"
            className={`btn-atelier ${danger ? "danger" : "primary"}`}
            style={{ flex: "none", padding: "0 18px" }}
          >
            {danger ? "Request…" : "Configure"}
          </button>
        </div>
      </div>
    </>
  );
}
