import type { Role } from "./identity.js";
import type { BoardStore } from "./boards.js";
import { effectiveSettings, type OrgPolicySource } from "./classification.js";
import { currentApiToken } from "./apiTokens.js";

/**
 * Who may reach a workspace right now, beyond their role (docs/26 A6).
 *
 * A workspace that requires two-step verification is closed to anyone who
 * hasn't turned it on — a member, a team, or a guest given one board. It
 * isn't a login gate: the person stays signed in and keeps every other
 * workspace; this one opens again the moment they enroll.
 *
 * The rule is applied where access is decided, and only there: the org role
 * (`orgRoleFor`) and the board role (`memberRole`, wrapped once by
 * `withAccessPolicy`). Every guard, the realtime room and every workspace
 * read already go through one of the two, so they agree without knowing the
 * policy exists. Paths that enumerate memberships to list content ask
 * `blocked` directly.
 *
 * A request made with an API token (apiTokens.ts) is held here too: it
 * reaches only the token's workspace, and never above the token's scope —
 * `read` as a viewer, `write` as an editor at most. Only the caller's own
 * access is limited; a question about someone else's role (is the person I
 * am sharing with a member?) is answered as it is.
 */

export type AccessBlock = "two_factor" | "token_scope";

const ROLE_ORDER: readonly Role[] = ["viewer", "commenter", "editor", "owner"];

/** The weaker of two roles. */
function capRole<R extends Role>(role: R, cap: Role): R {
  return (ROLE_ORDER.indexOf(role) > ROLE_ORDER.indexOf(cap) ? cap : role) as R;
}

export interface AccessPolicyDeps {
  /** The org as the policy reads it; undefined when there's no org store. */
  org(orgId: string): Promise<OrgPolicySource>;
  /** Whether this person has two-step verification on. */
  hasTwoFactor(userId: string): Promise<boolean>;
  now?: () => number;
}

/** Settings change rarely; a short cache keeps the policy off the hot path. */
const SETTINGS_TTL_MS = 15_000;
const BOARD_ORG_TTL_MS = 60_000;
const BOARD_ORG_CAP = 5_000;

export class AccessPolicy {
  private readonly requires = new Map<string, { at: number; value: boolean }>();
  private readonly boardOrgs = new Map<string, { at: number; orgId: string }>();

  constructor(private readonly deps: AccessPolicyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Whether the workspace requires two-step verification. */
  async requiresTwoFactor(orgId: string): Promise<boolean> {
    const hit = this.requires.get(orgId);
    if (hit && this.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const value = effectiveSettings(await this.deps.org(orgId)).requireTwoFactor;
    this.requires.set(orgId, { at: this.now(), value });
    return value;
  }

  /** A settings write lands at once in this process (others within the TTL). */
  forgetOrg(orgId: string): void {
    this.requires.delete(orgId);
  }

  /** Whether this person has two-step verification on. */
  hasTwoFactor(userId: string): Promise<boolean> {
    return this.deps.hasTwoFactor(userId);
  }

  /** Why this person can't reach this workspace right now, or null. */
  async blocked(userId: string, orgId: string): Promise<AccessBlock | null> {
    const token = currentApiToken();
    if (token && token.userId === userId && token.orgId !== orgId) return "token_scope";
    if ((await this.requiresTwoFactor(orgId)) && !(await this.hasTwoFactor(userId))) {
      return "two_factor";
    }
    return null;
  }

  /**
   * The role as it may be used right now: undefined when blocked, and no
   * more than an API token's scope allows.
   */
  async allow<R extends Role>(
    userId: string,
    orgId: string,
    role: R | undefined,
  ): Promise<R | undefined> {
    if (!role) return undefined;
    if (await this.blocked(userId, orgId)) return undefined;
    const token = currentApiToken();
    if (token && token.userId === userId) {
      return capRole(role, token.scopes.includes("write") ? "editor" : "viewer");
    }
    return role;
  }

  /** The org a board lives in (cached briefly; a board rarely moves). */
  async boardOrg(boards: BoardStore, boardId: string): Promise<string | undefined> {
    const hit = this.boardOrgs.get(boardId);
    if (hit && this.now() - hit.at < BOARD_ORG_TTL_MS) return hit.orgId;
    const board = await boards.get(boardId);
    if (!board) return undefined;
    if (this.boardOrgs.size >= BOARD_ORG_CAP) this.boardOrgs.clear();
    this.boardOrgs.set(boardId, { at: this.now(), orgId: board.orgId });
    return board.orgId;
  }
}

/** Every board role, as the access policy allows it. */
export function withAccessPolicy(boards: BoardStore, policy: AccessPolicy): BoardStore {
  return new Proxy(boards, {
    get(target, prop, receiver) {
      if (prop === "memberRole") {
        return async (
          boardId: string,
          userId: string,
          lookupOrgRole?: (userId: string) => Promise<Role | undefined>,
        ): Promise<Role | undefined> => {
          const role = await target.memberRole(boardId, userId, lookupOrgRole);
          if (!role) return role;
          const orgId = await policy.boardOrg(target, boardId);
          return orgId ? policy.allow(userId, orgId, role) : role;
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
