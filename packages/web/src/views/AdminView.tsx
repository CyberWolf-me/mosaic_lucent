import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../http.js";
import { Ico } from "../ui/icons.js";
import { requestSettings } from "../ui/Chrome.js";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  FilterChips,
  Page,
  PageHeader,
  SectionLabel,
} from "../ui/kit.js";
import { loadOrgRuns, type AiRunView } from "../review.js";
import {
  AUTOMATION_COPY,
  AUTOMATION_RULES,
  loadAutomation,
  setAutomationRule,
  type AutomationRule,
  type AutomationSettings,
} from "../automation.js";
import {
  PROVIDER_FORMS,
  STATE_WORD,
  checkIntegration,
  connectIntegration,
  disconnectIntegration,
  loadIntegrations,
  providerLabel,
  startOAuth,
  takeOAuthReturn,
  type AvailableProvider,
  type ConnectionView,
} from "../integrationsAdmin.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeams,
  removeTeamMember,
  type TeamView,
} from "../teams.js";
import { deleteForGood, loadTrash, restoreFromTrash, type TrashEntry } from "../trash.js";
import {
  listOrgTokens,
  loadRequireTwoFactor,
  revokeOrgToken,
  scopeLabel,
  setApiTokensDisabled,
  setRequireTwoFactor,
  type ApiTokenView,
} from "../security.js";
import {
  getCurrentOrgId,
  listOrgGuests,
  removeOrgGuest,
  removeOrgMember,
  setOrgMemberRole,
  type OrgGuest,
} from "../orgs.js";
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
  /** Owners see whether each member has two-step verification on (docs/26 A6). */
  twoFactor?: boolean;
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
  const [meId, setMeId] = useState<string | null>(null);
  /** The member a Remove/Leave is waiting to be confirmed for. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

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
        const meBody = (await meRes.json()) as {
          user?: { id: string };
          memberships?: Array<{ orgId: string }>;
        };
        setMeId(meBody.user?.id ?? null);
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
    () => (org?.members ?? []).filter((m) => roleFilter === "all" || m.role === roleFilter),
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
  const personal = org?.id.startsWith("org_personal_") ?? false;

  // docs/26 A6: an owner changes roles and removes people; anyone can leave.
  const changeRole = async (userId: string, role: "owner" | "editor" | "viewer") => {
    if (!org) return;
    setMemberBusy(userId);
    setMemberError(null);
    const result = await setOrgMemberRole(org.id, userId, role);
    setMemberBusy(null);
    if (!result.ok) return setMemberError(result.error);
    setOrg({ ...org, members: org.members.map((m) => (m.userId === userId ? { ...m, role } : m)) });
  };
  const remove = async (userId: string) => {
    if (!org) return;
    setMemberBusy(userId);
    setMemberError(null);
    const result = await removeOrgMember(org.id, userId);
    setMemberBusy(null);
    setConfirming(null);
    if (!result.ok) return setMemberError(result.error);
    if (userId === meId) {
      // Left: this workspace is no longer yours to look at.
      window.location.assign("/?view=home");
      return;
    }
    setOrg({ ...org, members: org.members.filter((m) => m.userId !== userId) });
  };

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
      {org && memberCount === 0 ? <EmptyState compact title="No members yet" /> : null}
      {org && memberCount > 0 ? (
        <>
          {roleItems.length > 1 && (
            <div className="boards-admin-filters">
              <FilterChips
                items={[
                  { id: "all" as RoleFilter, label: "All", count: memberCount },
                  ...roleItems,
                ]}
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
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>
                      <span className="boards-admin-person">
                        <Avatar name={m.name || m.email || "?"} size={28} />
                        <span>{m.name || "(no name)"}</span>
                        {m.twoFactor !== undefined && (
                          <span
                            className={`admin-2fa ${m.twoFactor ? "on" : "off"}`}
                            title={
                              m.twoFactor
                                ? "Two-step verification is on"
                                : "Two-step verification is off"
                            }
                          >
                            {m.twoFactor ? "2FA" : "No 2FA"}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="mono boards-admin-email">{m.email || "—"}</td>
                    <td>
                      {org.role === "owner" &&
                      m.userId !== meId &&
                      !(personal && m.role === "owner") ? (
                        <select
                          className="boards-admin-role-select"
                          aria-label={`Role for ${m.name || m.email}`}
                          value={m.role}
                          disabled={memberBusy !== null}
                          onChange={(e) =>
                            void changeRole(
                              m.userId,
                              e.target.value as "owner" | "editor" | "viewer",
                            )
                          }
                        >
                          <option value="owner">Owner</option>
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      ) : (
                        <span className={`boards-role ${m.role}`}>{roleLabel(m.role)}</span>
                      )}
                    </td>
                    <td className="boards-admin-actions">
                      {(org.role === "owner" || m.userId === meId) &&
                        !(personal && m.role === "owner") &&
                        (confirming === m.userId ? (
                          <>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={memberBusy !== null}
                              onClick={() => void remove(m.userId)}
                            >
                              {m.userId === meId
                                ? "Leave the workspace"
                                : `Remove ${m.name || m.email}`}
                            </Button>
                            <Button size="sm" onClick={() => setConfirming(null)}>
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            disabled={memberBusy !== null}
                            onClick={() => {
                              setMemberError(null);
                              setConfirming(m.userId);
                            }}
                          >
                            {m.userId === meId ? "Leave" : "Remove"}
                          </Button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {memberError && (
            <p className="boards-admin-error" role="alert">
              {memberError}
            </p>
          )}
          <p className="boards-admin-hint">
            Removing someone ends their access to every board here, straight away. These are
            workspace roles. Access to a single board, and the roles on it, is managed from that
            board&apos;s Share dialog.
          </p>
        </>
      ) : null}

      <SectionLabel>Security</SectionLabel>
      <SecuritySection org={org} />

      <SectionLabel>Teams</SectionLabel>
      <TeamsSection org={org} />

      <SectionLabel>Guests</SectionLabel>
      <GuestsSection org={org} />

      <SectionLabel>Trash</SectionLabel>
      <TrashSection org={org} />

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

      <SectionLabel>AI activity</SectionLabel>
      <AiActivitySection org={org} />

      <SectionLabel>Integrations</SectionLabel>
      <IntegrationsSection org={org} />

      <SectionLabel>Automation</SectionLabel>
      <AutomationSection org={org} />

      <SectionLabel>Single sign-on</SectionLabel>
      <SsoSection state={sso} hasOrg={org !== null} />
    </Page>
  );
}

const SURFACE_WORD: Record<string, string> = {
  canvas: "Canvas request",
  meeting: "Meeting extraction",
  voice: "Voice",
  mcp: "MCP agent",
  ask: "Ask",
  notes: "Meeting notes",
  recap: "Meeting summary",
};

/**
 * Every AI run in the workspace (docs/26 J6, ADR 0047): which model, on
 * which board, who started it, what it became and who approved it. Owners
 * only, like the activity log.
 */
