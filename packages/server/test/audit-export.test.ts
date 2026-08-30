import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryOrgStore } from "../src/orgs.js";

/**
 * The audit surface's F1 slice: keyset pagination (the route's old fixed-100
 * was the bug) and CSV export with RFC 4180 escaping.
 *
 * Both ride the real InMemoryOrgStore, seeded through `audit()` directly —
 * the rows are the store's own shape, so the test pins the route's
 * contract, not a fixture's.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

interface Harness {
  base: string;
  close: () => Promise<void>;
  orgStore: InMemoryOrgStore;
  api: (
    path: string,
    init: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any; text: string }>;
  signup: (email: string) => Promise<{ token: string; orgId: string }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (path, init) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    // Read the stream once, then parse — a Response body cannot be cloned
    // after `json()` has consumed it.
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { status: res.status, body, text };
  };

  const signup = async (email: string) => {
    const res = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const body = res.body as { token: string; memberships: Array<{ orgId: string }> };
    return { token: body.token, orgId: body.memberships[0]!.orgId };
  };

  return { base, close, orgStore, api, signup };
}

describe("GET /api/orgs/:id/audit — pagination + CSV (F1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("pages by keyset and reports the next cursor only while more exist", async () => {
    h = await harness();
    const owner = await h.signup("audit@example.com");
    // 3 rows, distinct timestamps.
    for (let i = 0; i < 3; i += 1) {
      await h.orgStore.audit({
        orgId: owner.orgId,
        actorId: "usr_x",
        action: "test.step",
        ip: null,
        at: 1_000 + i,
      });
    }
    const page1 = await h.api(`/api/orgs/${owner.orgId}/audit?limit=2`, { token: owner.token });
    expect(page1.status).toBe(200);
    expect(page1.body.entries).toHaveLength(2);
    // Newest first.
    expect(page1.body.entries[0].at).toBe(1_002);
    expect(page1.body.nextCursor).toEqual({ at: 1_001, id: page1.body.entries[1].id });

    const { at, id } = page1.body.nextCursor as { at: number; id: string };
    const page2 = await h.api(
      `/api/orgs/${owner.orgId}/audit?limit=2&cursorAt=${at}&cursorId=${encodeURIComponent(id)}`,
      { token: owner.token },
    );
    expect(page2.status).toBe(200);
    expect(page2.body.entries).toHaveLength(1);
    // A short page means done: no cursor, no probe.
    expect(page2.body.nextCursor).toBeNull();
  });

  it("exports CSV with the header, all rows and RFC 4180 escaping", async () => {
    h = await harness();
    const owner = await h.signup("csv@example.com");
    // One hostile row: a comma and a quote in the action.
    await h.orgStore.audit({
      orgId: owner.orgId,
      actorId: "usr_x",
      action: 'test, "quoted" action',
      ip: null,
      at: 1_000,
    });
    await h.orgStore.audit({
      orgId: owner.orgId,
      actorId: "usr_x",
      action: "plain.action",
      ip: "203.0.113.7",
      at: 2_000,
    });

    const res = await h.api(`/api/orgs/${owner.orgId}/audit?format=csv`, { token: owner.token });
    expect(res.status).toBe(200);
    const csv = res.text;
    expect(csv).toContain("id,at,actor_id,actor_email,action,target_type,target_id,ip");
    // The hostile cell is quoted with doubled inner quotes.
    expect(csv).toContain('"test, ""quoted"" action"');
    // A plain row lands unquoted, with the empty target columns as
    // consecutive commas: action,target_type,target_id,ip.
    expect(csv).toMatch(/plain\.action,,,203\.0\.113\.7/);
    // CRLF line endings, per RFC 4180.
    expect(csv).toContain("\r\n");
  });

  it("keeps the export owner-only", async () => {
    h = await harness();
    const owner = await h.signup("a@lucent.test");
    const stranger = await h.signup("b@lucent.test");
    const res = await h.api(`/api/orgs/${owner.orgId}/audit?format=csv`, {
      token: stranger.token,
    });
    expect(res.status).toBe(404);
  });
});
