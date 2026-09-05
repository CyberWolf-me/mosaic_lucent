import { randomBytes } from "node:crypto";

/**
 * The integration connection + task-link store (Stage D4, ADR 0030).
 *
 * TWO record families, one store — deliberately together, because they are
 * the same concern at two ends: WHERE an org connects to an external
 * execution system (the connection, org-scoped, owner-administered — the
 * SsoStore shape), and WHICH board node maps to WHICH external task (the
 * link, board-scoped like meetings/presence — sync state, not workspace
 * state). The Action node stays one node with zero provider strings on it
 * (the D4 acceptance's literal wording); the link is connection-scoped
 * state the sync owns, the same division that keeps presence and snapshots
 * out of the workspace blob.
 *
 * Credentials are REFERENCE-FIRST: the connection row carries an env var
 * name / vault pointer, never a secret value — the discipline every
 * existing secret in the system follows (LLM key, SCIM token, Stripe keys:
 * all env, none ever in the DB). If a future OAuth flow (D6/D7) must
 * persist a token, the TOTP precedent applies (plaintext column + "the DB
 * is expected to be encrypted at rest" threat-model note) — D4 adds zero
 * new crypto and no cipher enters the codebase.
 */

/** The provider vocabulary D4 knows. Open per the adapter architecture —
 * the store validates against the KNOWN set so a typo'd provider name
 * fails at the boundary, while the provider MAP in AppDeps stays the
 * runtime authority on what is actually implemented. */
