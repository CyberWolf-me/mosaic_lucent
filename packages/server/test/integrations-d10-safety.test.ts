import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
import { FakeProvider } from "../src/integrations/fake.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";

/**
 * The D10 production-safety contracts (ADR 0036), end to end through the
 * real app:
 *
 *   THE LINK-GC RECOVERY INVARIANT — the review's exact scenario: create →
 *   sync → LIN-482 → delete the node → the GC collects the link →
 *   recreate the action with the same id → sync → recoverCreate finds the
 *   task by the marker → RELINKED, ZERO new wire creates. Also the
 *   board-deleted variant.
 *
 *   THE TERMINAL-ROW PRUNE — the complete terminal sets (failed is
 *   retryable, never pruned), the terminal-timestamp cutoff, pending
 *   rows structurally safe.
 *
 *   THE PRUNE-REPLAY RULE — a webhook redelivered after the prune does
 *   not duplicate the queue row when the board state is unchanged (the
 *   ingest's resolution-level dedupe is the second barrier).
 */

const SECRET = "d10-safety-secret-0123456789";

async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const fake = new FakeProvider();
  const store = new InMemoryIntegrationStore();
  const actions = new InMemoryIntegrationActionStore();
  const webhookEvents = new InMemoryIntegrationWebhookEventStore();
  const inbound = new InMemoryInboundChangeStore();
  process.env.D10_FAKE_CRED = "fake-key";
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
      >([["fake", () => fake]]),
      actions,
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
    actions,
    webhookEvents,
    inbound,
    fake,
    close: async () => { await close(); },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.D10_FAKE_CRED;
});

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

function actionOps(id: string): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d10" } },
    { op: "SET_ISSUE", id, issue: { type: "task", status: "open" } },
  ];
}

describe("THE LINK-GC RECOVERY INVARIANT (the review's exact scenario)", () => {
  it("create → sync → the task exists → delete node → GC → recreate → sync → RELINKED, zero new creates", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d10@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    const put = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT", token: user.token, csrf: "csrf",
      body: JSON.stringify({ credentialRef: "D10_FAKE_CRED" }),
    });
    expect(put.status).toBe(201);
    const created = await api(h, "/api/boards", {
      method: "POST", token: user.token, body: JSON.stringify({ name: "D10 board", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token: user.token, body: JSON.stringify({ ops: actionOps("nd_brief"), label: "seed" }),
    });

    // 1. SYNC: the task is created, the link exists.
    const sync1 = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST", token: user.token, csrf: "csrf",
    });
    expect(sync1.body.created).toBe(1);
    const links1 = await api(h, `/api/boards/${boardId}/integrations/links`, { token: user.token });
    const externalId = links1.body.links[0]!.externalId;
    const createsBefore = h.fake.calls.filter((c) => c.method === "createTask").length;

    // 2. DELETE the node.
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token: user.token, body: JSON.stringify({ ops: [{ op: "DELETE_NODE", id: "nd_brief" }], label: "delete" }),
    });

    // 3. THE GC: the link's node is gone → collected (the sweep's own logic,
    // exercised directly — the arm is a main.ts interval).
    const board = await h.boardStore.get(boardId);
    expect(board!.workspace.nodes["nd_brief"]).toBeUndefined();
    const removed = await h.store.unlink(boardId, "nd_brief", "fake");
    expect(removed).toBe(true);

    // 4. RECREATE the action with the SAME id (the restore/undo case —
    // the marker ext_nd_brief is stable across the recreation).
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token: user.token, body: JSON.stringify({ ops: actionOps("nd_brief"), label: "recreate" }),
    });

    // 5. SYNC AGAIN: the node is unlinked — the RECOVERY runs BEFORE the
    // create. The marker ext_nd_brief is the idempotency key the first
    // create carried (the D10 marker contract), so the fake's byKey map
    // resolves it — the same way a real provider's description search
    // does. THE INVARIANT: RELINKED at the ORIGINAL external id, ZERO new
    // creates on the provider.
    const sync2 = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST", token: user.token, csrf: "csrf",
    });
    const relinked = sync2.body.results.find((r: any) => r.action === "relinked");
    expect(relinked).toBeDefined();
    expect(relinked.externalId).toBe(externalId);
    const createsAfter = h.fake.calls.filter((c) => c.method === "createTask").length;
    expect(createsAfter).toBe(createsBefore); // ZERO new creates
    const links2 = await api(h, `/api/boards/${boardId}/integrations/links`, { token: user.token });
    expect(links2.body.links).toHaveLength(1);
    expect(links2.body.links[0].externalId).toBe(externalId);
  });

  it("the board-deleted variant: a link whose board is gone is collected; nothing else runs", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d10b@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT", token: user.token, csrf: "csrf",
      body: JSON.stringify({ credentialRef: "D10_FAKE_CRED" }),
    });
    // A link to a board that no longer exists in the store.
    await h.store.linkTask(
      { orgId, boardId: "brd_gone", nodeId: "n1", provider: "fake", externalId: "fake-9", lastSyncedStatus: "todo" },
      1,
    );
    // The GC's own check (the sweep arm's logic, exercised directly):
    const board = await h.boardStore.get("brd_gone");
    expect(board).toBeUndefined();
    expect(await h.store.unlink("brd_gone", "n1", "fake")).toBe(true);
    expect(await h.store.linksForExternalId("fake", "fake-9")).toHaveLength(0);
  });
});