function AiActivitySection({ org }: { org: OrgSummary | null }) {
  const [runs, setRuns] = useState<AiRunView[] | null | "failed">(null);
  useEffect(() => {
    if (!org || org.role !== "owner") return;
    void loadOrgRuns(org.id).then((r) => setRuns(r ?? "failed"));
  }, [org]);
  if (!org) return null;
  if (org.role !== "owner") {
    return <EmptyState compact title="AI activity is visible to workspace owners" />;
  }
  if (runs === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading AI activity…
      </p>
    );
  }
  if (runs === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load AI activity.
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        compact
        title="No AI runs yet"
        body="Every time Lucent's model builds, answers, summarizes, or an agent writes on a board, it is recorded here — with the model, who asked, and who approved what it produced."
      />
    );
  }
  return (
    <Card className="boards-admin-card">
      <ol className="boards-audit" aria-label="AI runs">
        {runs.slice(0, 50).map((run) => {
          const outcome =
            run.opCount === 0
              ? "answer"
              : run.opSeqs.length > 0
                ? `${run.opCount} ${run.opCount === 1 ? "change" : "changes"} · ${
                    run.approvedByName ? `approved by ${run.approvedByName}` : "applied, no review"
                  }`
                : run.proposalId
                  ? `${run.opCount} proposed`
                  : `${run.opCount} not applied`;
          return (
            <li key={run.id} className="boards-audit-row">
              <time
                className="boards-audit-when mono"
                dateTime={new Date(run.createdAt).toISOString()}
                title={new Date(run.createdAt).toLocaleString()}
              >
                {formatWhen(run.createdAt)}
              </time>
              <span className="boards-audit-actor">
                {run.initiatedByName ? (
                  <>
                    <Avatar name={run.initiatedByName} size={20} />
                    {run.initiatedByName}
                  </>
                ) : (
                  "Lucent"
                )}
              </span>
              <span
                className="boards-audit-action mono"
                title={`${run.provider} · ${run.model ?? "model not reported"}`}
              >
                {SURFACE_WORD[run.surface] ?? run.surface} · {run.model ?? run.provider}
              </span>
              <span className="boards-audit-subject mono" title={run.boardName ?? undefined}>
                {run.boardName ? `${run.boardName.slice(0, 20)} · ` : ""}
                {outcome}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/**
 * Teams (docs/26 A6): groups of the workspace's members that boards can be
 * shared with. Owners create them and choose their members; a team your
 * identity provider manages is shown, and changed there.
 */
/**
 * Requiring two-step verification (docs/26 A6). Members and guests without
 * it are kept out of the workspace — not signed out — until they turn it on;
 * the switch says how many that is before it's flipped.
 */
function SecuritySection({ org }: { org: OrgSummary | null }) {
  const [required, setRequired] = useState<boolean | null | "failed">(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!org || org.role !== "owner") return;
    void loadRequireTwoFactor(org.id).then((r) => setRequired(r ?? "failed"));
  }, [org]);
  if (!org) return null;
  if (org.role !== "owner") {
    return <EmptyState compact title="Security is set by workspace owners" />;
  }
  if (required === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading security…
      </p>
    );
  }
  if (required === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load security settings.
      </p>
    );
  }
  const without = org.members.filter((m) => m.twoFactor === false);
  const toggle = async (on: boolean) => {
    setRequired(on);
    setSaving(true);
    setError(null);
    const r = await setRequireTwoFactor(org.id, on);
    setSaving(false);
    if (!r.ok) {
      setRequired(!on);
      setError(r.error);
    }
  };
  return (
    <Card className="boards-admin-card">
      <label className="automation-rule">
        <input
          type="checkbox"
          checked={required}
          disabled={saving}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>
          <span className="automation-rule-title">Require two-step verification</span>
          <span className="automation-rule-body">
            Anyone without it — members and guests — can&apos;t open this workspace&apos;s boards
            until they turn it on in Settings → Security. They stay signed in, and keep their other
            workspaces.
            {without.length > 0
              ? ` ${without.length} of ${org.members.length} member${org.members.length === 1 ? "" : "s"} ${without.length === 1 ? "doesn't" : "don't"} have it yet${required ? ", and can't get in" : ""}: ${without
                  .map((m) => m.name || m.email)
                  .join(", ")}.`
              : " Every member has it on."}
          </span>
        </span>
      </label>
      {error && (
        <p className="boards-admin-error" role="alert">
          {error}
        </p>
      )}
      <ApiTokensAdmin orgId={org.id} />
    </Card>
  );
}

/**
 * The API tokens that reach the workspace (docs/26 A6): whose, what they can
 * do, when last used — and the switch that stops every one of them at once.
 */
function ApiTokensAdmin({ orgId }: { orgId: string }) {
  const [state, setState] = useState<{ tokens: ApiTokenView[]; disabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => setState(await listOrgTokens(orgId));
  useEffect(() => {
    void listOrgTokens(orgId).then(setState);
  }, [orgId]);
  if (!state) return null;
  const allow = async (on: boolean) => {
    setState({ ...state, disabled: !on });
    setError(null);
    const r = await setApiTokensDisabled(orgId, !on);
    if (!r.ok) {
      setState({ ...state, disabled: on });
      setError(r.error);
    }
  };
  const revoke = async (id: string) => {
    const r = await revokeOrgToken(orgId, id);
    if (!r.ok) setError(r.error);
    await refresh();
  };
  return (
    <div className="admin-tokens">
      <label className="automation-rule">
        <input
          type="checkbox"
          checked={!state.disabled}
          onChange={(e) => void allow(e.target.checked)}
        />
        <span>
          <span className="automation-rule-title">Allow API tokens</span>
          <span className="automation-rule-body">
            Members can make tokens for scripts and agents that act as them here — reading, or
            editing at most; never sharing, settings or members. Turning this off stops every token
            at once.
          </span>
        </span>
      </label>
      {state.tokens.length > 0 && (
        <ul className="admin-token-list" aria-label="API tokens for this workspace">
          {state.tokens.map((t) => (
            <li key={t.id}>
              <span className="admin-token-who">
                <span className="admin-token-name">{t.name}</span>
                <span className="boards-admin-muted">
                  {[
                    t.userName,
                    scopeLabel(t.scopes),
                    t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : "never used",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <Button size="sm" onClick={() => void revoke(t.id)} aria-label={`Revoke ${t.name}`}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="boards-admin-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TeamsSection({ org }: { org: OrgSummary | null }) {
  const [teams, setTeams] = useState<TeamView[] | null | "failed">(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const reload = async (orgId: string) => setTeams((await listTeams(orgId)) ?? "failed");
  useEffect(() => {
    if (org) void reload(org.id);
  }, [org]);
  if (!org) return null;
  if (teams === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading teams…
      </p>
    );
  }
  if (teams === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load teams.
      </p>
    );
  }
  const owner = org.role === "owner";
  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    if (!result.ok) setError(result.error ?? "That didn't work.");
    await reload(org.id);
    return result.ok;
  };
  return (
    <Card className="boards-admin-card">
      {teams.length === 0 && (
        <p className="boards-admin-muted">
          No teams yet. A team is a group of members a board can be shared with — the design team
          edits the design boards.
        </p>
      )}
      <ul className="team-list" aria-label="Teams">
        {teams.map((team) => {
          const outside = org.members.filter(
            (m) => !team.members.some((t) => t.userId === m.userId),
          );
          return (
            <li key={team.id} className="team-row">
              <div className="team-head">
                <span className="team-name">{team.name}</span>
                {team.managed && (
                  <span className="team-managed">Managed by your identity provider</span>
                )}
                <span className="team-count">
                  {team.members.length} {team.members.length === 1 ? "member" : "members"}
                </span>
                {owner &&
                  !team.managed &&
                  (confirming === team.id ? (
                    <span className="team-actions">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busy}
                        onClick={() => void run(() => deleteTeam(org.id, team.id))}
                      >
                        Delete {team.name}
                      </Button>
                      <Button size="sm" onClick={() => setConfirming(null)}>
                        Keep
                      </Button>
                    </span>
                  ) : (
                    <span className="team-actions">
                      <Button size="sm" disabled={busy} onClick={() => setConfirming(team.id)}>
                        Delete
                      </Button>
                    </span>
                  ))}
              </div>
              <div className="team-members">
                {team.members.map((m) => (
                  <span key={m.userId} className="team-member">
                    {m.name || m.email}
                    {owner && !team.managed && (
                      <button
                        type="button"
                        aria-label={`Remove ${m.name || m.email} from ${team.name}`}
                        disabled={busy}
                        onClick={() => void run(() => removeTeamMember(org.id, team.id, m.userId))}
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {owner && !team.managed && outside.length > 0 && (
                  <select
                    className="boards-admin-role-select"
                    aria-label={`Add someone to ${team.name}`}
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const userId = e.target.value;
                      if (userId) void run(() => addTeamMember(org.id, team.id, userId));
                    }}
                  >
                    <option value="">Add someone…</option>
                    {outside.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name || m.email}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {owner && (
        <form
          className="team-new"
          aria-label="New team"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            void run(() => createTeam(org.id, trimmed)).then((ok) => {
              if (ok) setName("");
            });
          }}
        >
          <input
            value={name}
            placeholder="New team — e.g. Design"
            aria-label="Team name"
            onChange={(e) => setName(e.target.value)}
          />
          <Button size="sm" variant="primary" type="submit" disabled={busy || !name.trim()}>
            Create team
          </Button>
        </form>
      )}
      {error && (
        <p className="boards-admin-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * The trash (docs/26 A6): what was deleted here in the last 30 days that you
 * can bring back — boards you own (every board, for an owner), meetings on
 * boards you edit, projects. An owner can also delete for good.
 */
function TrashSection({ org }: { org: OrgSummary | null }) {
  const [items, setItems] = useState<TrashEntry[] | null | "failed">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const reload = async (orgId: string) => setItems((await loadTrash(orgId)) ?? "failed");
  useEffect(() => {
    if (org) void reload(org.id);
  }, [org]);
  if (!org) return null;
  if (items === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading the trash…
      </p>
    );
  }
  if (items === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load the trash.
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        title="The trash is empty"
        body="A deleted board, meeting or project waits here for 30 days before it's gone for good."
      />
    );
  }
  const act = async (item: TrashEntry, restore: boolean) => {
    setBusy(item.id);
    const result = restore
      ? await restoreFromTrash(org.id, item.kind, item.id)
      : await deleteForGood(org.id, item.kind, item.id);
    setBusy(null);
    setNote(
      result.ok
        ? {
            text: restore ? `Restored “${item.name}”.` : `Deleted “${item.name}” for good.`,
            tone: "ok",
          }
        : { text: result.error, tone: "error" },
    );
    await reload(org.id);
  };
  const days = (at: number) => Math.max(0, Math.ceil((at - Date.now()) / 86_400_000));
  return (
    <Card className="boards-admin-card">
      <ul className="trash-list" aria-label="Trash">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="trash-row">
            <span className="trash-kind mono-caps">{item.kind}</span>
            <span className="trash-name">
              {item.name}
              {item.boardName && <span className="trash-where"> · on {item.boardName}</span>}
            </span>
            <span className="trash-when">
              deleted by {item.deletedBy} · gone in {days(item.purgeAt)} days
            </span>
            <span className="trash-actions">
              <Button size="sm" disabled={busy !== null} onClick={() => void act(item, true)}>
                Restore
              </Button>
              {org.role === "owner" && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => void act(item, false)}
                >
                  Delete for good
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {note && (
        <p
          className={`integ-notice ${note.tone}`}
          role={note.tone === "error" ? "alert" : "status"}
        >
          {note.text}
        </p>
      )}
    </Card>
  );
}

/**
 * People outside the workspace with some of its boards (docs/26 A6) — who
 * they are, which boards, and a way to end all of it at once. Owners only.
 */
function GuestsSection({ org }: { org: OrgSummary | null }) {
  const [guests, setGuests] = useState<OrgGuest[] | null | "failed">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!org || org.role !== "owner") return;
    void listOrgGuests(org.id).then((g) => setGuests(g ?? "failed"));
  }, [org]);
  if (!org) return null;
  if (org.role !== "owner") {
    return <EmptyState compact title="Guests are visible to workspace owners" />;
  }
  if (guests === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading guests…
      </p>
    );
  }
  if (guests === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load guests.
      </p>
    );
  }
  if (guests.length === 0) {
    return (
      <EmptyState
        compact
        title="No guests"
        body="People outside the workspace you share a board with appear here, with every board they can open."
      />
    );
  }
  const end = async (userId: string) => {
    setBusy(userId);
    setError(null);
    const result = await removeOrgGuest(org.id, userId);
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setGuests(guests.filter((g) => g.userId !== userId));
  };
  return (
    <Card className="boards-admin-card">
      <ul className="guest-list" aria-label="Guests">
        {guests.map((g) => (
          <li key={g.userId} className="guest-row">
            <span className="boards-admin-person">
              <Avatar name={g.name || g.email || "?"} size={24} />
              <span>
                <span className="guest-name">{g.name}</span>
                <span className="guest-email mono">{g.email}</span>
              </span>
            </span>
            <span className="guest-boards">
              {g.boards.map((b) => `${b.name} (${roleLabel(b.role).toLowerCase()})`).join(" · ")}
            </span>
            <Button size="sm" disabled={busy !== null} onClick={() => void end(g.userId)}>
              End access
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="boards-admin-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * The org's connections to Linear, Jira and GitHub (docs/26 A5): connect,
 * check, edit and disconnect each, and see how it has been answering —
 * Connected, Failing, Needs a new key, Disconnected. Owners only.
 */
function IntegrationsSection({ org }: { org: OrgSummary | null }) {
  const [data, setData] = useState<
    { connections: ConnectionView[]; available: AvailableProvider[] } | null | "failed"
  >(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    provider: string;
    text: string;
    tone: "ok" | "error";
  } | null>(null);
  const reload = async (orgId: string) => {
    const next = await loadIntegrations(orgId);
    setData(next ?? "failed");
  };
  useEffect(() => {
    if (!org || org.role !== "owner") return;
    void reload(org.id);
  }, [org]);
  // Back from a provider's sign-in page (docs/26 A5): say how it went.
  useEffect(() => {
    const back = takeOAuthReturn();
    if (!back) return;
    setNotice({
      provider: back.provider,
      text: back.connected
        ? `${providerLabel(back.provider)} is connected.`
        : (back.reason ?? `${providerLabel(back.provider)} wasn't connected.`),
      tone: back.connected ? "ok" : "error",
    });
  }, []);
  if (!org) return null;
  if (org.role !== "owner") {
    return <EmptyState compact title="Integrations are set up by workspace owners" />;
  }
  if (data === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading integrations…
      </p>
    );
  }
  if (data === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load integrations.
      </p>
    );
  }
  const providers = [
    ...data.available.map((a) => a.provider),
    ...data.connections
      .map((c) => c.provider)
      .filter((p) => !data.available.some((a) => a.provider === p)),
  ];
  if (providers.length === 0) {
    return (
      <EmptyState
        compact
        title="No integrations on this server"
        body="Linear, Jira and GitHub become available when the server is configured for them."
      />
    );
  }
  const check = async (provider: string) => {
    setBusy(provider);
    const result = await checkIntegration(org.id, provider);
    setBusy(null);
    setNotice(
      result.ok
        ? result.checked
          ? { provider, text: "It answered — the connection works.", tone: "ok" }
          : { provider, text: result.detail ?? "It didn't answer.", tone: "error" }
        : { provider, text: result.error, tone: "error" },
    );
    await reload(org.id);
  };
  const disconnect = async (provider: string) => {
    setBusy(provider);
    const ok = await disconnectIntegration(org.id, provider);
    setBusy(null);
    setNotice(
      ok
        ? {
            provider,
            text: "Disconnected. Links stay; nothing syncs until you reconnect.",
            tone: "ok",
          }
        : { provider, text: "Couldn't disconnect it.", tone: "error" },
    );
    await reload(org.id);
  };
  return (
    <Card className="boards-admin-card">
      <ul className="integ-list" aria-label="Integrations">
        {providers.map((provider) => {
          const c = data.connections.find((x) => x.provider === provider);
          return (
            <li key={provider} className="integ-row">
              <div className="integ-head">
                <span className="integ-name">{providerLabel(provider)}</span>
                <span className={`integ-state ${c ? c.state : "none"}`}>
                  {c ? STATE_WORD[c.state] : "Not connected"}
                </span>
                <span className="integ-actions">
                  {c && c.state !== "revoked" && (
                    <Button size="sm" disabled={busy !== null} onClick={() => void check(provider)}>
                      Check
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={c ? "ghost" : "primary"}
                    disabled={busy !== null}
                    onClick={() => {
                      setNotice(null);
                      setEditing(editing === provider ? null : provider);
                    }}
                  >
                    {!c ? "Connect" : c.state === "revoked" ? "Reconnect" : "Edit"}
                  </Button>
                  {c && c.state !== "revoked" && (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void disconnect(provider)}
                    >
                      Disconnect
                    </Button>
                  )}
                </span>
              </div>
              {c && <div className="integ-detail">{healthLine(c)}</div>}
              {notice?.provider === provider && (
                <p
                  className={`integ-notice ${notice.tone}`}
                  role={notice.tone === "error" ? "alert" : "status"}
                >
                  {notice.text}
                </p>
              )}
              {editing === provider && (
                <ConnectForm
                  provider={provider}
                  oauth={data.available.some((a) => a.provider === provider && a.oauth)}
                  connection={c}
                  onCancel={() => setEditing(null)}
                  onSaved={async (text, tone) => {
                    setEditing(null);
                    setNotice({ provider, text, tone });
                    await reload(org.id);
                  }}
                  orgId={org.id}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** What the state rests on, in a sentence. */
function healthLine(c: ConnectionView): string {
  const h = c.health;
  switch (c.state) {
    case "revoked":
      return "Disconnected. Existing links stay; reconnect to sync again.";
    case "needs-reauth":
      return `The key was refused or isn't set on the server${h?.lastError ? ` (${h.lastError})` : ""}. Save a new one.`;
    case "degraded":
      return `${h?.failures ?? 1} failed ${h?.failures === 1 ? "call" : "calls"}${
        h?.lastOkAt ? ` since it last answered ${formatWhen(h.lastOkAt)}` : ""
      }${h?.lastError ? ` — ${h.lastError}` : ""}.`;
    default:
      return h?.lastOkAt ? `Last answered ${formatWhen(h.lastOkAt)}.` : "Not used yet.";
  }
}

function ConnectForm({
  orgId,
  provider,
  oauth,
  connection,
  onCancel,
  onSaved,
}: {
  orgId: string;
  provider: string;
  /** The server can connect it with OAuth: the key variable is optional. */
  oauth: boolean;
  connection: ConnectionView | undefined;
  onCancel: () => void;
  onSaved: (text: string, tone: "ok" | "error") => Promise<void>;
}) {
  const form = PROVIDER_FORMS[provider] ?? { label: provider, credential: "the key", fields: [] };
  const [credentialRef, setCredentialRef] = useState("");
  const [config, setConfig] = useState<Record<string, string>>(connection?.config ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missingFields = form.fields
    .filter((f) => f.required && !config[f.key]?.trim())
    .map((f) => f.label);
  const missing = [...(credentialRef.trim() ? [] : ["the key's variable"]), ...missingFields];
  const signIn = async () => {
    if (missingFields.length > 0) {
      setError(`Fill in ${missingFields.join(", ")}.`);
      return;
    }
    setSaving(true);
    setError(null);
    const clean = Object.fromEntries(
      Object.entries(config)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v !== ""),
    );
    const started = await startOAuth(orgId, provider, clean);
    if ("url" in started) {
      window.location.assign(started.url);
      return;
    }
    setSaving(false);
    setError(started.error);
  };
  const submit = async () => {
    if (missing.length > 0) {
      setError(`Fill in ${missing.join(", ")}.`);
      return;
    }
    setSaving(true);
    setError(null);
    const clean = Object.fromEntries(
      Object.entries(config)
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([, v]) => v !== ""),
    );
    const result = await connectIntegration(orgId, provider, { credentialRef, config: clean });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await onSaved(
      result.checked
        ? `${form.label} is connected — it answered.`
        : `Saved, but ${form.label} didn't answer: ${result.detail ?? "no reply"}.`,
      result.checked ? "ok" : "error",
    );
  };
  const keyField = (
    <label className="integ-field">
      <span>Key variable</span>
      <input
        className="mono"
        value={credentialRef}
        placeholder={`${provider.toUpperCase()}_API_KEY`}
        onChange={(e) => {
          setCredentialRef(e.target.value);
          setError(null);
        }}
      />
      <small>
        The name of an environment variable on the Lucent server that holds {form.credential}. The
        key itself never passes through your browser
        {connection ? ` — enter it again to save changes (now ${connection.credentialRef})` : ""}.
      </small>
    </label>
  );
  const settings = form.fields.map((f) => (
    <label key={f.key} className="integ-field">
      <span>
        {f.label}
        {f.required ? "" : " (optional)"}
      </span>
      <input
        value={config[f.key] ?? ""}
        placeholder={f.placeholder}
        onChange={(e) => {
          setConfig({ ...config, [f.key]: e.target.value });
          setError(null);
        }}
      />
    </label>
  ));
  return (
    <form
      className="integ-form"
      aria-label={`Connect ${form.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {oauth ? (
        <>
          {settings}
          <div className="integ-oauth">
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void signIn()}>
              Connect with {form.label}
            </Button>
            <small>You&apos;ll approve Lucent in {form.label} and come back here connected.</small>
          </div>
          <div className="integ-or mono-caps">or use a key on the server</div>
          {keyField}
        </>
      ) : (
        <>
          {keyField}
          {settings}
        </>
      )}
      {error && (
        <p className="integ-notice error" role="alert">
          {error}
        </p>
      )}
      <div className="integ-form-actions">
        <Button size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={saving}>
          {saving ? "Checking…" : "Save and check"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The org's automation rules (docs/26 A5): what Lucent does on its own.
 * Owners only — the settings route's floor. A switch moves when clicked and
 * then settles on what the server now enforces; a failed save puts it back.
 */
function AutomationSection({ org }: { org: OrgSummary | null }) {
  const [rules, setRules] = useState<AutomationSettings | null | "failed">(null);
  const [saving, setSaving] = useState<AutomationRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!org || org.role !== "owner") return;
    void loadAutomation(org.id).then((r) => setRules(r ?? "failed"));
  }, [org]);
  if (!org) return null;
  if (org.role !== "owner") {
    return <EmptyState compact title="Automation is set by workspace owners" />;
  }
  if (rules === null) {
    return (
      <p className="boards-admin-muted" role="status">
        Loading automation…
      </p>
    );
  }
  if (rules === "failed") {
    return (
      <p className="boards-admin-muted" role="alert">
        Couldn&apos;t load automation.
      </p>
    );
  }
  const toggle = async (rule: AutomationRule, on: boolean) => {
    const before = rules;
    setRules({ ...before, [rule]: on });
    setSaving(rule);
    setError(null);
    const next = await setAutomationRule(org.id, rule, on);
    setSaving(null);
    if (next) {
      setRules(next);
    } else {
      setRules(before);
      setError("Couldn't save that — the rule is unchanged.");
    }
  };
  return (
    <Card className="boards-admin-card">
      <ul className="automation-rules" aria-label="Automation rules">
        {AUTOMATION_RULES.map((rule) => (
          <li key={rule}>
            <label className="automation-rule">
              <input
                type="checkbox"
                checked={rules[rule]}
                disabled={saving !== null}
                onChange={(e) => void toggle(rule, e.target.checked)}
              />
              <span>
                <span className="automation-rule-title">{AUTOMATION_COPY[rule].title}</span>
                <span className="automation-rule-body">{AUTOMATION_COPY[rule].body}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p className="boards-admin-muted" role="alert">
          {error}
        </p>
      )}
    </Card>
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
  if (role === "commenter") return "Commenter";
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
