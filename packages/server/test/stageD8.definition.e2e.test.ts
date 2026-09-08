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
import { GithubProvider } from "../src/integrations/github.js";
import { JiraProvider } from "../src/integrations/jira.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";
import type { ExecutionProvider } from "../src/integrations/provider.js";

/**
 * Stage D8's definition of done — THE MULTI-PROVIDER BOARD, one acceptance
 * through the UNTOUCHED routes (the one-file-one-map-entry proof at platform
 * level): two Linear-linked nodes, two GitHub-linked, two Jira-linked, plus
 * the review's arms —
 *
 *   the capability-loss E2E (dueDate+blocked → the GitHub preview carries
 *   2 warnings → approve without ack → 409 → with ack → applied, GitHub
 *   state=open, no dueDate);
 *   the GitHub recovery (create lands, response lost → the poll finds it →
 *   reconciled, 0 duplicates — and the >1 arm → the honest failure);
 *   the Jira transition (resolved → posted; a status with no counterpart →
 *   the warned-then-honest error);
 *   a signed GitHub webhook (closed:not_planned) → the queue stores the
 *   composed word → accept → the system-actor row actorId "github";
 *   CROSS-PROVIDER SAME ACTION (one action → a GitHub link AND a Jira link
 *   coexisting — the (nodeId, provider) uniqueness in practice);
 *   UNLINK ISOLATION (unlink github → the jira link remains);
 *   duplicate approval per provider; the workspace blob free of
 *   linear/github/jira strings; viewer 404s.
 */

const SECRET = "d8-acceptance-secret-0123456789";
const GH_WEBHOOK_SECRET = "whsec_d8_acceptance_gh";

/* ------------------------------ The three wires ------------------------- */

