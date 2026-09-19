import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
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
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { LinearProvider } from "../src/integrations/linear.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";

/**
 * Stage D7's definition of done — the inbound mirror, end to end against a
 * STUBBED WIRE LinearProvider (the receiver/queue suites pin the pieces;
 * this file proves the platform story):
 *
 *   The D6-linked board (created + approved through the real routes) → a
 *   SIGNED webhook fires (Linear says Done) → ONE pending row with the
 *   drift joined to the live board value → ACCEPT applies the reviewed
 *   snapshot as the SYSTEM actor (the op log's first system row: Lucent ←
 *   linear, accepted by <user>), the node's status changes, the link's
 *   lastSyncedStatus records the provider's word → a redelivery of the
 *   same bytes is a duplicate (no second row) → a NEWER value updates the
 *   pending row in place → THE NEVER-GUESS case ("In QA" → the warning
 *   row, accept refused 409, the board keeps its state) → THE TAMPERED
 *   SIGNATURE (400, the ledger stays EMPTY) → THE CONFLICT CASE (an
 *   explicit sync supersedes the pending row and reports the count) →
 *   the unlinked issue (ignored) → THE WORKSPACE INVARIANT (the blob
 *   carries no provider strings throughout).
 */

const SECRET = "d7-acceptance-secret-0123456789";
const WEBHOOK_SECRET = "whsec_d7_acceptance";

/** The wire: the D6-shaped stub — the provider side of the story. */
class ScriptedLinearWire {
  readonly issues: Array<{
    id: string;
    identifier: string;
    title: string;
    description: string;
    state: string;
    url: string;
  }> = [];
  private nextIssue = 1;

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    if (body.query.includes("workflowStates")) {
      return respond({
        workflowStates: {
          nodes: [
            { id: "st-todo", name: "Todo" },
            { id: "st-progress", name: "In Progress" },
            { id: "st-done", name: "Done" },
            { id: "st-canceled", name: "Canceled" },
          ],
        },
      });
    }
    if (body.query.includes("query { users")) {
      return respond({ users: { nodes: [] } });
    }
    if (body.query.includes("issueCreate")) {
      const identifier = `LIN-${this.nextIssue}`;
      this.nextIssue += 1;
      const row = {
        id: `uuid-${identifier}`,
        identifier,
        title: String(body.variables.title),
        description: String(body.variables.description ?? ""),
        state: body.variables.stateId === "st-done" ? "Done" : "Todo",
        url: `https://linear.app/team/issue/${identifier}`,
      };
      this.issues.push(row);
      return respond({ issueCreate: { success: true, issue: rowToIssue(row) } });
    }
    if (body.query.includes("issueUpdate")) {
      return respond({ issueUpdate: { success: true, issue: { id: String(body.variables.id) } } });
    }
    if (body.query.includes("issue(id:")) {
      const found = this.issues.find((i) => i.identifier === body.variables.identifier);
      return respond({ issue: found ? rowToIssue(found) : null });
    }
    if (body.query.includes("issues(filter")) {
      const needle = String(body.variables.search);
      const found = this.issues.filter(
        (i) => i.title.includes(needle) || i.description.includes(needle),
      );
      return respond({ issues: { nodes: found.map(rowToIssue) } });
    }
    return respond({});
  }) as typeof fetch;
}

function respond(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function rowToIssue(row: {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
}) {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    state: { name: row.state },
    assignee: null,
    dueDate: null,
    url: row.url,
  };
}

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

function issueUpdateWebhook(identifier: string, stateName: string): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    created_at: new Date().toISOString(),
    data: {
      id: "uuid-x",
      identifier,
      name: "Some issue",
      state: { name: stateName, type: "started" },
    },
    url: `https://linear.app/team/issue/${identifier}`,
  });
}

