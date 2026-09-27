import { randomBytes } from "node:crypto";
import { actionNodes, decisionsBehindAction, type Workspace } from "@lucent/core";
import { connectionState, nextHealth, type CallOutcome, type ConnectionHealth } from "./health.js";

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
export const INTEGRATION_PROVIDERS = [
  "fake",
  "linear",
  "github",
  "jira",
  "figma",
  "slack",
] as const;
export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];

export const INTEGRATION_STATUSES = ["active", "disabled"] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const MAX_CREDENTIAL_REF_CHARS = 200;
export const MAX_SCOPES = 10;

/**
 * Operator-secret guard: a credentialRef names an environment variable whose
 * value the server will send to an external host. An org owner must not be
 * able to name operator-held secrets (session keys, SCIM/Stripe credentials,
 * database URLs) and exfiltrate them through a connection's baseUrl override.
 * The match is a case-insensitive substring so `lucent_session_secret`,
 * `LUCENT_SESSION_SECRET` and `my-session-backup` all refuse with the same
 * honest 400. Integration keys (LINEAR/GITHUB/JIRA test refs) contain none
 * of these substrings and pass unchanged.
 */
export const FORBIDDEN_CREDENTIAL_REF_SUBSTRINGS = [
  "SESSION",
  "SCIM",
  "STRIPE",
  "DATABASE",
  "SECRET",
  "PRIVATE",
  "PASSWORD",
  "LIVEKIT",
  "OAUTH",
  "SMTP",
  "TOTP",
  "TICKET",
] as const;

export function assertSafeCredentialRef(ref: string): void {
  const upper = ref.toUpperCase();
  for (const needle of FORBIDDEN_CREDENTIAL_REF_SUBSTRINGS) {
    if (upper.includes(needle)) {
      throw new Error(`credentialRef must not reference operator secrets (contains "${needle}")`);
    }
  }
}

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
  /**
   * Provider-specific configuration (Stage D6, the review's fix): Linear's
   * teamId lives HERE — on the connection, never on the Action, never in
   * the workspace, never as an env-only secret. Validated at the
   * connection boundary (≤10 short entries); the provider factory reads
   * it at construction.
   */
  config?: Record<string, string>;
  /** What the connection may do, provider-specific words (e.g. "issues:write"). */
  scopes: string[];
  status: IntegrationStatus;
  /** How it has been answering (docs/26 A5); absent until the first call. */
  health?: ConnectionHealth;
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

/**
 * What the provider said for the fields beyond status at the last sync,
 * accept or dismiss (docs/26 A5) — the baseline an inbound change is news
 * against. An empty string is "none there".
 */
export interface SyncedFields {
  assignee?: string;
  dueDate?: string;
}

/** An external task's fields, as a link's baseline. */
export function syncedFieldsOf(task: { assignee?: string; dueDate?: string }): SyncedFields {
  return { assignee: task.assignee ?? "", dueDate: task.dueDate ?? "" };
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
  /** docs/26 A5: the owner and due date the provider held at last sync. */
  lastSyncedFields?: SyncedFields;
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
  /** Merged over the link's baseline; absent leaves it as it was. */
  lastSyncedFields?: SyncedFields;
}

export interface IntegrationStore {
  /**
   * Idempotent upsert by (orgId, provider): the admin "paste the reference"
   * flow, the SsoStore putConnection precedent. One connection per provider
   * per org — a second config replaces the first.
   */
  putConnection(
    input: NewIntegrationConnection & { config?: Record<string, string> },
    now: number,
  ): Promise<IntegrationConnection>;
  /** The org's connections, oldest first. */
  connectionsForOrg(orgId: string): Promise<IntegrationConnection[]>;
  connection(orgId: string, provider: string): Promise<IntegrationConnection | undefined>;
  /**
   * Stage D7: every ACTIVE connection for one provider, across orgs — the
   * webhook receiver's org-resolution input (it resolves each candidate's
   * webhookSecretRef and matches the signature to find the org).
   */
  connectionsFor(provider: string): Promise<IntegrationConnection[]>;
  /** Disable (never hard-delete — the audit trail keeps the reference). */
  setConnectionStatus(
    orgId: string,
    provider: string,
    status: IntegrationStatus,
    now: number,
  ): Promise<boolean>;
  /**
   * docs/26 A5: record how a batch of calls went (`nextHealth`). A no-op for
   * a connection that doesn't exist.
   */
  recordCall(orgId: string, provider: string, outcome: CallOutcome, now: number): Promise<void>;