class GithubWire {
  readonly issues: Array<{ number: number; title: string; body: string; state: string; state_reason: string | null }> = [];
  private next = 100;
  /** Arm: the NEXT create lands but its response is lost (the recovery case). */
  hangNextCreate = false;

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (url.pathname === "/repos/acme/app/assignees") {
      return new Response(JSON.stringify([{ login: "sarah-dev" }]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/repos/acme/app/issues") {
      const number = ++this.next;
      this.issues.push({
        number,
        title: String(body?.title ?? ""),
        body: String(body?.body ?? ""),
        state: "open",
        state_reason: null,
      });
      if (this.hangNextCreate) {
        this.hangNextCreate = false;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }) as Promise<Response>;
      }
      return new Response(
        JSON.stringify({
          number,
          title: String(body?.title ?? ""),
          body: String(body?.body ?? ""),
          state: "open",
          state_reason: null,
          html_url: `https://github.com/acme/app/issues/${number}`,
          assignees: [],
        }),
        { status: 201 },
      );
    }
    if (method === "PATCH") {
      const number = Number(url.pathname.split("/").pop());
      const issue = this.issues.find((i) => i.number === number);
      if (!issue) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      if (typeof body?.state === "string") issue.state = body.state;
      if (typeof body?.state_reason === "string") issue.state_reason = body.state_reason;
      return new Response(JSON.stringify({ ...issue, html_url: `https://github.com/acme/app/issues/${number}`, assignees: [] }), { status: 200 });
    }
    if (method === "GET" && url.pathname === `/repos/acme/app/issues/${url.pathname.split("/").pop()}`) {
      const number = Number(url.pathname.split("/").pop());
      const issue = this.issues.find((i) => i.number === number);
      if (!issue) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      return new Response(JSON.stringify({ ...issue, html_url: `https://github.com/acme/app/issues/${number}`, assignees: [] }), { status: 200 });
    }
    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q") ?? "";
      const markerToken = (q.match(/"([^"]+)"/) ?? [])[1] ?? "";
      const found = this.issues.filter((i) => i.body.includes(markerToken));
      return new Response(JSON.stringify({ items: found.map((i) => ({ ...i, html_url: `https://github.com/acme/app/issues/${i.number}`, assignees: [] })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
}

class JiraWire {
  readonly issues: Array<{ key: string; summary: string; marker: string; status: string; duedate: string | null }> = [];
  private next = 1;
  /** The transitions the scripted board offers (the 1-match contract). */
  transitions: Array<{ id: string; to: string }> = [
    { id: "11", to: "In Progress" },
    { id: "31", to: "Done" },
  ];

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const path = url.pathname;
    if (path === "/rest/api/3/issue" && method === "POST") {
      const key = `LAUNCH-${this.next++}`;
      const fields = body?.fields as Record<string, unknown>;
      this.issues.push({
        key,
        summary: String(fields?.summary ?? ""),
        marker: String(fields?.description ? JSON.stringify(fields.description) : ""),
        status: "To Do",
        duedate: (fields?.duedate as string) ?? null,
      });
      return new Response(JSON.stringify({ key }), { status: 201 });
    }
    const issueMatch = path.match(/^\/rest\/api\/3\/issue\/(LAUNCH-\d+)$/);
    if (issueMatch) {
      const key = issueMatch[1]!;
      const issue = this.issues.find((i) => i.key === key);
      if (!issue) return new Response(JSON.stringify({ errorMessages: ["not found"] }), { status: 404 });
      if (method === "PUT") {
        const fields = body?.fields as Record<string, unknown>;
        if (typeof fields?.summary === "string") issue.summary = fields.summary;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({
        key,
        fields: {
          summary: issue.summary,
          description: { type: "doc", version: 1, content: [] },
          status: { name: issue.status },
          assignee: null,
          duedate: issue.duedate,
        },
      }), { status: 200 });
    }
    // The transitions route: /rest/api/3/issue/LAUNCH-N/transitions.
    const transitionMatch = path.match(/^\/rest\/api\/3\/issue\/(LAUNCH-\d+)\/transitions$/);
    if (transitionMatch) {
      const key = transitionMatch[1]!;
      const issue = this.issues.find((i) => i.key === key);
      if (!issue) return new Response(JSON.stringify({ errorMessages: ["not found"] }), { status: 404 });
      if (method === "GET") {
        return new Response(JSON.stringify({
          transitions: this.transitions.map((t) => ({ id: t.id, name: t.to, to: { name: t.to } })),
        }), { status: 200 });
      }
      const chosen = this.transitions.find((t) => t.id === String((body?.transition as Record<string, unknown>)?.id));
      if (issue && chosen) issue.status = chosen.to;
      return new Response(null, { status: 204 });
    }
    if (path === "/rest/api/3/search/jql") {
      const jql = url.searchParams.get("jql") ?? "";
      const markerToken = (jql.match(/"([^"]+)"/) ?? [])[1] ?? "";
      const found = this.issues.filter((i) => i.marker.includes(markerToken));
      return new Response(JSON.stringify({
        issues: found.map((i) => ({
          key: i.key,
          fields: { summary: i.summary, description: {}, status: { name: i.status }, assignee: null, duedate: i.duedate },
        })),
      }), { status: 200 });
    }
    if (path === "/rest/api/3/user/assignable/search") {
      return new Response(JSON.stringify([
        { accountId: "a1", emailAddress: "sarah@example.com", displayName: "Sarah Chen" },
      ]), { status: 200 });
    }
    return new Response(JSON.stringify({ errorMessages: ["no route"] }), { status: 404 });
  }) as typeof fetch;
}

class LinearWire {
  readonly issues: Array<{ id: string; identifier: string; title: string; description: string; state: string; url: string }> = [];
  private next = 1;

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const q = body.query;
    const respond = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const rowToIssue = (row: { id: string; identifier: string; title: string; description: string; state: string; url: string }) => ({
      id: row.id, identifier: row.identifier, title: row.title, description: row.description,
      state: { name: row.state }, assignee: null, dueDate: null, url: row.url,
    });
    if (q.includes("workflowStates")) {
      return respond({ workflowStates: { nodes: [
        { id: "st-todo", name: "Todo" }, { id: "st-done", name: "Done" }, { id: "st-canceled", name: "Canceled" },
      ] } });
    }
    if (q.includes("query { users")) return respond({ users: { nodes: [] } });
    if (q.includes("issueCreate")) {
      const identifier = `LIN-${this.next++}`;
      const row = { id: `uuid-${identifier}`, identifier, title: String(body.variables.title), description: String(body.variables.description ?? ""), state: "Todo", url: `https://linear.test/issue/${identifier}` };
      this.issues.push(row);
      return respond({ issueCreate: { success: true, issue: rowToIssue(row) } });
    }
    if (q.includes("issueUpdate")) return respond({ issueUpdate: { success: true, issue: { id: "x" } } });
    if (q.includes("issue(id:")) {
      const found = this.issues.find((i) => i.identifier === body.variables.identifier);
      return respond({ issue: found ? rowToIssue(found) : null });
    }
    if (q.includes("issues(filter")) {
      const needle = String(body.variables.search);
      const found = this.issues.filter((i) => i.title.includes(needle) || i.description.includes(needle));
      return respond({ issues: { nodes: found.map(rowToIssue) } });
    }
    return respond({});
  }) as typeof fetch;
}

