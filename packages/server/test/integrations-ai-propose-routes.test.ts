import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider } from "@lucent/ai";
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
import type { ExternalPlanRequest, ExternalPlanResult, LLMProvider } from "@lucent/ai";

/**
 * The D9 AI-propose route: the narrowing agent through the same human gate
 * (ADR 0035). Pins the ladder order (connection before model — a refusal
 * costs no allowance), the never-tests (never widen / never auto-approve /
 * never spend on refusal), and the arms (dedup, the unknown-id drop, the
 * cap rejection, the empty intersection).
 *
 * A scripted selector LLM stands in for the model: the tests set its plan
 * verbatim, so the route's INTERSECTION logic is what's under test.
 */

const SECRET = "d9-ai-propose-route-secret";

/** A scripted selector: the test sets .plan; every call is counted. */
class ScriptedSelector implements LLMProvider {
  readonly name = "scripted";
  calls = 0;
  lastRequest: ExternalPlanRequest | null = null;
  plan: ExternalPlanResult = { nodeIds: [], explanation: "test rationale" };

  async generateOperations(): Promise<never> {
    throw new Error("not used");
  }
  async generateAnswer(): Promise<never> {
    throw new Error("not used");
  }
  async generateExternalPlan(request: ExternalPlanRequest): Promise<ExternalPlanResult> {
    this.calls += 1;
    this.lastRequest = request;
    return { ...this.plan };
  }
}

