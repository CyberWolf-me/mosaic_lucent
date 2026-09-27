import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, stampAuthorship, type Operation } from "@lucent/core";
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
  extractProposalItems,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import {
  InMemoryIntegrationWebhookEventStore,
  githubWebhookScheme,
  parseLinearWebhook,
} from "../src/integrations/webhook.js";
import {
  InMemoryInboundChangeStore,
  ingestInboundChange,
  type IngestDeps,
} from "../src/integrations/inbound.js";
import { issueWith } from "../src/integrations/applyInbound.js";
import { pollInbound } from "../src/integrations/poll.js";
import { connectionState } from "../src/integrations/health.js";

/**
 * Inbound beyond status (docs/26 A5): a tracker's owner and due date reach
 * the board as changes a person accepts — each news only once, against what
 * the link last saw — and the poll brings them in for providers with no
 * webhook (Jira) or deliveries that never arrived.
 */

const fake = { mapStatus: new FakeProvider().mapStatus.bind(new FakeProvider()) };

function deps(
  overrides: Partial<IngestDeps> = {},
): IngestDeps & { store: InMemoryInboundChangeStore } {
  const store = new InMemoryInboundChangeStore();
  return {
    linksForExternalId: async () => [
      {
        orgId: "org",
        boardId: "brd",
        nodeId: "n1",
        provider: "fake",
        externalId: "F-1",
        lastSyncedStatus: "todo",
        lastSyncedFields: { assignee: "Ada", dueDate: "2026-10-01" },
      },
    ],
    boardNodeStatus: async () => "open",
    boardNodeIssue: async () => ({ assignee: "Ada", dueDate: "2026-10-01" }),
    store,
    provider: fake,
    ...overrides,
  } as IngestDeps & { store: InMemoryInboundChangeStore };
}

describe("ingest, field by field", () => {
  it("queues an owner or date that moved there, and nothing that didn't", async () => {
    const d = deps();
    const out = await ingestInboundChange(
      d,
      { provider: "fake", externalId: "F-1", assignee: "Bo", dueDate: "2026-10-01" },
      "org",
    );
    expect(out.records.map((r) => [r.field, r.externalValue, r.mappedValue])).toEqual([
      ["assignee", "Bo", "Bo"],
    ]);
    // A status-only delivery never reads as "unassigned".
    const statusOnly = await ingestInboundChange(
      deps(),
      { provider: "fake", externalId: "F-1", status: "done" },
      "org",
    );
    expect(statusOnly.records.map((r) => r.field)).toEqual(["status"]);
  });

  it("reads a cleared field as clearing, and an unreadable date as a warning", async () => {
    const out = await ingestInboundChange(
      deps(),
      { provider: "fake", externalId: "F-1", assignee: null, dueDate: "next sprint" },
      "org",
    );
    expect(out.records.map((r) => [r.field, r.externalValue, r.mappedValue])).toEqual([
      ["assignee", "", ""],
      ["dueDate", "next sprint", undefined],
    ]);
    const iso = await ingestInboundChange(
      deps(),
      { provider: "fake", externalId: "F-1", dueDate: "2026-11-05T00:00:00.000Z" },
      "org",
    );
    expect(iso.records[0]).toMatchObject({ field: "dueDate", mappedValue: "2026-11-05" });
  });

  it("the board agreeing, or the provider saying what it said last time, is not news", async () => {
    // The board already says it (a different case of the same name).
    const agree = await ingestInboundChange(
      deps({ boardNodeIssue: async () => ({ assignee: "bo" }) }),
      { provider: "fake", externalId: "F-1", assignee: "Bo" },
      "org",
    );
    expect(agree.records).toEqual([]);
    // The poll re-reads a status the link already recorded.
    const polled = await ingestInboundChange(
      deps(),
      { provider: "fake", externalId: "F-1", status: "todo" },
      "org",
      "sweep",
    );
    expect(polled.records).toEqual([]);
  });

  it("an accepted change sets or clears the one field", () => {
    const issue = { type: "task", status: "open", assignee: "Ada", dueDate: "2026-10-01" };
    expect(issueWith(issue, "assignee", "Bo")).toMatchObject({ assignee: "Bo", status: "open" });
    expect(issueWith(issue, "dueDate", "")).not.toHaveProperty("dueDate");
    expect(issueWith(undefined, "status", "completed")).toEqual({
      type: "task",
      status: "completed",
    });
  });
});

