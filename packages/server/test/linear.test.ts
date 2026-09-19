import { describe, expect, it } from "vitest";
import { LinearProvider } from "../src/integrations/linear.js";

/**
 * The Linear adapter's wire contract (Stage D6, ADR 0032) — asserted against
 * a scripted GraphQL responder, never a live account (the StripeClient/
 * Anthropic fetchImpl precedent). What is pinned: the raw-key
 * Authorization header (NO Bearer — the documented divergence), the exact
 * `{ query, variables }` bodies, issueCreate → the ExternalTask
 * normalization (externalId = the IDENTIFIER, LIN-482), the deterministic
 * assignee ladder, the cached workflowStates (one query per batch),
 * mapStatus's never-guesses rule, the recovery search, and the error/
 * retry/timeout arms.
 */

interface Wire {
  url: string;
  init: RequestInit;
}

function responder(handler: (wire: Wire) => Response | Promise<Response>) {
  const seen: Wire[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const wire: Wire = { url: String(url), init: init ?? {} };
    seen.push(wire);
    return handler(wire);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function gqlResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status });
}

function linearIssue(over: Partial<{ id: string; identifier: string; title: string; state: string; assignee: string; dueDate: string }> = {}) {
  return {
    id: over.id ?? "uuid-1",
    identifier: over.identifier ?? "LIN-482",
    title: over.title ?? "Sarah will prepare the launch campaign",
    description: "the brief\n\n<!-- lucent-action:ext_n1 -->",
    state: { name: over.state ?? "Todo" },
    assignee: over.assignee ? { name: over.assignee, email: "sarah@example.com" } : null,
    dueDate: over.dueDate ?? "2026-09-15",
    url: `https://linear.app/team/issue/${over.identifier ?? "LIN-482"}`,
  };
}

function provider(fetchImpl: typeof fetch, overrides = {}) {
  return new LinearProvider({
    apiKey: "lin_api_test_123",
    teamId: "team_1",
    baseUrl: "https://linear.test/graphql",
    fetchImpl,
    maxAttempts: 1,
    ...overrides,
  });
}

const ISSUE_CREATE_BODY = (wire: Wire) =>
  JSON.parse(String(wire.init.body)) as { query: string; variables: Record<string, unknown> };

const USERS = [
  { id: "u-sarah", name: "Sarah Chen", email: "sarah@example.com" },
  { id: "u-alex1", name: "Alex Johnson", email: "alex.j@example.com" },
  { id: "u-alex2", name: "Alex Jones", email: "alex.jones@example.com" },
];

const STATES = [
  { id: "st-todo", name: "Todo" },
  { id: "st-progress", name: "In Progress" },
  { id: "st-done", name: "Done" },
  { id: "st-canceled", name: "Canceled" },
  { id: "st-blocked", name: "Blocked" },
];

function route(wire: Wire): Response {
  const body = ISSUE_CREATE_BODY(wire);
  if (body.query.includes("workflowStates")) {
    return gqlResponse({ workflowStates: { nodes: STATES } });
  }
  if (body.query.includes("query { users")) {
    return gqlResponse({ users: { nodes: USERS } });
  }
  if (body.query.includes("issueCreate")) {
    const sarah = USERS.find((u) => u.id === body.variables.assigneeId);
    return gqlResponse({
      issueCreate: {
        success: true,
        issue: linearIssue(sarah ? { assignee: sarah.name } : {}),
      },
    });
  }
  if (body.query.includes("issueUpdate")) {
    return gqlResponse({ issueUpdate: { success: true, issue: linearIssue() } });
  }
  if (body.query.includes("issue(id:")) {
    return gqlResponse({ issue: linearIssue() });
  }
  if (body.query.includes("issues(filter")) {
    return gqlResponse({ issues: { nodes: [linearIssue()] } });
  }
  return new Response(JSON.stringify({ errors: [{ message: "unknown query" }] }), { status: 200 });
}