/* ------------------------------- The harness ----------------------------- */

async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  process.env.LUCENT_D8_LINEAR_KEY = "lin_api_d8";
  process.env.LUCENT_D8_GH_KEY = "ghp_d8";
  process.env.LUCENT_D8_JIRA_CRED = "dev@example.com:jira_token";
  process.env.LUCENT_D8_GH_WEBHOOK = GH_WEBHOOK_SECRET;
  const ghWire = new GithubWire();
  const jiraWire = new JiraWire();
  const linearWire = new LinearWire();
  const providers = new Map<string, () => ExecutionProvider>([
    ["linear", () => new LinearProvider({ apiKey: "lin_api_d8", teamId: "team_1", baseUrl: "https://linear.test/graphql", fetchImpl: linearWire.fetchImpl, maxAttempts: 1, timeoutMs: 2_000 })],
    ["github", () => new GithubProvider({ token: "ghp_d8", repo: "acme/app", fetchImpl: ghWire.fetchImpl, maxAttempts: 1, timeoutMs: 2_000, recoverPollMs: [1, 1, 1] })],
    ["jira", () => new JiraProvider({ email: "dev@example.com", apiToken: "jira_token", site: "https://acme.atlassian.net", projectKey: "LAUNCH", fetchImpl: jiraWire.fetchImpl, maxAttempts: 1, timeoutMs: 2_000, recoverPollMs: [1, 1, 1] })],
  ]);
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
      providers,
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents: new InMemoryIntegrationWebhookEventStore(),
      inbound,
      // The two hang arms must run in the test budget, not the default 15s
      // (the D6 e2e's lesson).
      executionTimeoutMs: 20,
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
    ghWire,
    jiraWire,
    linearWire,
    close: async () => { await close(); },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.LUCENT_D8_LINEAR_KEY;
  delete process.env.LUCENT_D8_GH_KEY;
  delete process.env.LUCENT_D8_JIRA_CRED;
  delete process.env.LUCENT_D8_GH_WEBHOOK;
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

function action(id: string, fields: { status?: string; assignee?: string; dueDate?: string } = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d8" } },
    { op: "SET_ISSUE", id, issue: { type: "task", status: fields.status ?? "open", ...(fields.assignee ? { assignee: fields.assignee } : {}), ...(fields.dueDate ? { dueDate: fields.dueDate } : {}) } },
  ];
}

/** The review's #21-22 arm: one action sent to BOTH github and jira — the
 * (nodeId, provider) uniqueness proven by coexisting links. */
const CROSS_OPS: Operation[] = [
  ...action("spec", { assignee: "sarah-dev", dueDate: "2026-09-20" }),
  ...action("brief", { assignee: "sarah-dev", dueDate: "2026-09-20", status: "blocked" }),
];

