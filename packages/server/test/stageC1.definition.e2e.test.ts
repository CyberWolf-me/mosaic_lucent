import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { AnswerRequest, AnswerResult, LLMProvider } from "@lucent/ai";
import { MockImageProvider } from "@lucent/ai";
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
 * Stage C1's definition of done, as one continuous scenario (the Stage B
 * acceptance-test format). The story the review approved:
 *
 *   A shared board accumulates real history — Alice's edits, then a
 *   review-gated proposal approved by Bob so the log carries the full
 *   accountability chain (Stage B's record feeding Stage C's timeline).
 *   On the Free plan the timeline shows the latest 25 of 30 revisions and
 *   says there is more. Alice asks "what changed?"; the model answers from
 *   exactly the window she can see, citing revisions that exist. A
 *   citation to a revision OUTSIDE the window is dropped like an invented
 *   one — the two scope guarantees (context and citation) that would make
 *   C1 the first feature to leak entitlements instead of enforcing them.
 *   The org upgrades to Pro: the SAME log immediately shows 30 revisions,
 *   both in the timeline and in the model's context. Bob, a viewer, asks
 *   too — asking is reading. A stranger gets 404 and the model is never
 *   called.
 */

const SECRET = "test-secret-at-least-16-chars";

/**
 * The scripted historian: echoes back a citation set chosen per question so
 * the scenario can drive validation from the outside. Captures every request
 * so the CONTEXT-scope assertions can read exactly what the model received.
 */
function historian(
  respond: (request: AnswerRequest) => Partial<AnswerResult>,
): LLMProvider & { requests: AnswerRequest[] } {
  const requests: AnswerRequest[] = [];
  return {
    name: "historian",
    requests,
    async generateOperations() {
      throw new Error("not under test");
    },
    async generateAnswer(request: AnswerRequest): Promise<AnswerResult> {
      requests.push(request);
      return { answer: "ok", citations: [], ...respond(request) } as AnswerResult;
    },
    async generateExternalPlan(): Promise<never> {
      throw new Error("the selector is not under test here");
    },
  } as LLMProvider & { requests: AnswerRequest[] };
}

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  meetingStore: InMemoryMeetingStore;
  usage: InMemoryUsageStore;
  provider: ReturnType<typeof historian>;
  close: () => Promise<void>;
}

