import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../http.js";
import { Ico } from "../ui/icons.js";
import { requestSettings } from "../ui/Chrome.js";
import { Avatar, Button, Card, EmptyState, FilterChips, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import { getCurrentOrgId } from "../orgs.js";
import { useWorkspace } from "../workspace.js";

/**
 * Admin console for an org (M2 + M3).
 *
 * Reads `GET /api/orgs/:id` for the membership roster, then
 * `GET /api/orgs/:id/audit` for the recent activity feed, and (owners only)
 * `GET /api/orgs/:id/sso` for whether an identity provider is connected. The
 * org is the one the rest of the app treats as active when the user is a
 * member of it, else the first membership on the account — every account is
 * guaranteed one (M2.1) — so this view never has to ask "which org".
 *
 * Two things are deliberately out of scope here: changing roles (a separate
 * `PATCH /api/boards/:id/members` form lives in `ShareDialog`), and SSO
 * setup (the owner API exists; there is no setup screen yet). The console
 * reads the data it owns; the mutating actions stay where the user already is
 * when they make them.
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

interface SsoConnection {
  id: string;
  idpEntityId: string;
  enforceSso: boolean;
  createdAt: number;
}

interface SsoClaim {
  id: string;
  domain: string;
  verifiedAt: number | null;
}

/** What the activity section can honestly say. */
type AuditState = "loading" | "ready" | "owners-only" | "error";

type SsoState =
  | { kind: "loading" }
  | { kind: "owners-only" }
  | { kind: "unconfigured" }
  | { kind: "error" }
  | { kind: "ready"; connections: SsoConnection[]; claims: SsoClaim[] };

type RoleFilter = "all" | "owner" | "editor" | "viewer";

export function AdminView({ onBack }: { onBack: () => void }) {
  const { setView } = useWorkspace();
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditState, setAuditState] = useState<AuditState>("loading");
  const [sso, setSso] = useState<SsoState>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setBusy(true);
      try {
        const meRes = await apiFetch("/api/auth/me");
        if (cancelled) return;
        if (!meRes.ok) {
          setError(
            meRes.status === 401
              ? "Sign in to see your workspace."
              : `Couldn't load your account (${meRes.status}).`,
          );
          return;
        }
        const meBody = (await meRes.json()) as { memberships?: Array<{ orgId: string }> };
        const memberships = meBody.memberships ?? [];
        // The org the rest of the app treats as active (Boards' switcher sets
        // it), when the user still belongs to it; otherwise the first
        // membership — the personal org for a fresh account.
        const active = getCurrentOrgId();
        const chosen = memberships.find((m) => m.orgId === active) ?? memberships[0];
        if (!chosen) {
          setError("You are not a member of any workspace yet.");
          return;
        }
        const orgRes = await apiFetch(`/api/orgs/${encodeURIComponent(chosen.orgId)}`);
        if (cancelled) return;
        if (orgRes.status !== 200) {
          setError(
            orgRes.status === 404
              ? "This workspace could not be loaded."
              : `Failed to load workspace (${orgRes.status}).`,
          );
          return;
        }
        const detail = (await orgRes.json()) as OrgSummary;
        if (cancelled) return;
        setOrg(detail);
        // Audit log and SSO are owner-only; the routes answer 403/404 to
        // anyone else. The members list still works for an editor, so render
        // that first and say plainly what a non-owner can't see.
        if (detail.role !== "owner") {
          setAuditState("owners-only");
          setSso({ kind: "owners-only" });
          return;
        }
        const orgPath = `/api/orgs/${encodeURIComponent(chosen.orgId)}`;
        const [auditRes, ssoRes] = await Promise.all([
          apiFetch(`${orgPath}/audit`).catch(() => null),
          apiFetch(`${orgPath}/sso`).catch(() => null),
        ]);
        if (cancelled) return;
        if (auditRes && auditRes.status === 200) {
          setAudit(((await auditRes.json()) as { entries?: AuditEntry[] }).entries ?? []);
          setAuditState("ready");
        } else {
          setAuditState(auditRes && auditRes.status === 403 ? "owners-only" : "error");
        }
        if (ssoRes && ssoRes.status === 200) {
          const body = (await ssoRes.json()) as {
            connections?: SsoConnection[];
            claims?: SsoClaim[];
          };
          if (!cancelled) {
            setSso({
              kind: "ready",
              connections: body.connections ?? [],
              claims: body.claims ?? [],
            });
          }
        } else if (!cancelled) {
          setSso({ kind: ssoRes && ssoRes.status === 503 ? "unconfigured" : "error" });
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

  const roleCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of org?.members ?? []) c[m.role] = (c[m.role] ?? 0) + 1;
    return c;
  }, [org]);

  const members = useMemo(
    () =>
      (org?.members ?? []).filter((m) => roleFilter === "all" || m.role === roleFilter),
    [org, roleFilter],
  );

  const nameOf = useMemo(() => {
    const byId = new Map((org?.members ?? []).map((m) => [m.userId, m.name || m.email]));
    return (id: string) => byId.get(id) ?? null;
  }, [org]);

  const roleItems = (["owner", "editor", "viewer"] as const)
    .filter((r) => (roleCounts[r] ?? 0) > 0)
    .map((r) => ({ id: r, label: `${roleLabel(r)}s`, count: roleCounts[r] ?? 0 }));

  const memberCount = org?.members.length ?? 0;

  return (
    <Page
      crumbs={[{ label: "Workspace admin", current: true }]}
      boardScoped={false}
      onOpenSettings={requestSettings}
      width="default"
    >
      <PageHeader
        eyebrow={org ? `Admin · ${org.name}` : "Admin"}
        title={org ? org.name : busy ? "Loading workspace…" : "Workspace"}
        lede={
          org
            ? `${youAre(org.role)} · ${memberCount} member${memberCount === 1 ? "" : "s"} · created ${formatDate(org.createdAt)}`
            : undefined
        }
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              <Ico.Left /> Back to canvas
            </Button>
            {org?.role === "owner" && (
              <Button variant="ghost" onClick={() => setView("analytics")}>
                <Ico.Gauge /> Usage
              </Button>
            )}
          </>
        }
      />

      {error ? (
        <div className="boards-admin-error" role="alert">
          {error}
        </div>
      ) : null}

      <SectionLabel count={org ? memberCount : undefined}>Members</SectionLabel>
      {busy && !org ? (
        <p className="boards-admin-muted" role="status">
          Loading members…
        </p>
      ) : null}
      {org && memberCount === 0 ? (
        <EmptyState compact title="No members yet" />
      ) : null}
      {org && memberCount > 0 ? (
        <>
          {roleItems.length > 1 && (
            <div className="boards-admin-filters">
              <FilterChips
                items={[{ id: "all" as RoleFilter, label: "All", count: memberCount }, ...roleItems]}
                value={roleFilter}
                onChange={setRoleFilter}
                label="Filter members by role"
              />
            </div>
          )}
          <Card className="boards-admin-card">
            <table className="boards-admin-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <span className="boards-admin-person">
                        <Avatar name={m.name || m.email || "?"} size={28} />
                        <span>{m.name || "(no name)"}</span>
                      </span>
                    </td>
                    <td className="mono boards-admin-email">{m.email || "—"}</td>
                    <td>
                      <span className={`boards-role ${m.role}`}>{roleLabel(m.role)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="boards-admin-hint">
            These are workspace roles. Access to a single board, and the roles on it, is managed
            from that board&apos;s Share dialog.
          </p>
        </>
      ) : null}

      <SectionLabel count={auditState === "ready" ? audit.length : undefined}>
        Recent activity
      </SectionLabel>
      {org && auditState === "loading" && (
        <p className="boards-admin-muted" role="status">
          Loading activity…
        </p>
      )}
      {auditState === "owners-only" && (
        <EmptyState compact title="The activity log is visible to workspace owners" />
      )}
      {auditState === "error" && (
        <p className="boards-admin-muted" role="alert">
          Couldn&apos;t load the activity log.
        </p>
      )}
      {auditState === "ready" &&
        (audit.length === 0 ? (
          <EmptyState
            compact
            title="No activity recorded yet"
            body="Workspace changes — renames and settings, deleted boards, billing, SSO and agent edits — are logged here as they happen."
          />
        ) : (
          <Card className="boards-admin-card">
            <ol className="boards-audit">
              {audit.slice(0, 25).map((entry) => {
                const actor = nameOf(entry.actorId);
                return (
                  <li key={entry.id} className="boards-audit-row">
                    <time
                      className="boards-audit-when mono"
                      dateTime={new Date(entry.at).toISOString()}
                      title={new Date(entry.at).toLocaleString()}
                    >
                      {formatWhen(entry.at)}
                    </time>
                    <span className="boards-audit-actor">
                      {actor ? (
                        <>
                          <Avatar name={actor} size={20} />
                          {actor}
                        </>
                      ) : (
                        <span className="mono" title={entry.actorId}>
                          {entry.actorId.slice(0, 14)}
                        </span>
                      )}
                    </span>
                    <span className="boards-audit-action mono">{entry.action}</span>
                    <span className="boards-audit-subject mono" title={entry.subject ?? undefined}>
                      {entry.subject ? `→ ${entry.subject.slice(0, 24)}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Card>
        ))}

      <SectionLabel>Single sign-on</SectionLabel>
      <SsoSection state={sso} hasOrg={org !== null} />
    </Page>
  );
}

function SsoSection({ state, hasOrg }: { state: SsoState; hasOrg: boolean }) {
  if (!hasOrg) return null;
  if (state.kind === "loading") {
    return (
      <p className="boards-admin-muted" role="status">
        Checking SSO…
      </p>
    );
  }
  if (state.kind === "owners-only") {
    return <EmptyState compact title="SSO settings are visible to workspace owners" />;
  }
  if (state.kind === "unconfigured") {
    return (
      <EmptyState
        compact
        title="SAML single sign-on isn't enabled on this server"
        body="Whoever runs this Lucent deployment can turn it on; until then, members sign in with their own accounts."
      />
    );
  }
  if (state.kind === "error") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load the SSO status.
      </p>
    );
  }
  const { connections, claims } = state;
  return (
    <Card className="boards-admin-card boards-sso">
      {connections.length === 0 ? (
        <div className="boards-sso-row">
          <span className="boards-sso-status off">Not connected</span>
          <span className="boards-admin-muted">
            No identity provider is connected. An owner connects one through the workspace SSO API
            (IdP metadata, a verified email domain, and optionally requiring SSO for everyone);
            there&apos;s no setup screen in the app yet.
          </span>
        </div>
      ) : (
        connections.map((c) => (
          <div key={c.id} className="boards-sso-row">
            <span className="boards-sso-status on">Connected</span>
            <span className="mono boards-sso-entity" title={c.idpEntityId}>
              {c.idpEntityId}
            </span>
            <span className="boards-admin-muted">
              {c.enforceSso ? "SSO required for everyone" : "SSO optional"} · since{" "}
              {formatDate(c.createdAt)}
            </span>
          </div>
        ))
      )}
      {claims.length > 0 && (
        <div className="boards-sso-claims">
          <span className="mono-caps">Email domains</span>
          {claims.map((d) => (
            <span key={d.id} className="boards-sso-domain">
              <span className="mono">{d.domain}</span>
              <span className={`boards-sso-status ${d.verifiedAt ? "on" : "off"}`}>
                {d.verifiedAt ? "Verified" : "Awaiting DNS"}
              </span>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return role;
}

function youAre(role: string): string {
  if (role === "owner") return "You own this workspace";
  const word = roleLabel(role).toLowerCase();
  return `You are ${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWhen(at: number): string {
  const delta = Date.now() - at;
  if (delta < 60_000) return "just now";
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return new Date(at).toLocaleString();
}
