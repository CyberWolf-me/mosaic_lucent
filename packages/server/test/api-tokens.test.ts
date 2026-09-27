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
import { apiTokenRefusal } from "../src/apiTokens.js";

/**
 * Personal API tokens (docs/26 A6): a token acts as its person, in one
 * workspace, at its scope — read as a viewer, write as an editor at most —
 * and can never manage the account or mint more of itself.
 */

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function harness() {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    boardStore: new InMemoryBoardStore(),
    secret: "api-tokens-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const signup = async (email: string, name: string) => {
    const r = await api("POST", "/api/auth/signup", undefined, {
      email,
      password: "password123",
      name,
    });
    return { token: r.body.token as string, id: r.body.user.id as string };
  };
  const owner = await signup("owner@acme.com", "Olive");
  const orgId = (await api("POST", "/api/orgs", owner.token, { name: "Acme" })).body.id as string;
  const join = async (email: string, name: string, role: "editor" | "viewer") => {
    const person = await signup(email, name);
    await userStore.setMembership({ userId: person.id, orgId, role });
    await orgStore.setMembership({ userId: person.id, orgId, role });
    return person;
  };
  const ed = await join("ed@acme.com", "Ed", "editor");
  const board = (await api("POST", "/api/boards", owner.token, { name: "Roadmap", orgId })).body
    .id as string;
  const mint = async (who: string, scopes: string[], org = orgId) =>
    api("POST", "/api/me/tokens", who, { name: "script", orgId: org, scopes });
  const op = (label: string) => ({
    label,
    ops: [
      {
        op: "CREATE_NODE",
        id: `n_${Math.random().toString(36).slice(2, 8)}`,
        nodeType: "process",
        label,
      },
    ],
  });
  return { api, owner, ed, join, orgId, board, mint, op };
}