  /**
   * Upsert the node's link by (nodeId, provider): a sync that re-links
   * replaces the external pointer, it never stacks a second one.
   */
  linkTask(input: LinkTaskInput, now: number): Promise<IntegrationTaskLink>;
  /** All links for a board — the join the UI renders "synced to X" from. */
  linksForBoard(boardId: string): Promise<IntegrationTaskLink[]>;
  /** The node's links (one per connected provider). */
  linksForNode(boardId: string, nodeId: string): Promise<IntegrationTaskLink[]>;
  /**
   * Stage D7: every link pointing at one external task — the inbound
   * ingest's entry point (a webhook names LIN-482; the links say which
   * boards' which nodes that is).
   */
  linksForExternalId(provider: string, externalId: string): Promise<IntegrationTaskLink[]>;
  /**
   * Stage D10: the org's links, newest-synced first, capped — the link-GC
   * arm's feed. Scanning the LINK table (not the boards) keeps the work
   * proportional to actual integration state, and the cap keeps one sweep
   * run bounded no matter how large the org grew.
   */
  linksForOrg(orgId: string, limit: number): Promise<IntegrationTaskLink[]>;
  /** Drop a link (unlink; deleting the node should cascade this). */
  unlink(boardId: string, nodeId: string, provider: string): Promise<boolean>;
}

