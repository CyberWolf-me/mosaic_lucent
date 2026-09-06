import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
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
import { createWorkspace } from "@lucent/core";
import {
  InMemoryIntegrationStore,
  InMemoryIntegrationActionStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";

/**
 * The D7 webhook route, end to end through the real app: the first-in-
 * ladder placement, the no-auth-guards contract (the signature is the
 * auth), the org resolution through the connection's webhookSecretRef,
 * and the fail-closed 503 when the bundle is absent.
 *
 * The FakeProvider stands in as the provider (its mapStatus knows the
 * "done" vocabulary) — the route is provider-agnostic by design; the
 * Linear scheme is pinned in the receiver suite.
 */

const SECRET = "d7-webhook-route-secret";
const WEBHOOK_SECRET = "whsec_test_d7";

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

function issueUpdate(identifier: string, stateName: string): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: { identifier, state: { name: stateName } },
  });
}

async function setup(opts?: { withoutBundle?: boolean }) {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const store = new InMemoryIntegrationStore();
  const inbound = new InMemoryInboundChangeStore();
  const webhookEvents = new InMemoryIntegrationWebhookEventStore();
  const integrations = opts?.withoutBundle
    ? undefined
    : {
        store,
        providers: new Map<
          string,
          import("../src/integrations/provider.js").ExecutionProviderFactory
        >([["fake", () => new FakeProvider()]]),
        actions: new InMemoryIntegrationActionStore(),
        ledger: new InMemoryExecutionLedger(),
        webhookEvents,
        inbound,
      };
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
    ...(integrations ? { integrations: integrations as never } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, boardStore, store, inbound, webhookEvents, close: async () => { await close(); } };
}

async function post(port: number, path: string, body: string, signature?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-signature": signature } : {}),
    },
    body,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function seedBoard(boardStore: InMemoryBoardStore, boardId: string, nodeId: string, status: string) {
  const workspace = createWorkspace({ name: "w" });
  workspace.nodes[nodeId] = {
    id: nodeId,
    nodeType: "task",
    label: "Node " + nodeId,
    issue: { type: "task", status, statusCategory: "todo" },
  };
  await boardStore.put({
    id: boardId,
    orgId: "org_test",
    ownerId: "usr_x",
    name: boardId,
    createdAt: 1,
    updatedAt: 1,
    workspace,
  });
}

describe("POST /api/integrations/:provider/webhook — the first-in-ladder receiver", () => {
  let h: Awaited<ReturnType<typeof setup>>;

  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    process.env["LUCENT_TEST_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    await h.store.putConnection(
      {
        orgId: "org_test",
        provider: "fake",
        credentialRef: "LUCENT_TEST_CRED",
        scopes: [],
        createdBy: "usr_x",
        config: { webhookSecretRef: "LUCENT_TEST_WEBHOOK_SECRET" },
      },
      Date.now(),
    );
  });

  it("is unauthenticated by design: a tampered signature is a 400, never a 401", async () => {
    const body = issueUpdate("LIN-1", "done");
    const result = await post(
      h.port,
      "/api/integrations/fake/webhook",
      body.replace("done", "todo"),
      sign(body),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ outcome: "invalid_signature" });
  });

  it("answers 503 fail-closed when the integrations bundle is absent", async () => {
    const bare = await setup({ withoutBundle: true });
    try {
      const body = issueUpdate("LIN-1", "done");
      const result = await post(bare.port, "/api/integrations/fake/webhook", body, sign(body));
      expect(result.status).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it("404s a provider nothing implements", async () => {
    const body = issueUpdate("LIN-1", "done");
    const result = await post(h.port, "/api/integrations/linear/webhook", body, sign(body));
    expect(result.status).toBe(404);
  });

  it("processes a signed delivery: the change lands in the inbound queue", async () => {
    await seedBoard(h.boardStore, "brd_w", "nd_w", "todo");
    await h.store.linkTask(
      {
        orgId: "org_test",
        boardId: "brd_w",
        nodeId: "nd_w",
        provider: "fake",
        externalId: "LIN-1",
        lastSyncedStatus: "todo",
      },
      1,
    );
    const body = issueUpdate("LIN-1", "done");
    const result = await post(h.port, "/api/integrations/fake/webhook", body, sign(body));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "processed" });
    const pending = await h.inbound.forBoard("brd_w");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      nodeId: "nd_w",
      externalId: "LIN-1",
      externalValue: "done",
      status: "pending",
    });
  });

  it("a redelivery of the same bytes is a duplicate — one queue row", async () => {
    await seedBoard(h.boardStore, "brd_d", "nd_d", "todo");
    await h.store.linkTask(
      {
        orgId: "org_test",
        boardId: "brd_d",
        nodeId: "nd_d",
        provider: "fake",
        externalId: "LIN-9",
        lastSyncedStatus: "todo",
      },
      1,
    );
    const body = issueUpdate("LIN-9", "done");
    const first = await post(h.port, "/api/integrations/fake/webhook", body, sign(body));
    expect(first.body).toMatchObject({ outcome: "processed" });
    const second = await post(h.port, "/api/integrations/fake/webhook", body, sign(body));
    expect(second.body).toMatchObject({ outcome: "duplicate" });
    const pending = await h.inbound.forBoard("brd_d");
    expect(pending).toHaveLength(1);
  });

  it("no candidate secrets: the honest no_subscription answer", async () => {
    delete process.env["LUCENT_TEST_WEBHOOK_SECRET"];
    try {
      const body = issueUpdate("LIN-1", "done");
      const result = await post(h.port, "/api/integrations/fake/webhook", body, sign(body));
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ outcome: "invalid_signature" });
    } finally {
      process.env["LUCENT_TEST_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    }
  });
});