async function harness(provider: ReturnType<typeof historian>): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const meetingStore = new InMemoryMeetingStore();
  const usage = new InMemoryUsageStore();
  const { server, close } = createApp({
    config,
    provider,
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
    provider,
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
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

describe("Stage C1 definition of done — the continuous scenario", () => {
  it("history accumulates, windows honestly, answers with citations, and upgrades reveal", async () => {
    // The scripted historian cites what the scenario asks it to cite.
    const h = (open = await harness(
      historian(() => ({
        answer: "Sarah's proposal changed pricing in revision 30.",
        citations: [
          { kind: "revision", id: "30" }, // visible: inside any window over this log
          { kind: "revision", id: "5" }, // outside the Free window: must drop
          { kind: "node", id: "ghost" }, // invented: must drop
        ],
      })),
    ));
    const alice = await signup(h, "alice@example.com");
    const bob = await signup(h, "bob@example.com");
    const stranger = await signup(h, "stranger@example.com");

    // -- A shared board with real history ----------------------------------
    const ws = createWorkspace();
    ws.nodes["pricing"] = { id: "pricing", nodeType: "decision", label: "Pricing ($15/mo)" };
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Q3 launch", workspace: ws }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    // Bob joins as a VIEWER — the route's floor, and the permission model
    // the review signed off ("asking is reading").
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

    // 29 manual revisions by Alice, one per minute.
    const baseAt = Date.now() - 30 * 60_000;
    for (let i = 1; i <= 29; i += 1) {
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: `n${i}`, nodeType: "step", label: `Step ${i}` },
      ];
      const append = await h.boardStore.appendOp({
        boardId,
        ops,
        by: alice.id,
        label: `change ${i}`,
        at: baseAt + i * 60_000,
        actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
      });
      expect(append.ok).toBe(true);
    }
    // Revision 30: the Stage B3 review-gated change — Bob cannot approve
    // (he's a viewer), so Alice drives it; what the scenario needs is the
    // AI actor record + the proposal join, which the real route produces.
    const proposal = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        operations: [
          { op: "CHANGE_TEXT", id: "pricing", text: "Pricing ($15/mo)" },
        ],
        request: "update pricing",
        explanation: "pricing refreshed",
        meetingId: "mtg_1",
        provenance: { quote: "fifteen a month", turnRange: [2, 3] },
      }),
    });
    expect(proposal.status).toBe(201);
    const approved = await api(
      h,
      `/api/boards/${boardId}/proposals/${proposal.body.proposal.id}/approve`,
      { method: "POST", token: alice.token },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.proposal.appliedSeq).toBe(30);

    // -- Free: the window is honest ---------------------------------------
    const free = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(free.status).toBe(200);
    expect(free.body.items).toHaveLength(25);
    expect(free.body.items[0].seq).toBe(30);
    expect(free.body.items[24].seq).toBe(6);
    expect(free.body.hasMore).toBe(true);
    expect(free.body.historyDepth).toBe(25);
    // The proposal join: revision 30 names its meeting and quote.
    expect(free.body.items[0].proposal).toMatchObject({
      meetingId: "mtg_1",
      quote: "fifteen a month",
    });
    // The actor record the Stage B record promised, summarized for the UI.
    expect(free.body.items[0].actor).toMatchObject({ type: "ai", name: "Lucent" });

    // Bob the VIEWER reads the same timeline.
    const asViewer = await api(h, `/api/boards/${boardId}/history`, { token: bob.token });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.items).toHaveLength(25);

    // -- Ask, under the Free window: both scope guarantees ----------------
    const asked = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what changed about pricing?" }),
    });
    expect(asked.status).toBe(200);

    // CONTEXT SCOPE: the model received exactly the visible window.
    const seen = h.provider.requests[0]!;
    expect(seen.history).toHaveLength(25);
    expect(seen.history[0]!.seq).toBe(30);
    expect(seen.history[24]!.seq).toBe(6);
    expect(seen.history.map((e) => e.seq)).not.toContain(5);
    expect(seen.historyTruncated).toBe(true);

    // CITATION SCOPE: revision 30 survives; revision 5 (outside the window)
    // and the invented node drop into warnings, answer intact.
    expect(asked.body.answer).toContain("revision 30");
    expect(asked.body.citations).toHaveLength(1);
    expect(asked.body.citations[0]).toMatchObject({ kind: "revision", id: "30" });
    expect(asked.body.warnings).toHaveLength(2);

    // -- The viewer asks too; the stranger cannot --------------------------
    h.provider.requests.length = 0;
    const viewerAsks = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ question: "why is the pricing node here?" }),
    });
    expect(viewerAsks.status).toBe(200);
    expect(h.provider.requests).toHaveLength(1);

    const strangerBoard = await api(h, `/api/boards/${boardId}/history`, {
      token: stranger.token,
    });
    expect(strangerBoard.status).toBe(404);
    h.provider.requests.length = 0;
    const strangerAsks = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: stranger.token,
      body: JSON.stringify({ question: "what is on this board?" }),
    });
    expect(strangerAsks.status).toBe(404);
    expect(h.provider.requests).toHaveLength(0);

    // -- Upgrade to Pro: the SAME log widens, timeline and context ----------
    const memberships = await h.userStore.membershipsFor(alice.id);
    await upgrade(h, memberships[0]!.orgId, "pro");

    const pro = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(pro.status).toBe(200);
    expect(pro.body.items).toHaveLength(30);
    expect(pro.body.items[29].seq).toBe(1);
    expect(pro.body.hasMore).toBe(false);

    h.provider.requests.length = 0;
    const proAsk = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what changed about pricing?" }),
    });
    expect(proAsk.status).toBe(200);
    const proSeen = h.provider.requests[0]!;
    expect(proSeen.history).toHaveLength(30);
    expect(proSeen.historyTruncated).toBe(false);
    // Revision 5 is now visible — the same citation the Free window refused
    // resolves, which is the upgrade path made concrete.
    expect(proAsk.body.citations.map((c: any) => c.id)).toContain("30");
    expect(proAsk.body.citations.map((c: any) => c.id)).toContain("5");
    expect(proAsk.body.warnings).toEqual([
      { citation: { kind: "node", id: "ghost" }, reason: "node not found on the board" },
    ]);
  });
});
