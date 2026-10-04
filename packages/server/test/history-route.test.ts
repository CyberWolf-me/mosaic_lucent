import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { PLAN_LADDER } from "../src/plans.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";
import { historyWindow } from "../src/historyWindow.js";

/**
 * The board history route (Stage C1), end to end. One route, four behaviors
 * that must never regress:
 *
 * - THE WINDOW: Free depth 25 — a 30-entry log yields the latest 25 and
 *   `hasMore: true`, never a quiet truncation to "the board begins here".
 * - THE UPGRADE PATH: putting the org on Pro immediately widens the SAME log
 *   to 30 visible entries. Nothing was deleted at Free depth; the entitlement
 *   only ever bounded the read (ADR 0019).
 * - THE FLOOR: hasMore is honest about the snapshot floor — a window that
 *   reaches the floor is the whole surviving log, not "the rest was hidden".
 * - THE JOIN: a revision produced by a Stage B3 proposal approval carries the
 *   proposal link, and a viewer (the route's floor) can read the timeline a
 *   stranger (404) cannot.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  usage: InMemoryUsageStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const usage = new InMemoryUsageStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore: usage,
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    usage,
    close: async () => {
      await close();
    },
  };
}

let open: Harness | null = null;

afterEach(async () => {
  await open?.close();
  open = null;
});

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string; csrf?: string } = {},
): Promise<{ status: number; body: any }> {
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
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function signup(h: Harness, email: string): Promise<{ token: string; id: string }> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

/** Seed N op-log entries directly through the store, one per revision. */
async function seedRevisions(
  h: Harness,
  boardId: string,
  userId: string,
  count: number,
  baseAt = Date.now() - count * 60_000,
) {
  for (let i = 1; i <= count; i += 1) {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: `n${i}`, nodeType: "step", label: `Node ${i}` },
    ];
    const append = await h.boardStore.appendOp({
      boardId,
      ops,
      by: userId,
      label: `change ${i}`,
      at: baseAt + i * 60_000,
      actor: { actorType: "user", actorId: userId, initiatedBy: userId },
    });
    expect(append.ok).toBe(true);
  }
}

