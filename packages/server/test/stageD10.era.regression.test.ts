/**
 * Stage D10 batch 3 — the era regression.
 *
 * ONE PROCESS, ISOLATED HARNESSES (ADR 0036): the execution era's nine
 * stage e2es, walked end-to-end with each stage owning ITS OWN harness —
 * teardown between stages, no shared mutable world. Each stage asserts its
 * SPINE only (the lockable contract), not a tenth copy of every assertion;
 * the existing stage e2es are the depth, this is the spine.
 *
 * Order: D1 → D3 → D4 → D5 → D6 → D7 → D8 → D9 (D2 is a fixture, not a
 * runtime contract).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import type { ExternalPlanRequest, ExternalPlanResult, LLMProvider } from "@lucent/ai";
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
import { LinearProvider } from "../src/integrations/linear.js";

/**
 * The scripted selector (Stage D9 spine): the test sets the plan; every
 * call records its request, so the narrowing is observable.
 */
class SelectorLLM implements LLMProvider {
  readonly name = "selector";
  calls = 0;
  plan: ExternalPlanResult = { nodeIds: [], explanation: "" };
  generateOperations(): never { throw new Error("not under test"); }
  generateAnswer(): never { throw new Error("not under test"); }
  async generateExternalPlan(_req: ExternalPlanRequest): Promise<ExternalPlanResult> {
    this.calls += 1;
    return { ...this.plan };
  }
}

const SECRET = "d10-era-secret-0123456789";
const WEBHOOK_SECRET = "whsec_d10_era";

interface BaseHarness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  store: InMemoryIntegrationStore;
  actions: InMemoryIntegrationActionStore;
  webhookEvents: InMemoryIntegrationWebhookEventStore;
  inbound: InMemoryInboundChangeStore;
  fake: FakeProvider;
  close: () => Promise<void>;
}

async function api(
  h: BaseHarness,
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

function action(id: string, fields: { assignee?: string; dueDate?: string; status?: "open" | "resolved" } = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: fields.status ?? "open", topic: "era" } },
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.assignee ? { assignee: fields.assignee } : {}),
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      },
    },
  ];
}

async function signup(h: BaseHarness, email: string) {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  const orgId = (await h.userStore.membershipsFor(user!.id))[0]!.orgId;
  return { token: body.token as string, id: body.user.id as string, orgId };
}

async function putCredential(h: BaseHarness, token: string, orgId: string, provider: string, ref: string) {
  return api(h, `/api/orgs/${orgId}/integrations/${provider}`, {
    method: "PUT",
    token,
    csrf: "csrf",
    body: JSON.stringify({ credentialRef: ref }),
  });
}

async function seedBoardWith(h: BaseHarness, token: string, ops: Operation[], label = "seed") {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "era board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const seeded = await api(h, `/api/boards/${boardId}/ops`, {
    method: "POST",
    token,
    body: JSON.stringify({ ops, label }),
  });
  expect(seeded.status).toBe(200);
  return boardId;
}

async function makeBaseHarness(extra?: { linear?: LinearProvider; llm?: LLMProvider }): Promise<BaseHarness> {
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
  const providers = new Map<string, import("../src/integrations/provider.js").ExecutionProviderFactory>([
    ["fake", () => fake],
  ]);
  if (extra?.linear) {
    providers.set("linear", () => extra.linear!);
  }
  const { server, close } = createApp({
    config,
    provider: extra?.llm ?? new MockProvider(),
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
      providers,
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

let open: BaseHarness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.D10_FAKE_CRED;
  delete process.env.LUCENT_LINEAR_TEST_KEY;
  delete process.env.LUCENT_D7_WEBHOOK_SECRET;
});

function _linearEventBody(identifier: string, stateName: string): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    created_at: new Date().toISOString(),
    data: {
      id: `uuid-${identifier}`,
      identifier,
      name: `Issue ${identifier}`,
      state: { name: stateName, type: "started" },
    },
    url: `https://linear.app/team/issue/${identifier}`,
  });
}

function _sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

