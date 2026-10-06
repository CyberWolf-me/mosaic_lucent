import type { Workspace } from "@lucent/core";

/**
 * V1 persistence: projects saved to localStorage (docs/07; PostgreSQL/S3 are
 * deferred to the full MVP per docs/06). Each project stores its semantic
 * workspace and conversation so a session can be reloaded.
 */

const INDEX_KEY = "lucent.projects";
const PROJECT_PREFIX = "lucent.project.";
/** Id of the project the user had open, so a reload returns to it. */
const LAST_OPEN_KEY = "lucent.lastProject";

/* --------------------------- account scoping ------------------------------ */

/**
 * Local persistence is scoped per signed-in account. Every key here used to be
 * global to the browser profile, so creating a NEW account on the same browser
 * inherited the previous account's whole project list — the dashboard showed
 * someone else's boards as "Recents", and the boot restore dropped them into
 * the last account's workspace. Keys are now namespaced by the session user's
 * id (`lucent.u.<userId>.<key>`); `session.ts` sets the scope on every auth
 * transition (signup, login, 2FA, logout, and the boot `/api/auth/me` check).
 *
 * The legacy global keys are adopted exactly once — by whichever account is
 * signed in when the scoping code first runs — so the person who already has
 * boards here keeps them. Every account authenticated after that claim starts
 * with a clean slate, which is the bug this fixes.
 */
const SCOPE_MARKER_KEY = "lucent.scope";
const LEGACY_CLAIM_KEY = "lucent.legacyClaimed";
/** The namespace in effect for this tab; null = legacy global keys. */
let scope: string | null = readCurrentScope();

function readCurrentScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_MARKER_KEY);
  } catch {
    return null;
  }
}

/**
 * Switch the active namespace. `null` returns to the legacy global keys (the
 * signed-out / local-only view). Passing the same user again is a no-op.
 */
export function setPersistenceScope(userId: string | null): void {
  const next = userId ?? null;
  if (next === scope) return;
  scope = next;
  try {
    if (next === null) localStorage.removeItem(SCOPE_MARKER_KEY);
    else localStorage.setItem(SCOPE_MARKER_KEY, next);
  } catch {
    /* storage unavailable: scoping stays in-memory for this tab */
  }
  if (next !== null) adoptLegacyKeysOnce(next);
}

/**
 * One-time adoption: the pre-scoping data sitting under the global keys moves
 * into the first account that authenticates on this browser, and the claim
 * marker keeps every later account from inheriting it. Copy (not move) — the
 * signed-out view still reads the legacy keys, and a botched migration must
 * never destroy the only copy of someone's boards.
 */
function adoptLegacyKeysOnce(userId: string): void {
  try {
    if (localStorage.getItem(LEGACY_CLAIM_KEY) !== null) return;
    // Snapshot the key list first: setItem below grows the storage, and the
    // DOM enumeration contract makes live iteration over a growing list
    // implementation-defined.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) keys.push(key);
    }
    for (const key of keys) {
      const isProjectRecord = key.startsWith(PROJECT_PREFIX);
      const isWorkspaceKey = key === INDEX_KEY || key === LAST_OPEN_KEY || key === SHARED_BOARD_KEY;
      if (!isProjectRecord && !isWorkspaceKey) continue;
      const value = localStorage.getItem(key);
      if (value === null) continue;
      const scopedKey = scopedName(key);
      if (localStorage.getItem(scopedKey) === null) {
        localStorage.setItem(scopedKey, value);
      }
    }
    localStorage.setItem(LEGACY_CLAIM_KEY, userId);
  } catch {
    /* best effort: worst case the user re-creates the boards */
  }
}

/** Map a legacy key name to the active namespace (`lucent.x` → `lucent.u.<id>.x`). */
function scopedName(key: string): string {
  if (scope === null || !key.startsWith("lucent.")) return key;
  return `lucent.u.${scope}.${key.slice("lucent.".length)}`;
}

/**
 * The active namespace's name for `key` — for sibling modules (orgs.ts) that
 * keep their own per-account key but should not re-implement the scoping rule.
 */
export function scopedStorageKey(key: string): string {
  return scopedName(key);
}

/** Storage helpers every reader/writer goes through, so scoping is one seam. */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(scopedName(key));
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  return safeSetItem(scopedName(key), value);
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(scopedName(key));
  } catch {
    /* ignore */
  }
}