/** Put the org on a paid tier, the way a completed checkout will. */
async function upgrade(h: Harness, orgId: string, plan: string) {
  const now = Date.now();
  await h.usage.seedPlans(PLAN_LADDER, now);
  await h.usage.putSubscription({
    orgId,
    plan,
    seats: 1,
    status: "active",
    periodStart: now,
    periodEnd: now + 30 * 24 * 60 * 60 * 1000,
    cancelAt: null,
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function makeBoard(h: Harness, token: string, name: string) {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name, workspace: createWorkspace() }),
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe("GET /api/boards/:id/history", () => {
  it("windows a 30-entry Free log to the latest 25, newest first, with hasMore", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Free window");
    await seedRevisions(h, boardId, alice.id, 30);

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    expect(res.body.historyDepth).toBe(25);
    expect(res.body.limit).toBe(25);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.latestSeq).toBe(30);
    expect(res.body.items).toHaveLength(25);
    // Newest first, the window is [6..30].
    expect(res.body.items[0].seq).toBe(30);
    expect(res.body.items[24].seq).toBe(6);
    expect(res.body.items.map((i: any) => i.seq)).not.toContain(5);
  });

  it("an upgrade to Pro immediately reveals the older revisions — nothing was deleted", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Upgrade path");
    await seedRevisions(h, boardId, alice.id, 30);

    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;
    await upgrade(h, orgId, "pro");

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    expect(res.body.historyDepth).toBe(500);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.items).toHaveLength(30);
    expect(res.body.items[29].seq).toBe(1);
  });

  it("reports actor display names and the AI actor as Lucent", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Actors");
    await seedRevisions(h, boardId, alice.id, 2);
    // One AI-actor entry, the shape proposal approval writes.
    await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "ai-node", nodeType: "step", label: "AI node" }],
      by: alice.id,
      label: "proposal approved",
      at: Date.now(),
      actor: {
        actorType: "ai",
        actorId: "lucent",
        initiatedBy: alice.id,
        approvedBy: alice.id,
      },
    });

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    const aiItem = res.body.items.find((i: any) => i.seq === 3);
    expect(aiItem.actor).toMatchObject({ type: "ai", name: "Lucent" });
    expect(aiItem.actor.initiatedBy).toBe("alice");
    expect(aiItem.actor.approvedBy).toBe("alice");
    const userItem = res.body.items.find((i: any) => i.seq === 2);
    expect(userItem.actor).toMatchObject({ type: "user", name: "alice" });
  });

  it("links a revision to the proposal that produced it (appliedSeq ↔ seq)", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Proposal join");
    await seedRevisions(h, boardId, alice.id, 1);

    // The real proposal flow: create through the route, approve through the
    // route — the approval commits through the room-less store path with the
    // AI actor, and the history route must join that revision back to the
    // proposal, its meeting, and its turnRange.
    const memberships = await h.userStore.membershipsFor(alice.id);
    const created = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({
        operations: [{ op: "CREATE_NODE", id: "pricing", nodeType: "step", label: "Pricing" }],
        request: "map pricing",
        explanation: "pricing node",
        meetingId: "mtg_1",
        provenance: { quote: "let's map pricing", turnRange: [2, 3] },
      }),
    });
    expect(created.status).toBe(201);
    void memberships;
    const pid = created.body.proposal.id as string;

    const approved = await api(h, `/api/boards/${boardId}/proposals/${pid}/approve`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
    });
    expect(approved.status).toBe(200);
    expect(approved.body.proposal.appliedSeq).toBe(2);

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    const linked = res.body.items.find((i: any) => i.seq === 2);
    expect(linked.proposal).toMatchObject({
      meetingId: "mtg_1",
      quote: "let's map pricing",
      turnRange: [2, 3],
    });
    expect(linked.actor).toMatchObject({ type: "ai", name: "Lucent" });
  });

  it("a viewer reads the timeline; a stranger gets 404, not 403", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const bob = await signup(h, "bob@example.com");
    const mallory = await signup(h, "mallory@example.com");
    const boardId = await makeBoard(h, alice.token, "Shared");
    await seedRevisions(h, boardId, alice.id, 3);

    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(share.status).toBe(201);
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ token: share.body.token }),
    });

    const asViewer = await api(h, `/api/boards/${boardId}/history`, { token: bob.token });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.items).toHaveLength(3);

    const asStranger = await api(h, `/api/boards/${boardId}/history`, {
      token: mallory.token,
    });
    expect(asStranger.status).toBe(404);
    expect(asStranger.body.error).toBe("board not found");
  });

  it("hasMore is honest at the snapshot floor: the window that reaches the floor is everything", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Floor");
    await seedRevisions(h, boardId, alice.id, 10);
    // Compact at seq 8: the log's floor is 8, and Free's 25-deep window spans
    // the entire surviving log, so hasMore must be FALSE (nothing above the
    // floor is hidden) even though the plan is narrow.
    await h.boardStore.putSnapshot(boardId, 8, createWorkspace());

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((i: any) => i.seq)).toEqual([10, 9]);
  });
});

