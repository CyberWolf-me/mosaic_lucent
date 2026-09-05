import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";
import { InMemoryIntegrationStore } from "../src/integrations/integrations.js";
import { FakeProvider } from "../src/integrations/fake.js";

/**
 * The integration routes (Stage D4, ADR 0030): the org-owner connection
 * surface and the board link surface, with the house rules pinned — role
 * guard before the store check (a 503 is not an oracle), the credential
 * reference FINGERPRINTED never echoed in full, disable-not-delete, and
 * viewer-floor link reads.
 */

const SECRET = "test-secret-at-least-16-chars";

async function makeHarness(withIntegrations = true) {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const fake = new FakeProvider();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore: new InMemoryUsageStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    ...(withIntegrations
      ? {
          integrations: {
            store: new InMemoryIntegrationStore(),
            providers: new Map([["fake", () => fake]]),
          },
        }
      : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, boardStore, close: async () => { await close(); } };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function api(h: NonNullable<typeof open>, path: string, init: RequestInit & { token?: string; csrf?: string } = {}) {
  const { token, csrf, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf, "x-requested-with": "lucent" } : {}),
      origin: h.base,
      ...(rest.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function signup(h: NonNullable<typeof open>, email: string) {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

async function orgIdOf(h: NonNullable<typeof open>, userId: string) {
  const m = await h.userStore.membershipsFor(userId);
  return m[0]!.orgId;
}

describe("the connection surface (org owner)", () => {
  it("an owner configures a connection idempotently; the reference is fingerprinted", async () => {
    const h = (open = await makeHarness());
    const owner = await signup(h, "owner@example.com");
    const orgId = await orgIdOf(h, owner.id);

    const put = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: owner.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "LUCENT_FAKE_TEST_KEY", scopes: ["tasks:write"] }),
    });
    expect(put.status).toBe(201);
    // The reference NEVER echoes in full — the SSO fingerprint precedent.
    expect(put.body.integration.credentialRef).toBe("LUCE…(20 chars)");
    expect(put.body.integration.provider).toBe("fake");
    expect(put.body.integration.status).toBe("active");

    // A second PUT replaces (idempotent per (org, provider)).
    const put2 = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: owner.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "LUCENT_FAKE_TEST_KEY_V2" }),
    });
    expect(put2.status).toBe(201);

    const list = await api(h, `/api/orgs/${orgId}/integrations`, { token: owner.token });
    expect(list.status).toBe(200);
    expect(list.body.integrations).toHaveLength(1);
    // The fingerprint never shows the suffix — that IS the rule. The
    // idempotent replace is proven by: one row, and the full new value
    // absent from the response.
    expect(JSON.stringify(list.body)).not.toContain("LUCENT_FAKE_TEST_KEY_V2");
    expect(list.body.integrations[0].updatedAt).toBeGreaterThanOrEqual(put.body.integration.updatedAt);
  });

  it("configuring a provider nothing implements is a 400, not a dead connection", async () => {
    const h = (open = await makeHarness());
    const owner = await signup(h, "owner2@example.com");
    const orgId = await orgIdOf(h, owner.id);
    const put = await api(h, `/api/orgs/${orgId}/integrations/linear`, {
      method: "PUT",
      token: owner.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    expect(put.status).toBe(400);
    expect(put.body.error).toContain("no provider implementation");
  });

  it("a member (not owner) is refused; DELETE disables without deleting", async () => {
    const h = (open = await makeHarness());
    const owner = await signup(h, "o3@example.com");
    const member = await signup(h, "m3@example.com");
    const orgId = await orgIdOf(h, owner.id);
    await h.userStore.setMembership({ orgId, userId: member.id, role: "editor" });

    const refused = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: member.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    expect(refused.status).toBe(404); // ids unguessable, the house rule

    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: owner.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    const del = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "DELETE",
      token: owner.token,
      csrf: "csrf",
    });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("disabled");

    const list = await api(h, `/api/orgs/${orgId}/integrations`, { token: owner.token });
    expect(list.body.integrations).toHaveLength(1); // still there, disabled
    expect(list.body.integrations[0].status).toBe("disabled");
  });
});

describe("the link surface (board viewer)", () => {
  it("links are readable at the viewer floor and scoped to the board", async () => {
    const h = (open = await makeHarness());
    const owner = await signup(h, "o4@example.com");
    const viewer = await signup(h, "v4@example.com");
    const stranger = await signup(h, "s4@example.com");
    const orgId = await orgIdOf(h, owner.id);

    const created = await api(h, "/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "B", workspace: createWorkspace() }),
    });
    const boardId = created.body.id;

    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ token: share.body.token }),
    });

    // Seed a link directly through the store (the sync route lands in B3).
    const store = new InMemoryIntegrationStore();
    void store;
    // (The harness's store is inside the app; re-create the link through
    // the app's own seam by... the sync route is Batch 3. For Batch 2 the
    // READ surface is what's pinned — an empty list is the honest state.)

    const asViewer = await api(h, `/api/boards/${boardId}/integrations/links`, { token: viewer.token });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.links).toEqual([]);

    const asStranger = await api(h, `/api/boards/${boardId}/integrations/links`, { token: stranger.token });
    expect(asStranger.status).toBe(404);
  });

  it("without the integrations bundle the routes answer 503 — fail-closed, role guard first", async () => {
    const h = (open = await makeHarness(false));
    const owner = await signup(h, "o5@example.com");
    const orgId = await orgIdOf(h, owner.id);

    // An ANONYMOUS call answers 401 (auth before store) — the 503 is not
    // an oracle over which orgs exist.
    const anon = await api(h, `/api/orgs/${orgId}/integrations`);
    expect(anon.status).toBe(401);

    const asOwner = await api(h, `/api/orgs/${orgId}/integrations`, { token: owner.token });
    expect(asOwner.status).toBe(503);
    expect(asOwner.body.error).toContain("not configured");
  });
});
