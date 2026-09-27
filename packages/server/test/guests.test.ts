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
import type { MailMessage } from "../src/email/mailer.js";

/**
 * Guests (docs/26 A6): someone outside a workspace given one of its boards
 * sees that board and nothing else of the workspace, finds it under "shared
 * with me", is marked as a guest, and an owner can see and end their access.
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
  const mail: MailMessage[] = [];
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://lucent.test" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    boardStore: new InMemoryBoardStore(),
    mailer: { send: async (m) => void mail.push(m) },
    secret: "guests-test-secret-16chars",
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
  const board = await api("POST", "/api/boards", owner.token, { name: "Client plan", orgId });
  return { api, signup, owner, orgId, boardId: board.body.id as string, mail, orgStore };
}

describe("guests", () => {
  it("a client given one board sees that board — and nothing else of the workspace", async () => {
    const h = await harness();
    const client = await h.signup("client@example.com");
    const invited = await h.api("POST", `/api/boards/${h.boardId}/members`, h.owner.token, {
      email: client.email,
      role: "commenter",
    });
    expect(invited).toMatchObject({ status: 202, body: { guest: true, role: "commenter" } });

    const shared = await h.api("GET", "/api/boards/shared-with-me", client.token);
    expect(shared.body.boards).toEqual([
      expect.objectContaining({ id: h.boardId, orgName: "Acme", role: "commenter" }),
    ]);
    expect((await h.api("GET", `/api/boards/${h.boardId}`, client.token)).status).toBe(200);
    // Nothing of the workspace itself: its members, its board list.
    for (const path of [`/api/orgs/${h.orgId}`, `/api/boards?orgId=${h.orgId}`]) {
      expect((await h.api("GET", path, client.token)).status, path).toBe(404);
    }
    // Workspace reads are scoped to the boards a person can open (ADR 0046):
    // a project on another board, or another board's statements, never show.
    const other = await h.api("POST", "/api/boards", h.owner.token, {
      name: "Internal",
      orgId: h.orgId,
    });
    await h.api("POST", `/api/boards/${other.body.id}/ops`, h.owner.token, {
      label: "seed",
      ops: [
        { op: "CREATE_NODE", id: "secret", nodeType: "process", label: "Internal pricing" },
        { op: "SET_STATEMENT", id: "secret", statement: { kind: "decision", status: "resolved" } },
      ],
    });
    await h.api("POST", `/api/orgs/${h.orgId}/projects`, h.owner.token, {
      name: "Internal project",
      boardIds: [other.body.id],
    });
    expect((await h.api("GET", `/api/boards/${other.body.id}`, client.token)).status).toBe(404);
    expect(
      (await h.api("GET", `/api/orgs/${h.orgId}/projects`, client.token)).body.projects ?? [],
    ).toEqual([]);
    const intel = await h.api("GET", `/api/orgs/${h.orgId}/intelligence`, client.token);
    expect(JSON.stringify(intel.body)).not.toContain("Internal pricing");

    // The member list says who's a guest.
    const members = await h.api("GET", `/api/boards/${h.boardId}/members`, h.owner.token);
    expect(members.body.members).toEqual([
      expect.objectContaining({ userId: client.id, guest: true, role: "commenter" }),
    ]);
  });

  it("an address with no account gets a link; the answer never says which", async () => {
    const h = await harness();
    const known = await h.signup("known@example.com");
    const a = await h.api("POST", `/api/boards/${h.boardId}/members`, h.owner.token, {
      email: known.email,
      role: "viewer",
    });
    const b = await h.api("POST", `/api/boards/${h.boardId}/members`, h.owner.token, {
      email: "stranger@example.com",
      role: "viewer",
    });
    expect(a.status).toBe(b.status);
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort());
    const letter = h.mail.find((m) => m.to === "stranger@example.com")!;
    expect(letter.subject).toBe('owner shared "Client plan" with you');
    expect(letter.text).toMatch(new RegExp(`http://lucent\\.test/\\?board=${h.boardId}&invite=`));
  });

  it("a workspace that keeps boards inside refuses guests", async () => {
    const h = await harness();
    await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, { sharingDisabled: true });
    const refused = await h.api("POST", `/api/boards/${h.boardId}/members`, h.owner.token, {
      email: "client@example.com",
      role: "viewer",
    });
    expect(refused.status).toBe(403);
  });

  it("an owner sees every guest and can end their access in one step", async () => {
    const h = await harness();
    const client = await h.signup("guest@example.com");
    const second = await h.api("POST", "/api/boards", h.owner.token, {
      name: "Timeline",
      orgId: h.orgId,
    });
    for (const boardId of [h.boardId, second.body.id]) {
      await h.api("POST", `/api/boards/${boardId}/members`, h.owner.token, {
        email: client.email,
        role: "viewer",
      });
    }
    const listed = await h.api("GET", `/api/orgs/${h.orgId}/guests`, h.owner.token);
    expect(listed.body.guests).toEqual([
      expect.objectContaining({
        userId: client.id,
        email: client.email,
        boards: expect.arrayContaining([
          expect.objectContaining({ name: "Client plan" }),
          expect.objectContaining({ name: "Timeline" }),
        ]),
      }),
    ]);
    const ended = await h.api("DELETE", `/api/orgs/${h.orgId}/guests/${client.id}`, h.owner.token);
    expect(ended.body).toMatchObject({ boards: 2 });
    expect((await h.api("GET", `/api/boards/${h.boardId}`, client.token)).status).toBe(404);
    expect((await h.api("GET", "/api/boards/shared-with-me", client.token)).body.boards).toEqual(
      [],
    );
    expect(
      (await h.orgStore.auditFor(h.orgId, 20)).find((e) => e.action === "org.guest.removed"),
    ).toMatchObject({ metadata: { boards: 2 } });
    // A member isn't a guest.
    expect(
      (await h.api("DELETE", `/api/orgs/${h.orgId}/guests/${h.owner.id}`, h.owner.token)).status,
    ).toBe(409);
    // Only an owner sees the list.
    expect((await h.api("GET", `/api/orgs/${h.orgId}/guests`, client.token)).status).toBe(404);
  });
});