export interface ChatEntry {
  role: "user" | "ai" | "error";
  text: string;
  /**
   * On an AI reply: what Lucent says back when the person is talking to it
   * (GenerateResult.reply) — a conversational sentence, often ending in a
   * question, spoken instead of the change description in `text`.
   */
  reply?: string;
  /**
   * On an AI reply that changed the board: what it changed (turnEffect.ts),
   * computed from the ops actually applied. The conversation then reads as
   * a log of what the team's board learned, not just of messages. Optional
   * so older saved conversations keep parsing.
   */
  effect?: import("./turnEffect.js").TurnEffect;
  /**
   * True when the AI judged this request to be about a different system than
   * the board shows (the prompt's parallel-diagram rule) and described what it
   * would build instead. The chat entry then carries a one-click "create that
   * board" affordance. Set only on `role: "ai"` entries; optional so older
   * saved conversations keep parsing.
   */
  suggestNewBoard?: boolean;
  /**
   * On a `suggestNewBoard` entry: the user's original prompt that the AI
   * answered, so the action can re-run it on the fresh board without the
   * renderer needing access to the surrounding chat history.
   */
  originPrompt?: string;
  /**
   * Partial-application report (M1): operations the server skipped, each with
   * the validator's own reason. The chat entry renders these under the reply
   * so the user sees exactly which relationships didn't land ("target not
   * found") instead of a silent gap — and can ask Lucent to fix just those.
   */
  skippedOps?: Array<{ op: string; reason: string }>;
  /**
   * Evidence links (Stage C1): on an Ask reply, the citations the server
   * resolved against real, visible state. Each renders as a chip that jumps
   * to its evidence — node → select+focus on the canvas, meeting → the
   * transcript, revision → the history view. Optional so older saved
   * conversations keep parsing.
   */
  citations?: Array<{
    kind: "node" | "meeting" | "revision";
    id: string;
    label: string;
    detail?: string;
    why?: string;
    turnRange?: [number, number];
  }>;
  /**
   * On an Ask reply: true when older revisions exist beyond the caller's
   * visible history window. The answer itself already discloses the limit in
   * prose (the historian prompt's rule); this bit lets the UI badge the
   * entry without re-parsing the text.
   */
  historyTruncated?: boolean;
  /** How well an Ask answer is supported (ADR 0048), computed on the server. */
  confidence?: { level: "none" | "low" | "medium" | "high"; reason: string };
  /**
   * On a generation-failure `error` entry: the user's original prompt, so
   * the entry renders a one-click "try again" affordance (found live,
   * 2026-09-10: three provider 502s left an empty board behind a transient
   * toast; the failure persisted in chat, but re-running meant retyping the
   * whole request). Set only by the failure arm; older conversations parse
   * unchanged.
   */
  retryPrompt?: string;
  /**
   * On an AI entry: the model replied in words and drew nothing — an answer,
   * an opinion, a question back. On an empty board the launch screen shows
   * it, so the person can write back instead of watching their request vanish.
   */
  drewNothing?: boolean;
}

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
}

/**
 * A review-gate batch's durable record (2026-09 direction: "finish the one
 * obvious reliability gap"). Previously a proposal lived only in React
 * state — a browser refresh silently dropped the AI's proposed changes while
 * the chat reply describing them survived, which read as Lucent losing work.
 *
 * Statuses and transitions (all idempotent — a repeated click, or a replayed
 * transition after a reload, is a no-op rather than a double-apply):
 *
 *   pending   → approved  (the ops committed; the record archives itself)
 *   pending   → rejected  (discarded from the board; the record archives)
 *   pending   → superseded (a NEWER proposal replaced it before review)
 *
 * Terminal records stay in the project (an audit trail: what Lucent proposed
 * and what the user did about it) until the next proposal overwrites the slot
 * — one proposal is pending per board at a time, because the review panel is
 * a single decision surface.
 */
export type ProposalStatus = "pending" | "approved" | "rejected" | "superseded";

export interface PersistedProposal {
  /** Stable across saves; a new proposal mints a new id. */
  id: string;
  /** Copied from the project for when the record is read outside context. */
  boardId: string | null;
  /**
   * The live meeting this batch came from, when it did. The proposal is then
   * the review gate for a meeting extraction, and the meeting id links it to
   * the transcript turns below.
   */
  meetingId: string | null;
  /** The source turns, quoted, when the proposal came from meeting capture. */
  turns?: string[];
  /** Stable index range of those turns in the meeting (Stage A provenance). */
  turnRange?: [number, number];
  /** Kinds of the source turns, when the capture classified them. */
  turnKinds?: string[];
  operations: import("@lucent/core").Operation[];
  status: ProposalStatus;
  createdAt: number;
  /** The request that produced the batch, for re-anchoring the review UI. */
  request: string;
  explanation: string;
}