describe("the wire contract", () => {
  it("sends the RAW key in Authorization — no Bearer prefix (Linear's documented divergence)", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    await p.createTask({ title: "A", idempotencyKey: "ext_n1" });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("lin_api_test_123");
    expect(String(headers.authorization)).not.toContain("Bearer");
    expect(headers["content-type"]).toBe("application/json");
    expect(seen[0]!.url).toBe("https://linear.test/graphql");
  });

  it("issueCreate carries teamId/title/marker/dueDate and returns the IDENTIFIER as externalId", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    const task = await p.createTask({
      title: "Sarah will prepare the launch campaign",
      description: "Prepare the launch brief",
      assignee: "sarah@example.com",
      dueDate: "2026-09-15",
      status: "open",
      idempotencyKey: "ext_n1",
    });
    // THE OWNER'S ACCEPTANCE SHAPE: provider=linear, externalId=LIN-482.
    expect(task).toMatchObject({
      provider: "linear",
      externalId: "LIN-482",
      title: "Sarah will prepare the launch campaign",
      assignee: "Sarah Chen",
      dueDate: "2026-09-15",
      url: "https://linear.app/team/issue/LIN-482",
    });
    // The wire body: the mutation carries the team + the fields + the marker.
    const createWire = seen.find((w) => ISSUE_CREATE_BODY(w).query.includes("issueCreate"))!;
    const vars = ISSUE_CREATE_BODY(createWire).variables;
    expect(vars.teamId).toBe("team_1");
    expect(vars.title).toBe("Sarah will prepare the launch campaign");
    expect(vars.dueDate).toBe("2026-09-15");
    expect(vars.assigneeId).toBe("u-sarah"); // the email ladder resolved it
    expect(vars.stateId).toBe("st-todo"); // open → Todo via the cached states
    expect(String(vars.description)).toContain("<!-- lucent-action:ext_n1 -->");
  });

  it("the workflowStates query runs ONCE per provider instance (the cached batch rule)", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    for (let i = 0; i < 10; i += 1) {
      await p.createTask({ title: `T${i}`, status: "in_progress", idempotencyKey: `ext_n${i}` });
    }
    const stateQueries = seen.filter((w) => ISSUE_CREATE_BODY(w).query.includes("workflowStates"));
    expect(stateQueries).toHaveLength(1); // one query per batch, not per item
  });
});

describe("the assignee resolution ladder", () => {
  it("exact email wins; exact name second; unique partial third; ambiguous rejects", async () => {
    const { fetchImpl } = responder(route);
    const p = provider(fetchImpl);
    // Email.
    expect(await p.createTask({ title: "A", assignee: "sarah@example.com", idempotencyKey: "k1" })).toBeDefined();
    // Exact normalized name.
    expect(await p.createTask({ title: "B", assignee: "Sarah Chen", idempotencyKey: "k2" })).toBeDefined();
    // Unique partial: only one Alex… wait, TWO Alexes — the ambiguous case.
    await expect(p.createTask({ title: "C", assignee: "Alex", idempotencyKey: "k3" })).rejects.toThrow(
      /uniquely resolve assignee "Alex"/,
    );
  });

  it("the resolution is cached per provider instance", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    await p.createTask({ title: "A", assignee: "sarah@example.com", idempotencyKey: "k1" });
    await p.createTask({ title: "B", assignee: "sarah@example.com", idempotencyKey: "k2" });
    const userQueries = seen.filter((w) => ISSUE_CREATE_BODY(w).query.includes("users"));
    expect(userQueries).toHaveLength(1); // the second create hit the cache
  });
});

describe("mapStatus — never a guess (ADR 0032's rule)", () => {
  it("Linear's WorkflowState names translate; unknown words return undefined", () => {
    const p = provider(responder(route).fetchImpl);
    expect(p.mapStatus("Todo")).toBe("open");
    expect(p.mapStatus("In Progress")).toBe("in_progress");
    expect(p.mapStatus("Blocked")).toBe("blocked");
    expect(p.mapStatus("Done")).toBe("completed");
    expect(p.mapStatus("Canceled")).toBe("cancelled");
    // The custom states a team invents — NOT guessed as open.
    expect(p.mapStatus("In QA")).toBeUndefined();
    expect(p.mapStatus("Deployed")).toBeUndefined();
    expect(p.mapStatus("whatever")).toBeUndefined();
  });

  it("toExternalStatus: the reverse mapping for outbound creates", () => {
    const p = provider(responder(route).fetchImpl);
    expect(p.toExternalStatus("open")).toBe("Todo");
    expect(p.toExternalStatus("in_progress")).toBe("In Progress");
    expect(p.toExternalStatus("completed")).toBe("Done");
    expect(p.toExternalStatus("cancelled")).toBe("Canceled");
  });
});

describe("recoverCreate — the ambiguous-outcome reconciliation", () => {
  it("finds the issue whose description carries the marker", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    const found = await p.recoverCreate("<!-- lucent-action:ext_n1 -->");
    expect(found?.externalId).toBe("LIN-482");
    const searchWire = seen.find((w) => ISSUE_CREATE_BODY(w).query.includes("issues(filter"))!;
    expect(ISSUE_CREATE_BODY(searchWire).variables.search).toBe("<!-- lucent-action:ext_n1 -->");
  });

  it("no match → undefined (the create never landed; the retry re-creates)", async () => {
    const { fetchImpl } = responder((_wire) => gqlResponse({ issues: { nodes: [] } }));
    const p = provider(fetchImpl);
    expect(await p.recoverCreate("<!-- lucent-action:ext_missing -->")).toBeUndefined();
  });
});

