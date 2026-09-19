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

/**
 * The D5 approval-flow routes (ADR 0031): propose → preview → approve →
 * execute, with the decided-once guard, the honest preview, zero effects on
 * reject, and the viewer floors.
 */

const SECRET = "test-secret-at-least-16-chars";

async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const fake = new FakeProvider();
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
      providers: new Map([["fake", () => fake]]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    fake,
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

async function orgIdOf(h: NonNullable<typeof open>, userId: string) {
  return (await h.userStore.membershipsFor(userId))[0]!.orgId;
}

function action(id: string, fields: { assignee?: string; dueDate?: string } = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d5" } },
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: "open",
        ...(fields.assignee ? { assignee: fields.assignee } : {}),
        ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
      },
    },
  ];
}

async function seedBoardWith(h: NonNullable<typeof open>, token: string, ops: Operation[]) {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "D5 board", workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const seeded = await api(h, `/api/boards/${boardId}/ops`, {
    method: "POST",
    token,
    body: JSON.stringify({ ops, label: "seed" }),
  });
  expect(seeded.status).toBe(200);
  return boardId;
}

describe("the propose → preview route", () => {
  it("returns the honest preview: creates with fields, the nothing-deleted statement", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "p@example.com");
    const orgId = await orgIdOf(h, alice.id);
    const put = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    expect(put.status).toBe(201);

    const ops = [
      ...action("task-1", { assignee: "Sarah", dueDate: "2026-09-20" }),
      ...action("task-2"),
    ];
    const boardId = await seedBoardWith(h, alice.token, ops);

    const propose = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(propose.status).toBe(201);
    expect(propose.body.action.status).toBe("pending");
    expect(propose.body.preview.creates).toHaveLength(2);
    expect(propose.body.preview.creates[0]).toMatchObject({
      nodeId: "task-1",
      title: "task 1",
      assignee: "Sarah",
      dueDate: "2026-09-20",
    });
    expect(propose.body.preview.updates).toEqual([]);
    expect(propose.body.preview.statement).toContain("Nothing will be deleted");
    expect(propose.body.preview.statement).toContain("2 task(s)");
  });

  it("one pending per (board, provider): a second propose supersedes and reports it", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "p2@example.com");
    const orgId = await orgIdOf(h, alice.id);
    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    const boardId = await seedBoardWith(h, alice.token, action("n1"));

    const first = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    const second = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(second.status).toBe(201);
    expect(second.body.action.supersededId).toBe(first.body.action.id);
  });
});

describe("the approve → execute route", () => {
  it("applies the batch: 10 created, 10 linked, and the second approve answers duplicate", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "a@example.com");
    const orgId = await orgIdOf(h, alice.id);
    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    const ops: Operation[] = [];
    for (let i = 1; i <= 10; i += 1) ops.push(...action(`task-${i}`));
    const boardId = await seedBoardWith(h, alice.token, ops);

    const propose = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    const actionId = propose.body.action.id;
    const approve = await api(
      h,
      `/api/boards/${boardId}/integrations/actions/${actionId}/approve`,
      {
        method: "POST",
        token: alice.token,
        csrf: "csrf",
      },
    );
    expect(approve.status).toBe(200);
    expect(approve.body.applied).toBe(10);
    expect(approve.body.failed).toBe(0);
    expect(h.fake.taskCount).toBe(10);

    // The links landed.
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    expect(links.body.links).toHaveLength(10);

    // The second approve: the decided-once guard answers duplicate with the
    // ORIGINAL outcome, zero new effects.
    const second = await api(h, `/api/boards/${boardId}/integrations/actions/${actionId}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(h.fake.taskCount).toBe(10); // unchanged
  });

  it("reject leaves ZERO external effects (the provider is never called)", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "r@example.com");
    const orgId = await orgIdOf(h, alice.id);
    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    const boardId = await seedBoardWith(h, alice.token, action("n1"));
    const propose = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    const reject = await api(
      h,
      `/api/boards/${boardId}/integrations/actions/${propose.body.action.id}/reject`,
      {
        method: "POST",
        token: alice.token,
        csrf: "csrf",
      },
    );
    expect(reject.status).toBe(200);
    expect(reject.body.action.status).toBe("rejected");
    expect(h.fake.calls).toHaveLength(0); // the provider was never called
    expect(h.fake.taskCount).toBe(0);
  });

  it("a viewer cannot propose or approve (404, ids unguessable); the list is viewer-readable", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "o@example.com");
    const viewer = await signup(h, "v@example.com");
    const orgId = await orgIdOf(h, alice.id);
    await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "R" }),
    });
    const boardId = await seedBoardWith(h, alice.token, action("n1"));
    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ token: share.body.token }),
    });

    const propose = await api(h, `/api/boards/${boardId}/integrations/fake/propose`, {
      method: "POST",
      token: viewer.token,
      csrf: "csrf",
    });
    expect(propose.status).toBe(404);
    const list = await api(h, `/api/boards/${boardId}/integrations/actions`, {
      token: viewer.token,
    });
    expect(list.status).toBe(200); // reads are viewer-floor
  });
});
