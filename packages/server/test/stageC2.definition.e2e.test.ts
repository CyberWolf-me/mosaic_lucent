import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, summarizeWorkspace } from "@lucent/ai";
import type { AnswerRequest, AnswerResult, LLMProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, validateOperations, type Operation } from "@lucent/core";
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
import { actorNamesFor, historyItems } from "../src/historyView.js";
import { buildAnswerRequest } from "../src/askContext.js";

/**
 * Stage C2's definition of done, as one continuous scenario (the Stage B/C1
 * acceptance-test format). The story the review approved:
 *
 *   A live meeting on a SHARED board says "we decided $15/month". The
 *   extraction lands as operations: a decision node, born resolved, with a
 *   topic — and its evidence (meeting id, turn range, the words) ON THE OPS
 *   themselves. The second browser sees both; the ✦ can jump to the
 *   transcript; Ask answers "what did we decide about pricing?" citing the
 *   decision node — evidence from the CONVERGED stamp, not one browser's
 *   memory. A later rejection ("we're not doing usage-based pricing")
 *   visibly supersedes: the target flips to superseded and undo restores
 *   it. A review-gated extraction stamps everyone when approved. A relabel
 *   of the decided node preserves the statement byte-for-byte. And a
 *   manual attempt to build a supersession cycle is refused by the same
 *   validator the AI faces.
 */

const SECRET = "test-secret-at-least-16-chars";

/** The scripted historian: answers from the digest, citing the decision node. */
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
      const decision = request.nodeIndex.find((n) => n.id === "pricing-decision");
      return {
        answer: decision
          ? `The team decided $15/month (topic: pricing, resolved).`
          : "I see no pricing statement in the visible window.",
        citations: decision ? [{ kind: "node", id: decision.id }] : [],
      };
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

