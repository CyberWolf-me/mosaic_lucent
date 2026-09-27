import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import {
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";
import {
  connectionFailure,
  connectionState,
  nextHealth,
  watchProvider,
} from "../src/integrations/health.js";
import type { Operation } from "@lucent/core";

/**
 * Connection health (docs/26 A5): active, degraded, needs re-auth, revoked —
 * derived from how the provider has been answering, with only the
 * connection's own failures counting against it.
 */

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

describe("connection health (unit)", () => {
  it("tells the connection's failures from an item's", () => {
    expect(connectionFailure(new HttpError("linear responded 401", 401))).toMatchObject({
      auth: true,
    });
    expect(
      connectionFailure(new Error('credential ref "LINEAR_KEY" is not set in the environment')),
    ).toMatchObject({ auth: true });
    expect(connectionFailure(new HttpError("jira responded 503", 503))).toMatchObject({
      auth: false,
    });
    expect(connectionFailure(new TypeError("fetch failed"))).toMatchObject({ auth: false });
    // The provider answered; it refused one thing.
    expect(connectionFailure(new HttpError('no transition to "done"', 0))).toBeNull();
    expect(connectionFailure(new HttpError("jira responded 404", 404))).toBeNull();
  });

  it("derives the state: failures degrade, the credential needs re-auth, success clears", () => {
    const at = 1_000;
    const degraded = nextHealth(undefined, { ok: false, error: "503", auth: false }, at);
    expect(connectionState({ status: "active", health: degraded })).toBe("degraded");
    const reauth = nextHealth(degraded, { ok: false, error: "401", auth: true }, at + 1);
    expect(connectionState({ status: "active", health: reauth })).toBe("needs-reauth");
    expect(reauth.failures).toBe(2);
    const fine = nextHealth(reauth, { ok: true }, at + 2);
    expect(connectionState({ status: "active", health: fine })).toBe("active");
    expect(fine).toMatchObject({ failures: 0, lastOkAt: at + 2, lastError: "401" });
    expect(connectionState({ status: "disabled", health: fine })).toBe("revoked");
  });

  it("reports a batch once: the first connection failure wins", async () => {
    const reports: unknown[] = [];
    const fake = new FakeProvider();
    const watched = watchProvider(fake, async (o) => void reports.push(o));
    fake.failNext("getTask", new HttpError("no such issue", 404));
    await expect(watched.provider.getTask("X-1")).rejects.toThrow();
    await watched.settle();
    expect(reports).toEqual([{ ok: true }]);

    const again = watchProvider(fake, async (o) => void reports.push(o));
    fake.failNext("searchTasks", new HttpError("linear responded 401", 401));
    await expect(again.provider.searchTasks("q")).rejects.toThrow();
    await again.provider.searchTasks("q");
    await again.settle();
    expect(reports[1]).toMatchObject({ ok: false, auth: true });
    // Untouched methods and properties pass through.
    expect(again.provider.name).toBe(fake.name);
  });
});

let open: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness() {
  const limits = limitsFromEnv();
  const fake = new FakeProvider();
  const store = new InMemoryIntegrationStore();
  const app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: "health-test-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    integrations: {
      store,
      providers: new Map<
        string,
        import("../src/integrations/provider.js").ExecutionProviderFactory
      >([["fake", () => fake]]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents: new InMemoryIntegrationWebhookEventStore(),
      inbound: new InMemoryInboundChangeStore(),
    },
  });
  open = app;
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (rest.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email: "health@example.com", password: "password123", name: "Hal" }),
  });
  const token = signup.body.token as string;
  const orgId = signup.body.memberships[0].orgId as string;
  return { api, token, orgId, fake, store };
}

describe("connection health (routes)", () => {
  it("lists what can be connected, checks a connection, and follows its state", async () => {
    const h = await harness();
    const listed = await h.api(`/api/orgs/${h.orgId}/integrations`, { token: h.token });
    expect(listed.body.available).toEqual([{ provider: "fake", supportsInbound: true }]);

    const put = await h.api(`/api/orgs/${h.orgId}/integrations/fake`, {
      method: "PUT",
      token: h.token,
      body: JSON.stringify({ credentialRef: "LUCENT_TEST_FAKE_KEY" }),
    });
    expect(put.body.integration.state).toBe("active");

    const check = await h.api(`/api/orgs/${h.orgId}/integrations/fake/check`, {
      method: "POST",
      token: h.token,
    });
    expect(check.body).toMatchObject({ ok: true, integration: { state: "active" } });
    expect(check.body.integration.health.lastOkAt).toEqual(expect.any(Number));

    h.fake.failNext("searchTasks", new HttpError("fake responded 401", 401));
    const refused = await h.api(`/api/orgs/${h.orgId}/integrations/fake/check`, {
      method: "POST",
      token: h.token,
    });
    expect(refused.body).toMatchObject({
      ok: false,
      detail: "fake responded 401",
      integration: { state: "needs-reauth", health: { lastError: "fake responded 401" } },
    });

    // Reconnecting is a fresh start.
    const again = await h.api(`/api/orgs/${h.orgId}/integrations/fake`, {
      method: "PUT",
      token: h.token,
      body: JSON.stringify({ credentialRef: "LUCENT_TEST_FAKE_KEY_2" }),
    });
    expect(again.body.integration.state).toBe("active");

    // Disconnected is revoked — and reconnecting brings it back (it used to
    // stay disabled whatever the owner saved).
    await h.api(`/api/orgs/${h.orgId}/integrations/fake`, { method: "DELETE", token: h.token });
    const revoked = await h.api(`/api/orgs/${h.orgId}/integrations`, { token: h.token });
    expect(revoked.body.integrations[0].state).toBe("revoked");
    const back = await h.api(`/api/orgs/${h.orgId}/integrations/fake`, {
      method: "PUT",
      token: h.token,
      body: JSON.stringify({ credentialRef: "LUCENT_TEST_FAKE_KEY" }),
    });
    expect(back.body.integration).toMatchObject({ status: "active", state: "active" });
  });

  it("a sync the provider keeps failing marks the connection degraded", async () => {
    const h = await harness();
    await h.api(`/api/orgs/${h.orgId}/integrations/fake`, {
      method: "PUT",
      token: h.token,
      body: JSON.stringify({ credentialRef: "LUCENT_TEST_FAKE_KEY" }),
    });
    const board = await h.api("/api/boards", {
      method: "POST",
      token: h.token,
      body: JSON.stringify({ name: "Sync", orgId: h.orgId }),
    });
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "t", nodeType: "task", label: "Ship it" },
      { op: "SET_STATEMENT", id: "t", statement: { kind: "action", status: "open" } },
      { op: "SET_ISSUE", id: "t", issue: { type: "task", status: "open" } },
    ];
    await h.api(`/api/boards/${board.body.id}/ops`, {
      method: "POST",
      token: h.token,
      body: JSON.stringify({ ops, label: "seed" }),
    });
    h.fake.failNext("createTask", new HttpError("fake responded 503", 503));
    const sync = await h.api(`/api/boards/${board.body.id}/integrations/fake/sync`, {
      method: "POST",
      token: h.token,
    });
    expect(sync.status).toBe(200);
    const connection = await h.store.connection(h.orgId, "fake");
    expect(connectionState(connection!)).toBe("degraded");
    expect(connection!.health).toMatchObject({ failures: 1, lastError: "fake responded 503" });
  });
});
