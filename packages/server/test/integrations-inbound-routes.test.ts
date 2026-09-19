import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import type { Operation } from "@lucent/core";
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
import {
  InMemoryIntegrationStore,
  InMemoryIntegrationActionStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";

/**
 * The D7 inbound routes: GET the queue (viewer), accept (editor, the
 * system-actor apply), dismiss (editor, keep ours), and the sync route's
 * supersession arm. Everything through the real app.
 *
 * Note: the CSRF guard only engages when a `lucent_session=` cookie rides
 * the request; these tests call with bearer tokens only, so `csrf: "csrf"`
 * mirrors the existing integration-route suites' convention.
 */

const SECRET = "d7-inbound-routes-secret";
const WEBHOOK_SECRET = "whsec_test_d7b";

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

const SEED_OPS: Operation[] = [
  { op: "CREATE_NODE", id: "nd_task", nodeType: "task", label: "Sync me" },
  {
    op: "SET_STATEMENT",
    id: "nd_task",
    statement: { kind: "action", status: "open", topic: "d7" },
  },
  {
    op: "SET_ISSUE",
    id: "nd_task",
    issue: { type: "task", status: "open", statusCategory: "todo" },
  },
];

interface Harness {
  port: number;
  base: string;
  boardId: string;
  orgId: string;
  token: string;
  userId: string;
  boardStore: InMemoryBoardStore;
  store: InMemoryIntegrationStore;
  inbound: InMemoryInboundChangeStore;
  close: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const store = new InMemoryIntegrationStore();
  const inbound = new InMemoryInboundChangeStore();

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
    integrations: {
      store,
      providers: new Map<
        string,
        import("../src/integrations/provider.js").ExecutionProviderFactory
      >([["fake", () => new FakeProvider()]]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents: new InMemoryIntegrationWebhookEventStore(),
      inbound,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // The user + org + board + link, through the public API.
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "d7@example.com", password: "password123", name: "D7 Owner" }),
  });
  const signupBody = (await signup.json()) as {
    token: string;
    user: { id: string };
    memberships: Array<{ orgId: string }>;
  };
  const token = signupBody.token;
  const userId = signupBody.user.id;
  const orgId = signupBody.memberships[0]!.orgId;
  const board = await fetch(`${base}/api/boards`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "D7 Board", orgId }),
  });
  const boardId = ((await board.json()) as { id: string }).id;
  const ops = await fetch(`${base}/api/boards/${boardId}/ops`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ops: SEED_OPS, label: "seed" }),
  });
  expect(ops.status).toBe(200);
  return {
    port,
    base,
    boardId,
    orgId,
    token,
    userId,
    boardStore,
    store,
    inbound,
    close: async () => {
      await close();
    },
  };
}