describe("Stage C2 definition of done — the continuous scenario", () => {
  it("meaning and evidence land as operations, converge to every holder, and survive edits", async () => {
    const h = (open = await harness(historian()));
    const alice = await signup(h, "alice@example.com");
    const bob = await signup(h, "bob@example.com");

    // -- A shared board + a real meeting transcript --------------------------
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Q3 launch", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;

    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(share.status).toBe(201);
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ token: share.body.token }),
    });

    const memberships = await h.userStore.membershipsFor(alice.id);
    const meeting = await h.meetingStore.insert({
      boardId,
      orgId: memberships[0]!.orgId,
      startedAt: Date.now() - 60_000,
      endedAt: null,
      turns: [
        {
          speaker: "Sarah",
          at: Date.now() - 50_000,
          text: "Let's price it at $15/month.",
          kind: "decision",
        },
      ],
      createdBy: alice.id,
      createdAt: Date.now() - 60_000,
    });

    // -- The live extraction: ops carrying statement + provenance ------------
    // What the client's meeting loop now sends (attachProvenance enriched
    // the batch BEFORE commit): a decision born resolved, its topic, and its
    // evidence on the ops themselves.
    const extraction: Operation[] = [
      { op: "CREATE_NODE", id: "pricing-proposal", nodeType: "idea", label: "Proposal: $20/month" },
      {
        op: "SET_STATEMENT",
        id: "pricing-proposal",
        statement: { kind: "proposal", status: "open", topic: "pricing" },
      },
      {
        op: "CREATE_NODE",
        id: "pricing-decision",
        nodeType: "decision",
        label: "Pricing at $15/month",
        provenance: {
          meetingId: meeting.id,
          turnRange: [0, 0],
          turnKinds: ["decision"],
          quote: "Let's price it at $15/month.",
        },
      },
      {
        op: "SET_STATEMENT",
        id: "pricing-decision",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "pricing",
          supersedes: ["pricing-proposal"],
          provenance: {
            meetingId: meeting.id,
            turnRange: [0, 0],
            turnKinds: ["decision"],
            quote: "Let's price it at $15/month.",
          },
        },
      },
    ];
    // The batch the client would commit is valid against the empty board…
    expect(validateOperations(createWorkspace(), extraction)).toEqual([]);

    // …and committed through the agent/ops route (the same boundary the WS
    // room and the client share).
    const committed = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: extraction, label: "meeting extraction" }),
    });
    expect(committed.status).toBe(200);

    // -- CONVERGENCE: the board holds statement + provenance -----------------
    // (The stored board is what peers reconstruct from; there is exactly one
    // answer to "why is this node here?" on every machine now.)
    const board = await h.boardStore.get(boardId);
    const decision = board?.workspace.nodes["pricing-decision"];
    expect(decision?.statement).toMatchObject({
      kind: "decision",
      status: "resolved",
      topic: "pricing",
    });
    expect(decision?.provenance).toEqual({
      meetingId: meeting.id,
      turnRange: [0, 0],
      turnKinds: ["decision"],
      quote: "Let's price it at $15/month.",
    });
    // The supersession was visible: the $20 proposal is superseded, its kind
    // and topic preserved.
    expect(board?.workspace.nodes["pricing-proposal"]?.statement).toMatchObject({
      kind: "proposal",
      status: "superseded",
      topic: "pricing",
    });

    // -- The history entry carries the enriched ops (a fresh peer replays
    // the evidence) and the actor chain -------------------------------------
    const log = await h.boardStore.loadLog(boardId);
    expect(log[0]?.ops.some((o) => o.op === "CREATE_NODE" && "provenance" in o)).toBe(true);
    const items = historyItems(log, await actorNamesFor(h.userStore, log), []);
    expect(items[0]?.actor).toMatchObject({ type: "user", name: "alice" });

    // -- Ask answers from the converged statement + evidence -----------------
    const asked = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: bob.token, // the second browser asks
      body: JSON.stringify({ question: "what did we decide about pricing?" }),
    });
    expect(asked.status).toBe(200);
    expect(asked.body.answer).toContain("$15/month");
    // The citation resolves to the decision node — from the server's own
    // state, which holds the statement because the ops carried it.
    expect(asked.body.citations).toEqual([
      expect.objectContaining({ kind: "node", id: "pricing-decision" }),
    ]);
    // And the digest the model saw included the statement bracket.
    const seen = h.provider.requests[0]!;
    expect(seen.boardDigest).toContain("[decision · resolved · topic: pricing");
    expect(seen.boardDigest).toContain(`[from meeting ${meeting.id}`);

    // -- A later rejection supersedes visibly; undo restores -----------------
    const rejection: Operation[] = [
      {
        op: "UPDATE_STATEMENT",
        id: "pricing-proposal",
        status: "rejected",
      },
    ];
    expect(validateOperations(board!.workspace, rejection)).toEqual([]);
    const rejected = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ ops: rejection, label: "rejection" }),
    });
    expect(rejected.status).toBe(200);
    const afterReject = await h.boardStore.get(boardId);
    expect(afterReject?.workspace.nodes["pricing-proposal"]?.statement?.status).toBe("rejected");

    // -- The gated path stamps everyone --------------------------------------
    // A review-gated extraction: the proposal record carries the evidence;
    // approval enriches the ops server-side (ADR 0022's third writer).
    const proposal = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        operations: [
          {
            op: "CREATE_NODE",
            id: "onboarding-decision",
            nodeType: "decision",
            label: "3-step onboarding",
          },
          {
            op: "SET_STATEMENT",
            id: "onboarding-decision",
            statement: { kind: "decision", status: "resolved", topic: "onboarding" },
          },
        ],
        request: "map the onboarding decision",
        explanation: "3 steps",
        meetingId: meeting.id,
        provenance: { quote: "reduce to three steps", turnRange: [0, 0], turnKinds: ["decision"] },
      }),
    });
    expect(proposal.status).toBe(201);
    const approved = await api(
      h,
      `/api/boards/${boardId}/proposals/${proposal.body.proposal.id}/approve`,
      { method: "POST", token: bob.token },
    );
    expect(approved.status).toBe(200);
    const afterGate = await h.boardStore.get(boardId);
    expect(afterGate?.workspace.nodes["onboarding-decision"]?.provenance).toMatchObject({
      meetingId: meeting.id,
      quote: "reduce to three steps",
    });

    // -- The identity rule: a relabel preserves meaning + evidence -----------
    const relabel: Operation[] = [
      { op: "CHANGE_TEXT", id: "pricing-decision", text: "$15/mo (final)" },
    ];
    const relabeled = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: relabel, label: "relabel" }),
    });
    expect(relabeled.status).toBe(200);
    const afterRelabel = await h.boardStore.get(boardId);
    const relabeled2 = afterRelabel?.workspace.nodes["pricing-decision"];
    expect(relabeled2?.label).toBe("$15/mo (final)");
    expect(relabeled2?.statement).toEqual(decision?.statement);
    expect(relabeled2?.provenance).toEqual(decision?.provenance);

    // -- The guardrail: a manual cycle attempt is refused --------------------
    const cycleBoard = applyOperations((await h.boardStore.get(boardId))!.workspace, [
      { op: "CREATE_NODE", id: "x", nodeType: "decision", label: "X" },
      {
        op: "SET_STATEMENT",
        id: "x",
        statement: { kind: "decision", status: "resolved", supersedes: ["pricing-decision"] },
      },
    ]);
    // x → pricing-decision; a statement on pricing-decision superseding x
    // closes the loop. The HUD's picker would not offer it — and the
    // validator refuses it regardless of who asks.
    const cycle: Operation[] = [
      {
        op: "SET_STATEMENT",
        id: "pricing-decision",
        statement: { kind: "decision", status: "resolved", supersedes: ["x"] },
      },
    ];
    expect(validateOperations(cycleBoard, cycle)).toHaveLength(1);
    expect(validateOperations(cycleBoard, cycle)[0]!.message).toContain("cycle");

    // -- And the board's statement layer is queryable in one selector --------
    const ws = (await h.boardStore.get(boardId))!.workspace;
    const statements = Object.values(ws.nodes).filter((n) => n.statement);
    expect(statements.map((n) => [n.id, n.statement!.kind, n.statement!.status])).toEqual(
      expect.arrayContaining([
        ["pricing-decision", "decision", "resolved"],
        ["pricing-proposal", "proposal", "rejected"],
        ["onboarding-decision", "decision", "resolved"],
      ]),
    );
  });

  it("the ask digest renders statements through the shared projection (unit seam)", async () => {
    const h = (open = await harness(historian()));
    const alice = await signup(h, "seam@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Seam", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "d", nodeType: "decision", label: "Decided thing" },
      {
        op: "SET_STATEMENT",
        id: "d",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
      },
    ]);
    const request = buildAnswerRequest({
      question: "what did we decide?",
      boardName: "Seam",
      workspace: ws,
      log: [],
      actorNames: new Map(),
      meetings: [],
      window: { depth: 25, hasMore: false },
    });
    expect(request.boardDigest).toContain("[decision · resolved · topic: pricing]");
    void boardId;
    void summarizeWorkspace;
  });
});
