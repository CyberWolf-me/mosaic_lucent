import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Operation } from "@lucent/core";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryTeamTemplateStore } from "../src/teamTemplates.js";
import { Limiter } from "../src/limiter.js";

/**
 * B1 team-libraries routes — end-to-end through HTTP, exercising the four
 * verbs the picker actually uses:
 *
 *   GET    /api/orgs/:id/templates            (list, viewer)
 *   GET    /api/orgs/:id/templates/:id        (one, viewer)
 *   POST   /api/orgs/:id/templates            (create, editor, CSRF)
 *   DELETE /api/orgs/:id/templates/:id        (remove, editor, CSRF)
 *
 * The InMemory stores back both the OrgStore and the TeamTemplateStore so the
 * test runs without Postgres. A parity test against Postgres belongs in
 * pg-store.test.ts and is gated on `LUCENT_TEST_DATABASE_URL`.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

const SAMPLE_OPS: Operation[] = [
  // CREATE_NODE carries a `node: { id, kind, text, x, y }` shape; cast keeps
  // the fixture terse without depending on `node` being defined separately.
  { op: "CREATE_NODE", id: "n1", nodeType: "sticky", label: "hello" } as unknown as Operation,
];

interface SignedUp {
  cookies: string;
  csrf: { cookieValue: string; headerValue: string };
  userId: string;
  orgId: string;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
  signup: (email: string) => Promise<SignedUp>;
  request: (
    cookies: string,
    init: {
      method?: string;
      path: string;
      body?: unknown;
      csrf?: string;
    },
  ) => Promise<{ status: number; body: any }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  // The mirror-on-signup handshake expects orgStore to match users with names
  // and emails — without it, GET /api/orgs/:id returns an empty member list.
  orgStore.userFinder = (id: string) => userStore.findById(id);
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore,
    teamTemplates: new InMemoryTeamTemplateStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  function pickCookie(setCookie: string | string[] | undefined, name: string): string | undefined {
    const list = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
    for (const raw of list) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      if (raw.slice(0, eq).trim() !== name) continue;
      return raw.slice(eq + 1).split(";")[0] ?? "";
    }
    return undefined;
  }

  async function csrfTokens(): Promise<{ cookieValue: string; headerValue: string }> {
    const res = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const body = (await res.json()) as { token: string };
    const cookieValue = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!cookieValue) throw new Error("csrf route did not set a lucent_csrf cookie");
    return { cookieValue, headerValue: body.token };
  }

  async function signup(email: string): Promise<SignedUp> {
    const csrf = await csrfTokens();
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrf.cookieValue}`,
        "x-csrf-token": csrf.headerValue,
      },
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const setCookieHeader = res.headers.get("set-cookie");
    if (!setCookieHeader)
      throw new Error(
        `signup did not set any cookie; headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`,
      );
    const body = (await res.json()) as {
      user: { id: string };
      memberships: Array<{ orgId: string }>;
    };
    const sessionCookie = pickCookie(setCookieHeader, "lucent_session");
    if (!sessionCookie) throw new Error("signup did not set a session cookie");
    const orgId = body.memberships[0]!.orgId;
    return {
      cookies: `lucent_session=${sessionCookie}; lucent_csrf=${csrf.cookieValue}`,
      csrf,
      userId: body.user.id,
      orgId,
    };
  }

  async function request(
    cookies: string,
    init: { method?: string; path: string; body?: unknown; csrf?: string },
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      origin: ORIGIN,
      cookie: cookies,
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    const res = await fetch(`${base}${init.path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  return { base, close, signup, request };
}

describe("team template routes (B1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("creates, lists, fetches and deletes an org template", async () => {
    h = await harness();
    const owner = await h.signup("owner@example.com");

    const create = await h.request(owner.cookies, {
      method: "POST",
      path: `/api/orgs/${owner.orgId}/templates`,
      body: {
        name: "Architecture diagram",
        kind: "architecture",
        description: "starter template",
        ops: SAMPLE_OPS,
      },
      csrf: owner.csrf.headerValue,
    });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({
      name: "Architecture diagram",
      kind: "architecture",
      orgId: owner.orgId,
    });
    const templateId = create.body.id as string;

    const list = await h.request(owner.cookies, {
      path: `/api/orgs/${owner.orgId}/templates`,
    });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.templates)).toBe(true);
    expect(list.body.templates.find((t: { id: string }) => t.id === templateId)).toBeTruthy();

    const one = await h.request(owner.cookies, {
      path: `/api/orgs/${owner.orgId}/templates/${templateId}`,
    });
    expect(one.status).toBe(200);
    expect(Array.isArray(one.body.ops)).toBe(true);

    const del = await h.request(owner.cookies, {
      method: "DELETE",
      path: `/api/orgs/${owner.orgId}/templates/${templateId}`,
      csrf: owner.csrf.headerValue,
    });
    expect([200, 204]).toContain(del.status);

    const after = await h.request(owner.cookies, {
      path: `/api/orgs/${owner.orgId}/templates/${templateId}`,
    });
    expect(after.status).toBe(404);
  });

  it("refuses to serve templates for an org the caller isn't a member of", async () => {
    h = await harness();
    const owner = await h.signup("a@example.com");
    const intruder = await h.signup("b@example.com");
    const create = await h.request(owner.cookies, {
      method: "POST",
      path: `/api/orgs/${owner.orgId}/templates`,
      body: { name: "Private", kind: "x", ops: SAMPLE_OPS },
      csrf: owner.csrf.headerValue,
    });
    expect(create.status).toBe(201);
    // Intruder asks for someone else's org template list — same 404 that
    // GET /api/orgs/:id uses, so the org id is unguessable.
    const list = await h.request(intruder.cookies, {
      path: `/api/orgs/${owner.orgId}/templates`,
    });
    expect(list.status).toBe(404);
  });

  it("rejects POSTs without CSRF on the browser session", async () => {
    h = await harness();
    const owner = await h.signup("c@example.com");
    const noCsrf = await h.request(owner.cookies, {
      method: "POST",
      path: `/api/orgs/${owner.orgId}/templates`,
      body: { name: "x", kind: "y", ops: SAMPLE_OPS },
    });
    expect(noCsrf.status).toBe(403);
  });
});
