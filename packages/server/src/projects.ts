import { randomBytes } from "node:crypto";

/**
 * Projects (docs/26 J2, ADR 0046): org-scoped records that gather boards —
 * and through them meetings and intelligence — around one objective.
 *
 * A project grants nothing. Every board in it is still read through board
 * access, so the routes filter a project's boards by what the caller can
 * read; `members` names who works on it (for filters and, later,
 * notifications), never who may see it.
 */

export const PROJECT_STATUSES = ["active", "paused", "done"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const MAX_PROJECT_NAME = 120;
export const MAX_PROJECT_OBJECTIVE = 2000;
export const MAX_PROJECT_MEMBERS = 200;

export interface StoredProject {
  id: string;
  orgId: string;
  name: string;
  objective: string;
  status: ProjectStatus;
  leadId: string | null;
  members: string[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** Linked boards, oldest link first. */
  boardIds: string[];
}

/** The fields a caller may set. */
export interface ProjectPatch {
  name?: string;
  objective?: string;
  status?: ProjectStatus;
  leadId?: string | null;
  members?: string[];
  archived?: boolean;
}

export interface ProjectStore {
  /** The org's projects, newest first; archived ones only when asked. */
  listForOrg(orgId: string, options?: { includeArchived?: boolean }): Promise<StoredProject[]>;
  get(id: string): Promise<StoredProject | undefined>;
  create(project: StoredProject): Promise<StoredProject>;
  update(id: string, patch: ProjectPatch, at: number): Promise<StoredProject | undefined>;
  /** Link a board. False when it was already linked. */
  linkBoard(projectId: string, boardId: string, by: string | null, at: number): Promise<boolean>;
  /** Unlink a board. False when it wasn't linked. */
  unlinkBoard(projectId: string, boardId: string, at: number): Promise<boolean>;
  /** The projects a board is linked to, archived ones excluded. */
  forBoard(boardId: string): Promise<StoredProject[]>;
}

export function newProjectId(): string {
  return "prj_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function checkMembers(value: unknown): Checked<string[]> {
  if (!Array.isArray(value)) return { ok: false, error: "members must be a list of user ids" };
  const ids = [...new Set(value)];
  if (ids.length > MAX_PROJECT_MEMBERS) {
    return { ok: false, error: `a project lists at most ${MAX_PROJECT_MEMBERS} members` };
  }
  if (!ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) {
    return { ok: false, error: "members must be a list of user ids" };
  }
  return { ok: true, value: ids as string[] };
}

/**
 * Validate a create (`name` required) or an update (every field optional).
 * Unknown keys are refused rather than ignored, so a typo can't silently
 * drop a change.
 */
export function validateProjectInput(
  body: unknown,
  mode: "create" | "update",
): Checked<ProjectPatch & { boardIds?: string[] }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "expected a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["name", "objective", "status", "leadId", "members", "archived"]);
  if (mode === "create") allowed.add("boardIds");
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown field "${key}"` };
  }
  const out: ProjectPatch & { boardIds?: string[] } = {};
  if ("name" in input || mode === "create") {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return { ok: false, error: "a project needs a name" };
    if (name.length > MAX_PROJECT_NAME) {
      return { ok: false, error: `a project name is at most ${MAX_PROJECT_NAME} characters` };
    }
    out.name = name;
  }
  if ("objective" in input) {
    if (typeof input.objective !== "string") return { ok: false, error: "objective must be text" };
    const objective = input.objective.trim();
    if (objective.length > MAX_PROJECT_OBJECTIVE) {
      return {
        ok: false,
        error: `an objective is at most ${MAX_PROJECT_OBJECTIVE} characters`,
      };
    }
    out.objective = objective;
  }
  if ("status" in input) {
    if (!PROJECT_STATUSES.includes(input.status as ProjectStatus)) {
      return { ok: false, error: `status is one of ${PROJECT_STATUSES.join(", ")}` };
    }
    out.status = input.status as ProjectStatus;
  }
  if ("leadId" in input) {
    if (input.leadId !== null && (typeof input.leadId !== "string" || !input.leadId)) {
      return { ok: false, error: "leadId is a user id, or null" };
    }
    out.leadId = input.leadId;
  }
  if ("members" in input) {
    const members = checkMembers(input.members);
    if (!members.ok) return members;
    out.members = members.value;
  }
  if ("archived" in input) {
    if (typeof input.archived !== "boolean")
      return { ok: false, error: "archived is true or false" };
    out.archived = input.archived;
  }
  if ("boardIds" in input) {
    if (
      !Array.isArray(input.boardIds) ||
      !input.boardIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
      return { ok: false, error: "boardIds must be a list of board ids" };
    }
    out.boardIds = [...new Set(input.boardIds as string[])];
  }
  return { ok: true, value: out };
}

/** Apply a validated patch to a record (the in-memory store and tests share this). */
export function applyProjectPatch(
  project: StoredProject,
  patch: ProjectPatch,
  at: number,
): StoredProject {
  const next: StoredProject = { ...project, updatedAt: at };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.objective !== undefined) next.objective = patch.objective;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.leadId !== undefined) next.leadId = patch.leadId;
  if (patch.members !== undefined) next.members = [...patch.members];
  if (patch.archived !== undefined) {
    next.archivedAt = patch.archived ? (project.archivedAt ?? at) : null;
  }
  return next;
}

export class InMemoryProjectStore implements ProjectStore {
  private readonly rows = new Map<string, StoredProject>();

  async listForOrg(orgId: string, options: { includeArchived?: boolean } = {}) {
    return [...this.rows.values()]
      .filter((p) => p.orgId === orgId && (options.includeArchived || p.archivedAt === null))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => ({ ...p, boardIds: [...p.boardIds] }));
  }

  async get(id: string) {
    const p = this.rows.get(id);
    return p ? { ...p, boardIds: [...p.boardIds] } : undefined;
  }

  async create(project: StoredProject) {
    this.rows.set(project.id, { ...project, boardIds: [...project.boardIds] });
    return { ...project };
  }

  async update(id: string, patch: ProjectPatch, at: number) {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const next = applyProjectPatch(current, patch, at);
    this.rows.set(id, next);
    return { ...next, boardIds: [...next.boardIds] };
  }

  async linkBoard(projectId: string, boardId: string, _by: string | null, at: number) {
    const p = this.rows.get(projectId);
    if (!p || p.boardIds.includes(boardId)) return false;
    this.rows.set(projectId, { ...p, boardIds: [...p.boardIds, boardId], updatedAt: at });
    return true;
  }

  async unlinkBoard(projectId: string, boardId: string, at: number) {
    const p = this.rows.get(projectId);
    if (!p || !p.boardIds.includes(boardId)) return false;
    this.rows.set(projectId, {
      ...p,
      boardIds: p.boardIds.filter((id) => id !== boardId),
      updatedAt: at,
    });
    return true;
  }

  async forBoard(boardId: string) {
    return [...this.rows.values()]
      .filter((p) => p.archivedAt === null && p.boardIds.includes(boardId))
      .map((p) => ({ ...p, boardIds: [...p.boardIds] }));
  }
}
