import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider } from "@lucent/ai";
import type { AnswerRequest, AnswerResult, LLMProvider } from "@lucent/ai";
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

/**
 * The ask route (Stage C1), end to end: POST /api/boards/:id/ask. The tests
 * are dominated by the two scope guarantees the review named — the ones that
 * would make C1 the first feature to LEAK entitlements rather than enforce
 * them:
 *
 * - CITATION SCOPE: the provider's citations are validated against the
 *   caller's visible window. A citation to revision 5 under a Free 25-deep
 *   window over a 30-entry log is dropped as `warnings`, exactly like an
 *   invented node id.
 * - CONTEXT SCOPE: the context the provider RECEIVED contains nothing outside
 *   the window. A scripted provider captures its request; the test asserts
 *   the captured history is exactly the latest 25 revisions and that a
 *   meeting older than the window never reached the model.
 *
 * Plus the guard-order basics: viewer floor, CSRF contract, 402 on a spent
 * allowance, and the metering tag that keeps usage rows answerable by mode.
 */

const SECRET = "test-secret-at-least-16-chars";

/** Records the request; answers a script. The tests read the captured context. */
function scriptedProvider(
  script: (request: AnswerRequest) => Partial<AnswerResult>,
): LLMProvider & { requests: AnswerRequest[] } {
  const requests: AnswerRequest[] = [];
  return {
    name: "scripted",
    requests,
    async generateOperations() {
      throw new Error("not under test");
    },
    async generateAnswer(request: AnswerRequest): Promise<AnswerResult> {
      requests.push(request);
      const answer = script(request);
      return { answer: "ok", citations: [], ...answer } as AnswerResult;
    },
  } as LLMProvider & { requests: AnswerRequest[] };
}

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  meetingStore: InMemoryMeetingStore;
  usage: InMemoryUsageStore;
  provider: ReturnType<typeof scriptedProvider>;
  close: () => Promise<void>;
}