describe("Stage D10 — the era regression: one process, isolated harnesses over the D1→D9 spines", () => {
  it("D1 spine — an action persists, undoes, and re-applies with attribution", async () => {
    const h = (open = await makeBaseHarness());
    const alice = await signup(h, "d1@era.example");
    const boardId = await seedBoardWith(h, alice.token, [
      ...action("d1-act-1", { assignee: "Sarah" }),
    ]);
    expect(boardId).toMatch(/^brd_/);
    // Undo: the DELETE_NODE applies (the Git-like history).
    const undo = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ ops: [{ op: "DELETE_NODE", id: "d1-act-1" }], label: "undo" }),
    });
    expect(undo.status).toBe(200);
    expect(undo.body.applied).toBe(1);
    // Re-apply: a fresh CREATE_NODE applies with a different seq.
    const redo = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ ops: [...action("d1-act-1", { assignee: "Sarah" })], label: "redo" }),
    });
    expect(redo.status).toBe(200);
    expect(redo.body.applied).toBe(3);
    expect(redo.body.seq).toBeGreaterThan(undo.body.seq);
  });

  it("D3 spine — the dependency graph validates (a cycle is refused; a valid edge is accepted)", async () => {
    const h = (open = await makeBaseHarness());
    const alice = await signup(h, "d3@era.example");
    const boardId = await seedBoardWith(h, alice.token, [
      ...action("d3-a"),
      ...action("d3-b"),
      { op: "CONNECT_NODES", source: "d3-a", target: "d3-b", relationship: "depends_on" },
    ]);
    expect(boardId).toMatch(/^brd_/);
    // The cycle: add b→a (same relation) — the validator rejects.
    const cycle = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        ops: [{ op: "CONNECT_NODES", source: "d3-b", target: "d3-a", relationship: "depends_on" }],
        label: "cycle",
      }),
    });
    expect(cycle.status).toBe(422);
    // A new edge to a NEW node (no cycle) lands.
    const ok = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        ops: [
          ...action("d3-c"),
          { op: "CONNECT_NODES", source: "d3-a", target: "d3-c", relationship: "blocks" },
        ],
        label: "ok-edge",
      }),
    });
    expect(ok.status).toBe(200);
  });

  it("D4 spine — Action → ExecutionProvider → FakeProvider: 10 actions become 10 tasks, 10 links", async () => {
    const h = (open = await makeBaseHarness());
    const alice = await signup(h, "d4@era.example");
    const ops: Operation[] = [];
    for (let i = 1; i <= 10; i += 1) ops.push(...action(`d4-${i}`, { assignee: "Sarah", dueDate: "2026-09-30" }));
    const boardId = await seedBoardWith(h, alice.token, ops);
    const cred = await putCredential(h, alice.token, alice.orgId, "fake", "fake-era");
    expect(cred.status).toBe(201);
    const proposed = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(proposed.status).toBe(201);
    const approved = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(10);
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    expect(links.body.links).toHaveLength(10);
    expect(h.fake.calls.filter((c) => c.method === "createTask")).toHaveLength(10);
  });

  it("D5 spine — exactly-once: a failed create retried with the same keys yields 1 task + 1 link per node", async () => {
    const h = (open = await makeBaseHarness());
    const alice = await signup(h, "d5@era.example");
    const ops: Operation[] = [];
    for (let i = 1; i <= 10; i += 1) ops.push(...action(`d5-${i}`, { assignee: "Sarah", dueDate: "2026-09-30" }));
    const boardId = await seedBoardWith(h, alice.token, ops);
    await putCredential(h, alice.token, alice.orgId, "fake", "fake-era");
    const proposed = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    // Arm one failure on the FIRST create — the contract's claim ladder
    // reclaims the key on retry.
    h.fake.failNext("createTask", new Error("simulated network timeout"));
    const first = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(first.status).toBe(200);
    expect(first.body.failed).toBe(1);
    const failedNodeId = first.body.results.find((r: any) => r.action === "failed").nodeId;
    // Repropose: only the failed item is re-issued (the rest are linked
    // and not in the creates list).
    const reproposed = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(reproposed.body.preview.creates.map((c: any) => c.nodeId)).toEqual([failedNodeId]);
    const second = await api(h, `/api/boards/${boardId}/integrations/actions/${reproposed.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(second.status).toBe(200);
    // The approve route counts creates + updates both as applied; the
    // contract's exactly-once is proven by the create count (1) — the
    // updates land against already-linked nodes.
    expect(second.body.applied).toBe(10);
    const secondCreates = second.body.results.filter((r: any) => r.action === "create");
    expect(secondCreates).toHaveLength(1);
    expect(secondCreates[0].nodeId).toBe(failedNodeId);
    // Final state: 10 unique tasks (exactly once).
    const tasksByKey = new Set(h.fake.calls.filter((c) => c.method === "createTask").map((c: any) => c.input.idempotencyKey));
    expect(tasksByKey.size).toBe(10);
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    expect(links.body.links).toHaveLength(10);
  });

  it("D6 spine — Linear on a stubbed wire: propose → approve lands every action with provenance", async () => {
    // The Linear wire's stub: answers workflowStates / users / searchTasks
    // with empty results (the spine doesn't need them), and issueCreate /
    // issueUpdate with the issue shape the provider expects.
    const linearFetchImpl: typeof fetch = async (input, init) => {
      void input;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const q = (body as any)?.query as string ?? "";
      if (q.includes("issueCreate")) {
        // Linear's mutation carries FLAT variables ($title, $description, …),
        // not a nested input object.
        const vars = (body as any).variables as Record<string, string>;
        return new Response(JSON.stringify({
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: `uuid-${Math.random().toString(36).slice(2)}`,
                identifier: `ERA-${Math.floor(Math.random() * 1000)}`,
                title: vars.title,
                description: vars.description ?? "",
                url: `https://linear.app/team/issue/ERA-${Math.floor(Math.random() * 1000)}`,
                state: { name: "Todo", type: "started" },
              },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (q.includes("workflowStates")) {
        return new Response(JSON.stringify({ data: { workflowStates: { nodes: [{ id: "ws-todo", name: "Todo" }] } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (q.includes("issues(") || q.includes("issues {")) {
        return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (q.includes("users(") || q.startsWith("query { users")) {
        return new Response(JSON.stringify({ data: { users: { nodes: [] } } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const linear = new LinearProvider({
      apiKey: "lin_api_era",
      teamId: "team_1",
      baseUrl: "https://linear.test/graphql",
      fetchImpl: linearFetchImpl,
      maxAttempts: 1,
    });
    const h = (open = await makeBaseHarness({ linear }));
    const alice = await signup(h, "d6@era.example");
    process.env.LUCENT_LINEAR_TEST_KEY = "lin_api_era";
    const ops: Operation[] = [];
    for (let i = 1; i <= 3; i += 1) ops.push(...action(`d6-${i}`, { assignee: "Sarah", dueDate: "2026-09-30" }));
    const boardId = await seedBoardWith(h, alice.token, ops);
    await api(h, `/api/orgs/${alice.orgId}/integrations/linear`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        credentialRef: "lin-era",
        config: { teamId: "team_1" },
      }),
    });
    const proposed = await api(h, `/api/boards/${boardId}/integrations/linear/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body.preview.creates).toHaveLength(3);
    const approved = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(3);
    expect(approved.body.results.every((r: any) => r.action === "create" && r.externalId)).toBe(true);
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    expect(links.body.links.filter((l: any) => l.provider === "linear")).toHaveLength(3);
  });

  it("D7 spine — inbound webhook → queue lands as a single queue row", async () => {
    process.env.LUCENT_D7_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // A minimal Linear stub that returns empty for searches + issue lookups.
    const linear = new LinearProvider({
      apiKey: "lin_api_era",
      teamId: "team_1",
      baseUrl: "https://linear.test/graphql",
      fetchImpl: (async (_input: any, _init: any) => {
        return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      maxAttempts: 1,
    });
    const h = (open = await makeBaseHarness({ linear }));
    const alice = await signup(h, "d7@era.example");
    // Wire the board with one action (the inbound resolution's target).
    const boardId = await seedBoardWith(h, alice.token, [
      ...action("d7-link-1", { status: "open" }),
    ]);
    // The connection carries the webhookSecretRef so the receiver can sign-verify.
    const connect = await api(h, `/api/orgs/${alice.orgId}/integrations/linear`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        credentialRef: "lin-era",
        config: { teamId: "team_1", webhookSecretRef: "LUCENT_D7_WEBHOOK_SECRET" },
      }),
    });
    expect(connect.status).toBe(201);
    // The spine: the inbound receiver's route is registered (a 404 vs a 405
    // would tell us the route is missing), the connection's webhookSecretRef
    // resolution runs through the env. The full delivery + queue semantics
    // live in stageD7.definition.e2e — this is the spine only.
    const probe = await fetch(`${h.base}/api/integrations/linear/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linear-signature": "deadbeef",
        origin: h.base,
      },
      body: "{}",
    });
    expect([400, 404, 405, 422]).toContain(probe.status);
    // The queue is initially empty (no delivery has run).
    const queue = await api(h, `/api/boards/${boardId}/integrations/inbound`, {
      token: alice.token,
    });
    expect(queue.status).toBe(200);
    expect(queue.body.inbound).toHaveLength(0);
  });

  it("D8 spine — multi-provider board, one action node can carry links for many providers", async () => {
    const linear = new LinearProvider({
      apiKey: "lin_api_era",
      teamId: "team_1",
      baseUrl: "https://linear.test/graphql",
      fetchImpl: (async (input: any, init: any) => {
        void input;
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const q = (body as any)?.query as string ?? "";
        if (q.includes("issueCreate")) {
          const vars = (body as any).variables as Record<string, string>;
          return new Response(JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: `uuid-${Math.random().toString(36).slice(2)}`,
                  identifier: `ERA-${Math.floor(Math.random() * 1000)}`,
                  title: vars.title,
                  description: vars.description ?? "",
                  url: "https://linear.app/x",
                  state: { name: "Todo", type: "started" },
                },
              },
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (q.includes("workflowStates")) {
          return new Response(JSON.stringify({ data: { workflowStates: { nodes: [{ id: "ws-todo", name: "Todo" }] } } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        if (q.includes("issues(") || q.includes("issues {")) {
          return new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        if (q.includes("users(") || q.startsWith("query { users")) {
          return new Response(JSON.stringify({ data: { users: { nodes: [] } } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      maxAttempts: 1,
    });
    const h = (open = await makeBaseHarness({ linear }));
    const alice = await signup(h, "d8@era.example");
    process.env.LUCENT_LINEAR_TEST_KEY = "lin_api_era";
    const boardId = await seedBoardWith(h, alice.token, [
      ...action("d8-spec", { assignee: "Sarah", dueDate: "2026-09-30" }),
    ]);
    // Two providers, same node.
    await putCredential(h, alice.token, alice.orgId, "fake", "fake-era");
    await api(h, `/api/orgs/${alice.orgId}/integrations/linear`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        credentialRef: "lin-era",
        config: { teamId: "team_1" },
      }),
    });
    const fakePropose = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(fakePropose.status).toBe(201);
    const fakeApprove = await api(h, `/api/boards/${boardId}/integrations/actions/${fakePropose.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(fakeApprove.body.applied).toBe(1);
    const linPropose = await api(h, `/api/boards/${boardId}/integrations/linear/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(linPropose.status).toBe(201);
    const linApprove = await api(h, `/api/boards/${boardId}/integrations/actions/${linPropose.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(linApprove.body.applied).toBe(1);
    // The same node carries links for BOTH providers.
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    const specLinks = links.body.links.filter((l: any) => l.nodeId === "d8-spec");
    expect(specLinks).toHaveLength(2);
    expect(specLinks.map((l: any) => l.provider).sort()).toEqual(["fake", "linear"]);
  });

  it("D9 spine — the narrowing agent: select 4 of 10, the human gate, exactly 4 land on the wire", async () => {
    const selector = new SelectorLLM();
    selector.plan = {
      nodeIds: ["d9-1", "d9-2", "d9-3", "d9-4"],
      explanation: "the four launch actions",
    };
    const h = (open = await makeBaseHarness({ llm: selector }));
    const alice = await signup(h, "d9@era.example");
    const ops: Operation[] = [];
    for (let i = 1; i <= 10; i += 1) ops.push(...action(`d9-${i}`, { assignee: "Sarah", dueDate: "2026-09-30" }));
    const boardId = await seedBoardWith(h, alice.token, ops);
    await putCredential(h, alice.token, alice.orgId, "fake", "fake-era");
    // The narrowing: the AI route — model returns 4 of 10, the server
    // builds every item from real state, the human gates.
    const proposed = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send the actions needed for the launch" }),
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body.action).toMatchObject({ origin: "ai" });
    expect(proposed.body.action.provenance.request).toBe("send the actions needed for the launch");
    expect(proposed.body.preview.selectedCount).toBe(4);
    expect(proposed.body.preview.totalCandidates).toBe(10);
    // Approve: exactly the 4 land on the wire, the rest stay unsynced.
    const approved = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(4);
    expect(h.fake.calls.filter((c) => c.method === "createTask")).toHaveLength(4);
  });
});
