import type { Workspace } from "@lucent/core";
import { apiFetch } from "./http.js";
import { hasSession } from "./session.js";

/**
 * Board REST client (docs/12). Server-side boards are what make a board
 * shareable: the realtime room is keyed by board id, so a board must exist on
 * the server before two people can join the same one.
 *
 * Every call requires a session. Signed-out users stay in the offline
 * localStorage flow and never reach these endpoints.
 */

export type BoardRole = "owner" | "editor" | "viewer";
/** Roles a share link may grant — ownership is never transferable by link. */
export type ShareRole = Exclude<BoardRole, "owner">;

export interface BoardSummary {
  id: string;
  name: string;
  updatedAt: number;
  /** Owning tenant. Present on list responses; the create/update 201 omits it. */
  orgId?: string;
  nodes?: number;
}

/** Which view a list call asks for; mirrors the server's `scope` parameter. */
export type BoardScope = "org" | "shared";

export interface BoardMemberSummary {
  boardId: string;
  userId: string;
  role: BoardRole;
  invitedBy: string | null;
  createdAt: number;
}

/**
 * Every board call, gated on having a session at all.
 *
 * `null` means "did not ask the server", which callers map to the offline flow.
 * The gate is `hasSession()` and not `getToken()`: a cookie session has no
 * readable bearer token, so the old token check made every board request a
 * silent no-op for exactly the users who had just signed in - the board list
 * came back empty and Settings reported "You are working offline".
 *
 * `apiFetch` supplies the session cookie, the CSRF header that the mutating
 * calls below (POST / PATCH / DELETE) are rejected without, and the bearer
 * header for legacy token sessions.
 */
async function authed(path: string, init?: RequestInit): Promise<Response | null> {
  if (!hasSession()) return null;
  return apiFetch(path, init ?? {});
}

/**
 * Create or update a server-side board. Passing `id` updates in place, which is
 * what "share the board I'm already working on" needs.
 *
 * `orgId` is a required parameter rather than an optional one because the
 * server's fallback for a missing one is `memberships[0]?.orgId` (app.ts:2183) -
 * whichever org the membership query happened to return first. A user who
 * belongs to two orgs then saves into an arbitrary tenant, and the board is
 * invisible from the list call for the org they were actually looking at. The
 * caller knows which org is on screen, so it has to say which.
 */
export async function saveBoard(
  orgId: string,
  name: string,
  workspace: Workspace,
  id?: string,
): Promise<BoardSummary | null> {
  const res = await authed("/api/boards", {
    method: "POST",
    body: JSON.stringify({ ...(id ? { id } : {}), orgId, name, workspace }),
  });
  if (!res || !res.ok) return null;
  const body = (await res.json()) as BoardSummary;
  // The 201 answers {id, name, updatedAt}; the tenant is the one we just asked
  // for, and callers that cache the summary need it on the object.
  return { ...body, orgId };
}

/**
 * Boards in one tenant. `scope` chooses the view the server offers:
 *   "org" (the default) - every board in the tenant, which requires a real
 *     `memberships` row; without one the server answers 404 `org not found`.
 *   "shared" - only boards the caller owns or holds a `board_members` row on.
 *     Deliberately does not require org membership, so an outside collaborator
 *     who arrived through a share link can still list what they can open.
 *
 * `orgId` is required because the route requires it: `GET /api/boards` with no
 * orgId is a 400 (`orgId query parameter required`, app.ts:2277), so the
 * no-argument version this replaces returned `[]` for every caller, always.
 */
export async function listBoards(orgId: string, scope?: BoardScope): Promise<BoardSummary[]> {
  const query = new URLSearchParams({ orgId });
  if (scope !== undefined) query.set("scope", scope);
  const res = await authed(`/api/boards?${query.toString()}`);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { boards?: BoardSummary[] };
  return data.boards ?? [];
}

/**
 * Fetch one board. Returns the caller's own role alongside the workspace, so
 * the UI can decide what to offer without a second request or a guess.
 * Null when the board doesn't exist or the caller isn't a member.
 */
