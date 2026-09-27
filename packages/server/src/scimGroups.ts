import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readScimBody,
  writeScimError,
  writeScimJson,
  type ScimIdentityStore,
  type ScimListResponse,
} from "./scim.js";
import { MAX_TEAM_NAME, newTeamId, type Team, type TeamStore } from "./teams.js";

/**
 * SCIM Groups → teams (docs/26 A6). An identity provider's groups become
 * the teams of one workspace — `LUCENT_SCIM_ORG_ID` names it, since the SCIM
 * gateway serves a deployment, not an org. A group's members are SCIM users
 * (their `id` is the provider's external id); a member who isn't in the
 * workspace yet is added as an editor, the same way SSO admits someone.
 *
 * A team a provider created carries its external id and is "managed": the
 * admin console can't rename it or change its members (the provider would
 * undo it), but can share boards with it.
 *
 *   GET /Groups[?filter=displayName eq "x"] · GET/PUT/PATCH/DELETE /Groups/:id · POST /Groups
 */

export interface ScimGroupsDeps {
  orgId: string;
  idp: string;
  teams: TeamStore;
  identities: ScimIdentityStore;
  /** Make sure this person is a member of the org (added as editor if not). */
  ensureMember(userId: string): Promise<void>;
  now(): number;
}

const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

interface GroupBody {
  displayName?: unknown;
  externalId?: unknown;
  members?: unknown;
}

async function toScim(deps: ScimGroupsDeps, team: Team, baseUrl: string) {
  const members = [];
  for (const userId of await deps.teams.members(team.id)) {
    const identity = await deps.identities.byUserId(deps.idp, userId);
    if (identity) members.push({ value: identity.externalId });
  }
  return {
    schemas: [GROUP_SCHEMA],
    id: team.id,
    ...(team.externalId ? { externalId: team.externalId } : {}),
    displayName: team.name,
    members,
    meta: {
      resourceType: "Group",
      created: new Date(team.createdAt).toISOString(),
      location: `${baseUrl}/scim/v2/Groups/${encodeURIComponent(team.id)}`,
    },
  };
}

/** SCIM member references → Lucent user ids (unknown references are skipped). */
async function resolveMembers(deps: ScimGroupsDeps, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    const value = (entry as { value?: unknown } | null)?.value;
    if (typeof value !== "string") continue;
    const identity = await deps.identities.byExternalId(deps.idp, value);
    if (!identity) continue;
    await deps.ensureMember(identity.userId);
    ids.push(identity.userId);
  }
  return [...new Set(ids)];
}

function displayNameOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= MAX_TEAM_NAME ? name : null;
}

/** `members[value eq "abc"]` → "abc". */
function memberFilterValue(path: string): string | null {
  const match = /^members\[value eq "([^"]+)"\]$/i.exec(path.trim());
  return match ? match[1]! : null;
}