describe("historyWindow arithmetic (the shared seam)", () => {
  it("window math is subtraction, and the floor is exact", () => {
    // Free depth, no snapshot, head 30: window [6..30], hasMore true.
    const free = historyWindow(30, 25, 0);
    expect(free).toMatchObject({ fromSeq: 6, hasMore: true, limit: 25 });

    // Pro depth: whole log visible.
    const pro = historyWindow(30, 500, 0);
    expect(pro).toMatchObject({ fromSeq: 1, hasMore: false });

    // Unlimited plan: bounded by the response ceiling only.
    const unlimited = historyWindow(30_000, null, 0);
    expect(unlimited.fromSeq).toBe(30_000 - 2000 + 1);
    expect(unlimited.hasMore).toBe(true);

    // Snapshot floor above the window start: hasMore stops at the floor.
    const floored = historyWindow(30, 25, 20);
    expect(floored).toMatchObject({ fromSeq: 21, hasMore: false });

    // Empty log: nothing to see, no lies about more.
    const empty = historyWindow(0, 25, 0);
    expect(empty).toMatchObject({ fromSeq: 1, hasMore: false, head: 0 });
  });

  it("a snapshot at the head does not hide the whole log (live, 2026-09-10)", () => {
    // Room eviction snapshots the current head on last-peer-leave while the
    // in-memory store never prunes. The claimed floor then sits AHEAD of
    // every entry; the old math computed fromSeq = baseSeq + 1 = head + 1,
    // so loadLog(fromSeq - 1) returned nothing and History/Ask rendered an
    // empty timeline over a full log. The window must degrade to the whole
    // surviving log instead.
    const atHead = historyWindow(7, 25, 7);
    expect(atHead).toMatchObject({ fromSeq: 1, hasMore: false, head: 7 });
    // Depth still caps the fallback, and hasMore stays exact (the excluded
    // entries really exist — nothing was compacted in this branch).
    const capped = historyWindow(60, 25, 60);
    expect(capped).toMatchObject({ fromSeq: 36, hasMore: true });
    // The tiny-board variant of the same shape.
    const tiny = historyWindow(3, 25, 3);
    expect(tiny).toMatchObject({ fromSeq: 1, hasMore: false });
  });
});

describe("statementEvent derivation (Stage C3)", () => {
  it("a revision that attached a statement carries its semantic event", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "ev@example.com");
    const boardId = await makeBoard(h, alice.token, "Events");
    // A revision whose ops make a decision.
    const append = await h.boardStore.appendOp({
      boardId,
      ops: [
        { op: "CREATE_NODE", id: "d1", nodeType: "decision", label: "Pricing $15" },
        {
          op: "SET_STATEMENT",
          id: "d1",
          statement: { kind: "decision", status: "resolved", topic: "pricing" },
        },
      ],
      by: alice.id,
      label: "meeting extraction",
      at: Date.now(),
      actor: { actorType: "ai", actorId: "lucent", initiatedBy: alice.id },
    });
    expect(append.ok).toBe(true);

    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.status).toBe(200);
    expect(append.ok).toBe(true);
    if (!append.ok) return;
    const row = res.body.items.find((i: any) => i.seq === append.seq);
    expect(row.statementEvent).toEqual({
      kind: "decision",
      status: "resolved",
      topic: "pricing",
      nodeId: "d1",
    });
  });

  it("a status change names the node's real kind, not a placeholder decision", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "ev3@example.com");
    const boardId = await makeBoard(h, alice.token, "Kinds");
    const first = await h.boardStore.appendOp({
      boardId,
      ops: [
        { op: "CREATE_NODE", id: "q1", nodeType: "question", label: "Cash on delivery?" },
        { op: "SET_STATEMENT", id: "q1", statement: { kind: "question", status: "open" } },
      ],
      by: alice.id,
      label: "ask",
      at: Date.now(),
    });
    expect(first.ok).toBe(true);
    const answered = await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "UPDATE_STATEMENT", id: "q1", status: "resolved" }],
      by: alice.id,
      label: "answered",
      at: Date.now(),
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    const row = res.body.items.find((i: any) => i.seq === answered.seq);
    expect(row.statementEvent).toMatchObject({
      kind: "question",
      status: "resolved",
      nodeId: "q1",
    });
  });

  it("a plain revision carries no statementEvent", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "ev2@example.com");
    const boardId = await makeBoard(h, alice.token, "Plain");
    await seedRevisions(h, boardId, alice.id, 1);
    const res = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(res.body.items[0].statementEvent).toBeUndefined();
  });
});
