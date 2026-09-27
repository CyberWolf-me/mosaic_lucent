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

/**
 * Favorites and the activity feed (docs/26 A6): what you star comes first,
 * shown only while you can open it; the feed tells you what others changed
 * on the boards you follow — never what you did yourself.
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
    secret: "me-routes-secret-16chars",
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
  const org = await api("POST", "/api/orgs", owner.token, { name: "Acme" });
  const orgId = org.body.id as string;
  const ed = await signup("ed@acme.com", "Ed");
  await userStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  await orgStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  const board = async (name: string) =>
    (await api("POST", "/api/boards", owner.token, { name, orgId })).body.id as string;
  const edit = (boardId: string, token: string, label: string) =>
    api("POST", `/api/boards/${boardId}/ops`, token, {
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
  return { api, owner, ed, orgId, board, edit };
}

describe("favorites", () => {
  it("stars what you can open, shows it while you still can", async () => {
    const h = await harness();
    const roadmap = await h.board("Roadmap");
    const outsider = (
      await h.api("POST", "/api/auth/signup", undefined, {
        email: "out@example.com",
        password: "password123",
        name: "Out",
      })
    ).body.token as string;
    expect((await h.api("PUT", `/api/me/favorites/board/${roadmap}`, outsider)).status).toBe(404);

    expect((await h.api("PUT", `/api/me/favorites/board/${roadmap}`, h.ed.token)).status).toBe(200);
    const project = await h.api("POST", `/api/orgs/${h.orgId}/projects`, h.owner.token, {
      name: "Launch",
    });
    await h.api("PUT", `/api/me/favorites/project/${project.body.id}`, h.ed.token);
    const listed = await h.api("GET", "/api/me/favorites", h.ed.token);
    expect(
      listed.body.favorites.map((f: { kind: string; name: string }) => [f.kind, f.name]),
    ).toEqual([
      ["project", "Launch"],
      ["board", "Roadmap"],
    ]);

    // A board in the trash is no longer there to open.
    await h.api("DELETE", `/api/boards/${roadmap}`, h.owner.token);
    const after = await h.api("GET", "/api/me/favorites", h.ed.token);
    expect(after.body.favorites.map((f: { name: string }) => f.name)).toEqual(["Launch"]);
    await h.api("DELETE", `/api/me/favorites/project/${project.body.id}`, h.ed.token);
    expect((await h.api("GET", "/api/me/favorites", h.ed.token)).body.favorites).toEqual([]);
  });
});

describe("the activity feed", () => {
  it("shows what others changed on boards you follow — never your own edits", async () => {
    const h = await harness();
    const roadmap = await h.board("Roadmap");
    const pricing = await h.board("Pricing");
    await h.edit(roadmap, h.ed.token, "Added the launch date");
    await h.edit(pricing, h.ed.token, "Priced the annual plan");
    await h.edit(roadmap, h.owner.token, "My own tweak");
    await h.api("PUT", `/api/me/favorites/board/${pricing}`, h.owner.token);

    const feed = await h.api("GET", "/api/me/activity", h.owner.token);
    const items = feed.body.activity as Array<{
      boardName: string;
      label: string;
      actor: string;
      starred: boolean;
    }>;
    expect(items.map((i) => i.label)).toEqual(
      expect.arrayContaining(["Added the launch date", "Priced the annual plan"]),
    );
    expect(items.some((i) => i.label === "My own tweak")).toBe(false);
    expect(items.find((i) => i.label === "Priced the annual plan")).toMatchObject({
      boardName: "Pricing",
      actor: "Ed",
      starred: true,
    });
    // Ed's feed has the owner's edit, not his own.
    const theirs = await h.api("GET", "/api/me/activity", h.ed.token);
    expect(theirs.body.activity.map((i: { label: string }) => i.label)).toEqual(["My own tweak"]);
  });
});
