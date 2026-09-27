import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { hashPassword } from "../src/auth.js";
import { InMemoryScimIdentityStore } from "../src/scim.js";
import { InMemoryTeamStore } from "../src/teams.js";

/**
 * Teams (docs/26 A6): a group of a workspace's members a board can be
 * shared with — resolved when access is checked, so joining or leaving a
 * team changes what someone can do at once — and what an identity
 * provider's groups sync into.
 */

const SCIM_TOKEN = "scim-token-for-teams-test";
let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function harness(scimOrg = false) {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const teams = new InMemoryTeamStore();
  const identities = new InMemoryScimIdentityStore();
  // The org SCIM manages must exist before the app reads its config.
  const orgId = "org_teams_acme";
  await orgStore.insert({ id: orgId, name: "Acme", createdAt: 1 });
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    teams,
    boardStore: new InMemoryBoardStore(),
    secret: "teams-test-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    ...(scimOrg
      ? {
          scim: {
            config: { idp: "okta", token: SCIM_TOKEN, orgId },
            identities,
            hashPassword: async (password: string) => {
              const combined = await hashPassword(password);
              const at = combined.indexOf(":");
              return { salt: combined.slice(0, at), hash: combined.slice(at + 1) };
            },
          },
        }
      : {}),
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": path.startsWith("/scim") ? "application/scim+json" : "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const signup = async (email: string) => {
    const r = await api("POST", "/api/auth/signup", undefined, {
      email,
      password: "password123",
      name: email.split("@")[0],
    });
    const user = await userStore.findByEmail(email);
    await userStore.setEmailVerified(user!.id, Date.now());
    return { token: r.body.token as string, id: r.body.user.id as string, email };
  };
  const join = async (who: { id: string }, role: "owner" | "editor" | "viewer") => {
    await userStore.setMembership({ userId: who.id, orgId, role });
    await orgStore.setMembership({ userId: who.id, orgId, role });
  };
  const owner = await signup("owner@acme.com");
  await join(owner, "owner");
  const board = await api("POST", "/api/boards", owner.token, { name: "Design system", orgId });
  return { api, signup, join, owner, orgId, boardId: board.body.id as string, teams, identities };
}

/** What the caller can do on the board, as the member list reports it. */
const roleOn = async (h: Awaited<ReturnType<typeof harness>>, token: string) =>
  (await h.api("GET", `/api/boards/${h.boardId}/members`, token)).body.role;