describe("webhooks carry the owner and the date", () => {
  it("Linear: an update's assignee and due date, only when present", () => {
    const parse = (data: Record<string, unknown>) =>
      parseLinearWebhook(
        "linear",
        Buffer.from(JSON.stringify({ action: "update", type: "Issue", data })),
        1,
      );
    expect(
      parse({
        identifier: "LIN-1",
        state: { name: "Todo" },
        assignee: { name: "Bo Builder" },
        dueDate: "2026-10-09",
      }),
    ).toMatchObject({ change: { assignee: "Bo Builder", dueDate: "2026-10-09", status: "Todo" } });
    const bare = parse({ identifier: "LIN-1", state: { name: "Todo" } });
    expect(bare).toMatchObject({ kind: "change" });
    expect((bare as { change: object }).change).not.toHaveProperty("assignee");
    expect(parse({ identifier: "LIN-1", state: { name: "Todo" }, assigneeId: null })).toMatchObject(
      { change: { assignee: null } },
    );
  });

  it("GitHub: assigned and unassigned events", () => {
    const parse = (body: Record<string, unknown>) =>
      githubWebhookScheme.parse("github", Buffer.from(JSON.stringify(body)), 1);
    expect(
      parse({
        action: "assigned",
        issue: { number: 7, state: "open", assignee: { login: "octo" } },
      }),
    ).toEqual({
      kind: "change",
      change: { provider: "github", externalId: "7", assignee: "octo", at: 1 },
    });
    expect(parse({ action: "unassigned", issue: { number: 7, assignee: null } })).toMatchObject({
      change: { assignee: null },
    });
  });
});

describe("a new task says why it exists", () => {
  it("carries the action's description and the decisions that drive it", () => {
    const ws = applyOperations(
      createWorkspace(),
      stampAuthorship(
        [
          { op: "CREATE_NODE", id: "d", nodeType: "process", label: "Offer annual plans" },
          { op: "SET_STATEMENT", id: "d", statement: { kind: "decision", status: "resolved" } },
          { op: "CREATE_NODE", id: "a", nodeType: "task", label: "Change billing" },
          { op: "SET_STATEMENT", id: "a", statement: { kind: "action", status: "open" } },
          {
            op: "SET_ISSUE",
            id: "a",
            issue: { type: "task", status: "open", description: "Monthly and annual prices." },
          },
          { op: "CONNECT_NODES", source: "d", target: "a", relationship: "drives" },
        ] as Operation[],
        "u",
      ),
    );
    const [item] = extractProposalItems(ws, new Map(), undefined);
    expect(item!.description).toBe(
      "Monthly and annual prices.\n\nWhy (decided in Lucent):\n- Offer annual plans",
    );
  });
});

/* ------------------------------------------------------------ through the app */

const WEBHOOK_SECRET = "whsec_inbound_fields";
let h: Awaited<ReturnType<typeof harness>>;

async function harness() {
  const limits = limitsFromEnv();
  const store = new InMemoryIntegrationStore();
  const inbound = new InMemoryInboundChangeStore();
  const boardStore = new InMemoryBoardStore();
  const provider = new FakeProvider();
  const providers = new Map<
    string,
    import("../src/integrations/provider.js").ExecutionProviderFactory
  >([["fake", () => provider]]);
  const app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore,
    secret: "inbound-fields-secret-16",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    integrations: {
      store,
      providers,
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents: new InMemoryIntegrationWebhookEventStore(),
      inbound,
    },
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
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
  const signup = await api("POST", "/api/auth/signup", undefined, {
    email: "fields@example.com",
    password: "password123",
    name: "Fi Fields",
  });
  const token = signup.body.token as string;
  const orgId = signup.body.memberships[0].orgId as string;
  const board = await api("POST", "/api/boards", token, { name: "Fields", orgId });
  const boardId = board.body.id as string;
  await api("POST", `/api/boards/${boardId}/ops`, token, {
    label: "seed",
    ops: [
      { op: "CREATE_NODE", id: "t", nodeType: "task", label: "Ship it" },
      { op: "SET_STATEMENT", id: "t", statement: { kind: "action", status: "open" } },
      {
        op: "SET_ISSUE",
        id: "t",
        issue: { type: "task", status: "open", assignee: "Ada", dueDate: "2026-10-01" },
      },
    ],
  });
  process.env.LUCENT_TEST_FIELDS_WEBHOOK = WEBHOOK_SECRET;
  await store.putConnection(
    {
      orgId,
      provider: "fake",
      credentialRef: "LUCENT_TEST_CRED",
      createdBy: signup.body.user.id,
      config: { webhookSecretRef: "LUCENT_TEST_FIELDS_WEBHOOK" },
    },
    Date.now(),
  );
  return { app, api, base, token, orgId, boardId, store, inbound, boardStore, provider, providers };
}