export async function fetchBoard(
  id: string,
): Promise<{ id: string; name: string; workspace: Workspace; role: BoardRole } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(id)}`);
  if (!res || !res.ok) return null;
  return (await res.json()) as {
    id: string;
    name: string;
    workspace: Workspace;
    role: BoardRole;
  };
}

/**
 * Mint a share link for a board (owner only). The returned token is the
 * capability; the caller builds the invite URL around it.
 */
export async function createShareLink(
  boardId: string,
  role: ShareRole,
  expiresInHours?: number,
): Promise<{ token: string; role: ShareRole; expiresAt: number | null } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/share`, {
    method: "POST",
    body: JSON.stringify({ role, ...(expiresInHours ? { expiresInHours } : {}) }),
  });
  if (!res || !res.ok) {
    // Surface the server's reason rather than swallowing it: "verify your
    // email before sharing a board" is a fixable action, and telling the
    // actual owner they're "not the owner" (the old blanket message) sent
    // people down the wrong path.
    try {
      const body = (await res?.json()) as { error?: string } | null;
      if (body?.error) lastShareLinkError = body.error;
    } catch {
      // non-JSON body: leave the generic caller message in place
    }
    return null;
  }
  return (await res.json()) as { token: string; role: ShareRole; expiresAt: number | null };
}

/** The server's reason for the last failed createShareLink, when it sent one.
 * Cleared on the next call. Exists so the share dialog can show the real
 * reason ("verify your email before sharing a board") instead of a guess. */
let lastShareLinkError: string | null = null;
export function readShareLinkError(): string | null {
  const err = lastShareLinkError;
  lastShareLinkError = null;
  return err;
}

/** Revoke one link, or every live link on the board when token is omitted. */
export async function revokeShareLinks(boardId: string, token?: string): Promise<number> {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/share${query}`, {
    method: "DELETE",
  });
  if (!res || !res.ok) return 0;
  return ((await res.json()) as { revoked?: number }).revoked ?? 0;
}

/**
 * Redeem a share link. Idempotent — joining a board you already belong to
 * returns your existing role rather than downgrading it. Returns the granted
 * role, or an error message suitable for showing the user.
 */
export async function joinBoard(
  boardId: string,
  token: string,
): Promise<{ ok: true; role: BoardRole } | { ok: false; error: string }> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/join`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  if (!res) return { ok: false, error: "Sign in to open a shared board." };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? "That invite link is not valid." };
  }
  const body = (await res.json()) as { role: BoardRole };
  return { ok: true, role: body.role };
}

/** Members of a board, plus the caller's own role. Any member may read this. */
export async function listMembers(
  boardId: string,
): Promise<{ members: BoardMemberSummary[]; role: BoardRole } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/members`);
  if (!res || !res.ok) return null;
  return (await res.json()) as { members: BoardMemberSummary[]; role: BoardRole };
}

/** Change a member's role (owner only). The board owner cannot be demoted. */
export async function setMemberRole(
  boardId: string,
  userId: string,
  role: ShareRole,
): Promise<boolean> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
  return Boolean(res?.ok);
}

/** Remove a member's access (owner only). */
export async function removeMember(boardId: string, userId: string): Promise<boolean> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  return Boolean(res?.ok);
}

/**
 * Mint a 60-second, single-use ticket for the WebSocket upgrade (M0.3). The
 * browser exchanges its bearer token for the ticket on demand, then the
 * token never appears in proxy access logs or server-side WS upgrade frames.
 */
export async function fetchRealtimeTicket(): Promise<string | null> {
  const res = await authed("/api/realtime/ticket", { method: "POST" });
  if (!res || !res.ok) return null;
  const body = (await res.json()) as { ticket?: string };
  return body.ticket ?? null;
}

// --- Server-side proposals (Stage B3) ---------------------------------------
//
// The proposal record on a server-adopted board lives on the SERVER, not in
// localStorage: every member of the board sees the same pending batch, and
// the decision is enforced where both browsers can see it. The shapes mirror
// `StoredProposal` from the server's proposals.ts.

export interface ServerProposal {
  id: string;
  boardId: string;
  meetingId: string | null;
  status: "pending" | "approved" | "rejected" | "superseded";
  operations: unknown[];
  request: string;
  explanation: string | null;
  provenance: {
    quote?: string;
    turnRange?: [number, number];
    turnKinds?: string[];
  } | null;
  createdBy: string;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  appliedSeq: number | null;
}

/** Create a proposal on the server; supersedes any pending predecessor. */
export async function createServerProposal(
  boardId: string,
  body: {
    operations: unknown[];
    request: string;
    explanation?: string;
    meetingId?: string;
    provenance?: {
      quote?: string;
      turnRange?: [number, number];
      turnKinds?: string[];
    };
  },
): Promise<ServerProposal | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { proposal?: ServerProposal };
  return data.proposal ?? null;
}

/** A board's proposals, newest first — the rehydrate path on board load. */
export async function listServerProposals(boardId: string): Promise<ServerProposal[]> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/proposals`);
  if (!res || !res.ok) return [];
  const data = (await res.json()) as { proposals?: ServerProposal[] };
  return data.proposals ?? [];
}