async function makeHarness(opts?: { withoutConnection?: boolean }) {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const usageStore = new InMemoryUsageStore();
  const selector = new ScriptedSelector();
  const store = new InMemoryIntegrationStore();
  const actions = new InMemoryIntegrationActionStore();
  process.env.D9_FAKE_CRED = "fake-key";
  if (!opts?.withoutConnection) {
    void store.putConnection(
      {
        orgId: "org_pre",
        provider: "fake",
        credentialRef: "D9_FAKE_CRED",
        scopes: [],
        createdBy: "usr_pre",
      },
      1,
    );
  }
  const { server, close } = createApp({
    config,
    provider: selector,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore,
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
      actions,
      ledger: new InMemoryExecutionLedger(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    usageStore,
    store,
    actions,
    selector,
    close: async () => {
      await close();
    },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.D9_FAKE_CRED;
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

/** Six actions: launch brief / spec / qa / pricing / onboarding / analytics. */
function seedOps(): Operation[] {
  const names = [
    "launch brief",
    "launch spec",
    "qa pass",
    "pricing update",
    "onboarding fix",
    "analytics check",
  ];
  const ops: Operation[] = [];
  for (const [i, name] of names.entries()) {
    const id = `nd_${i + 1}`;
    ops.push({ op: "CREATE_NODE", id, nodeType: "action", label: name });
    ops.push({
      op: "SET_STATEMENT",
      id,
      statement: { kind: "action", status: "open", topic: "d9" },
    });
    ops.push({ op: "SET_ISSUE", id, issue: { type: "task", status: "open" } });
  }
  return ops;
}

async function seedBoard(h: NonNullable<typeof open>, token: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "D9 board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const seeded = await api(h, `/api/boards/${boardId}/ops`, {
    method: "POST",
    token,
    body: JSON.stringify({ ops: seedOps(), label: "seed" }),
  });
  expect(seeded.status).toBe(200);
  return boardId;
}

describe("the AI-propose route — the narrowing agent", () => {
  it("the happy path: the narrowed record (origin ai, provenance, sourceSeq, the ratio), the same preview shape", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    // Move the connection into the user's org.
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    h.selector.plan = {
      nodeIds: ["nd_1", "nd_2", "nd_4"],
      explanation: "These appear related to the launch milestone.",
    };

    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send the launch-related actions" }),
    });
    expect(result.status).toBe(201);
    expect(result.body.action).toMatchObject({ origin: "ai", sourceSeq: expect.any(Number) });
    expect(result.body.action.provenance).toEqual({
      request: "send the launch-related actions",
      explanation: "These appear related to the launch milestone.",
    });
    // THE SELECTION RATIO: 3 of the board's 6.
    expect(result.body.preview.selectedCount).toBe(3);
    expect(result.body.preview.totalCandidates).toBe(6);
    expect(result.body.preview.statement).toContain("3 of the board's 6");
    expect(result.body.preview.creates).toHaveLength(3);
    expect(result.body.preview.explanation).toContain("launch milestone");

    // The record: pending, narrowed, with the AI provenance — and ONLY the
    // human approve route can decide it.
    const record = await h.actions.action(boardId, result.body.action.id);
    expect(record!.status).toBe("pending");
    expect(record!.origin).toBe("ai");
    expect(record!.items).toHaveLength(3);
    expect(record!.items.map((i) => i.nodeId)).toEqual(["nd_1", "nd_2", "nd_4"]);
    expect(record!.sourceSeq).toBeGreaterThan(0);
    // The usage metered on success with the mode tag.
    const month = await h.usageStore.monthToDate(orgId, "ai.generation", Date.now());
    expect(month).toBe(1);
    // The selector's request carried the semantic context + the request.
    expect(h.selector.lastRequest!.candidates).toHaveLength(6);
    expect(h.selector.lastRequest!.request).toBe("send the launch-related actions");
  });

  it("NEVER WIDEN: a ghost nodeId the model offers is dropped with a visible warning", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    h.selector.plan = {
      nodeIds: ["nd_1", "nd_ghost", "nd_2"],
      explanation: "mixing real and invented ids",
    };
    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send some" }),
    });
    expect(result.status).toBe(201);
    expect(result.body.preview.creates).toHaveLength(2);
    expect(result.body.preview.warnings).toEqual([expect.stringContaining("nd_ghost")]);
    const record = await h.actions.action(boardId, result.body.action.id);
    expect(record!.items.map((i) => i.nodeId)).toEqual(["nd_1", "nd_2"]);
  });

  it("DEDUP: a,a,b → 2 items, first-occurrence order, honest counts", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    h.selector.plan = { nodeIds: ["nd_1", "nd_1", "nd_2", "nd_2"], explanation: "duplicated" };
    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send some" }),
    });
    expect(result.body.preview.selectedCount).toBe(2);
    expect(result.body.preview.creates.map((c: any) => c.nodeId)).toEqual(["nd_1", "nd_2"]);
  });

  it("THE CAP: a 17-id selection is REFUSED with the honest 422 — never truncated", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    // The board has 6; the model re-selects them past the cap by repeating
    // — after dedup the count is 6, under the cap. To arm the cap honestly,
    // seed a 12-action board (over the 10 cap).
    const more: Operation[] = [];
    for (let i = 7; i <= 14; i += 1) {
      const id = `nd_${i}`;
      more.push({ op: "CREATE_NODE", id, nodeType: "action", label: `action ${i}` });
      more.push({
        op: "SET_STATEMENT",
        id,
        statement: { kind: "action", status: "open", topic: "d9" },
      });
      more.push({ op: "SET_ISSUE", id, issue: { type: "task", status: "open" } });
    }
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: user.token,
      body: JSON.stringify({ ops: more, label: "more" }),
    });
    h.selector.plan = {
      nodeIds: Array.from({ length: 12 }, (_, i) => `nd_${i + 1}`),
      explanation: "selected everything",
    };
    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send everything" }),
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("Lucent selected 12 actions");
    expect(result.body.max).toBe(10);
    // No record was created.
    expect((await h.actions.actionsForBoard(boardId)).length).toBe(0);
  });

  it("THE EMPTY INTERSECTION: none of the model's ids resolve → the recovery 422", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    h.selector.plan = { nodeIds: ["ghost_1", "ghost_2"], explanation: "nothing real" };
    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send whatever" }),
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toContain("couldn't identify actions");
    expect(result.body.hint).toContain("Try:");
  });

  it("NEVER SPEND ON REFUSAL: no connection → 404 with ZERO model calls and no usage", async () => {
    const h = (open = await makeHarness({ withoutConnection: true }));
    const user = await signup(h, "d9@example.com");
    const boardId = await seedBoard(h, user.token);
    const result = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send the launch ones" }),
    });
    expect(result.status).toBe(404);
    expect(h.selector.calls).toBe(0);
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    expect(await h.usageStore.monthToDate(orgId, "ai.generation", Date.now())).toBe(0);
  });

  it("the approve flow is UNTOUCHED: the AI record approves through the same human route, with the same ledger keys", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    h.selector.plan = { nodeIds: ["nd_1"], explanation: "one" };
    const proposed = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "the brief" }),
    });
    expect(proposed.status).toBe(201);
    // The human approve route decides it — the same route, same semantics.
    const approved = await api(
      h,
      `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`,
      {
        method: "POST",
        token: user.token,
        csrf: "csrf",
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(1);
    // The link registry carries the item.
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: user.token });
    expect(links.body.links).toHaveLength(1);
    expect(links.body.links[0].nodeId).toBe("nd_1");
  });

  it("the 422s: no executable actions, and an empty request body is refused", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d9@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    await h.store.putConnection(
      { orgId, provider: "fake", credentialRef: "D9_FAKE_CRED", scopes: [], createdBy: user.id },
      2,
    );
    const boardId = await seedBoard(h, user.token);
    const noBody = await api(h, `/api/boards/${boardId}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
    });
    expect(noBody.status).toBe(400);
    // A board with no actions.
    const empty = await api(h, "/api/boards", {
      method: "POST",
      token: user.token,
      body: JSON.stringify({ name: "empty", workspace: createWorkspace() }),
    });
    h.selector.plan = { nodeIds: ["x"], explanation: "x" };
    const noActions = await api(h, `/api/boards/${empty.body.id}/integrations/fake/propose-ai`, {
      method: "POST",
      token: user.token,
      csrf: "csrf",
      body: JSON.stringify({ request: "anything" }),
    });
    expect(noActions.status).toBe(422);
    expect(noActions.body.error).toContain("no executable actions");
    expect(h.selector.calls).toBe(0);
  });
});
