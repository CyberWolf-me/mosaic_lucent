import { randomBytes } from "node:crypto";
import type { BoardStore } from "./boards.js";
import { roleAtLeast, type Role } from "./identity.js";

/**
 * Teams inside a workspace (docs/26 A6): a named group of the org's members
 * — "Design", "Platform" — that a board can be shared with. Every member
 * already reads every board of their workspace at their workspace role; a
 * team grant raises what a group can do on particular boards (the design
 * team edits the design boards), and it's what an identity provider's
 * groups sync into (SCIM Groups).
 *
 * A team grant is resolved when access is checked, never copied onto people:
 * someone who joins the team has its boards at once, and someone who leaves
 * loses them at once (a board they have open keeps its role until they
 * rejoin the room). Teams hold members only — a guest is never in one.
 */

export type TeamRole = Extract<Role, "editor" | "commenter" | "viewer">;
export const TEAM_ROLES: readonly TeamRole[] = ["editor", "commenter", "viewer"];

export interface Team {
  id: string;
  orgId: string;
  name: string;
  createdAt: number;
  /** The identity provider's id, when SCIM manages the team. */
  externalId: string | null;
}

export interface TeamGrant {
  boardId: string;
  teamId: string;
  role: TeamRole;
}

export interface TeamStore {
  list(orgId: string): Promise<Team[]>;
  get(orgId: string, teamId: string): Promise<Team | undefined>;
  byExternalId(orgId: string, externalId: string): Promise<Team | undefined>;
  create(team: Team): Promise<void>;
  rename(orgId: string, teamId: string, name: string): Promise<boolean>;
  /** Deletes the team, its memberships and its board grants. */
  delete(orgId: string, teamId: string): Promise<boolean>;
  members(teamId: string): Promise<string[]>;
  addMember(teamId: string, userId: string): Promise<void>;
  removeMember(teamId: string, userId: string): Promise<void>;
  /** Replace the whole member list (SCIM PUT). */
  setMembers(teamId: string, userIds: readonly string[]): Promise<void>;
  /** Everyone leaving an org leaves its teams. */
  removeUserFromOrg(orgId: string, userId: string): Promise<void>;
  grants(boardId: string): Promise<TeamGrant[]>;
  setGrant(grant: TeamGrant): Promise<void>;
  removeGrant(boardId: string, teamId: string): Promise<boolean>;
  /** The strongest role a person holds on a board through their teams. */
  roleOnBoard(boardId: string, userId: string): Promise<TeamRole | undefined>;
}

export function newTeamId(): string {
  return "team_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

export const MAX_TEAM_NAME = 80;

export function strongest(roles: ReadonlyArray<Role | undefined>): Role | undefined {
  let best: Role | undefined;
  for (const role of roles) {
    if (role && (!best || roleAtLeast(role, best))) best = role;
  }
  return best;
}

export class InMemoryTeamStore implements TeamStore {
  private readonly teams = new Map<string, Team>();
  private readonly memberSets = new Map<string, Set<string>>();
  private readonly grantRows = new Map<string, TeamGrant>();

  async list(orgId: string): Promise<Team[]> {
    return [...this.teams.values()]
      .filter((t) => t.orgId === orgId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(orgId: string, teamId: string): Promise<Team | undefined> {
    const team = this.teams.get(teamId);
    return team && team.orgId === orgId ? { ...team } : undefined;
  }

  async byExternalId(orgId: string, externalId: string): Promise<Team | undefined> {
    return [...this.teams.values()].find((t) => t.orgId === orgId && t.externalId === externalId);
  }

  async create(team: Team): Promise<void> {
    this.teams.set(team.id, { ...team });
    this.memberSets.set(team.id, new Set());
  }

  async rename(orgId: string, teamId: string, name: string): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team || team.orgId !== orgId) return false;
    this.teams.set(teamId, { ...team, name });
    return true;
  }

  async delete(orgId: string, teamId: string): Promise<boolean> {
    const team = this.teams.get(teamId);
    if (!team || team.orgId !== orgId) return false;
    this.teams.delete(teamId);
    this.memberSets.delete(teamId);
    for (const [key, grant] of this.grantRows) {
      if (grant.teamId === teamId) this.grantRows.delete(key);
    }
    return true;
  }

  async members(teamId: string): Promise<string[]> {
    return [...(this.memberSets.get(teamId) ?? [])];
  }

  async addMember(teamId: string, userId: string): Promise<void> {
    this.memberSets.get(teamId)?.add(userId);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    this.memberSets.get(teamId)?.delete(userId);
  }

  async setMembers(teamId: string, userIds: readonly string[]): Promise<void> {
    if (this.teams.has(teamId)) this.memberSets.set(teamId, new Set(userIds));
  }

  async removeUserFromOrg(orgId: string, userId: string): Promise<void> {
    for (const team of this.teams.values()) {
      if (team.orgId === orgId) this.memberSets.get(team.id)?.delete(userId);
    }
  }

  async grants(boardId: string): Promise<TeamGrant[]> {
    return [...this.grantRows.values()].filter((g) => g.boardId === boardId);
  }

  async setGrant(grant: TeamGrant): Promise<void> {
    this.grantRows.set(`${grant.boardId}:${grant.teamId}`, { ...grant });
  }

  async removeGrant(boardId: string, teamId: string): Promise<boolean> {
    return this.grantRows.delete(`${boardId}:${teamId}`);
  }

  async roleOnBoard(boardId: string, userId: string): Promise<TeamRole | undefined> {
    const roles = (await this.grants(boardId))
      .filter((g) => this.memberSets.get(g.teamId)?.has(userId))
      .map((g) => g.role);
    return strongest(roles) as TeamRole | undefined;
  }
}

/**
 * A board store whose effective roles include team grants. Only the calls
 * that resolve an EFFECTIVE role (they pass the org-role resolver) consult
 * teams, and only for members of the board's org: a call asking "does this
 * person hold a direct grant?" still gets exactly that answer, and a guest
 * is never lifted by a team they can't be in.
 */
export function withTeamGrants(boards: BoardStore, teams: TeamStore): BoardStore {
  return new Proxy(boards, {
    get(target, prop, receiver) {
      if (prop === "memberRole") {
        return async (
          boardId: string,
          userId: string,
          lookupOrgRole?: (userId: string) => Promise<Role | undefined>,
        ): Promise<Role | undefined> => {
          const role = await target.memberRole(boardId, userId, lookupOrgRole);
          if (!lookupOrgRole || role === "owner") return role;
          if (!(await lookupOrgRole(userId))) return role;
          return strongest([role, await teams.roleOnBoard(boardId, userId)]);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
