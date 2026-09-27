import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTotpStore } from "../src/totpStore.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { base32Decode, totp } from "../src/totp.js";

/**
 * A workspace that requires two-step verification (docs/26 A6): anyone
 * without it — member or guest — is kept out of it, and only it, until they
 * turn it on. The owner can't lock themselves out turning it on, nobody can
 * slip out of it by turning theirs off, and a blocked member can still leave.
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
    totpStore: new InMemoryTotpStore(),
    secret: "two-factor-policy-secret",
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
  /** Enroll in two-step verification, answering with a live code. */
  const enroll = async (token: string) => {
    const begin = await api("POST", "/api/auth/2fa/enroll", token);
    const secret = begin.body.secret as string;
    const done = await api("POST", "/api/auth/2fa/enroll/confirm", token, {
      secret,
      code: totp(base32Decode(secret)),
    });
    expect(done.status).toBe(200);
    return secret;
  };
  const owner = await signup("owner@acme.com", "Olive");
  const orgId = (await api("POST", "/api/orgs", owner.token, { name: "Acme" })).body.id as string;
  const ed = await signup("ed@acme.com", "Ed");
  await userStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  await orgStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  const guest = await signup("gil@client.example", "Gil");
  const boardId = (await api("POST", "/api/boards", owner.token, { name: "Roadmap", orgId })).body
    .id as string;
  await api("POST", `/api/boards/${boardId}/members`, owner.token, {
    email: "gil@client.example",
    role: "viewer",
  });
  return { api, enroll, owner, ed, guest, orgId, boardId };
}

describe("requiring two-step verification", () => {
  it("keeps out members and guests without it — and only from this workspace", async () => {
    const h = await harness();
    const require2fa = () =>
      h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, { requireTwoFactor: true });

    // The owner can't turn it on without having it: it would lock them out.
    expect((await require2fa()).status).toBe(409);
    await h.enroll(h.owner.token);
    expect((await require2fa()).status).toBe(200);
    expect((await h.api("GET", `/api/boards/${h.boardId}`, h.owner.token)).status).toBe(200);

    // A member without it: the workspace is closed, its boards too.
    expect((await h.api("GET", `/api/boards/${h.boardId}`, h.ed.token)).status).toBe(404);
    expect((await h.api("GET", `/api/boards?orgId=${h.orgId}`, h.ed.token)).status).toBe(404);
    const orgs = await h.api("GET", "/api/orgs", h.ed.token);
    expect(orgs.body.orgs.find((o: { id: string }) => o.id === h.orgId)).toMatchObject({
      name: "Acme",
      blocked: "two_factor",
    });
    // ...but not their own workspace.
    const personal = orgs.body.orgs.find((o: { isPersonal: boolean }) => o.isPersonal);
    expect(personal.blocked).toBeUndefined();
    const access = await h.api("GET", "/api/me/access", h.ed.token);
    expect(access.body).toEqual({
      twoFactor: false,
      blocked: [{ orgId: h.orgId, orgName: "Acme", reason: "two_factor", asGuest: false }],
    });

    // A guest given one board is kept out of it too.
    expect((await h.api("GET", `/api/boards/${h.boardId}`, h.guest.token)).status).toBe(404);
    const guestAccess = await h.api("GET", "/api/me/access", h.guest.token);
    expect(guestAccess.body.blocked).toEqual([
      { orgId: h.orgId, orgName: "Acme", reason: "two_factor", asGuest: true },
    ]);
    expect((await h.api("GET", "/api/boards/shared-with-me", h.guest.token)).body.boards).toEqual(
      [],
    );

    // The owner sees who has it on.
    const detail = await h.api("GET", `/api/orgs/${h.orgId}`, h.owner.token);
    expect(
      detail.body.members.map((m: { name: string; twoFactor: boolean }) => [m.name, m.twoFactor]),
    ).toEqual(
      expect.arrayContaining([
        ["Olive", true],
        ["Ed", false],
      ]),
    );

    // Turning it on opens the workspace again, at once.
    await h.enroll(h.ed.token);
    expect((await h.api("GET", `/api/boards/${h.boardId}`, h.ed.token)).status).toBe(200);
    expect((await h.api("GET", "/api/me/access", h.ed.token)).body.blocked).toEqual([]);
    const status = await h.api("GET", "/api/auth/2fa", h.ed.token);
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
  });

  it("can't be slipped by turning it off, and a blocked member can still leave", async () => {
    const h = await harness();
    const secret = await h.enroll(h.owner.token);
    await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, {
      requireTwoFactor: true,
    });
    const off = await h.api("POST", "/api/auth/2fa/disable", h.owner.token, {
      code: totp(base32Decode(secret)),
    });
    expect(off.status).toBe(409);
    expect(off.body.requiredBy).toEqual(["Acme"]);

    const left = await h.api("DELETE", `/api/orgs/${h.orgId}/members/${h.ed.id}`, h.ed.token);
    expect(left.status).toBe(200);
    expect((await h.api("GET", "/api/me/access", h.ed.token)).body.blocked).toEqual([]);

    // Lifting the requirement opens it to everyone again.
    await h.api("PATCH", `/api/orgs/${h.orgId}/settings`, h.owner.token, {
      requireTwoFactor: false,
    });
    expect((await h.api("GET", `/api/boards/${h.boardId}`, h.guest.token)).status).toBe(200);
  });
});