/**
 * Approve or reject. Returns the decided record plus `duplicate` when the
 * proposal was already decided (the other browser got there first — a read,
 * not a second commit).
 */
export async function decideServerProposal(
  boardId: string,
  proposalId: string,
  verdict: "approve" | "reject",
): Promise<{ proposal: ServerProposal; duplicate: boolean } | null> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/proposals/${encodeURIComponent(proposalId)}/${verdict}`,
    { method: "POST" },
  );
  if (!res || !res.ok) return null;
  const out = (await res.json()) as { proposal: ServerProposal; duplicate?: boolean };
  return { proposal: out.proposal, duplicate: out.duplicate === true };
}

/* ------------------------- Stage C1: history + ask ------------------------- */

/** One revision of the server-backed timeline, as the history route summarizes it. */
export interface BoardHistoryItem {
  seq: number;
  at: number;
  label: string;
  operationId?: string;
  opCount: number;
  actor: {
    type: "user" | "ai" | "system";
    name: string;
    id: string;
    initiatedBy?: string;
    approvedBy?: string;
  };
  /** Node/object ids the batch referenced — the "show on board" jump. */
  touched: string[];
  /**
   * The statement this revision attached or changed (Stage C3): the timeline
   * renders it as a semantic row — "decision made", "question resolved".
   */
  statementEvent?: {
    kind: "decision" | "proposal" | "question" | "action" | "requirement" | "risk";
    status: "open" | "resolved" | "rejected" | "superseded";
    topic?: string;
    supersedes?: string[];
    nodeId: string;
  };
  proposal?: {
    id: string;
    meetingId: string | null;
    quote?: string;
    turnRange?: [number, number];
  };
}

export interface BoardHistory {
  items: BoardHistoryItem[];
  historyDepth: number | null;
  limit: number;
  hasMore: boolean;
  latestSeq: number;
  windowCeiling: number;
}

/**
 * The visible revision window of a shared board (Stage C1). Server-side history
 * exists only for shared boards — a local (localStorage) board has no op log,
 * and its history view keeps using the client timeline.
 */
export async function fetchBoardHistory(boardId: string): Promise<BoardHistory | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/history`);
  if (!res || !res.ok) return null;
  return (await res.json()) as BoardHistory;
}

/** One search result (Stage C4), as the search route returns it. */
export interface BoardSearchHit {
  kind: "node" | "turn" | "revision";
  /** node: the node id · turn: the meeting id · revision: the seq. */
  id: string;
  nodeType?: string;
  label?: string;
  statement?: { kind: string; status: string; topic?: string };
  meetingId?: string;
  turnIndex?: number;
  speaker?: string;
  snippet?: string;
  seq?: number;
  at?: number;
  actorName?: string;
  /** The query tokens that fired — the "Matching: pricing, 20" line. */
  matched: string[];
  score: number;
}

export interface BoardSearchResponse {
  query: string;
  results: BoardSearchHit[];
  historyDepth: number | null;
  /** Older content exists beyond the entitlement and was not searched. */
  windowTruncated: boolean;
  windowCeiling: number;
}

/**
 * Search a shared board (Stage C4): one retriever with Ask — same entitlement
 * window, same corpus. Local (never-shared) boards keep the palette's local
 * scan: there is nothing server-side to search for them.
 */
