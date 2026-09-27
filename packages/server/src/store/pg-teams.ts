import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { boardTeamGrants, teamMembers, teams } from "../db/schema.js";
import { strongest, type Team, type TeamGrant, type TeamRole, type TeamStore } from "../teams.js";

type Handle = Db["db"];

/** docs/26 A6: teams, their members and their board grants in Postgres. */
export class PostgresTeamStore implements TeamStore {
  constructor(private readonly db: Handle) {}

  private toTeam(row: typeof teams.$inferSelect): Team {
    return {
      id: row.id,
      orgId: row.orgId,
      name: row.name,
      createdAt: row.createdAt,
      externalId: row.externalId,
    };
  }

  async list(orgId: string): Promise<Team[]> {
    const rows = await this.db.select().from(teams).where(eq(teams.orgId, orgId));
    return rows.map((r) => this.toTeam(r)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(orgId: string, teamId: string): Promise<Team | undefined> {
    const [row] = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)));
    return row ? this.toTeam(row) : undefined;
  }

  async byExternalId(orgId: string, externalId: string): Promise<Team | undefined> {
    const [row] = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.externalId, externalId)));
    return row ? this.toTeam(row) : undefined;
  }

  async create(team: Team): Promise<void> {
    await this.db.insert(teams).values({
      id: team.id,
      orgId: team.orgId,
      name: team.name,
      externalId: team.externalId,
      createdAt: team.createdAt,
    });
  }

  async rename(orgId: string, teamId: string, name: string): Promise<boolean> {
    const updated = await this.db
      .update(teams)
      .set({ name })
      .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)))
      .returning();
    return updated.length > 0;
  }

  async delete(orgId: string, teamId: string): Promise<boolean> {
    // Members and grants go with it (ON DELETE CASCADE).
    const gone = await this.db
      .delete(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.id, teamId)))
      .returning();
    return gone.length > 0;
  }

  async members(teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId));
    return rows.map((r) => r.userId);
  }

  async addMember(teamId: string, userId: string): Promise<void> {
    await this.db.insert(teamMembers).values({ teamId, userId }).onConflictDoNothing();
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  }

  async setMembers(teamId: string, userIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
      if (userIds.length > 0) {
        await tx
          .insert(teamMembers)
          .values([...new Set(userIds)].map((userId) => ({ teamId, userId })));
      }
    });
  }

  async removeUserFromOrg(orgId: string, userId: string): Promise<void> {
    const ids = (await this.list(orgId)).map((t) => t.id);
    if (ids.length === 0) return;
    await this.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, ids)));
  }

  async grants(boardId: string): Promise<TeamGrant[]> {
    const rows = await this.db
      .select()
      .from(boardTeamGrants)
      .where(eq(boardTeamGrants.boardId, boardId));
    return rows.map((r) => ({ boardId: r.boardId, teamId: r.teamId, role: r.role as TeamRole }));
  }

  async setGrant(grant: TeamGrant): Promise<void> {
    await this.db
      .insert(boardTeamGrants)
      .values(grant)
      .onConflictDoUpdate({
        target: [boardTeamGrants.boardId, boardTeamGrants.teamId],
        set: { role: grant.role },
      });
  }

  async removeGrant(boardId: string, teamId: string): Promise<boolean> {
    const gone = await this.db
      .delete(boardTeamGrants)
      .where(and(eq(boardTeamGrants.boardId, boardId), eq(boardTeamGrants.teamId, teamId)))
      .returning();
    return gone.length > 0;
  }

  async roleOnBoard(boardId: string, userId: string): Promise<TeamRole | undefined> {
    const rows = await this.db
      .select({ role: boardTeamGrants.role })
      .from(boardTeamGrants)
      .innerJoin(teamMembers, eq(teamMembers.teamId, boardTeamGrants.teamId))
      .where(and(eq(boardTeamGrants.boardId, boardId), eq(teamMembers.userId, userId)));
    return strongest(rows.map((r) => r.role as TeamRole)) as TeamRole | undefined;
  }
}