describe("API tokens", () => {
  it("act as their person, in one workspace, at their scope", async () => {
    const h = await harness();
    const made = await h.mint(h.ed.token, ["read"]);
    expect(made.status).toBe(201);
    const read = made.body.token as string;
    expect(read).toMatch(/^lct_[A-Za-z0-9_-]{43}$/);
    expect(made.body).toMatchObject({ orgName: "Acme", scopes: ["read"], name: "script" });
    expect(made.body.expiresAt).toBeGreaterThan(Date.now() + 89 * 86_400_000);

    // The list never carries the token, or its hash.
    const listed = await h.api("GET", "/api/me/tokens", h.ed.token);
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(read);
    expect(listed.body.tokens[0].tokenHash).toBeUndefined();

    // Read: as a viewer, and only reading.
    expect((await h.api("GET", "/api/auth/me", read)).body.user.name).toBe("Ed");
    expect((await h.api("GET", `/api/boards/${h.board}`, read)).status).toBe(200);
    const wrote = await h.api("POST", `/api/boards/${h.board}/ops`, read, h.op("nope"));
    expect(wrote.status).toBe(403);
    expect(wrote.body.error).toMatch(/can only read/);

    // One workspace: Ed's own personal workspace isn't reachable with it,
    // and isn't even listed.
    const orgs = await h.api("GET", "/api/orgs", read);
    expect(orgs.body.orgs.map((o: { name: string }) => o.name)).toEqual(["Acme"]);
    const personal = `org_personal_${h.ed.id}`;
    expect((await h.api("GET", `/api/boards?orgId=${personal}`, read)).status).toBe(404);

    // Never the account, or more tokens.
    for (const [method, path] of [
      ["GET", "/api/me/tokens"],
      ["POST", "/api/me/tokens"],
      ["POST", "/api/auth/2fa/enroll"],
      ["POST", "/api/auth/signout-all"],
      ["POST", "/api/realtime/ticket"],
      ["GET", `/api/orgs/${h.orgId}/tokens`],
    ] as const) {
      expect((await h.api(method, path, read)).status, `${method} ${path}`).toBe(403);
    }

    // Write: changes things, as an editor at most — never as an owner.
    const write = (await h.mint(h.owner.token, ["read", "write"])).body.token as string;
    expect((await h.api("POST", `/api/boards/${h.board}/ops`, write, h.op("ok"))).status).toBe(200);
    const settings = await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, write, {
      sharingDisabled: true,
    });
    expect(settings.status).toBe(404);
    expect(
      (await h.api("GET", `/api/orgs/${h.orgId}/settings`, h.owner.token)).body.effective,
    ).toMatchObject({ sharingDisabled: false });
  });

  it("stop at once when revoked, turned off, or their person leaves", async () => {
    const h = await harness();
    const first = (await h.mint(h.ed.token, ["read"])).body;
    const second = (await h.mint(h.ed.token, ["read"])).body;
    const third = (await h.mint(h.ed.token, ["read"])).body;
    const opens = async (token: string) =>
      (await h.api("GET", `/api/boards/${h.board}`, token)).status;

    // Revoked by its person.
    expect((await h.api("DELETE", `/api/me/tokens/${first.id}`, h.ed.token)).status).toBe(200);
    expect(await opens(first.token)).toBe(401);

    // Revoked by an owner, who sees every token that reaches the workspace.
    const all = await h.api("GET", `/api/orgs/${h.orgId}/tokens`, h.owner.token);
    expect(all.body.tokens.map((t: { userName: string }) => t.userName)).toEqual(["Ed", "Ed"]);
    expect(JSON.stringify(all.body)).not.toContain(second.token);
    await h.api("DELETE", `/api/orgs/${h.orgId}/tokens/${second.id}`, h.owner.token);
    expect(await opens(second.token)).toBe(401);

    // Turned off for the workspace: every token stops, none can be made.
    await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, {
      apiTokensDisabled: true,
    });
    expect(await opens(third.token)).toBe(403);
    expect((await h.mint(h.ed.token, ["read"])).status).toBe(403);
    await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, {
      apiTokensDisabled: false,
    });
    expect(await opens(third.token)).toBe(200);

    // Its person leaves the workspace: the token reaches nothing.
    await h.api("DELETE", `/api/orgs/${h.orgId}/members/${h.ed.id}`, h.owner.token);
    expect(await opens(third.token)).toBe(404);

    // Every make and revoke is in the audit log.
    const audit = await h.api("GET", `/api/orgs/${h.orgId}/audit`, h.owner.token);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === "api_token.created")).toHaveLength(3);
    expect(actions.filter((a: string) => a === "api_token.revoked")).toHaveLength(2);
  });

  it("can only do what their person can", async () => {
    const h = await harness();
    const vi = await h.join("vi@acme.com", "Vi", "viewer");
    const refused = await h.mint(vi.token, ["read", "write"]);
    expect(refused.status).toBe(400);
    expect((await h.mint(vi.token, ["read"])).status).toBe(201);
    // A workspace you're not in.
    const outsider = (
      await h.api("POST", "/api/auth/signup", undefined, {
        email: "out@example.com",
        password: "password123",
        name: "Out",
      })
    ).body.token as string;
    expect((await h.mint(outsider, ["read"])).status).toBe(404);
    expect((await h.api("GET", "/api/boards/1", "lct_not-a-real-token")).status).toBe(401);
  });
});

describe("apiTokenRefusal", () => {
  it("lets a token read its person, and nothing about the account", () => {
    expect(apiTokenRefusal("GET", "/api/auth/me", ["read"])).toBeNull();
    expect(apiTokenRefusal("GET", "/api/auth/sessions", ["read", "write"])).not.toBeNull();
    expect(apiTokenRefusal("POST", "/api/account/delete", ["read", "write"])).not.toBeNull();
    expect(apiTokenRefusal("POST", "/api/boards/b1/join", ["read", "write"])).not.toBeNull();
    expect(apiTokenRefusal("POST", "/api/orgs", ["read", "write"])).not.toBeNull();
    expect(apiTokenRefusal("GET", "/api/orgs", ["read"])).toBeNull();
    expect(apiTokenRefusal("POST", "/api/boards/b1/ops", ["read", "write"])).toBeNull();
    expect(apiTokenRefusal("POST", "/api/boards/b1/ops", ["read"])).toMatch(/only read/);
  });
});
