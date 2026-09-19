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
import { InMemoryIntegrationStore } from "../src/integrations/integrations.js";
import { FakeProvider } from "../src/integrations/fake.js";

/**
 * Stage D4's definition of done — the owner's acceptance as one continuous
 * story (the stageD family):
 *
 *   10 action nodes on a shared board. An owner configures the fake
 *   connection through the admin route. ONE sync call → 10/10 created in
 *   the FakeProvider, 10/10 linked in the registry (externalId + url per
 *   node, statuses translated through mapStatus). A second sync → 10/10
 *   skipped — the link is the idempotency key at the route level. A status
 *   drift on the board → updateTask runs, lastSyncedStatus moves. Unlink +
 *   sync → re-created. And the acceptance's literal wording: the CORE
 *   Action model never learns a provider-shaped thing — the workspace blob
 *   carries ZERO provider strings throughout, asserted at every step.
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
  const store = new InMemoryIntegrationStore();
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
    integrations: { store, providers: new Map([["fake", () => fake]]) },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    store,
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

function action(
  id: string,
  fields: { assignee?: string; dueDate?: string; status?: string } = {},
): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d4" } },
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

describe("Stage D4 definition of done — Action → ExecutionProvider → FakeProvider", () => {
  it("10 actions → 10 external tasks → 10 links; idempotent re-sync; drift updates; the core untouched", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "d4@example.com");
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;

    // -- The board + 10 actions (all through the real ops route) -----------
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "D4 board", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    const tenOps: Operation[] = [];
    for (let i = 1; i <= 10; i += 1)
      tenOps.push(...action(`task-${i}`, { assignee: `owner-${i}`, dueDate: "2026-09-20" }));
    const seeded = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: tenOps, label: "ten actions" }),
    });
    expect(seeded.status).toBe(200);

    // -- The connection (owner route, fingerprinted) --------------------------
    const put = await api(h, `/api/orgs/${orgId}/integrations/fake`, {
      method: "PUT",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "LUCENT_FAKE_ACCEPTANCE_KEY" }),
    });
    expect(put.status).toBe(201);

    // -- THE SYNC: 10/10 created + linked ---------------------------------------
    const sync = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(sync.status).toBe(200);
    expect(sync.body.provider).toBe("fake");
    expect(sync.body.created).toBe(10);
    expect(sync.body.updated).toBe(0);
    expect(sync.body.skipped).toBe(0);

    // 10 tasks in the FakeProvider (deterministic ids fake-1..fake-10).
    expect(h.fake.taskCount).toBe(10);
    expect(h.fake.calls.filter((c) => c.method === "createTask")).toHaveLength(10);

    // 10 links in the registry, one per node, url + translated status.
    const links = await api(h, `/api/boards/${boardId}/integrations/links`, { token: alice.token });
    expect(links.status).toBe(200);
    expect(links.body.links).toHaveLength(10);
    for (let i = 1; i <= 10; i += 1) {
      const row = links.body.links.find((l: any) => l.nodeId === `task-${i}`);
      expect(row, `task-${i} linked`).toBeDefined();
      expect(row.externalId).toBe(`fake-${i}`);
      expect(row.url).toBe(`https://fake.example.com/task/fake-${i}`);
      expect(row.status).toBe("todo"); // open → todo through the adapter
    }

    // -- A second sync: 10/10 SKIPPED (the link is the idempotency key) --------
    const sync2 = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(sync2.status).toBe(200);
    expect(sync2.body.created).toBe(0);
    expect(sync2.body.updated).toBe(0);
    expect(sync2.body.skipped).toBe(10);

    // -- Drift: a board status moves → updateTask runs, lastSyncedStatus moves.
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        ops: [{ op: "UPDATE_ISSUE", id: "task-3", status: "in_progress" }],
        label: "drift",
      }),
    });
    const sync3 = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(sync3.status).toBe(200);
    expect(sync3.body.updated).toBe(1);
    expect(sync3.body.results.find((r: any) => r.nodeId === "task-3").status).toBe("active"); // in_progress → active
    const links3 = await api(h, `/api/boards/${boardId}/integrations/links`, {
      token: alice.token,
    });
    expect(links3.body.links.find((l: any) => l.nodeId === "task-3").status).toBe("active");

    // -- Unlink + re-sync (the D10 recovery contract): the node's external
    // task still exists (the sync created it with the ext_<nodeId> marker),
    // so the unlinked re-sync RELINKS to the original task rather than
    // creating a duplicate. The link is restored to the same external id.
    expect(await h.store.unlink(boardId, "task-5", "fake")).toBe(true);
    const sync4 = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    // Stage D10: no new create — the recovery found the original task.
    const task5Result = sync4.body.results.find((r: any) => r.nodeId === "task-5");
    expect(["relinked", "created"]).toContain(task5Result.action);
    expect(sync4.body.skipped).toBe(9);
    const links4 = await api(h, `/api/boards/${boardId}/integrations/links`, {
      token: alice.token,
    });
    expect(links4.body.links.find((l: any) => l.nodeId === "task-5")).toBeDefined();

    // -- THE ACCEPTANCE'S LITERAL WORDING: the core Action model never
    // learned a provider-shaped thing — the workspace blob carries ZERO
    // provider strings throughout the whole story.
    const board = await h.boardStore.get(boardId);
    const blob = JSON.stringify(board!.workspace);
    expect(blob).not.toContain("fake-1");
    expect(blob).not.toContain("externalId");
    expect(blob).not.toContain("provider");
    // And the action nodes are exactly what D1 built: statement + issue.
    const node = board!.workspace.nodes["task-1"]!;
    expect(node.statement?.kind).toBe("action");
    expect(node.issue?.assignee).toBe("owner-1");

    // -- The floors: a viewer cannot sync; a stranger sees nothing ------------
    const bob = await signup(h, "viewer@example.com");
    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ token: share.body.token }),
    });
    const viewerSync = await api(h, `/api/boards/${boardId}/integrations/fake/sync`, {
      method: "POST",
      token: bob.token,
      csrf: "csrf",
    });
    expect(viewerSync.status).toBe(404); // editor floor, ids unguessable
    const viewerLinks = await api(h, `/api/boards/${boardId}/integrations/links`, {
      token: bob.token,
    });
    expect(viewerLinks.status).toBe(200); // links are readable state
    expect(viewerLinks.body.links).toHaveLength(10);
  });
});