describe("owner and due date, end to end", () => {
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.app.close();
  });

  it("a webhook's owner and date queue, accept sets one, dismiss keeps the other", async () => {
    await h.store.linkTask(
      {
        orgId: h.orgId,
        boardId: h.boardId,
        nodeId: "t",
        provider: "fake",
        externalId: "FAKE-9",
        lastSyncedStatus: "todo",
        lastSyncedFields: { assignee: "Ada", dueDate: "2026-10-01" },
      },
      1,
    );
    const fire = async (data: Record<string, unknown>) => {
      const body = JSON.stringify({ action: "update", type: "Issue", data });
      await fetch(`${h.base}/api/integrations/fake/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature": createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex"),
        },
        body,
      });
    };
    await fire({
      identifier: "FAKE-9",
      state: { name: "todo" },
      assignee: { name: "Bo" },
      dueDate: "2026-10-15",
    });
    const listed = await h.api("GET", `/api/boards/${h.boardId}/integrations/inbound`, h.token);
    const rows = listed.body.inbound as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.field, r.externalValue, r.boardValue]).sort()).toEqual([
      ["assignee", "Bo", "Ada"],
      ["dueDate", "2026-10-15", "2026-10-01"],
    ]);
    const owner = rows.find((r) => r.field === "assignee")!;
    const date = rows.find((r) => r.field === "dueDate")!;
    const accepted = await h.api(
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${owner.id}/accept`,
      h.token,
    );
    expect(accepted.status).toBe(200);
    const node = (await h.boardStore.get(h.boardId))!.workspace.nodes["t"]!;
    expect(node.issue).toMatchObject({ assignee: "Bo", dueDate: "2026-10-01", status: "open" });
    await h.api(
      "POST",
      `/api/boards/${h.boardId}/integrations/inbound/${date.id}/dismiss`,
      h.token,
    );
    const [link] = await h.store.linksForNode(h.boardId, "t");
    expect(link!.lastSyncedFields).toEqual({ assignee: "Bo", dueDate: "2026-10-15" });

    // The same date again (a later delivery about something else): not news.
    await fire({
      identifier: "FAKE-9",
      state: { name: "todo" },
      dueDate: "2026-10-15",
      title: "renamed there",
    });
    const pending = (await h.inbound.forBoard(h.boardId)).filter((r) => r.status === "pending");
    expect(pending).toEqual([]);
  });

  it("the poll reads linked tasks and queues what moved there, once", async () => {
    const task = await h.provider.createTask({ title: "Ship it", status: "open", assignee: "Ada" });
    await h.store.linkTask(
      {
        orgId: h.orgId,
        boardId: h.boardId,
        nodeId: "t",
        provider: "fake",
        externalId: task.externalId,
        lastSyncedStatus: task.status,
        lastSyncedFields: { assignee: "Ada", dueDate: "" },
      },
      1,
    );
    const poll = () =>
      pollInbound({
        store: h.store,
        inbound: h.inbound,
        providers: h.providers,
        boardStore: h.boardStore,
      });
    // Nothing moved there yet.
    expect(await poll()).toMatchObject({ connections: 1, read: 1, queued: 0 });
    await h.provider.updateTask(task.externalId, { status: "completed", assignee: "Bo" });
    expect((await poll()).queued).toBe(2);
    await poll();
    const pending = (await h.inbound.forBoard(h.boardId)).filter((r) => r.status === "pending");
    expect(pending.map((r) => r.field).sort()).toEqual(["assignee", "status"]);
    expect(pending.every((r) => r.source === "sweep")).toBe(true);
    // A connection that stops answering is recorded, and the run moves on.
    h.provider.failNext("getTask", Object.assign(new Error("fake responded 503"), { status: 503 }));
    await poll();
    expect(connectionState((await h.store.connection(h.orgId, "fake"))!)).toBe("degraded");
  });
});