export interface ProjectData extends ProjectMeta {
  workspace: Workspace;
  chat: ChatEntry[];
  /**
   * The current (or most recently decided) proposal for this board, when
   * there is one to remember. Absent on older saves.
   */
  proposal?: PersistedProposal;
  /**
   * Decided proposals, newest last, capped (`PROPOSAL_HISTORY_CAP`). The audit
   * trail: what Lucent proposed and what the user did about it. Absent on
   * older saves.
   */
  proposalHistory?: PersistedProposal[];
  /**
   * Workspace architectural rules & durable context: persistent tech stack,
   * architectural constraints, naming conventions, and prohibited patterns.
   */
  rules?: string;
}

/** How many decided proposals the project remembers. */
export const PROPOSAL_HISTORY_CAP = 10;

/** Mint a proposal record id — same shape as the other local ids. */
export function newProposalId(): string {
  return `prp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** True when the record can still be decided; false for terminal states. */
export function proposalIsPending(record: PersistedProposal | undefined): boolean {
  return record?.status === "pending";
}

/**
 * Idempotent transition. A record already in a terminal state keeps it — the
 * second click of a double-click, or a decision replayed after a reload, is a
 * no-op rather than a second apply. Returns the updated record.
 */
export function decideProposal(
  record: PersistedProposal,
  decision: Exclude<ProposalStatus, "pending">,
): PersistedProposal {
  if (record.status !== "pending") return record;
  return { ...record, status: decision };
}

/**
 * Open a new proposal record: a pending predecessor (if any) is superseded
 * first, and both land in the returned project fields. Pure — the caller
 * owns the state and the save.
 */
export function openProposalIn(
  data: Pick<ProjectData, "proposal" | "proposalHistory">,
  record: Omit<PersistedProposal, "status">,
): { proposal: PersistedProposal; proposalHistory: PersistedProposal[] } {
  const history = [...(data.proposalHistory ?? [])];
  if (proposalIsPending(data.proposal)) {
    history.push({ ...data.proposal!, status: "superseded" });
  }
  const opened: PersistedProposal = { ...record, status: "pending" };
  return {
    proposal: opened,
    // Newest last, bounded: the cap is the audit window, not a growth path.
    proposalHistory: history.slice(-PROPOSAL_HISTORY_CAP),
  };
}

/**
 * Archive a decision: the record gains its terminal status, moves to the end
 * of the history, and stays in the active slot as the "most recently decided"
 * record (the review panel only reads *pending* ones, so a decided record in
 * the slot is inert — it just keeps the audit complete in one save).
 */
export function archiveDecision(
  data: Pick<ProjectData, "proposal" | "proposalHistory">,
  decision: Exclude<ProposalStatus, "pending">,
): { proposal: PersistedProposal; proposalHistory: PersistedProposal[] } {
  const current = data.proposal;
  if (!current) {
    throw new Error("archiveDecision requires a current proposal");
  }
  const decided = decideProposal(current, decision);
  const history = (data.proposalHistory ?? [])
    .filter((p) => p.id !== decided.id)
    .concat([decided])
    .slice(-PROPOSAL_HISTORY_CAP);
  return { proposal: decided, proposalHistory: history };
}

function readIndex(): ProjectMeta[] {
  const raw = lsGet(INDEX_KEY);
  try {
    return raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(index: ProjectMeta[]): void {
  lsSet(INDEX_KEY, JSON.stringify(index));
}

/**
 * Listeners for storage errors. Workspace subscribes to surface a toast when
 * the browser refuses a write because localStorage is full — without this
 * the failure was invisible and the user kept editing a board that wouldn't
 * survive a reload (M0.5).
 */
const storageListeners = new Set<(message: string) => void>();
export function onStorageError(listener: (message: string) => void): () => void {
  storageListeners.add(listener);
  return () => storageListeners.delete(listener);
}
function emitStorageError(message: string): void {
  for (const l of storageListeners) l(message);
}

/**
 * Set a localStorage key with quota handling. Browser quotas vary (~5–10 MB
 * by origin), so a large workspace can hit the wall during a single save.
 * Returning false lets upstream code try a recovery (drop oldest project,
 * compress, etc.) without crashing.
 */
function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    emitStorageError(
      `Local storage is full and the autosave for "${key}" was rejected. ` +
        `Free up some space or move this board to the server. (${(err as Error).message})`,
    );
    return false;
  }
}

export function listProjects(): ProjectMeta[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadProject(id: string): ProjectData | null {
  try {
    const raw = lsGet(PROJECT_PREFIX + id);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<ProjectData>;
    // A record without a workspace is a half-finished save (found by the live
    // test pass: the new-board action switched projects before any autosave
    // had written the new one). Loading it whole would hand `undefined` to
    // every reader of `.workspace`; treat it as absent so the caller falls
    // back to an empty board rather than crashing on it.
    if (!data || !data.id || !data.workspace) return null;
    // Back-compat: fill in fields added after older projects were saved.
    const ws = data.workspace;
    if (ws) {
      if (!ws.wireframes) data.workspace = { ...ws, wireframes: {} };
      if (!ws.shapes) data.workspace = { ...data.workspace, shapes: {} };
      if (!ws.shapeLinks) data.workspace = { ...data.workspace, shapeLinks: {} };
      if (!ws.votes) data.workspace = { ...data.workspace, votes: {} };
      if (!ws.reactions) data.workspace = { ...data.workspace, reactions: {} };
      if (!ws.comments) data.workspace = { ...data.workspace, comments: {} };
    }
    data.chat = Array.isArray(data.chat) ? data.chat : [];
    // A proposal record from a pre-persistence save can't exist; from an
    // interim build it may lack a status. Anything malformed is dropped
    // rather than surfaced — a proposal is recoverable (re-ask), a crash on
    // load is not.
    if (data.proposal && data.proposal.operations && data.proposal.id) {
      const p = data.proposal;
      data.proposal = { ...p, status: p.status ?? "pending" };
    } else {
      delete data.proposal;
    }
    return data as ProjectData;
  } catch {
    return null;
  }
}

export function saveProject(data: Omit<ProjectData, "updatedAt">): ProjectData {
  const record: ProjectData = { ...data, updatedAt: Date.now() };
  const ok = lsSet(PROJECT_PREFIX + record.id, JSON.stringify(record));
  if (!ok) return record;
  const index = readIndex().filter((p) => p.id !== record.id);
  index.push({ id: record.id, name: record.name, updatedAt: record.updatedAt });
  writeIndex(index);
  return record;
}

export function deleteProject(id: string): void {
  lsRemove(PROJECT_PREFIX + id);
  writeIndex(readIndex().filter((p) => p.id !== id));
}

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A default project name that doesn't collide with any currently saved
 * project. Derived from the actual set of persisted names (not a counter),
 * so it survives reloads and is never fooled by deleted projects — every
 * "New workspace" used to save the same hardcoded "Untitled workspace",
 * which is why every session's cards carried identical names.
 */
export function uniqueProjectName(base = "Untitled workspace"): string {
  const names = new Set(readIndex().map((p) => p.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * The local autosave slot for a server-side board.
 *
 * Autosave writes under whichever project id is current, so a board opened
 * from the server needs an id of its own: without one, opening a shared board
 * makes the next autosave overwrite whatever local project happened to be open
 * with the shared board's content. Derived from the board id rather than minted
 * so re-opening the same board reuses one mirror instead of accumulating a
 * local project per visit, and `isMirrorProjectId` lets the dashboard tell a
 * mirror apart from a genuinely local project.
 */
const MIRROR_PREFIX = "board-";

export function mirrorProjectId(boardId: string): string {
  return MIRROR_PREFIX + boardId;
}

export function isMirrorProjectId(id: string): boolean {
  return id.startsWith(MIRROR_PREFIX);
}

/** The board a mirror slot belongs to, or null when the id is a local project. */
export function boardIdOfMirror(id: string): string | null {
  return id.startsWith(MIRROR_PREFIX) ? id.slice(MIRROR_PREFIX.length) : null;
}

/**
 * Remember/forget which project was open. Without this the app booted a brand
 * new empty workspace on every reload, so saved work looked lost even though it
 * was on disk — the board had to be re-opened by hand from the dashboard.
 */
export function setLastOpenProject(id: string | null): void {
  if (id) lsSet(LAST_OPEN_KEY, id);
  else lsRemove(LAST_OPEN_KEY);
}

/** The most recent project that still exists, or null on a first run. */
export function loadLastOpenProject(): ProjectData | null {
  try {
    const id = lsGet(LAST_OPEN_KEY);
    if (id) {
      const data = loadProject(id);
      if (data) return data;
    }
    // Fall back to the newest saved project so a stale pointer still recovers work.
    const newest = listProjects()[0];
    return newest ? loadProject(newest.id) : null;
  } catch {
    return null;
  }
}

/**
 * Id of the server-side board this browser is collaborating on, if any. Kept
 * separate from the local project index: a shared board lives on the server and
 * is rejoined after a reload, whereas local projects are this browser's only.
 */
const SHARED_BOARD_KEY = "lucent.sharedBoard";

export function setSharedBoardId(id: string | null): void {
  if (id) lsSet(SHARED_BOARD_KEY, id);
  else lsRemove(SHARED_BOARD_KEY);
}

export function getSharedBoardId(): string | null {
  return lsGet(SHARED_BOARD_KEY);
}
