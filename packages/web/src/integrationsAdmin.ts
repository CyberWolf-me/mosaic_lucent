import { apiFetch } from "./http.js";

/**
 * The org's integration connections, for the admin console (docs/26 A5):
 * connect, check, edit and disconnect Linear, Jira and GitHub, and see how
 * each has been answering. Owner-only — the routes' floor.
 *
 * A connection names a SERVER environment variable that holds the key,
 * never the key itself (ADR 0030): the key never passes through a browser.
 */

export type ConnectionState = "active" | "degraded" | "needs-reauth" | "revoked";

export interface ConnectionHealthView {
  failures: number;
  authFailed: boolean;
  lastError?: string;
  lastErrorAt?: number;
  lastOkAt?: number;
}

export interface ConnectionView {
  provider: string;
  status: string;
  state: ConnectionState;
  health?: ConnectionHealthView;
  config?: Record<string, string>;
  /** The credential reference as a fingerprint ("LINE…(18 chars)"). */
  credentialRef: string;
  supportsInbound?: boolean;
  updatedAt: number;
}

export interface AvailableProvider {
  provider: string;
  supportsInbound: boolean;
}

interface FieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

export interface ProviderForm {
  label: string;
  /** What the credential variable must hold. */
  credential: string;
  fields: FieldSpec[];
}

const WEBHOOK_FIELD: FieldSpec = {
  key: "webhookSecretRef",
  label: "Webhook secret variable (for changes made there to reach Lucent)",
  placeholder: "LINEAR_WEBHOOK_SIGNING",
};

/** Per provider: what the connection needs, in the provider's own words. */
export const PROVIDER_FORMS: Record<string, ProviderForm> = {
  linear: {
    label: "Linear",
    credential: "a Linear API key",
    fields: [
      { key: "teamId", label: "Team ID", placeholder: "e.g. 9cfb482a-…", required: true },
      WEBHOOK_FIELD,
    ],
  },
  jira: {
    label: "Jira",
    credential: "email:api_token for an Atlassian account",
    fields: [
      {
        key: "site",
        label: "Site",
        placeholder: "https://acme.atlassian.net",
        required: true,
      },
      { key: "projectKey", label: "Project key", placeholder: "ENG", required: true },
      { key: "issueType", label: "Issue type", placeholder: "Task" },
    ],
  },
  github: {
    label: "GitHub",
    credential: "a token that can read and write issues",
    fields: [
      { key: "repo", label: "Repository", placeholder: "owner/repo", required: true },
      { ...WEBHOOK_FIELD, placeholder: "GITHUB_WEBHOOK_SECRET" },
    ],
  },
  slack: {
    label: "Slack",
    credential: "a Slack incoming-webhook URL (https://hooks.slack.com/services/…)",
    fields: [],
  },
  fake: {
    label: "Test tracker",
    credential: "anything (the test tracker checks nothing)",
    fields: [],
  },
};

export function providerLabel(provider: string): string {
  return PROVIDER_FORMS[provider]?.label ?? provider;
}

/** The state in words, for the chip and for screen readers. */
export const STATE_WORD: Record<ConnectionState, string> = {
  active: "Connected",
  degraded: "Failing",
  "needs-reauth": "Needs a new key",
  revoked: "Disconnected",
};

async function json(res: Response): Promise<Record<string, unknown> | null> {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function loadIntegrations(
  orgId: string,
): Promise<{ connections: ConnectionView[]; available: AvailableProvider[] } | null> {
  try {
    const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/integrations`);
    if (!res.ok) return null;
    const body = await json(res);
    return {
      connections: (body?.integrations as ConnectionView[] | undefined) ?? [],
      available: (body?.available as AvailableProvider[] | undefined) ?? [],
    };
  } catch {
    return null;
  }
}

export type ConnectResult =
  | { ok: true; connection: ConnectionView; checked: boolean; detail?: string }
  | { ok: false; error: string };

/**
 * Save a connection, then check it — one read-only call through it — so the
 * owner learns now, not at the first sync, whether it works.
 */
export async function connectIntegration(
  orgId: string,
  provider: string,
  input: { credentialRef: string; config: Record<string, string> },
): Promise<ConnectResult> {
  const org = encodeURIComponent(orgId);
  const name = encodeURIComponent(provider);
  try {
    const saved = await apiFetch(`/api/orgs/${org}/integrations/${name}`, {
      method: "PUT",
      body: JSON.stringify({
        credentialRef: input.credentialRef.trim(),
        ...(Object.keys(input.config).length > 0 ? { config: input.config } : {}),
      }),
    });
    const body = await json(saved);
    if (!saved.ok) {
      const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
      return { ok: false, error: `${String(body?.error ?? "Couldn't save it")}${detail}` };
    }
    const checked = await checkIntegration(orgId, provider);
    if (checked.ok) return checked;
    return {
      ok: true,
      connection: body?.integration as ConnectionView,
      checked: false,
      detail: checked.error,
    };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

export async function checkIntegration(orgId: string, provider: string): Promise<ConnectResult> {
  try {
    const res = await apiFetch(
      `/api/orgs/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(provider)}/check`,
      { method: "POST" },
    );
    const body = await json(res);
    if (!res.ok) return { ok: false, error: String(body?.error ?? "Couldn't check it") };
    return {
      ok: true,
      connection: body?.integration as ConnectionView,
      checked: body?.ok === true,
      ...(typeof body?.detail === "string" ? { detail: body.detail } : {}),
    };
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

export async function disconnectIntegration(orgId: string, provider: string): Promise<boolean> {
  try {
    const res = await apiFetch(
      `/api/orgs/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(provider)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
}