async function makeHarness(wire: ScriptedLinearWire) {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  process.env.LUCENT_LINEAR_TEST_KEY = "lin_api_test";
  process.env.LUCENT_D7_WEBHOOK_SECRET = WEBHOOK_SECRET;
  const linear = new LinearProvider({
    apiKey: "lin_api_test",
    teamId: "team_1",
    baseUrl: "https://linear.test/graphql",
    fetchImpl: wire.fetchImpl,
    maxAttempts: 1,
    timeoutMs: 2_000,
  });
  const store = new InMemoryIntegrationStore();
  const inbound = new InMemoryInboundChangeStore();
  const webhookEvents = new InMemoryIntegrationWebhookEventStore();
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
      providers: new Map([
        ["linear", (): import("../src/integrations/provider.js").ExecutionProvider => linear],
      ]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents,
      inbound,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    store,
    inbound,
    webhookEvents,
    close: async () => {
      await close();
    },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function api(
  h: NonNullable<typeof open>,
  path: string,
  init: RequestInit & { token?: string; csrf?: string } = {},
) {
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

async function fireWebhook(
  h: NonNullable<typeof open>,
  body: string,
  signature: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${h.base}/api/integrations/linear/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Link a board node to LIN-1 directly through the store (the D6 approval
 * path is pinned by the D6 acceptance; here we need links + a live board). */
function action(id: string): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d7" } },
    { op: "SET_ISSUE", id, issue: { type: "task", status: "open" } },
  ];
}

async function seedLinkedBoard(h: NonNullable<typeof open>, token: string, orgId: string) {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "D7 board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const ops: Operation[] = [...action("spec"), ...action("qa")];
  const seeded = await api(h, `/api/boards/${boardId}/ops`, {
    method: "POST",
    token,
    body: JSON.stringify({ ops, label: "seed" }),
  });
  expect(seeded.status).toBe(200);
  // Two links: spec→LIN-1, qa→LIN-2 (the store-level link, as approval writes).
  for (const [nodeId, externalId] of [
    ["spec", "LIN-1"],
    ["qa", "LIN-2"],
  ] as const) {
    await h.store.linkTask(
      {
        orgId,
        boardId,
        nodeId,
        provider: "linear",
        externalId,
        url: `https://linear.app/team/issue/${externalId}`,
        lastSyncedStatus: "Todo",
      },
      Date.now(),
    );
  }
  return boardId;
}

describe("Stage D7 definition of done — inbound sync, end to end on a stubbed wire", () => {
  it("the full story: webhook → queue → accept (system actor) → dedupe → warning → tamper → conflict → invariant", async () => {
    const wire = new ScriptedLinearWire();
    const h = (open = await makeHarness(wire));

    // The org + user + the connection (webhookSecretRef resolved by the receiver).
    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "d7@example.com", password: "password123", name: "D7" }),
    });
    expect(signup.status).toBe(201);
    const token: string = signup.body.token;
    const userId: string = signup.body.user.id;
    const orgId = (await h.userStore.membershipsFor(userId))[0]!.orgId;
    const put = await api(h, `/api/orgs/${orgId}/integrations/linear`, {
      method: "PUT",
      token,
      csrf: "csrf",
      body: JSON.stringify({
        credentialRef: "LUCENT_LINEAR_TEST_KEY",
        config: { teamId: "team_1", webhookSecretRef: "LUCENT_D7_WEBHOOK_SECRET" },
      }),
    });
    expect(put.status).toBe(201);

    const boardId = await seedLinkedBoard(h, token, orgId);

    // 1. THE SIGNED WEBHOOK: Linear says the spec is Done.
    const body = issueUpdateWebhook("LIN-1", "Done");
    const delivery = await fireWebhook(h, body, sign(body));
    expect(delivery.status).toBe(200);
    expect(delivery.body).toMatchObject({ outcome: "processed" });

    // 2. ONE PENDING ROW, joined to the live board value.
    const queue = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    expect(queue.status).toBe(200);
    expect(queue.body.inbound).toHaveLength(1);
    const row = queue.body.inbound[0];
    expect(row).toMatchObject({
      nodeId: "spec",
      externalId: "LIN-1",
      externalValue: "Done",
      mappedValue: "completed",
      status: "pending",
      boardValue: "open",
      resolved: false,
      url: "https://linear.app/team/issue/LIN-1",
    });

    // 3. ACCEPT: the reviewed snapshot applies as the SYSTEM actor; the
    //    link records the provider's word.
    const accept = await api(h, `/api/boards/${boardId}/integrations/inbound/${row.id}/accept`, {
      method: "POST",
      token,
      csrf: "csrf",
    });
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ applied: 1, seq: expect.any(Number) });
    const board = await h.boardStore.get(boardId);
    expect(board!.workspace.nodes["spec"]!.issue!.status).toBe("completed");
    const log = await h.boardStore.loadLog(boardId, 0);
    const entry = [...log].reverse().find((e) => e.label === "sync from linear");
    expect(entry).toBeDefined();
    expect(entry!.actor).toMatchObject({
      actorType: "system",
      actorId: "linear",
      initiatedBy: userId,
    });
    const link = (await h.store.linksForNode(boardId, "spec")).find((l) => l.provider === "linear");
    expect(link!.lastSyncedStatus).toBe("Done");

    // A second accept is the honest duplicate (no second op).
    const logBefore = log.length;
    const reaccept = await api(h, `/api/boards/${boardId}/integrations/inbound/${row.id}/accept`, {
      method: "POST",
      token,
      csrf: "csrf",
    });
    expect(reaccept.status).toBe(200);
    expect(reaccept.body.duplicate).toBe(true);
    expect((await h.boardStore.loadLog(boardId, 0)).length).toBe(logBefore);

    // 4. THE QUEUE-LEVEL DEDUPE: a redelivery of the same bytes is a
    //    duplicate; a NEWER value (qa: In Progress) updates the row.
    const qaBody = issueUpdateWebhook("LIN-2", "In Progress");
    const first = await fireWebhook(h, qaBody, sign(qaBody));
    expect(first.body).toMatchObject({ outcome: "processed" });
    const redelivered = await fireWebhook(h, qaBody, sign(qaBody));
    expect(redelivered.body).toMatchObject({ outcome: "duplicate" });
    let queue2 = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    expect(queue2.body.inbound.filter((r: any) => r.status === "pending")).toHaveLength(1);
    const newer = issueUpdateWebhook("LIN-2", "Done");
    await fireWebhook(h, newer, sign(newer));
    queue2 = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    const pendingQa = queue2.body.inbound.filter((r: any) => r.status === "pending");
    expect(pendingQa).toHaveLength(1);
    expect(pendingQa[0]).toMatchObject({
      nodeId: "qa",
      externalValue: "Done",
      mappedValue: "completed",
    });

    // 5. THE CONFLICT CASE: an explicit sync supersedes the pending row and
    //    says so. (The sync route pushes the board's value outbound; the
    //    pushed value is the newer human decision.)
    const sync = await api(h, `/api/boards/${boardId}/integrations/linear/sync`, {
      method: "POST",
      token,
      csrf: "csrf",
    });
    expect(sync.status).toBe(200);
    expect(sync.body.supersededInbound).toBe(1);
    const queue3 = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    expect(queue3.body.inbound.find((r: any) => r.nodeId === "qa")).toMatchObject({
      status: "superseded",
    });

    // 6. THE NEVER-GUESS CASE: "In QA" does not translate — the warning row
    //    queues, accept refuses with the honest 409, dismiss keeps the board.
    const warnBody = issueUpdateWebhook("LIN-1", "In QA");
    await fireWebhook(h, warnBody, sign(warnBody));
    const queue4 = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    const warning = queue4.body.inbound.find(
      (r: any) => r.status === "pending" && r.externalValue === "In QA",
    );
    expect(warning).toBeDefined();
    expect(warning.mappedValue).toBeNull();
    const refused = await api(
      h,
      `/api/boards/${boardId}/integrations/inbound/${warning.id}/accept`,
      {
        method: "POST",
        token,
        csrf: "csrf",
      },
    );
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("no translation");
    expect((await h.boardStore.get(boardId))!.workspace.nodes["spec"]!.issue!.status).toBe(
      "completed",
    );
    const dismissed = await api(
      h,
      `/api/boards/${boardId}/integrations/inbound/${warning.id}/dismiss`,
      {
        method: "POST",
        token,
        csrf: "csrf",
      },
    );
    expect(dismissed.status).toBe(200);
    const linkAfter = (await h.store.linksForNode(boardId, "spec")).find(
      (l) => l.provider === "linear",
    );
    expect(linkAfter!.lastSyncedStatus).toBe("In QA");

    // 7. THE TAMPERED SIGNATURE: 400, and the event ledger holds no new row
    //    for those bytes (verify-before-ledger).
    const tampered = issueUpdateWebhook("LIN-2", "Done").replace("Done", "Todo");
    const tamperSign = sign(issueUpdateWebhook("LIN-2", "Done"));
    const before = (await h.webhookEvents.pending(0, Date.now() + 1, 100)).length;
    const refusedDelivery = await fireWebhook(h, tampered, tamperSign);
    expect(refusedDelivery.status).toBe(400);
    expect(refusedDelivery.body).toMatchObject({ outcome: "invalid_signature" });
    expect((await h.webhookEvents.pending(0, Date.now() + 1, 100)).length).toBe(before);

    // 8. THE UNLINKED ISSUE: a webhook for an issue no board links — no
    //    record, no noise.
    const unlinked = issueUpdateWebhook("LIN-999", "Done");
    const unlinkedRes = await fireWebhook(h, unlinked, sign(unlinked));
    expect(unlinkedRes.body).toMatchObject({ outcome: "processed" });
    const queue5 = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    expect(queue5.body.inbound.some((r: any) => r.externalId === "LIN-999")).toBe(false);

    // 9. THE WORKSPACE INVARIANT: after the accept, the workspace blob
    //    carries no provider strings.
    const finalBlob = JSON.stringify((await h.boardStore.get(boardId))!.workspace);
    expect(/linear|LIN-|lucent-action|webhook/i.test(finalBlob)).toBe(false);
  });
});