export function newIntegrationId(prefix: "int_" | "lnk_" | "act_" | "inb_"): string {
  return prefix + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/** Validate + normalize a connection input; throws the honest reason.
 * The normalized shape always carries a concrete scopes array (empty when
 * the caller gave none) — the row type requires it. */
export function normalizeConnection(
  input: NewIntegrationConnection,
): Required<NewIntegrationConnection> & { config?: Record<string, string> } {
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
  assertSafeCredentialRef(ref);
  const scopes = (input.scopes ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SCOPES);
  // Stage D6: provider config — shallow-validated (≤10 entries, short
  // strings); provider-specific validation is the factory's business at
  // connect time (the Linear factory 400s on a missing teamId).
  const rawConfig = (input as { config?: Record<string, string> }).config;
  const config: Record<string, string> | undefined = rawConfig
    ? Object.fromEntries(
        Object.entries(rawConfig)
          .filter(([k, v]) => k && typeof v === "string")
          .slice(0, 10)
          .map(([k, v]) => [k.slice(0, 60), v.slice(0, 200)]),
      )
    : undefined;
  return {
    orgId: input.orgId,
    provider,
    credentialRef: ref,
    ...(config && Object.keys(config).length > 0 ? { config } : {}),
    scopes,
    createdBy: input.createdBy,
  };
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

/**
 * The shared proposal-item builder (extracted from the propose route in
 * Stage D9, verbatim): creates for unlinked action nodes, updates for
 * linked ones, each with its exactly-once key and the D8 capability
 * warnings. Both the human propose route and the AI propose route call
 * THIS — the item computation can never diverge between them, which is
 * what makes "the AI may only narrow" a structural fact rather than a
 * convention: the AI route receives this list and intersects it.
 */
export function extractProposalItems(
  workspace: Workspace,
  linksForProvider: ReadonlyMap<string, { nodeId: string; externalId: string }>,
  capabilityWarnings:
    | ((fields: {
        title: string;
        assignee?: string;
        dueDate?: string;
        status?: string;
      }) => Array<{ field: string; reason: string }>)
    | undefined,
): IntegrationActionItem[] {
  return actionNodes(workspace).map((node) => {
    const issue = node.issue!;
    const link = linksForProvider.get(node.id);
    const fields = {
      title: node.label,
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
      ...(issue.status ? { status: issue.status } : {}),
    };
    const warnings = capabilityWarnings?.(fields);
    const description = taskDescription(workspace, node.id);
    return {
      nodeId: node.id,
      action: link ? ("update" as const) : ("create" as const),
      title: node.label,
      ...(issue.assignee ? { assignee: issue.assignee } : {}),
      ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
      status: issue.status,
      ...(link ? { externalId: link.externalId } : {}),
      ...(description ? { description } : {}),
      idempotencyKey: `ext_${node.id}`,
      ...(warnings && warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/**
 * What an external task says about itself (docs/26 A5): the action's own
 * description, and the decisions on the board that drive it — so whoever
 * picks it up in Linear, Jira or GitHub knows why it exists.
 */
export function taskDescription(workspace: Workspace, nodeId: string): string | undefined {
  const own = workspace.nodes[nodeId]?.issue?.description?.trim();
  const why = decisionsBehindAction(workspace, nodeId).map((d) => `- ${d.label}`);
  const parts = [
    ...(own ? [own] : []),
    ...(why.length > 0 ? [`Why (decided in Lucent):\n${why.join("\n")}`] : []),
  ];
  return parts.length > 0 ? parts.join("\n\n").slice(0, 4000) : undefined;
}

/** The admin's view of a connection: the reference as a FINGERPRINT, never in full. */
export function connectionView(c: IntegrationConnection): Record<string, unknown> {
  return {
    id: c.id,
    orgId: c.orgId,
    provider: c.provider,
    credentialRef: `${c.credentialRef.slice(0, 4)}…(${c.credentialRef.length} chars)`,
    ...(c.config ? { config: c.config } : {}),
    scopes: c.scopes,
    status: c.status,
    // docs/26 A5: the derived state and what it's based on; Slack is a
    // channel Lucent posts to, not a tracker work syncs with.
    state: connectionState(c),
    kind: c.provider === "slack" ? "notifier" : "tracker",
    ...(c.health ? { health: c.health } : {}),
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
    input: NewIntegrationConnection & { config?: Record<string, string> },
    now: number,
  ): Promise<IntegrationConnection> {
    const normalized = normalizeConnection(input);
    const existing = [...this.connections.values()].find(
      (c) => c.orgId === normalized.orgId && c.provider === normalized.provider,
    );
    if (existing) {
      // Reconnecting is a fresh start: active again, and the old credential's
      // failures no longer describe it (docs/26 A5).
      const { health: _stale, ...rest } = existing;
      const updated: IntegrationConnection = {
        ...rest,
        credentialRef: normalized.credentialRef,
        ...(normalized.config ? { config: normalized.config } : {}),
        scopes: normalized.scopes,
        status: "active",
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
      ...(normalized.config ? { config: normalized.config } : {}),
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

  async connection(orgId: string, provider: string): Promise<IntegrationConnection | undefined> {
    const found = [...this.connections.values()].find(
      (c) => c.orgId === orgId && c.provider === provider,
    );
    return found ? { ...found } : undefined;
  }

  async connectionsFor(provider: string): Promise<IntegrationConnection[]> {
    return [...this.connections.values()]
      .filter((c) => c.provider === provider && c.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
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

  async recordCall(
    orgId: string,
    provider: string,
    outcome: CallOutcome,
    now: number,
  ): Promise<void> {
    const found = [...this.connections.values()].find(
      (c) => c.orgId === orgId && c.provider === provider,
    );
    if (!found) return;
    this.connections.set(found.id, { ...found, health: nextHealth(found.health, outcome, now) });
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
        ...(normalized.lastSyncedFields
          ? { lastSyncedFields: { ...existing.lastSyncedFields, ...normalized.lastSyncedFields } }
          : {}),
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
      ...(normalized.lastSyncedFields ? { lastSyncedFields: normalized.lastSyncedFields } : {}),
      syncedAt: now,
    };
    this.links.set(row.id, row);
    return { ...row };
  }

  async linksForBoard(boardId: string): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()].filter((l) => l.boardId === boardId).map((l) => ({ ...l }));
  }

  async linksForNode(boardId: string, nodeId: string): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()]
      .filter((l) => l.boardId === boardId && l.nodeId === nodeId)
      .map((l) => ({ ...l }));
  }

  async linksForExternalId(provider: string, externalId: string): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()]
      .filter((l) => l.provider === provider && l.externalId === externalId)
      .map((l) => ({ ...l }));
  }

  async linksForOrg(orgId: string, limit: number): Promise<IntegrationTaskLink[]> {
    return [...this.links.values()]
      .filter((l) => l.orgId === orgId)
      .sort((a, b) => b.syncedAt - a.syncedAt)
      .slice(0, limit)
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

/* -------------------------------------------------------------------------- */
/* External action records (Stage D5, ADR 0031)                                */
/* -------------------------------------------------------------------------- */

/**
 * The external-action proposal record — B3's PATTERN in a new kind, NOT the
 * B3 pipeline (ADR 0030's ruling: an external action is not a canvas
 * Operation; extending StoredProposal fails on the non-empty-ops check,
 * the Operation[] typing, the op-log appliedSeq, the room commit, and the
 * one-pending-per-board index would make a canvas proposal and an external
 * batch fight for one slot). Reused from the pattern: the status quartet,
 * the decided-once transition guard, one-pending-per-(board,provider) by
 * supersede, the duplicate-decider answer.
 *
 * The record STORES its items — the payload doubles as the sweep's replay
 * source (unlike a Stripe event, an intended external create has no
 * external authoritative copy to re-fetch).
 */
export const INTEGRATION_ACTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "superseded",
] as const;
export type IntegrationActionStatus = (typeof INTEGRATION_ACTION_STATUSES)[number];

/** One node's planned external effect within a batch. */
export interface IntegrationActionItem {
  nodeId: string;
  action: "create" | "update";
  title: string;
  assignee?: string;
  dueDate?: string;
  /** The D1 canonical status word at proposal time. */
  status: string;
  /** For updates: the existing external id; for creates: absent. */
  externalId?: string;
  /** docs/26 A5: what the task says about itself — see `taskDescription`. */
  description?: string;
  /** The exactly-once key the executor threads to the provider. */
  idempotencyKey: string;
  /**
   * Stage D8, ADR 0034's honesty layer: what the provider CANNOT represent
   * faithfully for this item, computed by capabilityWarnings at propose time.
   * The approve route refuses a warning-carrying record unless the caller
   * acknowledged them — capability loss is part of the human gate.
   */
  warnings?: Array<{ field: string; reason: string }>;
}

export interface IntegrationActionRecord {
  id: string;
  orgId: string;
  boardId: string;
  provider: IntegrationProviderName;
  /**
   * The connection the proposal previewed against (Stage D6, the review's
   * safety check): approval refuses when the connection changed — disabled,
   * replaced — between propose and approve (409 "connection changed;
   * create a new preview"). A proposal must execute through the exact
   * connection its preview showed.
   */
  connectionId: string;
  status: IntegrationActionStatus;
  items: IntegrationActionItem[];
  createdBy: string;
  createdAt: number;
  /**
   * Stage D9, ADR 0035: who initiated the proposal — the human route or
   * the AI narrowing path. Existing records read as "user" (the default:
   * every record before D9 was human-initiated). The DECIDER is always
   * human on both paths; origin distinguishes who drafted.
   */
  origin?: "user" | "ai";
  /**
   * Stage D9: the AI path's provenance — the user's request and the
   * model's rationale. The rationale is a RECOMMENDATION, never board
   * truth (the C2/C5 doctrine: AI interpretation is not automatically
   * semantic state); it is rendered, never fed back as evidence.
   */
  provenance?: { request: string; explanation: string };
  /**
   * Stage D9: the board's op-log head at proposal time — the revision the
   * proposal was computed against. Audit + stale detection, not a gate:
   * approval applies the ITEM SNAPSHOT the record stores, so a board that
   * moved after the propose still gets exactly what the human reviewed.
   */
  sourceSeq?: number | null;
  decidedBy?: string;
  decidedAt?: number;
  appliedAt?: number;
  error?: string;
}

export interface IntegrationActionStore {
  /**
   * One-pending-per-(board, provider): a new proposal supersedes any
   * pending predecessor (the B3 create pattern), returning its id.
   */
  propose(input: {
    orgId: string;
    boardId: string;
    provider: IntegrationProviderName;
    connectionId: string;
    items: IntegrationActionItem[];
    createdBy: string;
    now: number;
    /** Stage D9: the originator + provenance + the board revision (the human path passes origin "user" implicitly). */
    origin?: "user" | "ai";
    provenance?: { request: string; explanation: string };
    sourceSeq?: number | null;
  }): Promise<{ record: IntegrationActionRecord; supersededId: string | null }>;
  /** Board-scoped read: a leaked id is not a read. */
  action(boardId: string, id: string): Promise<IntegrationActionRecord | undefined>;
  /** The board's action history, newest first. */
  actionsForBoard(boardId: string): Promise<IntegrationActionRecord[]>;
  /**
   * The decided-once transition guard (the B3 decide pattern): a second
   * decide on an already-decided record is a NO-OP returning the current
   * state — the caller answers "duplicate", never a second effect.
   */
  decide(
    boardId: string,
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    now: number,
  ): Promise<IntegrationActionRecord | undefined>;
  /** Mark the batch applied (the executor's final write). */
  applied(boardId: string, id: string, now: number): Promise<void>;
}

/** The InMemory action-store pair (the proposals.ts convention). */
export class InMemoryIntegrationActionStore implements IntegrationActionStore {
  private readonly records = new Map<string, IntegrationActionRecord>();

  async propose(input: {
    orgId: string;
    boardId: string;
    provider: IntegrationProviderName;
    connectionId: string;
    items: IntegrationActionItem[];
    createdBy: string;
    now: number;
    origin?: "user" | "ai";
    provenance?: { request: string; explanation: string };
    sourceSeq?: number | null;
  }): Promise<{ record: IntegrationActionRecord; supersededId: string | null }> {
    const pending = [...this.records.values()].find(
      (r) => r.boardId === input.boardId && r.provider === input.provider && r.status === "pending",
    );
    let supersededId: string | null = null;
    if (pending) {
      supersededId = pending.id;
      this.records.set(pending.id, { ...pending, status: "superseded" });
    }
    const record: IntegrationActionRecord = {
      id: newIntegrationId("act_"),
      orgId: input.orgId,
      boardId: input.boardId,
      provider: input.provider,
      connectionId: input.connectionId,
      status: "pending",
      items: input.items,
      createdBy: input.createdBy,
      createdAt: input.now,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
      ...(input.sourceSeq !== undefined ? { sourceSeq: input.sourceSeq } : {}),
    };
    this.records.set(record.id, record);
    return { record: { ...record }, supersededId };
  }

  async action(boardId: string, id: string): Promise<IntegrationActionRecord | undefined> {
    const found = this.records.get(id);
    // Board-scoped: the id alone is not a read.
    if (!found || found.boardId !== boardId) return undefined;
    return { ...found };
  }

  async actionsForBoard(boardId: string): Promise<IntegrationActionRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.boardId === boardId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({ ...r }));
  }

  async decide(
    boardId: string,
    id: string,
    decision: "approved" | "rejected",
    decidedBy: string,
    now: number,
  ): Promise<IntegrationActionRecord | undefined> {
    const found = this.records.get(id);
    if (!found || found.boardId !== boardId) return undefined;
    // Decided once: a second decide changes nothing.
    if (found.status !== "pending") return { ...found };
    const updated: IntegrationActionRecord = {
      ...found,
      status: decision,
      decidedBy,
      decidedAt: now,
    };
    this.records.set(id, updated);
    return { ...updated };
  }

  async applied(boardId: string, id: string, now: number): Promise<void> {
    const found = this.records.get(id);
    if (!found || found.boardId !== boardId) return;
    this.records.set(id, { ...found, appliedAt: now });
  }
}