async function harness(provider?: ReturnType<typeof scriptedProvider>): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const meetingStore = new InMemoryMeetingStore();
  const usage = new InMemoryUsageStore();
  const theProvider = provider ?? scriptedProvider(() => ({}));
  const { server, close } = createApp({
    config,
    provider: theProvider,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: meetingStore,
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
    meetingStore,
    usage,
    provider: theProvider,
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

async function ask(
  h: Harness,
  token: string,
  boardId: string,
  question: string,
  history?: unknown,
) {
  return api(h, `/api/boards/${boardId}/ask`, {
    method: "POST",
    token,
    body: JSON.stringify({ question, ...(history ? { history } : {}) }),
  });
}

describe("POST /api/boards/:id/ask", () => {
  it("answers a viewer's question with citations resolved to display labels", async () => {
    const h = (open = await harness(
      scriptedProvider(() => ({
        answer: "Sarah changed pricing in revision 30.",
        citations: [
          { kind: "revision", id: "30", detail: "the change" },
          { kind: "node", id: "n30", detail: "the node" },
        ],
      })),
    ));
    const alice = await signup(h, "alice@example.com");
    const bob = await signup(h, "bob@example.com");
    // The board's workspace must actually contain n30 — a node citation
    // resolves against board state, not the log.
    const ws = createWorkspace();
    ws.nodes["n30"] = { id: "n30", nodeType: "step", label: "Node 30" };
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Shared", workspace: ws }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    await seedRevisions(h, boardId, alice.id, 30);

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

    const res = await ask(h, bob.token, boardId, "what changed?");
    expect(res.status).toBe(200);
    expect(res.body.answer).toContain("revision 30");
    expect(res.body.citations).toEqual([
      {
        kind: "revision",
        id: "30",
        label: "Revision 30 · change 30",
        detail: expect.any(String),
        why: "the change",
      },
      { kind: "node", id: "n30", label: "Node 30", why: "the node" },
    ]);
    // The honest-window numbers ride the response.
    expect(res.body.historyDepth).toBe(25);
    expect(res.body.hasMore).toBe(true);
  });

  it("CONTEXT SCOPE: the provider receives exactly the visible window — never more", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Free window");
    await seedRevisions(h, boardId, alice.id, 30);

    // A meeting whose transcript predates the window's oldest revision: its
    // content only reached the board through revisions 1-5, which the caller
    // cannot see, so the model must not see the meeting either (amendment 1).
    const memberships = await h.userStore.membershipsFor(alice.id);
    await h.meetingStore.insert({
      boardId,
      orgId: memberships[0]!.orgId,
      startedAt: Date.now() - 40 * 60_000,
      endedAt: null,
      createdAt: Date.now() - 40 * 60_000,
      turns: [{ speaker: "Alex", at: Date.now() - 40 * 60_000, text: "old decision", kind: "decision" }],
      createdBy: alice.id,
    });

    const res = await ask(h, alice.token, boardId, "what changed?");
    expect(res.status).toBe(200);
    const seen = h.provider.requests[0]!;
    // History: exactly revisions 6-30, newest first.
    expect(seen.history).toHaveLength(25);
    expect(seen.history[0]!.seq).toBe(30);
    expect(seen.history[24]!.seq).toBe(6);
    expect(seen.history.map((e) => e.seq)).not.toContain(5);
    // Truncation is stated, so the model can disclose it.
    expect(seen.historyTruncated).toBe(true);
    expect(seen.historyDepth).toBe(25);
  });

  it("CITATION SCOPE: a citation outside the window is dropped like an invented one", async () => {
    const h = (open = await harness(
      scriptedProvider(() => ({
        answer: "Pricing changed here and there.",
        citations: [
          { kind: "revision", id: "5" }, // outside the Free window (1-5 hidden)
          { kind: "revision", id: "30" }, // visible
          { kind: "node", id: "ghost" }, // invented
        ],
      })),
    ));
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Drops");
    await seedRevisions(h, boardId, alice.id, 30);

    const res = await ask(h, alice.token, boardId, "what changed about pricing?");
    expect(res.status).toBe(200);
    expect(res.body.citations).toHaveLength(1);
    expect(res.body.citations[0].id).toBe("30");
    expect(res.body.warnings).toEqual([
      { citation: { kind: "revision", id: "5" }, reason: "revision outside your visible history window" },
      { citation: { kind: "node", id: "ghost" }, reason: "node not found on the board" },
    ]);
  });

  it("a viewer's meeting outside their window is not in the model context", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Meetings");
    await seedRevisions(h, boardId, alice.id, 3);

    // A fresh meeting AFTER the window's floor: visible, and its turns ride
    // the context. The scripted provider captures it.
    const memberships = await h.userStore.membershipsFor(alice.id);
    await h.meetingStore.insert({
      boardId,
      orgId: memberships[0]!.orgId,
      startedAt: Date.now() + 60_000,
      endedAt: null,
      createdAt: Date.now() + 60_000,
      turns: [{ speaker: "Alex", at: Date.now() + 60_000, text: "go with stripe", kind: "decision" }],
      createdBy: alice.id,
    });

    const res = await ask(h, alice.token, boardId, "what did we decide?");
    expect(res.status).toBe(200);
    const seen = h.provider.requests[0]!;
    expect(seen.meetings).toHaveLength(1);
    expect(seen.meetings[0]!.turns[0]!.text).toBe("go with stripe");
  });

  it("refuses without a CSRF token for cookie sessions; bearer clients pass", async () => {
    // Cookie-session CSRF: the ask route's guard order must mirror generate's.
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Csrf");

    // Mint the csrf pair, then sign in over cookies for the session the guard
    // keys on (bearer clients never carry it, which is why they pass).
    const csrfRes = await fetch(`${h.base}/api/auth/csrf`, { headers: { origin: h.base } });
    const csrfToken = ((await csrfRes.json()) as { token: string }).token;
    const csrfCookie = (csrfRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const login = await fetch(`${h.base}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: h.base,
        cookie: csrfCookie,
        "x-csrf-token": csrfToken,
        "x-requested-with": "lucent",
      },
      body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = (login.headers.get("set-cookie") ?? "")
      .split(/,(?=[^;]+=)/)
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith("lucent_session="));
    expect(sessionCookie).toBeDefined();

    // The cookie session WITHOUT the csrf pair: refused.
    const refused = await fetch(`${h.base}/api/boards/${boardId}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base, cookie: sessionCookie! },
      body: JSON.stringify({ question: "what changed?" }),
    });
    expect(refused.status).toBe(403);

    // With the pair: through. (The double-submit cookie is signed, so the
    // header echoes the raw token and the cookie carries its signature.)
    const allowed = await fetch(`${h.base}/api/boards/${boardId}/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: h.base,
        cookie: `${sessionCookie}; ${csrfCookie}`,
        "x-csrf-token": csrfToken,
        "x-requested-with": "lucent",
      },
      body: JSON.stringify({ question: "what changed?" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("402s when the monthly allowance is spent, without calling the provider", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Spent");
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;
    // Free: 50/month. Pre-spend it.
    await h.usage.record({
      id: `usage_test_${Math.random().toString(36).slice(2)}`,
      orgId,
      kind: "ai.generation",
      quantity: 50,
      at: Date.now(),
    });

    const res = await ask(h, alice.token, boardId, "what changed?");
    expect(res.status).toBe(402);
    expect(res.body.reason).toBe("plan_limit");
    expect(h.provider.requests).toHaveLength(0);
  });

  it("meters a successful ask as ai.generation with mode ask", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Metered");
    await seedRevisions(h, boardId, alice.id, 2);

    const res = await ask(h, alice.token, boardId, "what changed?");
    expect(res.status).toBe(200);
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;
    // Metering is fire-and-forget; wait for the write like the gates tests do.
    let counted = 0;
    for (let i = 0; i < 100; i += 1) {
      counted = await h.usage.monthToDate(orgId, "ai.generation", Date.now());
      if (counted >= 1) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(counted).toBe(1);
  });

  it("a stranger cannot ask on a board they cannot see (404, and no provider call)", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const mallory = await signup(h, "mallory@example.com");
    const boardId = await makeBoard(h, alice.token, "Private");
    await seedRevisions(h, boardId, alice.id, 2);

    const res = await ask(h, mallory.token, boardId, "what changed?");
    expect(res.status).toBe(404);
    expect(h.provider.requests).toHaveLength(0);
  });

  it("an upgraded org's ask sees the deeper window immediately", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Pro window");
    await seedRevisions(h, boardId, alice.id, 30);
    const memberships = await h.userStore.membershipsFor(alice.id);
    await upgrade(h, memberships[0]!.orgId, "pro");

    const res = await ask(h, alice.token, boardId, "what changed?");
    expect(res.status).toBe(200);
    const seen = h.provider.requests[0]!;
    expect(seen.history).toHaveLength(30);
    expect(seen.history[29]!.seq).toBe(1);
    expect(seen.historyTruncated).toBe(false);
  });
});