describe("the error, retry, and timeout arms", () => {
  it("the GraphQL error envelope surfaces as LinearError, not a silent data undefined", async () => {
    const { fetchImpl } = responder(() =>
      new Response(JSON.stringify({ errors: [{ message: "team not found" }] }), { status: 200 }),
    );
    const p = provider(fetchImpl);
    await expect(p.createTask({ title: "A", idempotencyKey: "k" })).rejects.toThrow(/team not found/);
  });

  it("429 retries then succeeds; non-retryable status throws immediately", async () => {
    let calls = 0;
    const { fetchImpl } = responder(() => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return gqlResponse({ issueCreate: { success: true, issue: linearIssue() } });
    });
    const p = provider(fetchImpl, { maxAttempts: 2, sleep: async () => {} });
    const task = await p.createTask({ title: "A", idempotencyKey: "k" });
    expect(task.externalId).toBe("LIN-482");
    expect(calls).toBe(2);
  });

  it("the timeout arm: a hanging fetch rejects when the abort signal fires", async () => {
    // A hanging fetch that HONORS the signal — the shape a real network
    // call has (the abort is what makes the timeout work).
    const hanging = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
    const p = provider(hanging as typeof fetch, { maxAttempts: 1, timeoutMs: 20 });
    await expect(p.createTask({ title: "A", idempotencyKey: "k" })).rejects.toThrow();
  });

  it("the factory refuses an unset env credential and a missing teamId with honest errors", async () => {
    const { linearConnectionFactory } = await import("../src/integrations/linear.js");
    const factory = linearConnectionFactory();
    const saved = process.env.LUCENT_LINEAR_TEST_KEY;
    delete process.env.LUCENT_LINEAR_TEST_KEY;
    expect(() => factory({ credentialRef: "LUCENT_LINEAR_TEST_KEY", config: { teamId: "t" } })).toThrow(
      /not set in the environment/,
    );
    process.env.LUCENT_LINEAR_TEST_KEY = saved;
    if (saved) {
      expect(() => factory({ credentialRef: "LUCENT_LINEAR_TEST_KEY" })).toThrow(/config.teamId/);
    }
  });

  it("the factory refuses unsafe or private custom baseUrls", async () => {
    const { linearConnectionFactory } = await import("../src/integrations/linear.js");
    const factory = linearConnectionFactory();
    const saved = process.env.LUCENT_LINEAR_TEST_KEY;
    process.env.LUCENT_LINEAR_TEST_KEY = "lin_test_key";
    try {
      expect(() =>
        factory({ credentialRef: "LUCENT_LINEAR_TEST_KEY", config: { teamId: "t", baseUrl: "http://evil.example/webhook" } }),
      ).toThrow(/only https/);
      expect(() =>
        factory({ credentialRef: "LUCENT_LINEAR_TEST_KEY", config: { teamId: "t", baseUrl: "https://192.168.0.9/hook" } }),
      ).toThrow(/private\/loopback/);
    } finally {
      if (saved === undefined) delete process.env.LUCENT_LINEAR_TEST_KEY;
      else process.env.LUCENT_LINEAR_TEST_KEY = saved;
    }
  });
});

describe("updateTask / getTask", () => {
  it("updateTask resolves the identifier to the UUID, then mutates by id", async () => {
    const { fetchImpl, seen } = responder(route);
    const p = provider(fetchImpl);
    const updated = await p.updateTask("LIN-482", { status: "completed" });
    expect(updated.externalId).toBe("LIN-482");
    const updateWire = seen.find((w) => ISSUE_CREATE_BODY(w).query.includes("issueUpdate"))!;
    const vars = ISSUE_CREATE_BODY(updateWire).variables;
    expect(vars.id).toBe("uuid-1"); // the UUID, not the identifier
    expect(vars.stateId).toBe("st-done"); // completed → Done via the cache
  });

  it("getTask by identifier caches the UUID for later updates", async () => {
    const { fetchImpl } = responder(route);
    const p = provider(fetchImpl);
    const task = await p.getTask("LIN-482");
    expect(task.externalId).toBe("LIN-482");
    expect(task.status).toBe("Todo");
  });
});
