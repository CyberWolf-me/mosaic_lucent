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

export interface ChatEntry {
  role: "user" | "ai" | "error";
  text: string;
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
}

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
}

export interface ProjectData extends ProjectMeta {
  workspace: Workspace;
  chat: ChatEntry[];
}

function readIndex(): ProjectMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(index: ProjectMeta[]): void {
  safeSetItem(INDEX_KEY, JSON.stringify(index));
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
    const raw = localStorage.getItem(PROJECT_PREFIX + id);
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
    return data as ProjectData;
  } catch {
    return null;
  }
}

export function saveProject(data: Omit<ProjectData, "updatedAt">): ProjectData {
  const record: ProjectData = { ...data, updatedAt: Date.now() };
  const ok = safeSetItem(PROJECT_PREFIX + record.id, JSON.stringify(record));
  if (!ok) return record;
  const index = readIndex().filter((p) => p.id !== record.id);
  index.push({ id: record.id, name: record.name, updatedAt: record.updatedAt });
  writeIndex(index);
  return record;
}

export function deleteProject(id: string): void {
  localStorage.removeItem(PROJECT_PREFIX + id);
  writeIndex(readIndex().filter((p) => p.id !== id));
}

export function newProjectId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
  try {
    if (id) localStorage.setItem(LAST_OPEN_KEY, id);
    else localStorage.removeItem(LAST_OPEN_KEY);
  } catch {
    /* storage unavailable (private mode / quota) — restore is best-effort */
  }
}

/** The most recent project that still exists, or null on a first run. */
export function loadLastOpenProject(): ProjectData | null {
  try {
    const id = localStorage.getItem(LAST_OPEN_KEY);
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
  try {
    if (id) localStorage.setItem(SHARED_BOARD_KEY, id);
    else localStorage.removeItem(SHARED_BOARD_KEY);
  } catch {
    /* storage unavailable — sharing just won't survive a reload */
  }
}

export function getSharedBoardId(): string | null {
  try {
    return localStorage.getItem(SHARED_BOARD_KEY);
  } catch {
    return null;
  }
}
