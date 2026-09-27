import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { projectBoards, projects, type DbProject } from "../db/schema.js";
import {
  applyProjectPatch,
  type ProjectPatch,
  type ProjectStatus,
  type ProjectStore,
  type StoredProject,
} from "../projects.js";

/**
 * Postgres-backed projects (docs/26 J2, ADR 0046). Board links live in
 * `project_boards`; deleting a board or a project removes its links by
 * cascade, so a project can never list a board that no longer exists.
 */
export class PostgresProjectStore implements ProjectStore {
  constructor(private readonly target: Db) {}

  private async withBoards(rows: DbProject[]): Promise<StoredProject[]> {
    if (rows.length === 0) return [];
    const links = await this.target.db
      .select()
      .from(projectBoards)
      .where(
        inArray(
          projectBoards.projectId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(projectBoards.addedAt));
    const byProject = new Map<string, string[]>();
    for (const link of links) {
      const list = byProject.get(link.projectId) ?? [];
      list.push(link.boardId);
      byProject.set(link.projectId, list);
    }
    return rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      name: r.name,
      objective: r.objective,
      status: r.status as ProjectStatus,
      leadId: r.leadId,
      members: Array.isArray(r.members) ? (r.members as string[]) : [],
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
      boardIds: byProject.get(r.id) ?? [],
    }));
  }

  async listForOrg(orgId: string, options: { includeArchived?: boolean } = {}) {
    const rows = await this.target.db
      .select()
      .from(projects)
      .where(
        options.includeArchived
          ? eq(projects.orgId, orgId)
          : and(eq(projects.orgId, orgId), isNull(projects.archivedAt)),
      )
      .orderBy(desc(projects.createdAt));
    return this.withBoards(rows);
  }

  async get(id: string) {
    const rows = await this.target.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return (await this.withBoards(rows))[0];
  }

  async create(project: StoredProject) {
    await this.target.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: project.id,
        orgId: project.orgId,
        name: project.name,
        objective: project.objective,
        status: project.status,
        leadId: project.leadId,
        members: project.members,
        createdBy: project.createdBy,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        archivedAt: project.archivedAt,
      });
      if (project.boardIds.length > 0) {
        await tx.insert(projectBoards).values(
          project.boardIds.map((boardId, i) => ({
            projectId: project.id,
            boardId,
            addedBy: project.createdBy,
            // Distinct stamps keep the caller's order on read.
            addedAt: project.createdAt + i,
          })),
        );
      }
    });
    return project;
  }

  async update(id: string, patch: ProjectPatch, at: number) {
    const current = await this.get(id);
    if (!current) return undefined;
    const next = applyProjectPatch(current, patch, at);
    await this.target.db
      .update(projects)
      .set({
        name: next.name,
        objective: next.objective,
        status: next.status,
        leadId: next.leadId,
        members: next.members,
        updatedAt: next.updatedAt,
        archivedAt: next.archivedAt,
      })
      .where(eq(projects.id, id));
    return next;
  }

  async linkBoard(projectId: string, boardId: string, by: string | null, at: number) {
    const inserted = await this.target.db
      .insert(projectBoards)
      .values({ projectId, boardId, addedBy: by, addedAt: at })
      .onConflictDoNothing({ target: [projectBoards.projectId, projectBoards.boardId] })
      .returning({ boardId: projectBoards.boardId });
    if (inserted.length === 0) return false;
    await this.target.db.update(projects).set({ updatedAt: at }).where(eq(projects.id, projectId));
    return true;
  }

  async unlinkBoard(projectId: string, boardId: string, at: number) {
    const removed = await this.target.db
      .delete(projectBoards)
      .where(and(eq(projectBoards.projectId, projectId), eq(projectBoards.boardId, boardId)))
      .returning({ boardId: projectBoards.boardId });
    if (removed.length === 0) return false;
    await this.target.db.update(projects).set({ updatedAt: at }).where(eq(projects.id, projectId));
    return true;
  }

  async forBoard(boardId: string) {
    const links = await this.target.db
      .select({ projectId: projectBoards.projectId })
      .from(projectBoards)
      .where(eq(projectBoards.boardId, boardId));
    if (links.length === 0) return [];
    const rows = await this.target.db
      .select()
      .from(projects)
      .where(
        and(
          inArray(
            projects.id,
            links.map((l) => l.projectId),
          ),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(desc(projects.createdAt));
    return this.withBoards(rows);
  }
}