describe("THE TERMINAL-ROW PRUNE (the complete sets, the safe cutoff)", () => {
  it("webhook events: processed/ignored older than the horizon pruned; failed, received, and fresh terminal rows survive", async () => {
    const h = (open = await makeHarness());
    const OLD = 1_000_000_000_000;
    const NEW = Date.now();
    const mk = async (id: string, status: "processed" | "ignored" | "failed" | "received", at: number) => {
      await h.webhookEvents.claim({ id, provider: "fake", orgId: "o", externalId: null, now: at - 1, staleAfterMs: 1 });
      if (status === "failed") await h.webhookEvents.markFailed(id, "boom", at);
      else if (status === "processed") await h.webhookEvents.markProcessed(id, "o", at);
      else if (status === "ignored") await h.webhookEvents.markIgnored(id, at);
    };
    await mk("old-processed", "processed", OLD);
    await mk("old-ignored", "ignored", OLD);
    await mk("new-processed", "processed", NEW);
    await mk("failed-row", "failed", OLD);
    await mk("received-row", "received", OLD);
    const horizon = Date.now() - 1000;
    const pruned = await h.webhookEvents.pruneTerminal(horizon, 100);
    expect(pruned).toBe(2); // old-processed + old-ignored; failed NEVER
    // failed + received survive (retryable + in-flight — the pending feed
    // lists exactly them, with a staleAt wide enough for their old claims);
    // new-processed is fresh (not in the feed, but the count proves it).
    const survivors = new Set(
      (await h.webhookEvents.pending(OLD, Date.now() + 1, 100)).map((e) => e.id),
    );
    expect(survivors.has("failed-row")).toBe(true);
    expect(survivors.has("received-row")).toBe(true);
  });

  it("inbound changes: applied/dismissed/superseded pruned by decidedAt; pending untouched", async () => {
    const h = (open = await makeHarness());
    const OLD = 1_000_000_000_000;
    const base = {
      orgId: "o", boardId: "b", provider: "fake" as const, nodeId: "n",
      externalId: "E1", field: "status" as const, externalValue: "done", mappedValue: "completed" as const,
    };
    const put = (id: string) =>
      h.inbound.put({ ...base, nodeId: id }, "webhook", OLD);
    await put("p1"); // stays pending — never pruned
    await put("p2");
    await h.inbound.decide("b", (await h.inbound.forBoard("b")).find((r) => r.nodeId === "p1")!.id, "applied", "u", OLD);
    await h.inbound.decide("b", (await h.inbound.forBoard("b")).find((r) => r.nodeId === "p2")!.id, "dismissed", "u", Date.now());
    const pruned = await h.inbound.pruneTerminal(Date.now() - 1000, 100);
    expect(pruned).toBe(1); // p1 (decided OLD); p2 decided NOW survives
    const rows = await h.inbound.forBoard("b");
    expect(rows.find((r) => r.nodeId === "p1")).toBeUndefined();
    expect(rows.find((r) => r.nodeId === "p2")).toBeDefined();
  });
});

describe("THE PRUNE-REPLAY RULE (the second barrier is semantic)", () => {
  it("a webhook redelivered after the prune does not duplicate the queue row when the board state is unchanged", async () => {
    const h = (open = await makeHarness());
    // The link + board state: the node's status equals the webhook's word.
    const board = { ...createWorkspace() };
    board.nodes["n1"] = {
      id: "n1", nodeType: "action", label: "N",
      statement: { kind: "action", status: "open" },
      issue: { type: "task", status: "completed", statusCategory: "done" },
    };
    await h.boardStore.put({
      id: "b", orgId: "o", ownerId: "u", name: "b", createdAt: 1, updatedAt: 1, workspace: board,
    });
    await h.store.linkTask(
      { orgId: "o", boardId: "b", nodeId: "n1", provider: "fake", externalId: "fake-1", lastSyncedStatus: "done" },
      1,
    );
    // THE FIRST DELIVERY (processed): "Done" → the board already says
    // completed → the resolution-level dedupe: NO queue row.
    const { ingestInboundChange } = await import("../src/integrations/inbound.js");
    const deps = {
      linksForExternalId: (p: string, e: string) => h.store.linksForExternalId(p, e),
      boardNodeStatus: async () => "completed",
      store: h.inbound,
      provider: h.fake,
    };
    const first = await ingestInboundChange(deps, { provider: "fake", externalId: "fake-1", status: "done" }, "o");
    expect(first.count).toBe(0);
    // THE PRUNE (any rows vanish) — then the REPLAY of the same semantic
    // event: the board is unchanged → still no row. The dedupe barrier is
    // the board's live value, not the pruned ledger row.
    await h.inbound.pruneTerminal(0, 100);
    const replay = await ingestInboundChange(deps, { provider: "fake", externalId: "fake-1", status: "done" }, "o");
    expect(replay.count).toBe(0);
    // But a NEW value (the provider moved again) still queues — the barrier
    // is dedupe, not a lock.
    const moved = await ingestInboundChange(deps, { provider: "fake", externalId: "fake-1", status: "todo" }, "o");
    expect(moved.count).toBe(1);
  });
});
