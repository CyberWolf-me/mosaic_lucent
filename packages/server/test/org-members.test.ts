import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
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
 * Managing an org's members (docs/26 A6): an owner changes roles and removes
 * people, anyone can leave, an org always keeps an owner, and a removed
 * person loses the org's boards at once — including one they have open.
 */

let app: App | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
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
    secret: "org-members-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
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
  // A team workspace with an owner, an editor and a viewer.
  const owner = await signup("owner@example.com");
  const org = await api("POST", "/api/orgs", owner.token, { name: "Acme" });
  const orgId = org.body.id as string;
  const join = async (email: string, role: "editor" | "viewer" | "owner") => {
    const who = await signup(email);
    await userStore.setMembership({ userId: who.id, orgId, role });
    await orgStore.setMembership({ userId: who.id, orgId, role });
    return who;
  };
  const openBoard = async (boardId: string, token: string) => {
    const ticket = (await api("POST", "/api/realtime/ticket", token)).body.ticket;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(socket);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (d) => messages.push(JSON.parse(String(d))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
    for (let i = 0; i < 40 && !messages.some((m) => m.type === "welcome"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return messages;
  };
  return { api, owner, orgId, join, openBoard, orgStore };
}

describe("org members", () => {
  it("an owner changes a role; the org always keeps an owner", async () => {
    const h = await harness();
    const ed = await h.join("ed@example.com", "editor");
    const changed = await h.api("PATCH", `/api/orgs/${h.orgId}/members/${ed.id}`, h.owner.token, {
      role: "viewer",
    });
    expect(changed).toMatchObject({ status: 200, body: { role: "viewer" } });
    const listed = await h.api("GET", `/api/orgs/${h.orgId}`, h.owner.token);
    expect(listed.body.members.find((m: { userId: string }) => m.userId === ed.id).role).toBe(
      "viewer",
    );
    // Only an owner may; and not into a role that doesn't exist.
    expect(
      (
        await h.api("PATCH", `/api/orgs/${h.orgId}/members/${h.owner.id}`, ed.token, {
          role: "viewer",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.api("PATCH", `/api/orgs/${h.orgId}/members/${ed.id}`, h.owner.token, {
          role: "admin",
        })
      ).status,
    ).toBe(400);
    // The last owner can't be demoted — until there's another.
    const alone = await h.api(
      "PATCH",
      `/api/orgs/${h.orgId}/members/${h.owner.id}`,
      h.owner.token,
      {
        role: "editor",
      },
    );
    expect(alone.status).toBe(409);
    await h.api("PATCH", `/api/orgs/${h.orgId}/members/${ed.id}`, h.owner.token, { role: "owner" });
    const handedOver = await h.api(
      "PATCH",
      `/api/orgs/${h.orgId}/members/${h.owner.id}`,
      h.owner.token,
      { role: "editor" },
    );
    expect(handedOver.status).toBe(200);
    // A personal workspace stays its owner's.
    const personal = `org_personal_${h.owner.id}`;
    expect(
      (await h.api("DELETE", `/api/orgs/${personal}/members/${h.owner.id}`, h.owner.token)).status,
    ).toBe(409);
    const audit = await h.orgStore.auditFor(h.orgId, 20);
    expect(audit.filter((a) => a.action === "org.member.role_changed")).toHaveLength(3);
  });

  it("removing someone ends their access to the org's boards at once", async () => {
    const h = await harness();
    const vi = await h.join("vi@example.com", "viewer");
    const board = await h.api("POST", "/api/boards", h.owner.token, {
      name: "Plan",
      orgId: h.orgId,
    });
    const boardId = board.body.id as string;
    // A direct grant above their org role, and the board open in a socket.
    await h.api("POST", `/api/boards/${boardId}/members`, h.owner.token, {
      email: vi.email,
      role: "editor",
    });
    expect((await h.api("GET", `/api/boards/${boardId}`, vi.token)).status).toBe(200);
    const messages = await h.openBoard(boardId, vi.token);
    expect(messages.some((m) => m.type === "welcome")).toBe(true);

    const removed = await h.api("DELETE", `/api/orgs/${h.orgId}/members/${vi.id}`, h.owner.token);
    expect(removed.body).toMatchObject({ removed: vi.id, boardGrantsRemoved: 1 });
    expect((await h.api("GET", `/api/orgs/${h.orgId}`, vi.token)).status).toBe(404);
    expect((await h.api("GET", `/api/boards/${boardId}`, vi.token)).status).toBe(404);
    await new Promise((r) => setTimeout(r, 50));
    expect(messages).toContainEqual({ type: "error", message: "access removed" });
    const audit = await h.orgStore.auditFor(h.orgId, 20);
    expect(audit.find((a) => a.action === "org.member.removed")).toMatchObject({
      metadata: { role: "viewer", boardGrantsRemoved: 1 },
    });
  });

  it("anyone can leave — except the last owner", async () => {
    const h = await harness();
    const ed = await h.join("leaver@example.com", "editor");
    const left = await h.api("DELETE", `/api/orgs/${h.orgId}/members/${ed.id}`, ed.token);
    expect(left.status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${h.orgId}`, ed.token)).status).toBe(404);
    const stuck = await h.api(
      "DELETE",
      `/api/orgs/${h.orgId}/members/${h.owner.id}`,
      h.owner.token,
    );
    expect(stuck).toMatchObject({
      status: 409,
      body: { error: expect.stringMatching(/last owner/) },
    });
    // A member can't remove anyone else.
    const other = await h.join("other@example.com", "editor");
    const again = await h.join("again@example.com", "editor");
    expect(
      (await h.api("DELETE", `/api/orgs/${h.orgId}/members/${other.id}`, again.token)).status,
    ).toBe(404);
  });
});