describe("teams", () => {
  it("a team's grant raises what its members can do, while they're in it", async () => {
    const h = await harness();
    const vi = await h.signup("vi@acme.com");
    await h.join(vi, "viewer");
    expect(await roleOn(h, vi.token)).toBe("viewer");

    const team = await h.api("POST", `/api/orgs/${h.orgId}/teams`, h.owner.token, {
      name: "Design",
    });
    expect(team.status).toBe(201);
    const teamId = team.body.id as string;
    await h.api("PUT", `/api/orgs/${h.orgId}/teams/${teamId}/members/${vi.id}`, h.owner.token);
    const granted = await h.api("PUT", `/api/boards/${h.boardId}/teams/${teamId}`, h.owner.token, {
      role: "editor",
    });
    expect(granted.body).toMatchObject({ name: "Design", role: "editor" });
    expect(await roleOn(h, vi.token)).toBe("editor");
    // It shows who has access through which team.
    const listed = await h.api("GET", `/api/boards/${h.boardId}/teams`, vi.token);
    expect(listed.body.teams).toEqual([{ teamId, name: "Design", role: "editor", members: 1 }]);
    const orgTeams = await h.api("GET", `/api/orgs/${h.orgId}/teams`, vi.token);
    expect(orgTeams.body.teams[0]).toMatchObject({ name: "Design", managed: false });

    // Leaving the team takes it away at once.
    await h.api("DELETE", `/api/orgs/${h.orgId}/teams/${teamId}/members/${vi.id}`, h.owner.token);
    expect(await roleOn(h, vi.token)).toBe("viewer");
    // So does leaving the workspace, and deleting the team drops its grants.
    await h.api("PUT", `/api/orgs/${h.orgId}/teams/${teamId}/members/${vi.id}`, h.owner.token);
    await h.api("DELETE", `/api/orgs/${h.orgId}/members/${vi.id}`, h.owner.token);
    expect(await h.teams.members(teamId)).toEqual([]);
    await h.api("DELETE", `/api/orgs/${h.orgId}/teams/${teamId}`, h.owner.token);
    expect(await h.teams.grants(h.boardId)).toEqual([]);
  });

  it("teams hold members only, owners manage them, names don't repeat", async () => {
    const h = await harness();
    const guest = await h.signup("guest@client.example");
    const ed = await h.signup("ed@acme.com");
    await h.join(ed, "editor");
    const team = await h.api("POST", `/api/orgs/${h.orgId}/teams`, h.owner.token, {
      name: "Design",
    });
    const teamId = team.body.id as string;
    // A guest is never lifted by a team.
    expect(
      (
        await h.api(
          "PUT",
          `/api/orgs/${h.orgId}/teams/${teamId}/members/${guest.id}`,
          h.owner.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (await h.api("POST", `/api/orgs/${h.orgId}/teams`, h.owner.token, { name: "design" })).status,
    ).toBe(409);
    expect(
      (await h.api("POST", `/api/orgs/${h.orgId}/teams`, ed.token, { name: "Platform" })).status,
    ).toBe(404);
    expect(
      (await h.api("PUT", `/api/boards/${h.boardId}/teams/${teamId}`, ed.token, { role: "editor" }))
        .status,
    ).toBe(404);
    expect(
      (
        await h.api("PUT", `/api/boards/${h.boardId}/teams/${teamId}`, h.owner.token, {
          role: "owner",
        })
      ).status,
    ).toBe(400);
  });
});

describe("SCIM Groups → teams", () => {
  it("an identity provider's group becomes a managed team, and keeps its members in step", async () => {
    const h = await harness(true);
    const provision = async (externalId: string, email: string) =>
      h.api("POST", "/scim/v2/Users", SCIM_TOKEN, { externalId, userName: email });
    await provision("okta-ada", "ada@acme.com");
    await provision("okta-bo", "bo@acme.com");

    const created = await h.api("POST", "/scim/v2/Groups", SCIM_TOKEN, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      externalId: "okta-group-design",
      displayName: "Design",
      members: [{ value: "okta-ada" }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ displayName: "Design", members: [{ value: "okta-ada" }] });
    const teamId = created.body.id as string;

    // In the workspace, as a managed team; its members joined the workspace.
    const orgTeams = await h.api("GET", `/api/orgs/${h.orgId}/teams`, h.owner.token);
    expect(orgTeams.body.teams).toEqual([
      expect.objectContaining({ id: teamId, name: "Design", managed: true }),
    ]);
    expect(orgTeams.body.teams[0].members.map((m: { email: string }) => m.email)).toEqual([
      "ada@acme.com",
    ]);
    // The admin console can't fight the provider over it.
    expect(
      (await h.api("PATCH", `/api/orgs/${h.orgId}/teams/${teamId}`, h.owner.token, { name: "X" }))
        .status,
    ).toBe(409);

    const patched = await h.api("PATCH", `/scim/v2/Groups/${teamId}`, SCIM_TOKEN, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "add", path: "members", value: [{ value: "okta-bo" }] },
        { op: "remove", path: 'members[value eq "okta-ada"]' },
        { op: "replace", path: "displayName", value: "Design team" },
      ],
    });
    expect(patched.body).toMatchObject({
      displayName: "Design team",
      members: [{ value: "okta-bo" }],
    });

    const filtered = await h.api(
      "GET",
      `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "Design team"')}`,
      SCIM_TOKEN,
    );
    expect(filtered.body.totalResults).toBe(1);

    const gone = await h.api("DELETE", `/scim/v2/Groups/${teamId}`, SCIM_TOKEN);
    expect(gone.status).toBe(204);
    expect(await h.teams.list(h.orgId)).toEqual([]);
  });
});