export async function handleScimGroups(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  baseUrl: string,
  deps: ScimGroupsDeps,
): Promise<void> {
  const base = "/scim/v2/Groups";
  const id = url.length > base.length ? decodeURIComponent(url.slice(base.length + 1)) : null;
  const team = id ? await deps.teams.get(deps.orgId, id) : undefined;

  if (!id) {
    if (req.method === "GET") {
      const query = new URL(req.url ?? "/", "http://scim.local").searchParams;
      const filter = query.get("filter");
      const wanted = filter ? /^displayName eq "([^"]*)"$/i.exec(filter.trim())?.[1] : undefined;
      let teams = await deps.teams.list(deps.orgId);
      if (filter) teams = wanted === undefined ? [] : teams.filter((t) => t.name === wanted);
      const resources = [];
      for (const t of teams) resources.push(await toScim(deps, t, baseUrl));
      const body: ScimListResponse<Record<string, unknown>> = {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: resources.length,
        Resources: resources,
        startIndex: 1,
        itemsPerPage: resources.length,
      };
      return writeScimJson(res, 200, null, body);
    }
    if (req.method === "POST") {
      const parsed = await readScimBody(req);
      if (!parsed.ok) return writeScimJson(res, parsed.status, null, parsed.scimError);
      const body = parsed.body as GroupBody;
      const name = displayNameOf(body.displayName);
      if (!name) return writeScimError(res, 400, "displayName is required");
      if ((await deps.teams.list(deps.orgId)).some((t) => t.name === name)) {
        return writeScimError(res, 409, `a group named "${name}" already exists`);
      }
      const teamId = newTeamId();
      const created: Team = {
        id: teamId,
        orgId: deps.orgId,
        name,
        createdAt: deps.now(),
        externalId:
          typeof body.externalId === "string" && body.externalId ? body.externalId : teamId,
      };
      await deps.teams.create(created);
      await deps.teams.setMembers(teamId, await resolveMembers(deps, body.members));
      const location = `${baseUrl}${base}/${encodeURIComponent(teamId)}`;
      return writeScimJson(res, 201, location, await toScim(deps, created, baseUrl));
    }
    return writeScimError(res, 405, "method not allowed");
  }

  if (!team) return writeScimError(res, 404, "group not found");

  if (req.method === "GET") return writeScimJson(res, 200, null, await toScim(deps, team, baseUrl));

  if (req.method === "DELETE") {
    await deps.teams.delete(deps.orgId, team.id);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "PUT") {
    const parsed = await readScimBody(req);
    if (!parsed.ok) return writeScimJson(res, parsed.status, null, parsed.scimError);
    const body = parsed.body as GroupBody;
    const name = displayNameOf(body.displayName);
    if (!name) return writeScimError(res, 400, "displayName is required");
    await deps.teams.rename(deps.orgId, team.id, name);
    await deps.teams.setMembers(team.id, await resolveMembers(deps, body.members));
    const fresh = (await deps.teams.get(deps.orgId, team.id))!;
    return writeScimJson(res, 200, null, await toScim(deps, fresh, baseUrl));
  }

  if (req.method === "PATCH") {
    const parsed = await readScimBody(req);
    if (!parsed.ok) return writeScimJson(res, parsed.status, null, parsed.scimError);
    const patch = parsed.body as { schemas?: unknown; Operations?: unknown };
    if (!Array.isArray(patch.Operations)) {
      return writeScimError(res, 400, `a PatchOp (${PATCH_SCHEMA}) needs Operations`);
    }
    for (const raw of patch.Operations) {
      const op = String((raw as { op?: unknown }).op ?? "").toLowerCase();
      const path =
        typeof (raw as { path?: unknown }).path === "string" ? (raw as { path: string }).path : "";
      const value = (raw as { value?: unknown }).value;
      const lower = path.toLowerCase();
      if (op === "add" && lower === "members") {
        for (const userId of await resolveMembers(deps, value)) {
          await deps.teams.addMember(team.id, userId);
        }
      } else if (op === "remove" && memberFilterValue(path)) {
        const identity = await deps.identities.byExternalId(deps.idp, memberFilterValue(path)!);
        if (identity) await deps.teams.removeMember(team.id, identity.userId);
      } else if (op === "remove" && lower === "members") {
        if (Array.isArray(value)) {
          for (const entry of value) {
            const ref = (entry as { value?: unknown } | null)?.value;
            if (typeof ref !== "string") continue;
            const identity = await deps.identities.byExternalId(deps.idp, ref);
            if (identity) await deps.teams.removeMember(team.id, identity.userId);
          }
        } else {
          await deps.teams.setMembers(team.id, []);
        }
      } else if (op === "replace" && lower === "members") {
        await deps.teams.setMembers(team.id, await resolveMembers(deps, value));
      } else if (op === "replace" && (lower === "displayname" || !path)) {
        const next = displayNameOf(
          lower === "displayname"
            ? value
            : (value as { displayName?: unknown } | null)?.displayName,
        );
        if (next) await deps.teams.rename(deps.orgId, team.id, next);
        if (!path && (value as { members?: unknown } | null)?.members !== undefined) {
          await deps.teams.setMembers(
            team.id,
            await resolveMembers(deps, (value as { members: unknown }).members),
          );
        }
      } else {
        return writeScimError(res, 400, `unsupported group operation: ${op} ${path}`);
      }
    }
    const fresh = (await deps.teams.get(deps.orgId, team.id))!;
    return writeScimJson(res, 200, null, await toScim(deps, fresh, baseUrl));
  }

  return writeScimError(res, 405, "method not allowed");
}