export async function searchBoard(
  boardId: string,
  query: string,
  signal?: AbortSignal,
): Promise<BoardSearchResponse | null> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/search?q=${encodeURIComponent(query)}`,
    { signal },
  );
  if (!res || !res.ok) return null;
  return (await res.json()) as BoardSearchResponse;
}

/** A citation the ask route resolved against real, visible state. */
export interface AskCitation {
  kind: "node" | "meeting" | "revision";
  id: string;
  label: string;
  detail?: string;
  why?: string;
  turnRange?: [number, number];
}

export interface AskResponse {
  answer: string;
  citations: AskCitation[];
  warnings?: Array<{ citation: { kind: string; id: string }; reason: string }>;
  historyDepth: number | null;
  hasMore: boolean;
  provider: string;
  model?: string;
}

/**
 * Ask Lucent about the board (Stage C1): the read direction of the AI pill's
 * Build/Ask split. The question bills the same ai.generationsPerMonth
 * allowance as Build, metered with mode "ask" — so a 402 here renders through
 * the same paywall, and `recordPlanRefusal` (in the caller) keeps the wall
 * honest rather than surfacing as a generic failure.
 */
export async function askLucent(
  boardId: string,
  question: string,
  history?: Array<{ role: "user" | "ai"; text: string }>,
): Promise<AskResponse | { error: string; status: number }> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/ask`, {
    method: "POST",
    body: JSON.stringify({ question, ...(history?.length ? { history } : {}) }),
  });
  if (!res) return { error: "You're working offline. Sign in to ask about this board.", status: 0 };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    return { error: body.error ?? "Lucent could not answer that question.", status: res.status };
  }
  return (await res.json()) as AskResponse;
}

/* -------------------------------------------------------------------------- */
/* Integrations (Stage D6) — the connection state, the links, the proposals   */
/* -------------------------------------------------------------------------- */

/** One external link, as the link GET returns it. */
export interface IntegrationLink {
  nodeId: string;
  provider: string;
  externalId: string;
  url?: string;
  status: string;
  syncedAt: number;
}

/** The org's connection (admin-view shaped: the credential fingerprinted). */
export interface IntegrationConnectionView {
  id: string;
  provider: string;
  credentialRef: string;
  config?: Record<string, string>;
  scopes: string[];
  status: "active" | "disabled";
  updatedAt: number;
}

/** The frozen propose-preview shape (ADR 0031's contract; D8 adds the
 * per-item capability warnings; D9 adds the AI-origin facts — the ratio,
 * the explanation, and the drop warnings). */
export interface IntegrationPreview {
  action: {
    id: string;
    provider: string;
    status: string;
    createdAt: number;
    supersededId?: string;
    /** "ai" when the narrowing agent drafted this proposal. */
    origin?: "user" | "ai";
    provenance?: { request: string; explanation: string };
    sourceSeq?: number | null;
  };
  preview: {
    creates: Array<{
      nodeId: string;
      title: string;
      assignee?: string;
      dueDate?: string;
      status: string;
      /** What this provider CANNOT represent faithfully for the item. */
      warnings?: Array<{ field: string; reason: string }>;
    }>;
    updates: Array<{
      nodeId: string;
      externalId?: string;
      title: string;
      status: string;
      warnings?: Array<{ field: string; reason: string }>;
    }>;
    statement: string;
    /** The AI path's selection ratio + rationale + drop warnings. */
    selectedCount?: number;
    totalCandidates?: number;
    explanation?: string;
    warnings?: string[];
  };
}

export interface IntegrationDecisionResult {
  applied?: number;
  failed?: number;
  inFlight?: number;
  results?: Array<Record<string, unknown>>;
  duplicate?: boolean;
  action?: Record<string, unknown>;
  error?: string;
}

export async function fetchIntegrationLinks(boardId: string): Promise<IntegrationLink[]> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/integrations/links`);
  if (!res || !res.ok) return [];
  const body = (await res.json()) as { links?: IntegrationLink[] };
  return body.links ?? [];
}

/**
 * The org's integration connections (the admin list). Returns [] offline or
 * on failure — a missing connection state renders the honest "not connected"
 * UX rather than an error.
 */
export async function fetchOrgIntegrations(orgId: string): Promise<IntegrationConnectionView[]> {
  const res = await authed(`/api/orgs/${encodeURIComponent(orgId)}/integrations`);
  if (!res || !res.ok) return [];
  const body = (await res.json()) as { integrations?: IntegrationConnectionView[] };
  return body.integrations ?? [];
}

export async function proposeIntegration(
  boardId: string,
  provider: string,
): Promise<IntegrationPreview | { error: string; status: number } | null> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/integrations/${encodeURIComponent(provider)}/propose`, {
    method: "POST",
  });
  if (!res) return null;
  if (!res.ok) return { error: (await res.json().catch(() => ({ error: "propose failed" }))).error ?? "propose failed", status: res.status };
  return (await res.json()) as IntegrationPreview;
}

