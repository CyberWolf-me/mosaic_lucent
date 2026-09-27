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
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryProjectStore } from "../src/projects.js";
import { InMemoryTrashStore, TRASH_WINDOW_MS, purgeExpiredTrash } from "../src/trash.js";

/**
 * The trash (docs/26 A6): deleting a board, a meeting or a project hides it
 * everywhere for 30 days — restorable, exactly as it was, by whoever could
 * delete it — and it goes for good after that.
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
  const boardStore = new InMemoryBoardStore();
  const meetings = new InMemoryMeetingStore();
  const projects = new InMemoryProjectStore();
  const trash = new InMemoryTrashStore();
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    boardStore,
    meetings,
    projects,
    trash,
    secret: "trash-test-secret-16chars",
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
  const owner = await signup("owner@acme.com");
  const org = await api("POST", "/api/orgs", owner.token, { name: "Acme" });
  const orgId = org.body.id as string;
  const join = async (email: string, role: "editor" | "viewer") => {
    const who = await signup(email);
    await userStore.setMembership({ userId: who.id, orgId, role });
    await orgStore.setMembership({ userId: who.id, orgId, role });
    return who;
  };
  return { api, owner, orgId, join, boardStore, meetings, projects, trash };
}

describe("the trash", () => {
  it("a deleted board is gone everywhere, and comes back exactly as it was", async () => {
    const h = await harness();
    const ed = await h.join("ed@acme.com", "editor");
    const board = await h.api("POST", "/api/boards", h.owner.token, {
      name: "Roadmap",
      orgId: h.orgId,
    });
    const boardId = board.body.id as string;
    await h.api("POST", `/api/boards/${boardId}/ops`, h.owner.token, {
      label: "seed",
      ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "process", label: "Keep me" }],
    });
    await h.api("POST", `/api/boards/${boardId}/members`, h.owner.token, {
      email: ed.email,
      role: "editor",
    });

    expect((await h.api("DELETE", `/api/boards/${boardId}`, h.owner.token)).status).toBe(204);
    expect((await h.api("GET", `/api/boards/${boardId}`, h.owner.token)).status).toBe(404);
    const listed = await h.api("GET", `/api/boards?orgId=${h.orgId}`, h.owner.token);
    expect(listed.body.boards.map((b: { id: string }) => b.id)).not.toContain(boardId);
    expect(await h.boardStore.countForOrg(h.orgId)).toBe(0);

    const inTrash = await h.api("GET", `/api/orgs/${h.orgId}/trash`, h.owner.token);
    expect(inTrash.body.items).toEqual([
      expect.objectContaining({ kind: "board", id: boardId, name: "Roadmap", deletedBy: "owner" }),
    ]);
    expect(inTrash.body.items[0].purgeAt - inTrash.body.items[0].deletedAt).toBe(TRASH_WINDOW_MS);
    // An editor who doesn't own it neither sees it there nor brings it back.
    expect((await h.api("GET", `/api/orgs/${h.orgId}/trash`, ed.token)).body.items).toEqual([]);
    expect(
      (
        await h.api("POST", `/api/orgs/${h.orgId}/trash/restore`, ed.token, {
          kind: "board",
          id: boardId,
        })
      ).status,
    ).toBe(404);

    const restored = await h.api("POST", `/api/orgs/${h.orgId}/trash/restore`, h.owner.token, {
      kind: "board",
      id: boardId,
    });
    expect(restored.status).toBe(200);
    const back = await h.api("GET", `/api/boards/${boardId}`, h.owner.token);
    expect(back.body.workspace.nodes.n1.label).toBe("Keep me");
    // Its grants came back with it.
    expect((await h.api("GET", `/api/boards/${boardId}`, ed.token)).status).toBe(200);
  });

  it("meetings and projects go to the trash too", async () => {
    const h = await harness();
    const board = await h.api("POST", "/api/boards", h.owner.token, {
      name: "Plan",
      orgId: h.orgId,
    });
    const boardId = board.body.id as string;
    const ended = await h.meetings.insert({
      boardId,
      orgId: h.orgId,
      startedAt: Date.UTC(2026, 8, 1),
      endedAt: Date.UTC(2026, 8, 1, 1),
      turns: [{ speaker: "A", at: 1, text: "Hi" }],
      createdBy: h.owner.id,
      createdAt: 1,
      title: "Kickoff",
    });
    const live = await h.meetings.insert({
      boardId,
      orgId: h.orgId,
      startedAt: Date.now(),
      endedAt: null,
      turns: [],
      createdBy: h.owner.id,
      createdAt: 2,
    });
    expect(
      (await h.api("DELETE", `/api/boards/${boardId}/meetings/${live.id}`, h.owner.token)).status,
    ).toBe(409);
    expect(
      (await h.api("DELETE", `/api/boards/${boardId}/meetings/${ended.id}`, h.owner.token)).status,
    ).toBe(200);
    const meetings = await h.api("GET", `/api/boards/${boardId}/meetings`, h.owner.token);
    expect(meetings.body.meetings.map((m: { id: string }) => m.id)).toEqual([live.id]);

    const project = await h.api("POST", `/api/orgs/${h.orgId}/projects`, h.owner.token, {
      name: "Launch",
      boardIds: [boardId],
    });
    const projectId = project.body.id as string;
    await h.api("DELETE", `/api/orgs/${h.orgId}/projects/${projectId}`, h.owner.token);
    expect(
      (await h.api("GET", `/api/orgs/${h.orgId}/projects/${projectId}`, h.owner.token)).status,
    ).toBe(404);

    const trash = await h.api("GET", `/api/orgs/${h.orgId}/trash`, h.owner.token);
    expect(trash.body.items.map((i: { kind: string; name: string }) => [i.kind, i.name])).toEqual([
      ["project", "Launch"],
      ["meeting", "Kickoff"],
    ]);
    await h.api("POST", `/api/orgs/${h.orgId}/trash/restore`, h.owner.token, {
      kind: "meeting",
      id: ended.id,
    });
    const again = await h.api("GET", `/api/boards/${boardId}/meetings`, h.owner.token);
    expect(again.body.meetings).toHaveLength(2);

    // An owner can delete for good now.
    const purged = await h.api(
      "DELETE",
      `/api/orgs/${h.orgId}/trash/project/${projectId}`,
      h.owner.token,
    );
    expect(purged.status).toBe(200);
    expect(await h.projects.get(projectId)).toBeUndefined();
  });

  it("the sweep purges what's been there past its 30 days, and nothing newer", async () => {
    const h = await harness();
    const old = await h.api("POST", "/api/boards", h.owner.token, { name: "Old", orgId: h.orgId });
    const fresh = await h.api("POST", "/api/boards", h.owner.token, {
      name: "New",
      orgId: h.orgId,
    });
    const now = Date.now();
    await h.boardStore.trash(old.body.id, h.owner.id, now - TRASH_WINDOW_MS - 1000);
    await h.boardStore.trash(fresh.body.id, h.owner.id, now);
    await h.trash.put({
      kind: "project",
      id: "prj_gone",
      orgId: h.orgId,
      boardId: null,
      name: "Gone",
      deletedBy: h.owner.id,
      deletedAt: now - TRASH_WINDOW_MS - 1000,
    });
    const result = await purgeExpiredTrash({
      boards: h.boardStore,
      meetings: h.meetings,
      projects: h.projects,
      trash: h.trash,
      now,
    });
    expect(result).toEqual({ boards: 1, meetings: 0, projects: 1 });
    expect((await h.boardStore.trashed(h.orgId)).map((t) => t.board.name)).toEqual(["New"]);
    expect(await h.trash.forOrg(h.orgId)).toEqual([]);
  });
});
