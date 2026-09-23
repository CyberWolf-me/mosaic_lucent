import { useEffect, useState } from "react";
import { apiFetch } from "../http.js";
import { Ico } from "../ui/icons.js";

/**
 * Admin console for an org (M2 + M3).
 *
 * Reads `GET /api/orgs/:id` for the membership roster, then
 * `GET /api/orgs/:id/audit` for the recent activity feed. The "this org"
 * id is the first membership on the signed-in user's account — every account
 * is guaranteed one (M2.1) — so this view never has to ask "which org".
 *
 * Two things are deliberately out of scope here: changing roles (a separate
 * `PATCH /api/boards/:id/members` form lives in `ShareDialog`), and SSO
 * settings (M6 — placeholder only). The console reads the data it owns; the
 * mutating actions stay where the user already is when they make them.
 */

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

export function AdminView({ onBack }: { onBack: () => void }) {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        // The admin console surfaces one org at a time. `orgId` comes from
        // the user's first membership — the personal org for a fresh
        // account, or whatever org they were last active in. A future
        // org-switcher adds the next move; for now the tray and the share
        // dialog both already know the org id from the same path.
        const meRes = await apiFetch("/api/auth/me");
        const meBody = (await meRes.json()) as { memberships?: Array<{ orgId: string }> };
        const memberships = meBody.memberships ?? [];
        const first = memberships[0];
        if (!first) {
          setError("You are not a member of any workspace yet.");
          return;
        }
        const orgRes = await apiFetch(`/api/orgs/${encodeURIComponent(first.orgId)}`);
        if (cancelled) return;
        if (orgRes.status !== 200) {
          setError(
            orgRes.status === 404
              ? "This workspace could not be loaded."
              : `Failed to load workspace (${orgRes.status}).`,
          );
          return;
        }
        setOrg((await orgRes.json()) as OrgSummary);
        // Audit log is owner/admin only; the route answers 403 if the caller
        // is not. The members list still works for an editor, so render
        // that first and treat the audit failure as a soft error.
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

  return (
    <div className="admin-view">
      <header className="admin-header">
        <div className="admin-head-row">
          <button className="icon-btn" onClick={onBack} aria-label="Back to canvas">
            <Ico.Left />
          </button>
          <h1>{org?.name ?? "Workspace"}</h1>
        </div>
        <div className="admin-meta">
          {org ? (
            <>
              <span>You are {roleLabel(org.role)}</span>
              <span className="dot" />
              <span>{org.members.length} members</span>
            </>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="admin-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="admin-section">
        <h2>Members</h2>
        {busy && !org ? <p className="muted">Loading…</p> : null}
        {org && org.members.length === 0 ? <p className="muted">No members yet.</p> : null}
        {org && org.members.length > 0 ? (
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {org.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name || "(no name)"}</td>
                  <td>{m.email || "—"}</td>
                  <td>
                    <span className={`role-pill role-${m.role}`}>{roleLabel(m.role)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section className="admin-section">
        <h2>Recent activity</h2>
        {audit.length === 0 ? (
          <p className="muted">
            {org ? "No activity recorded yet." : "Members-only view; activity is owner/admin."}
          </p>
        ) : (
          <ol className="audit-list">
            {audit.slice(0, 25).map((entry) => (
              <li key={entry.id} className="audit-entry">
                <span className="audit-when">{formatWhen(entry.at)}</span>
                <span className="audit-action">{entry.action}</span>
                <span className="audit-subject">
                  {entry.subject ? `→ ${entry.subject.slice(0, 24)}` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="admin-section admin-future">
        <h2>SSO / SCIM</h2>
        <p className="muted">
          Sign in with your own identity provider (SAML) and provision members automatically (SCIM)
          are available on this deployment. An owner connects them from the org&apos;s SSO settings
          — paste your IdP metadata, verify your email domain, and optionally require SSO for
          everyone. Until then, invite and manage people from the roster above.
        </p>
      </section>
    </div>
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return role;
}

function formatWhen(at: number): string {
  const delta = Date.now() - at;
  if (delta < 60_000) return "just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return new Date(at).toLocaleString();
}