/**
 * Stage D9: the AI path — "Ask Lucent to draft". The request is the
 * natural-language narrowing instruction; the server builds every item
 * from real state, the model only selects, and the answer is the same
 * preview shape with the AI-origin facts.
 *
 * Stage E3: `nodeIds` is the create-the-work bridge — a human surface
 * (the plan's Send button) names the derived actions itself. When
 * present, the server skips the selector model entirely and runs the ids
 * through the same intersect/cap/warn narrowing.
 */
export async function proposeIntegrationAI(
  boardId: string,
  provider: string,
  request: string,
  nodeIds?: readonly string[],
): Promise<IntegrationPreview | { error: string; status: number; hint?: string } | null> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/integrations/${encodeURIComponent(provider)}/propose-ai`,
    {
      method: "POST",
      body: JSON.stringify({
        request,
        ...(nodeIds && nodeIds.length > 0 ? { nodeIds: [...nodeIds] } : {}),
      }),
    },
  );
  if (!res) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "propose failed" }))) as {
      error?: string;
      hint?: string;
    };
    return { error: body.error ?? "propose failed", status: res.status, ...(body.hint ? { hint: body.hint } : {}) };
  }
  return (await res.json()) as IntegrationPreview;
}

export async function decideIntegrationAction(
  boardId: string,
  actionId: string,
  decision: "approve" | "reject",
  options?: { acknowledgeWarnings?: boolean },
): Promise<IntegrationDecisionResult | { error: string; status: number; warnings?: Array<{ nodeId: string; field: string; reason: string }> } | null> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/integrations/actions/${encodeURIComponent(actionId)}/${decision}`,
    {
      method: "POST",
      // The D8 ack: a warning-carrying record executes only with the
      // explicit acknowledgeWarnings body.
      ...(options?.acknowledgeWarnings
        ? { body: JSON.stringify({ acknowledgeWarnings: true }) }
        : {}),
    },
  );
  if (!res) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "decision failed" }))) as {
      error?: string;
      warnings?: Array<{ nodeId: string; field: string; reason: string }>;
    };
    return {
      error: body.error ?? "decision failed",
      status: res.status,
      ...(Array.isArray(body.warnings) ? { warnings: body.warnings } : {}),
    };
  }
  return (await res.json()) as IntegrationDecisionResult;
}

// --- Inbound changes (Stage D7 — the human-gated queue) ---------------------

/** One queued external change, as the route joins it to the live board. */
export interface InboundChangeView {
  id: string;
  provider: string;
  nodeId: string;
  nodeLabel: string;
  externalId: string;
  url?: string;
  field: "status";
  /** The raw provider word at detection — what the human reads. */
  externalValue: string;
  /** null = the never-guesses warning row (dismiss-only). */
  mappedValue: string | null;
  status: "pending" | "applied" | "dismissed" | "superseded";
  source: "webhook" | "sweep";
  detectedAt: number;
  /** The node's live issue status, for "X says done — the board says todo". */
  boardValue: string | null;
  /** True when the board already equals the mapped value. */
  resolved: boolean;
  decidedBy?: string;
  decidedAt?: number;
  appliedSeq?: number;
  reason?: string;
}

export async function fetchInboundChanges(boardId: string): Promise<InboundChangeView[]> {
  const res = await authed(`/api/boards/${encodeURIComponent(boardId)}/integrations/inbound`);
  if (!res || !res.ok) return [];
  const body = (await res.json()) as { inbound?: InboundChangeView[] };
  return body.inbound ?? [];
}

export async function decideInboundChange(
  boardId: string,
  changeId: string,
  decision: "accept" | "dismiss",
): Promise<{ change?: InboundChangeView; duplicate?: boolean; seq?: number; error?: string; status?: number } | null> {
  const res = await authed(
    `/api/boards/${encodeURIComponent(boardId)}/integrations/inbound/${encodeURIComponent(changeId)}/${decision}`,
    { method: "POST" },
  );
  if (!res) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "decision failed" }))) as { error?: string };
    return { error: body.error ?? "decision failed", status: res.status };
  }
  return (await res.json()) as { change?: InboundChangeView; duplicate?: boolean; seq?: number };
}