export const INTEGRATION_PROVIDERS = ["fake", "linear", "github", "jira", "figma", "slack"] as const;
export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ["active", "disabled"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const MAX_CREDENTIAL_REF_CHARS = 200;
export const MAX_SCOPES = 10;

/** One org's connection to one external system. */
export interface IntegrationConnection {
  id: string;
  orgId: string;
  provider: IntegrationProviderName;
  /**
   * A REFERENCE to the credential (env var name / vault pointer) — never
   * the secret itself. Echoed to admins as a fingerprint prefix only,
   * the SSO cert precedent: the admin surface proves what is configured
   * without re-displaying the material.
   */
  credentialRef: string;
  /** What the connection may do, provider-specific words (e.g. "issues:write"). */
  scopes: string[];
  status: IntegrationStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewIntegrationConnection {
  orgId: string;
  provider: IntegrationProviderName;
  credentialRef: string;
  scopes?: string[];
  createdBy: string;
}

/** One board node's live link to an external task. */
export interface IntegrationTaskLink {
  id: string;
  orgId: string;
  boardId: string;
  nodeId: string;
  provider: IntegrationProviderName;
  externalId: string;
  url?: string;
  /** The external status word AT LAST SYNC — raw, before mapStatus. */
  lastSyncedStatus: string;
  syncedAt: number;
}

export interface LinkTaskInput {
  orgId: string;
  boardId: string;
  nodeId: string;
  provider: IntegrationProviderName;
  externalId: string;
  url?: string;
  lastSyncedStatus: string;
}

export interface IntegrationStore {
  /**
   * Idempotent upsert by (orgId, provider): the admin "paste the reference"
   * flow, the SsoStore putConnection precedent. One connection per provider
   * per org — a second config replaces the first.
   */
  putConnection(input: NewIntegrationConnection, now: number): Promise<IntegrationConnection>;
  /** The org's connections, oldest first. */
  connectionsForOrg(orgId: string): Promise<IntegrationConnection[]>;
  connection(orgId: string, provider: string): Promise<IntegrationConnection | undefined>;
  /** Disable (never hard-delete — the audit trail keeps the reference). */
  setConnectionStatus(
    orgId: string,
    provider: string,
    status: IntegrationStatus,
    now: number,
  ): Promise<boolean>;

  /**
   * Upsert the node's link by (nodeId, provider): a sync that re-links
   * replaces the external pointer, it never stacks a second one.
   */
  linkTask(input: LinkTaskInput, now: number): Promise<IntegrationTaskLink>;
  /** All links for a board — the join the UI renders "synced to X" from. */
  linksForBoard(boardId: string): Promise<IntegrationTaskLink[]>;
  /** The node's links (one per connected provider). */
  linksForNode(boardId: string, nodeId: string): Promise<IntegrationTaskLink[]>;
  /** Drop a link (unlink; deleting the node should cascade this). */
  unlink(boardId: string, nodeId: string, provider: string): Promise<boolean>;
}

export function newIntegrationId(prefix: "int_" | "lnk_"): string {
  return prefix + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/** Validate + normalize a connection input; throws the honest reason.
 * The normalized shape always carries a concrete scopes array (empty when
 * the caller gave none) — the row type requires it. */
export function normalizeConnection(
  input: NewIntegrationConnection,
): Required<NewIntegrationConnection> {
  const provider = INTEGRATION_PROVIDERS.find((p) => p === input.provider);
  if (!provider) {
    throw new Error(
      `unknown provider "${input.provider}" (known: ${INTEGRATION_PROVIDERS.join(", ")})`,
    );
  }
  const ref = input.credentialRef.trim();
  if (!ref || ref.length > MAX_CREDENTIAL_REF_CHARS) {
    throw new Error(`credentialRef must be 1..${MAX_CREDENTIAL_REF_CHARS} characters`);
  }
  const scopes = (input.scopes ?? []).map((s) => s.trim()).filter(Boolean).slice(0, MAX_SCOPES);
  return { orgId: input.orgId, provider, credentialRef: ref, scopes, createdBy: input.createdBy };
}

/** Validate a link input; throws the honest reason. */
export function normalizeLink(input: LinkTaskInput): LinkTaskInput {
  const provider = INTEGRATION_PROVIDERS.find((p) => p === input.provider);
  if (!provider) {
    throw new Error(`unknown provider "${input.provider}"`);
  }
  if (!input.externalId.trim()) throw new Error("externalId is required");
  return { ...input, provider, externalId: input.externalId.trim() };
}

/** The admin's view of a connection: the reference as a FINGERPRINT, never in full. */
export function connectionView(c: IntegrationConnection): Record<string, unknown> {
  return {
    id: c.id,
    orgId: c.orgId,
    provider: c.provider,
    credentialRef: `${c.credentialRef.slice(0, 4)}…(${c.credentialRef.length} chars)`,
    scopes: c.scopes,
    status: c.status,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The in-memory pair (the proposals.ts convention: interface + impl, one file). */
export class InMemoryIntegrationStore implements IntegrationStore {
  private readonly connections = new Map<string, IntegrationConnection>(); // id → row
  private readonly links = new Map<string, IntegrationTaskLink>(); // id → row

  async putConnection(
    input: NewIntegrationConnection,
    now: number,
  ): Promise<IntegrationConnection> {
    const normalized = normalizeConnection(input);
    const existing = [...this.connections.values()].find(
      (c) => c.orgId === normalized.orgId && c.provider === normalized.provider,
    );
    if (existing) {
      const updated: IntegrationConnection = {
        ...existing,
        credentialRef: normalized.credentialRef,
        scopes: normalized.scopes,
        updatedAt: now,
      };
      this.connections.set(existing.id, updated);
      return { ...updated };
    }
    const row: IntegrationConnection = {
      id: newIntegrationId("int_"),
      orgId: normalized.orgId,
      provider: normalized.provider,
      credentialRef: normalized.credentialRef,
      scopes: normalized.scopes,
      status: "active",
      createdBy: normalized.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.connections.set(row.id, row);
    return { ...row };
  }

  async connectionsForOrg(orgId: string): Promise<IntegrationConnection[]> {
    return [...this.connections.values()]
      .filter((c) => c.orgId === orgId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
  }

  async connection(
    orgId: string,
    provider: string,
  ): Promise<IntegrationConnection | undefined> {
    const found = [...this.connections.values()].find(
      (c) => c.orgId === orgId && c.provider === provider,
    );
    return found ? { ...found } : undefined;
  }

  async setConnectionStatus(
    orgId: string,
    provider: string,
    status: IntegrationStatus,
    now: number,
  ): Promise<boolean> {
    const found = [...this.connections.values()].find(
      (c) => c.orgId === orgId && c.provider === provider,
    );
    if (!found) return false;
    this.connections.set(found.id, { ...found, status, updatedAt: now });
    return true;
  }

  async linkTask(input: LinkTaskInput, now: number): Promise<IntegrationTaskLink> {
    const normalized = normalizeLink(input);
    const existing = [...this.links.values()].find(
      (l) =>
        l.boardId === normalized.boardId &&
        l.nodeId === normalized.nodeId &&
        l.provider === normalized.provider,
    );
    if (existing) {
      const updated: IntegrationTaskLink = {
        ...existing,
        externalId: normalized.externalId,
        ...(normalized.url !== undefined ? { url: normalized.url } : {}),
        lastSyncedStatus: normalized.lastSyncedStatus,
        syncedAt: now,
      };
      this.links.set(existing.id, updated);
      return { ...updated };
    }
    const row: IntegrationTaskLink = {
      id: newIntegrationId("lnk_"),
      orgId: normalized.orgId,
      boardId: normalized.boardId,
      nodeId: normalized.nodeId,
      provider: normalized.provider,
      externalId: normalized.externalId,
      ...(normalized.url !== undefined ? { url: normalized.url } : {}),
      lastSyncedStatus: normalized.lastSyncedStatus,
      syncedAt: now,
    };
    this.links.set(row.id, row);
    return { ...row };
  }

  async linksForBoard(boardId: string): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()]
      .filter((l) => l.boardId === boardId)
      .map((l) => ({ ...l }));
  }

  async linksForNode(boardId: string, nodeId: string): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()]
      .filter((l) => l.boardId === boardId && l.nodeId === nodeId)
      .map((l) => ({ ...l }));
  }

  async unlink(boardId: string, nodeId: string, provider: string): Promise<boolean> {
    const found = [...this.links.values()].find(
      (l) => l.boardId === boardId && l.nodeId === nodeId && l.provider === provider,
    );
    if (!found) return false;
    this.links.delete(found.id);
    return true;
  }
}