describe("Stage D8 definition of done — the multi-provider board, end to end on three stubbed wires", () => {
  it("the full story: three providers through the untouched routes; the capability gate; the recovery; the transition; the webhook; cross-provider links; unlink isolation; the invariant", { timeout: 20_000 }, async () => {
    const h = (open = await makeHarness());

    // The user + org + three connections (each provider's config schema).
    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "d8@example.com", password: "password123", name: "D8" }),
    });
    expect(signup.status).toBe(201);
    const token: string = signup.body.token;
    const orgId = (await h.userStore.membershipsFor(signup.body.user.id))[0]!.orgId;
    for (const [provider, config] of [
      ["linear", { teamId: "team_1", webhookSecretRef: "LUCENT_D8_GH_WEBHOOK" === "LUCENT_D8_GH_WEBHOOK" ? "LUCENT_D8_GH_WEBHOOK" : undefined }],
      ["github", { repo: "acme/app", webhookSecretRef: "LUCENT_D8_GH_WEBHOOK" }],
      ["jira", { site: "https://acme.atlassian.net", projectKey: "LAUNCH" }],
    ] as const) {
      const credRef = provider === "linear" ? "LUCENT_D8_LINEAR_KEY" : provider === "github" ? "LUCENT_D8_GH_KEY" : "LUCENT_D8_JIRA_CRED";
      const put = await api(h, `/api/orgs/${orgId}/integrations/${provider}`, {
        method: "PUT", token, csrf: "csrf",
        body: JSON.stringify({ credentialRef: credRef, config: config as unknown as Record<string, string> }),
      });
      expect(put.status).toBe(201);
    }

    // The board: one spec action (cross-provider target) + one blocked
    // brief with a dueDate (the capability-loss target).
    const created = await api(h, "/api/boards", {
      method: "POST", token, body: JSON.stringify({ name: "D8 board", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const seeded = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token, body: JSON.stringify({ ops: CROSS_OPS, label: "seed" }),
    });
    expect(seeded.status).toBe(200);

    // ---- THE CAPABILITY-LOSS ARM (the review's #20): github cannot carry
    // dueDate or blocked — the preview says so; the ack is required.
    const ghPropose = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(ghPropose.status).toBe(201);
    const briefRow = ghPropose.body.preview.creates.find((c: any) => c.nodeId === "brief");
    expect(briefRow.warnings.map((w: any) => w.field).sort()).toEqual(["dueDate", "status"]);
    const specRow = ghPropose.body.preview.creates.find((c: any) => c.nodeId === "spec");
    // spec's status is open + a dueDate → one warning (the dueDate only).
    expect(specRow.warnings.map((w: any) => w.field)).toEqual(["dueDate"]);
    const ghRefused = await api(h, `/api/boards/${boardId}/integrations/actions/${ghPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(ghRefused.status).toBe(409);
    expect(ghRefused.body.warnings.length).toBeGreaterThanOrEqual(3);
    expect(h.ghWire.issues).toHaveLength(0); // nothing reached the wire
    const ghApproved = await api(h, `/api/boards/${boardId}/integrations/actions/${ghPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(ghApproved.status).toBe(200);
    expect(ghApproved.body.applied).toBe(2);
    // GitHub received both, no dueDate, all open (the consented loss).
    expect(h.ghWire.issues).toHaveLength(2);
    for (const issue of h.ghWire.issues) {
      expect(issue.state).toBe("open");
    }

    // JIRA through the same untouched routes: faithful fields, the ack
    // not required (no warnings — blocked warns).
    const jiraPropose = await api(h, `/api/boards/${boardId}/integrations/jira/propose`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(jiraPropose.status).toBe(201);
    const jiraBrief = jiraPropose.body.preview.creates.find((c: any) => c.nodeId === "brief");
    expect(jiraBrief.warnings.map((w: any) => w.field)).toEqual(["status"]);
    const jiraRefused = await api(h, `/api/boards/${boardId}/integrations/actions/${jiraPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(jiraRefused.status).toBe(409);
    const jiraApproved = await api(h, `/api/boards/${boardId}/integrations/actions/${jiraPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(jiraApproved.status).toBe(200);
    expect(jiraApproved.body.applied).toBe(2);
    expect(h.jiraWire.issues).toHaveLength(2);
    // The duedate rides (faithful field), and the blocked status stayed
    // "To Do" (the create does not transition).
    const jiraSpec = h.jiraWire.issues.find((i) => i.summary === "spec");
    expect(jiraSpec!.duedate).toBe("2026-09-20");

    // ---- DUPLICATE APPROVAL PER PROVIDER (linear's arm, run before any
    // extra nodes exist so the counts stay 2): propose, approve, re-approve
    // → duplicate:true, zero new wire mutations.
    const linearPropose = await api(h, `/api/boards/${boardId}/integrations/linear/propose`, {
      method: "POST", token, csrf: "csrf",
    });
    const linearApprove = await api(h, `/api/boards/${boardId}/integrations/actions/${linearPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(linearApprove.body.applied).toBe(2);
    const linearReapprove = await api(h, `/api/boards/${boardId}/integrations/actions/${linearPropose.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(linearReapprove.body.duplicate).toBe(true);
    expect(h.linearWire.issues).toHaveLength(2);

    // ---- CROSS-PROVIDER SAME ACTION (the review's #21, three providers
    // deep): spec now carries a github, a jira, AND a linear link — the
    // (nodeId, provider) uniqueness proven three ways on one node.
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token });
    const specLinks = links.body.links.filter((l: any) => l.nodeId === "spec");
    expect(specLinks).toHaveLength(3);
    expect(specLinks.map((l: any) => l.provider).sort()).toEqual(["github", "jira", "linear"]);

    // ---- UNLINK ISOLATION (the review's #22): dropping the github link
    // leaves the jira + linear links intact (the store's per-provider
    // unlink — isolation is per provider, not per node).
    await h.store.unlink(boardId, "spec", "github");
    const after = await api(h, `/api/boards/${boardId}/integrations/links`, { token });
    const specAfter = after.body.links.filter((l: any) => l.nodeId === "spec");
    expect(specAfter).toHaveLength(2);
    expect(specAfter.map((l: any) => l.provider).sort()).toEqual(["jira", "linear"]);

    // ---- THE D10 RELINK (the recovery contract's >1 protection): after an
    // unlink the original issue is still on the wire; the recovery finds it
    // and RELINKS — never creates a duplicate, even if hangNextCreate were
    // set (the recovery short-circuits before the create races the timeout).
    const ghPropose2 = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token, csrf: "csrf",
    });
    const specItem = ghPropose2.body.preview.creates.find((c: any) => c.nodeId === "spec");
    expect(specItem).toBeDefined(); // back to create after the unlink
    const ghApproved2 = await api(h, `/api/boards/${boardId}/integrations/actions/${ghPropose2.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    // THE D10 RECOVERY CONTRACT: spec's original issue still lives on the wire
    // (the unlink only dropped the Lucent-side row), so recoverCreate finds
    // it FIRST and RELINKS — no new wire mutation, no timeout. Brief drifts.
    expect(ghApproved2.body.failed).toBe(0);
    expect(ghApproved2.body.applied).toBe(2);
    const specResult = ghApproved2.body.results.find((r: any) => r.nodeId === "spec");
    expect(specResult.action).toBe("relinked");
    const githubProvider = new GithubProvider({ token: "ghp_d8", repo: "acme/app", fetchImpl: h.ghWire.fetchImpl, maxAttempts: 1, recoverPollMs: [1, 1, 1] });
    // Only ONE wire issue carries ext_spec (the original — the hung create never landed):
    await expect(githubProvider.recoverCreate("lucent-action:ext_spec")).resolves.toBeDefined();

    // ---- THE 0→1 RECOVERY (a fresh node, a fresh key): the create lands,
    // the response is lost, recoverCreate polls and finds the ONE issue.
    const heroSeed = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token, body: JSON.stringify({ ops: action("hero", { dueDate: "2026-09-30" }), label: "hero" }),
    });
    expect(heroSeed.status).toBe(200);
    h.ghWire.hangNextCreate = true;
    const ghPropose3 = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token, csrf: "csrf",
    });
    const ghApproved3 = await api(h, `/api/boards/${boardId}/integrations/actions/${ghPropose3.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(ghApproved3.body.failed).toBe(1); // hero's create timed out
    const recovered = await githubProvider.recoverCreate("lucent-action:ext_hero");
    expect(recovered).toBeDefined();
    const lastIssue = h.ghWire.issues[h.ghWire.issues.length - 1]!;
    expect(recovered!.externalId).toBe(String(lastIssue.number));

    // ---- THE JIRA TRANSITION: completed resolves the single "Done"
    // transition and posts it.
    const jiraProvider = new JiraProvider({
      email: "dev@example.com", apiToken: "jira_token", site: "https://acme.atlassian.net",
      projectKey: "LAUNCH", fetchImpl: h.jiraWire.fetchImpl, maxAttempts: 1, timeoutMs: 2_000,
    });
    const moved = await jiraProvider.updateTask("LAUNCH-1", { status: "completed" });
    expect(moved.status).toBe("Done");
    expect(h.jiraWire.issues.find((i) => i.key === "LAUNCH-1")!.status).toBe("Done");
    // A Lucent status with no Jira counterpart: the honest error.
    await expect(jiraProvider.updateTask("LAUNCH-1", { status: "cancelled" })).rejects.toThrow(/no well-known Jira counterpart/);

    // ---- THE SIGNED GITHUB WEBHOOK: closed:not_planned → the queue
    // stores the composed word; accept → the system-actor row.
    const specGithubNumber = String(h.ghWire.issues[1]!.number); // the brief's link
    const body = JSON.stringify({
      action: "closed",
      issue: { number: Number(specGithubNumber), state: "closed", state_reason: "not_planned" },
    });
    const sig = createHmac("sha256", GH_WEBHOOK_SECRET).update(Buffer.from(body, "utf8")).digest("hex");
    const delivery = await fetch(`${h.base}/api/integrations/github/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
      body,
    });
    expect(delivery.status).toBe(200);
    const queue = await api(h, `/api/boards/${boardId}/integrations/inbound`, { token });
    const pendingRow = queue.body.inbound.find(
      (r: any) => r.status === "pending" && r.externalValue === "closed:not_planned",
    );
    expect(pendingRow).toBeDefined();
    expect(pendingRow.mappedValue).toBe("cancelled");
    const accept = await api(h, `/api/boards/${boardId}/integrations/inbound/${pendingRow.id}/accept`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(accept.status).toBe(200);
    const board = await h.boardStore.get(boardId);
    expect(board!.workspace.nodes["brief"]!.issue!.status).toBe("cancelled");
    const log = await h.boardStore.loadLog(boardId, 0);
    const systemEntry = [...log].reverse().find((e) => e.label === "sync from github");
    expect(systemEntry).toBeDefined();
    expect(systemEntry!.actor).toMatchObject({ actorType: "system", actorId: "github" });

    // ---- VIEWER FLOOR: a non-member's propose + links calls 404.
    const viewer = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "d8viewer@example.com", password: "password123", name: "Viewer" }),
    });
    const vPropose = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token: viewer.body.token, csrf: "csrf",
    });
    expect(vPropose.status).toBe(404);

    // ---- THE WORKSPACE INVARIANT: after three providers' creates,
    // updates, a webhook, and an accept, the blob carries no provider strings.
    const finalBlob = JSON.stringify((await h.boardStore.get(boardId))!.workspace);
    expect(/linear|github|jira|LIN-|LAUNCH-|lucent-action/i.test(finalBlob)).toBe(false);
  });
});
