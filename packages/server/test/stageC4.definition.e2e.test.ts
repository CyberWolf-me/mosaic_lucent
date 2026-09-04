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
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";

/**
 * Stage C4's definition of done, as one continuous scenario (the B/C1/C2/C3
 * acceptance-test format). The story the plan approved:
 *
 *   Monday's meeting mumbles about pricing — an UNCLASSIFIED turn ("maybe
 *   $20 for the pro tier"), the corpus no digest ever shows. The board
 *   carries a pricing statement. Beyond the Free window, an old revision
 *   mentions pricing too. SEARCH finds the unclassified turn and the
 *   statement, and returns NOTHING from beyond the window — the corpus
 *   contract. ASK, asked the same question, receives the retrieved hit in
 *   its provider request (meeting id + turn index) and cites the meeting.
 *   The palette's pure functions group and navigate every hit kind through
 *   the existing citation contract. One retriever, two consumers, one
 *   boundary.
 */

const SECRET = "test-secret-at-least-16-chars";

/**
 * The scripted historian: answers from the retrieved evidence, citing the
 * turn hit's meeting; captures every request so the scope assertions can
 * read exactly what the model received.
 */
function historian(): LLMProvider & { requests: AnswerRequest[] } {
  const requests: AnswerRequest[] = [];
  return {
    name: "historian",
    requests,
    async generateOperations() {
      throw new Error("not under test");
    },
    async generateAnswer(request: AnswerRequest): Promise<AnswerResult> {
      requests.push(request);
      // The retrieval-grounded answer the historian v4 is taught to build:
      // read the retrieved turn, cite its meeting, name the turn index.
      const turnHit = request.retrieved?.find((h) => h.kind === "turn");
      if (turnHit && turnHit.turnIndex !== undefined) {
        return {
          answer:
            `The team discussed it in meeting ${turnHit.id} (turn ${turnHit.turnIndex}): ` +
            `"${turnHit.label}". That turn is unclassified, so it appears in the retrieved ` +
            `evidence rather than the meeting extracts.`,
          citations: [{ kind: "meeting", id: turnHit.id }],
        };
      }
      return {
        answer: "No retrieved evidence matches within the visible window.",
        citations: [],
      };
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

describe("Stage C4 definition of done — the continuous scenario", () => {
  it("one retriever, two consumers, one boundary: search and Ask see the same window", async () => {
    const h = (open = await harness(historian()));
    const alice = await signup(h, "alice@example.com");

    // -- A shared board -------------------------------------------------------
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Q3 launch", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;

    // -- Monday's meeting: an UNCLASSIFIED pricing mumble --------------------
    const DAY = 24 * 3_600_000;
    const mondayAt = Date.now() - 2 * DAY;
    const monday = await h.meetingStore.insert({
      boardId,
      orgId,
      startedAt: mondayAt,
      endedAt: mondayAt + 3_600_000,
      turns: [
        // index 0: UNCLASSIFIED — the corpus no digest ever shows. This is
        // the sentence C4 exists to make reachable.
        { speaker: "Maya", at: mondayAt + 60_000, text: "Maybe $20 for the pro tier?" },
        // index 1: classified — the extracts carry this one.
        { speaker: "Tom", at: mondayAt + 120_000, text: "Agreed, pricing settled.", kind: "decision" },
      ],
      createdBy: alice.id,
      createdAt: mondayAt,
    });

    // The pricing statement the extraction produced from turn 1.
    const { applyOperations } = await import("@lucent/core");
    const pricingOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "pricing-decision",
        nodeType: "decision",
        label: "Pricing decision $15",
        provenance: { meetingId: monday.id, turnRange: [1, 1], turnKinds: ["decision"], quote: "Agreed, pricing settled." },
      },
      {
        op: "SET_STATEMENT",
        id: "pricing-decision",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "pricing",
          provenance: { meetingId: monday.id, turnRange: [1, 1] },
        },
      },
    ];
    const mondayAppend = await h.boardStore.appendOp({
      boardId,
      ops: pricingOps,
      by: alice.id,
      label: "Monday extraction",
      at: mondayAt + 180_000,
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(mondayAppend.ok).toBe(true);
    const board = await h.boardStore.get(boardId);
    if (!board || !mondayAppend.ok) throw new Error("board missing");
    await h.boardStore.put({
      ...board,
      workspace: applyOperations(board.workspace, pricingOps),
    });

    // -- Beyond the Free window: an old pricing revision ---------------------
    // 27 revisions total: Free depth 25 keeps the latest 25. The layout is
    // load-bearing (the C3 lesson): the visible window's oldest entry must
    // predate the meeting, or visibleMeetings — correctly — excludes it.
    // So: two pre-meeting revisions that fall BELOW the window (the oldest
    // carries the pricing-matching label the scope assertions need hidden),
    // then one pre-meeting revision that stays VISIBLE (it defines the
    // floor), then the extraction, then noise.
    const beyond = await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "old-node", nodeType: "step", label: "old" }],
      by: alice.id,
      label: "pricing retro before the launch",
      at: mondayAt - 2 * DAY,
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(beyond.ok).toBe(true);
    const beyondFiller = await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "early-node", nodeType: "step", label: "early" }],
      by: alice.id,
      label: "early housekeeping",
      at: mondayAt - 1.5 * DAY,
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(beyondFiller.ok).toBe(true);
    // The visible floor: predates the meeting, so Monday's transcript is
    // inside the window its own extraction defines.
    const floor = await h.boardStore.appendOp({
      boardId,
      ops: [{ op: "CREATE_NODE", id: "setup-node", nodeType: "step", label: "setup" }],
      by: alice.id,
      label: "board setup",
      at: mondayAt - 1 * DAY,
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(floor.ok).toBe(true);
    // 23 noise revisions above the extraction: 27 total, newest 25 visible,
    // the two oldest beyond the window.
    for (let i = 0; i < 23; i += 1) {
      const append = await h.boardStore.appendOp({
        boardId,
        ops: [{ op: "CREATE_NODE", id: `noise-${i}`, nodeType: "step", label: `noise ${i}` }],
        by: alice.id,
        label: `housekeeping ${i}`,
        at: mondayAt + 200_000 + i * 60_000,
        actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
      });
      expect(append.ok).toBe(true);
    }

    // -- SEARCH: find the mumble, the statement, and nothing beyond ---------
    const search = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pro tier")}`,
      { token: alice.token },
    );
    expect(search.status).toBe(200);
    expect(search.body.historyDepth).toBe(25);
    expect(search.body.windowTruncated).toBe(true);

    // The unclassified turn — index 0, Maya's mumble — is found. This is the
    // C1 promise ("not every sentence deserves context-window space") kept.
    const turnHits = search.body.results.filter((r: any) => r.kind === "turn");
    expect(turnHits).toHaveLength(1);
    expect(turnHits[0].meetingId).toBe(monday.id);
    expect(turnHits[0].turnIndex).toBe(0);
    expect(turnHits[0].snippet).toContain("20");
    expect(turnHits[0].matched).toContain("pro");

    // The same query another way: "pricing" finds the statement node…
    const pricingSearch = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`,
      { token: alice.token },
    );
    expect(pricingSearch.status).toBe(200);
    const pricingNodes = pricingSearch.body.results.filter((r: any) => r.kind === "node");
    expect(pricingNodes.map((n: any) => n.id)).toContain("pricing-decision");
    const pricingHit = pricingNodes.find((n: any) => n.id === "pricing-decision");
    expect(pricingHit?.statement).toEqual({ kind: "decision", status: "resolved", topic: "pricing" });

    // …and the "retro" query finds ONLY content inside the window: the old
    // revision (seq below the Free floor) is NOT in the results.
    const retroSearch = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("retro")}`,
      { token: alice.token },
    );
    expect(retroSearch.status).toBe(200);
    const retroRevisions = retroSearch.body.results.filter((r: any) => r.kind === "revision");
    if (beyond.ok) {
      expect(retroRevisions.map((r: any) => r.seq)).not.toContain(beyond.seq);
    }

    // -- ASK: the same window, the same retriever, as evidence ---------------
    h.provider.requests.length = 0;
    const asked = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      csrf: "csrf",
      body: JSON.stringify({ question: "who said anything about the pro tier?" }),
    });
    expect(asked.status).toBe(200);

    // The captured provider request contains the retrieved turn hit —
    // meeting id and stable turn index — evidence the digest never shows.
    const captured = h.provider.requests.at(-1);
    expect(captured).toBeDefined();
    const capturedTurn = captured?.retrieved?.find(
      (r) => r.kind === "turn" && r.turnIndex === 0,
    );
    expect(capturedTurn?.id).toBe(monday.id);
    expect(capturedTurn?.label).toContain("Maya");

    // And the answer cites the meeting the turn belongs to.
    expect(asked.body.citations).toEqual(
      expect.arrayContaining([{ kind: "meeting", id: monday.id, label: expect.any(String) }]),
    );

    // The scopes agree: the search response and the ask request saw the
    // same window — the unclassified turn in both, the old revision in
    // neither. THE C4 ACCEPTANCE CRITERION, stated end to end.
    const capturedRevisionIds = (captured?.retrieved ?? [])
      .filter((r) => r.kind === "revision")
      .map((r) => r.id);
    if (beyond.ok) expect(capturedRevisionIds).not.toContain(String(beyond.seq));
  });
});
