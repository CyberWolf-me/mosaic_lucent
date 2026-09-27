import type { StatementKind, StatementStatus } from "@lucent/core";
import { apiFetch } from "./http.js";
import type { MeetingSummary } from "./meetings.js";

/**
 * Workspace projects and workspace intelligence (docs/26 J2/J3, ADR 0046) —
 * the server's view across every board this person can read.
 *
 * Named `OrgProject` on purpose: elsewhere in this app a "project" is the
 * open board (`projectId`, the local boards in `persistence.ts`). An
 * `OrgProject` is the org-level record that gathers boards around an
 * objective, and it grants nothing — its boards, meetings and statements
 * come back only where the board itself could be opened.
 */

export type OrgProjectStatus = "active" | "paused" | "done";

export interface ProjectStats {
  openQuestions: number;
  openActions: number;
  blocked: number;
  decisions: number;
  openRisks: number;
}

export interface OrgProject {
  id: string;
  orgId: string;
  name: string;
  objective: string;
  status: OrgProjectStatus;
  leadId: string | null;
  members: string[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  /** The linked boards this person can open. */
  boards: Array<{ id: string; name: string; updatedAt: number }>;
  stats?: ProjectStats;
}

/** One statement from the workspace index, with the board it lives on. */
export interface WorkspaceStatement {
  kind: StatementKind;
  /** The node on its board. */
  id: string;
  label: string;
  status: StatementStatus;
  boardId: string;
  boardName: string;
  blocked: boolean;
  topic?: string;
  supersedes?: string[];
  assignee?: string;
  dueDate?: string;
  executionStatus?: string;
  drivesActions?: number;
  provenance?: { meetingId: string; turnRange?: [number, number] };
  /** ADR 0047: how it came to be trusted; absent before trust existed. */
  trust?: import("@lucent/core").StatementTrust;
}

export interface WorkspaceIntelligence {
  statements: WorkspaceStatement[];
  total: number;
  truncated: boolean;
  counts: Record<StatementKind, { total: number; open: number }>;
  boards: number;
}

export interface ProjectPage {
  project: OrgProject;
  meetings: MeetingSummary[];
  statements: WorkspaceStatement[];
}

const orgPath = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}`;

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function listOrgProjects(
  orgId: string,
  options: { archived?: boolean } = {},
): Promise<OrgProject[] | null> {
  try {
    const res = await apiFetch(
      `${orgPath(orgId)}/projects${options.archived ? "?archived=1" : ""}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { projects?: OrgProject[] };
    return Array.isArray(body.projects) ? body.projects : [];
  } catch {
    return null;
  }
}

export async function getOrgProject(orgId: string, projectId: string): Promise<ProjectPage | null> {
  try {
    const res = await apiFetch(`${orgPath(orgId)}/projects/${encodeURIComponent(projectId)}`);
    if (!res.ok) return null;
    return (await res.json()) as ProjectPage;
  } catch {
    return null;
  }
}

export async function createOrgProject(
  orgId: string,
  input: { name: string; objective?: string; boardIds?: string[] },
): Promise<Result<OrgProject>> {
  try {
    const res = await apiFetch(`${orgPath(orgId)}/projects`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res, "Couldn't create the project.") };
    return { ok: true, value: (await res.json()) as OrgProject };
  } catch {
    return { ok: false, error: "Couldn't reach Lucent. Try again." };
  }
}

export async function updateOrgProject(
  orgId: string,
  projectId: string,
  patch: Partial<Pick<OrgProject, "name" | "objective" | "status">> & { archived?: boolean },
): Promise<Result<OrgProject>> {
  try {
    const res = await apiFetch(`${orgPath(orgId)}/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res, "Couldn't save the project.") };
    return { ok: true, value: (await res.json()) as OrgProject };
  } catch {
    return { ok: false, error: "Couldn't reach Lucent. Try again." };
  }
}

export async function setProjectBoard(
  orgId: string,
  projectId: string,
  boardId: string,
  linked: boolean,
): Promise<Result<OrgProject>> {
  try {
    const res = await apiFetch(
      `${orgPath(orgId)}/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}`,
      { method: linked ? "PUT" : "DELETE" },
    );
    if (!res.ok)
      return { ok: false, error: await errorOf(res, "Couldn't change the project's boards.") };
    return { ok: true, value: (await res.json()) as OrgProject };
  } catch {
    return { ok: false, error: "Couldn't reach Lucent. Try again." };
  }
}

/** The projects a board belongs to — empty when there are none or the call fails. */
export async function projectsOfBoard(
  boardId: string,
): Promise<Array<{ id: string; name: string; status: OrgProjectStatus }>> {
  try {
    const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/projects`);
    if (!res.ok) return [];
    const body = (await res.json()) as {
      projects?: Array<{ id: string; name: string; status: OrgProjectStatus }>;
    };
    return Array.isArray(body.projects) ? body.projects : [];
  } catch {
    return [];
  }
}

/**
 * Every statement on the boards this person can read in the org, narrowed by
 * kind, status, project, board or assignee (`"me"`). Null when the call fails.
 */
export async function loadWorkspaceIntelligence(
  orgId: string,
  filter: {
    kinds?: StatementKind[];
    statuses?: StatementStatus[];
    project?: string;
    board?: string;
    assignee?: string;
    limit?: number;
  } = {},
): Promise<WorkspaceIntelligence | null> {
  const params = new URLSearchParams();
  if (filter.kinds?.length) params.set("kind", filter.kinds.join(","));
  if (filter.statuses?.length) params.set("status", filter.statuses.join(","));
  if (filter.project) params.set("project", filter.project);
  if (filter.board) params.set("board", filter.board);
  if (filter.assignee) params.set("assignee", filter.assignee);
  if (filter.limit) params.set("limit", String(filter.limit));
  const query = params.toString();
  try {
    const res = await apiFetch(`${orgPath(orgId)}/intelligence${query ? `?${query}` : ""}`);
    if (!res.ok) return null;
    return (await res.json()) as WorkspaceIntelligence;
  } catch {
    return null;
  }
}
