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
import type { ExecutionProvider } from "../src/integrations/provider.js";
import { GithubProvider } from "../src/integrations/github.js";

/**
 * The D8 capability-honesty seam at the ROUTE level (ADR 0034): a warning-
 * carrying provider's preview shows the warnings, the items STORE them, and
 * approve refuses with the honest 409 until the caller acks them — the human
 * gate covers what the provider will DROP, not just what it will touch.
 *
 * The GithubProvider stands in as the warning-carrying provider with a
 * scripted wire (its own suite pins its contract); the FakeProvider covers
 * the no-warnings path (Linear's shape).
 */

const SECRET = "d8-capability-route-secret";

function scriptGithubWire() {
  const wires: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    wires.push({ method, path: url.pathname, body });
    if (url.pathname === "/repos/acme/app/assignees") {
      return new Response(JSON.stringify([{ login: "sarah-dev" }]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/repos/acme/app/issues") {
      return new Response(
        JSON.stringify({
          number: wires.filter((w) => w.method === "POST" && w.path === "/repos/acme/app/issues").length,
          title: String(body?.title ?? ""),
          body: String(body?.body ?? ""),
          state: "open",
          state_reason: null,
          html_url: "https://github.com/acme/app/issues/1",
          assignees: [],
        }),
        { status: 201 },
      );
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
  const github = new GithubProvider({
    token: "ghp_test",
    repo: "acme/app",
    fetchImpl,
    maxAttempts: 1,
    recoverPollMs: [1],
  });
  return { github, wires };
}

async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const { github, wires } = scriptGithubWire();
  const actions = new InMemoryIntegrationActionStore();
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
      store: new InMemoryIntegrationStore(),
      providers: new Map<string, () => ExecutionProvider>([["github", () => github]]),
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
    actions,
    wires,
    close: async () => { await close(); },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => { await open?.close(); open = null; });

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

/** An action with a dueDate + blocked status — exactly the fields GitHub
 * cannot represent faithfully (the review's capability-loss example). */
const LOSSY_OPS: Operation[] = [
  { op: "CREATE_NODE", id: "nd_brief", nodeType: "action", label: "Prepare launch brief" },
  { op: "SET_STATEMENT", id: "nd_brief", statement: { kind: "action", status: "open", topic: "d8" } },
  { op: "SET_ISSUE", id: "nd_brief", issue: { type: "task", status: "blocked", assignee: "sarah-dev", dueDate: "2026-09-20" } },
];

async function seedBoard(h: NonNullable<typeof open>, token: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST", token, body: JSON.stringify({ name: "D8 board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const seeded = await api(h, `/api/boards/${boardId}/ops`, {
    method: "POST", token, body: JSON.stringify({ ops: LOSSY_OPS, label: "seed" }),
  });
  expect(seeded.status).toBe(200);
  return boardId;
}

describe("the capability-honesty seam at the route level", () => {
  it("propose stores the warnings on the items; the preview carries them; approve 409s until the ack, then executes", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d8@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    process.env.GH_TEST_TOKEN = "ghp_test";
    const put = await api(h, `/api/orgs/${orgId}/integrations/github`, {
      method: "PUT", token: user.token, csrf: "csrf",
      body: JSON.stringify({ credentialRef: "GH_TEST_TOKEN", config: { repo: "acme/app" } }),
    });
    expect(put.status).toBe(201);
    const boardId = await seedBoard(h, user.token);

    // PROPOSE: the preview carries the dueDate + blocked warnings.
    const propose = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token: user.token, csrf: "csrf",
    });
    expect(propose.status).toBe(201);
    const item = propose.body.preview.creates[0];
    expect(item.warnings.map((w: any) => w.field).sort()).toEqual(["dueDate", "status"]);
    expect(item.warnings.find((w: any) => w.field === "dueDate").reason).toContain("2026-09-20");
    expect(item.warnings.find((w: any) => w.field === "status").reason).toContain("blocked");

    // The record STORES them (the approve gate reads the record, not the
    // preview — a stale preview cannot smuggle a warning-free approval).
    const record = await h.actions.action(boardId, propose.body.action.id);
    expect(record!.items[0]!.warnings).toHaveLength(2);

    // APPROVE WITHOUT THE ACK → the honest 409, the warnings echoed, zero
    // wire mutations.
    const refused = await api(h, `/api/boards/${boardId}/integrations/actions/${propose.body.action.id}/approve`, {
      method: "POST", token: user.token, csrf: "csrf",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.warnings).toHaveLength(2);
    expect(refused.body.acknowledgeWarnings).toBe(true);
    expect(h.wires.filter((w) => w.method === "POST" && w.path === "/repos/acme/app/issues")).toHaveLength(0);

    // APPROVE WITH THE ACK → executes; GitHub receives the title + the
    // assignee, no dueDate field at all (the loss is now CONSENTED), and
    // the body carries the recovery marker.
    const approved = await api(h, `/api/boards/${boardId}/integrations/actions/${propose.body.action.id}/approve`, {
      method: "POST", token: user.token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(1);
    const wire = h.wires.find((w) => w.method === "POST" && w.path === "/repos/acme/app/issues");
    expect(wire!.body).not.toHaveProperty("dueDate");
    expect(wire!.body?.title).toBe("Prepare launch brief");
    expect(String(wire!.body?.body)).toContain("lucent-action:ext_nd_brief");
    delete process.env.GH_TEST_TOKEN;
  });

  it("the duplicate approve answers the original outcome even with warnings acked", async () => {
    const h = (open = await makeHarness());
    const user = await signup(h, "d8b@example.com");
    const orgId = (await h.userStore.membershipsFor(user.id))[0]!.orgId;
    process.env.GH_TEST_TOKEN = "ghp_test";
    await api(h, `/api/orgs/${orgId}/integrations/github`, {
      method: "PUT", token: user.token, csrf: "csrf",
      body: JSON.stringify({ credentialRef: "GH_TEST_TOKEN", config: { repo: "acme/app" } }),
    });
    const boardId = await seedBoard(h, user.token);
    const propose = await api(h, `/api/boards/${boardId}/integrations/github/propose`, {
      method: "POST", token: user.token, csrf: "csrf",
    });
    const actionId = propose.body.action.id;
    await api(h, `/api/boards/${boardId}/integrations/actions/${actionId}/approve`, {
      method: "POST", token: user.token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    const before = h.wires.filter((w) => w.method === "POST").length;
    const dup = await api(h, `/api/boards/${boardId}/integrations/actions/${actionId}/approve`, {
      method: "POST", token: user.token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(dup.body.duplicate).toBe(true);
    expect(h.wires.filter((w) => w.method === "POST").length).toBe(before);
    delete process.env.GH_TEST_TOKEN;
  });
});