async function api(h: Harness, method: string, path: string, body?: unknown) {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${h.token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

describe("the inbound queue routes", () => {
  let h: Harness;

  // Per-test isolation: each test gets a fresh harness (board, queue,
  // links), so an accept in one test never leaks a mutated board into the
  // next. The queue rows are per-board; a fresh board is a fresh queue.
  beforeEach(async () => {
    h = await makeHarness();
    process.env["LUCENT_TEST_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    await h.store.putConnection(
      {
        orgId: h.orgId,
        provider: "fake",
        credentialRef: "LUCENT_TEST_CRED",
        scopes: [],
        createdBy: h.userId,
        config: { webhookSecretRef: "LUCENT_TEST_WEBHOOK_SECRET" },
      },
      Date.now(),
    );
    await h.store.linkTask(
      {
        orgId: h.orgId,
        boardId: h.boardId,
        nodeId: "nd_task",
        provider: "fake",
        externalId: "FAKE-7",
        lastSyncedStatus: "todo",
      },
      1,
    );
  });
  afterEach(async () => {
    await h.close();
  });

  async function fireWebhook(stateName: string): Promise<Record<string, unknown> | null> {
    const body = issueUpdate("FAKE-7", stateName);
    const res = await fetch(`${h.base}/api/integrations/fake/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sign(body) },
      body,
    });
    return (await res.json().catch(() => null)) as Record<string, unknown> | null;
  }

  it("GET inbound: the queue joined to the live board value, viewer floor", async () => {
    await fireWebhook("done");
    const result = await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`);
    expect(result.status).toBe(200);
    const rows = result.body!.inbound as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: "nd_task",
      externalId: "FAKE-7",
      externalValue: "done",
      status: "pending",
      boardValue: "open",
      resolved: false,
    });
  });

  it("accept applies the reviewed snapshot with the SYSTEM actor and updates the link", async () => {
    await fireWebhook("done");
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    const changeId = rows[0]!.id as string;
    const result = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${changeId}/accept`,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ applied: 1, seq: expect.any(Number) });

    // The board's node carries the mapped value now.
    const board = await h.boardStore.get(h.boardId);
    expect(board!.workspace.nodes["nd_task"]!.issue!.status).toBe("completed");
    // The op log entry: the system actor, the provider as actorId, the
    // acceptor as initiatedBy — the timeline's honest provenance.
    const log = await h.boardStore.loadLog(h.boardId, 0);
    const entry = [...log].reverse().find((e) => e.label === "sync from fake");
    expect(entry).toBeDefined();
    expect(entry!.actor).toMatchObject({
      actorType: "system",
      actorId: "fake",
      initiatedBy: h.userId,
    });
    // The link's lastSyncedStatus records the provider's word.
    const link = (await h.store.linksForNode(h.boardId, "nd_task")).find(
      (l) => l.provider === "fake",
    );
    expect(link!.lastSyncedStatus).toBe("done");
    // The record is applied.
    const after = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    expect(after[0]).toMatchObject({ status: "applied" });
  });

  it("a second accept is the honest duplicate — no second op", async () => {
    await fireWebhook("done");
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    const changeId = rows[0]!.id as string;
    await api(h, "POST", `/api/boards/${h.boardId}/integrations/inbound/${changeId}/accept`);
    const before = (await h.boardStore.loadLog(h.boardId, 0)).length;
    const second = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${changeId}/accept`,
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect((await h.boardStore.loadLog(h.boardId, 0)).length).toBe(before);
  });

  it("a never-guesses warning row: accept refuses with the honest 409, dismiss works", async () => {
    // A word the FakeProvider does not know.
    await fireWebhook("In QA");
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ externalValue: "In QA", mappedValue: null, status: "pending" });
    const changeId = rows[0]!.id as string;
    const accept = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${changeId}/accept`,
    );
    expect(accept.status).toBe(409);
    expect(accept.body!.error as string).toContain("no translation");
    // The board is untouched.
    const board = await h.boardStore.get(h.boardId);
    expect(board!.workspace.nodes["nd_task"]!.issue!.status).toBe("open");
    // Dismiss is the offered path.
    const dismiss = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${changeId}/dismiss`,
    );
    expect(dismiss.status).toBe(200);
    // The link still records the provider's word.
    const link = (await h.store.linksForNode(h.boardId, "nd_task")).find(
      (l) => l.provider === "fake",
    );
    expect(link!.lastSyncedStatus).toBe("In QA");
  });

  it("dismiss keeps the board's value and marks the row dismissed", async () => {
    await fireWebhook("done");
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    const changeId = rows[0]!.id as string;
    const dismiss = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${changeId}/dismiss`,
    );
    expect(dismiss.status).toBe(200);
    const board = await h.boardStore.get(h.boardId);
    expect(board!.workspace.nodes["nd_task"]!.issue!.status).toBe("open");
    const after = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    expect(after[0]).toMatchObject({ status: "dismissed" });
  });

  it("the sync route SUPERSEDES pending inbound rows and reports the count", async () => {
    await fireWebhook("done");
    const sync = await api(h, "POST", `/api/boards/${h.boardId}/integrations/fake/sync`);
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ supersededInbound: 1 });
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ status: "superseded" });
  });

  it("an unknown change id is a board-scoped 404", async () => {
    const result = await api(
      h,
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/inb_missing/accept`,
    );
    expect(result.status).toBe(404);
  });

  it("the resolved join: a record the board already matches is not queued at all", async () => {
    // The board's issue is "open"; the FakeProvider's word that maps to
    // "open" is "todo". A "todo" webhook equals the live value → the
    // resolution-level dedupe: no pending row, nothing to decide.
    await fireWebhook("todo");
    const rows = (await api(h, "GET", `/api/boards/${h.boardId}/integrations/inbound`)).body!
      .inbound as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(0);
  });
});
