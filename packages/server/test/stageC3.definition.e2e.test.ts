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
 * Stage C3's definition of done, as one continuous scenario (the B/C1/C2
 * acceptance-test format). The story the plan approved:
 *
 *   Monday's meeting decides $20 (a decision born resolved, evidence riding
 *   the ops). Wednesday's meeting corrects to $15 — the correction
 *   SUPERSEDES visibly, from the later meeting. Ask "why did we change
 *   pricing?" answers from the digest's evolution section, citing both
 *   meetings and naming turn indices. Turn-precision scope: Wednesday's
 *   turn 0 lists exactly the objects its turnRange produced. Meetings-window
 *   scope: when the Free window excludes Monday, the provider request never
 *   contains it and the truncation is disclosed. The timeline shows both
 *   meetings and both statement events in order. The end route is
 *   idempotent, and the canvas ✦ contract (meeting + turnRange) holds.
 */

const SECRET = "test-secret-at-least-16-chars";

/**
 * The scripted historian: answers from the digest's evolution section,
 * citing both meetings and the superseding node; captures every request so
 * the scope assertions can read exactly what the model received.
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
      // The evolution answer the historian v3 is taught to build: the
      // chain from the digest, both meetings, turn indices named.
      const hasChain = request.boardDigest.includes("Statement evolution");
      const newer = request.meetings[0];
      const older = request.meetings[1];
      const citations = [];
      if (hasChain && newer && older) {
        citations.push({ kind: "meeting" as const, id: newer.id });
        citations.push({ kind: "meeting" as const, id: older.id });
        const node = request.nodeIndex.find((n) => n.id === "pricing-new");
        if (node) citations.push({ kind: "node" as const, id: node.id });
      }
      return {
        answer: hasChain
          ? `Pricing changed between meetings: the ${older?.id} decision ($20, turn ${
              older?.turns[0]?.index ?? "?"
            }) was superseded by ${newer?.id}'s correction (    5, turn ${
              newer?.turns[0]?.index ?? "?"
            }). The board now carries the     5 decision.`
          : "I can see no pricing change in the visible window.",
        citations,
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

describe("Stage C3 definition of done — the continuous scenario", () => {
  it("the chain reads across meetings, the reverse link is exact, and the timeline merges", async () => {
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

    // A revision from before Monday's meeting, so the visible window's
    // floor predates the meeting itself: the meetings section can carry it
    // (on any real board, earlier history exists below the oldest visible
    // meeting — without this, the extraction's own timestamp would define
    // the floor and exclude the meeting that produced it).
    const preMonday = await h.boardStore.appendOp({
      boardId,
      ops: [{ op: 'CREATE_NODE', id: 'seed-node', nodeType: 'step', label: 'Seed' }],
      by: alice.id,
      label: 'board created',
      at: Date.now() - 3 * 24 * 3_600_000,
      actor: { actorType: 'user', actorId: alice.id, initiatedBy: alice.id },
    });
    expect(preMonday.ok).toBe(true);

    // -- Monday's meeting: decides $20 ----------------------------------------
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;
    const monday = await h.meetingStore.insert({
      boardId,
      orgId,
      startedAt: Date.now() - 2 * 24 * 3_600_000,
      endedAt: Date.now() - 2 * 24 * 3_600_000 + 3_600_000,
      turns: [
        {
          speaker: "Alex",
          at: Date.now() - 2 * 24 * 3_600_000 + 60_000,
          text: "Twenty a month works for the launch.",
          kind: "decision",
        },
      ],
      createdBy: alice.id,
      createdAt: Date.now() - 2 * 24 * 3_600_000,
    });

    // The extraction the meeting loop sends: the decision, evidence on the ops.
    const mondayOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "pricing-old",
        nodeType: "decision",
        label: "Pricing at $20/month",
        provenance: { meetingId: monday.id, turnRange: [0, 0], turnKinds: ["decision"], quote: "Twenty a month works." },
      },
      {
        op: "SET_STATEMENT",
        id: "pricing-old",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "pricing",
          provenance: { meetingId: monday.id, turnRange: [0, 0] },
        },
      },
    ];
    
    // Monday's extraction, committed at Monday's time so the meeting sits
    // inside the window the revisions define (the ops route stamps 'now',
    // which would push Monday's meeting outside its own window).
    const mondayAppend = await h.boardStore.appendOp({
      boardId,
      ops: mondayOps,
      by: alice.id,
      label: 'Monday extraction',
      at: monday.startedAt + 1,
      actor: { actorType: 'user', actorId: alice.id, initiatedBy: alice.id },
    });
    expect(mondayAppend.ok).toBe(true);
    // appendOp logs the entry; the stored board is a projection the route
    // applies separately — mirror that (the ops route's own ordering).
    const { applyOperations } = await import('@lucent/core');
    const mondayBoard = await h.boardStore.get(boardId);
    await h.boardStore.put({
      ...mondayBoard!,
      workspace: applyOperations(mondayBoard!.workspace, mondayOps),
      updatedAt: Date.now(),
    });

    // -- Wednesday's meeting: corrects to $15, superseding visibly -------------
    const wednesday = await h.meetingStore.insert({
      boardId,
      orgId,
      startedAt: Date.now() - 24 * 3_600_000,
      endedAt: Date.now() - 24 * 3_600_000 + 3_600_000,
      turns: [
        {
          speaker: "Sarah",
          at: Date.now() - 24 * 3_600_000 + 60_000,
          text: "Actually, fifteen a month — twenty felt steep.",
          kind: "decision",
        },
        { speaker: "Alex", at: Date.now() - 24 * 3_600_000 + 120_000, text: "Agreed." },
      ],
      createdBy: alice.id,
      createdAt: Date.now() - 24 * 3_600_000,
    });
    const wednesdayOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "pricing-new",
        nodeType: "decision",
        label: "Pricing at $15/month",
        provenance: { meetingId: wednesday.id, turnRange: [0, 0], turnKinds: ["decision"], quote: "fifteen a month" },
      },
      {
        op: "SET_STATEMENT",
        id: "pricing-new",
        statement: {
          kind: "decision",
          status: "resolved",
          topic: "pricing",
          supersedes: ["pricing-old"],
          provenance: { meetingId: wednesday.id, turnRange: [0, 0] },
        },
      },
    ];
    
    const wednesdayAppend = await h.boardStore.appendOp({
      boardId,
      ops: wednesdayOps,
      by: alice.id,
      label: 'Wednesday correction',
      at: wednesday.startedAt + 1,
      actor: { actorType: 'user', actorId: alice.id, initiatedBy: alice.id },
    });
    expect(wednesdayAppend.ok).toBe(true);
    const wednesdayBoard = await h.boardStore.get(boardId);
    await h.boardStore.put({
      ...wednesdayBoard!,
      workspace: applyOperations(wednesdayBoard!.workspace, wednesdayOps),
      updatedAt: Date.now(),
    });

    // The chain: the old decision is visibly superseded.
    const board = await h.boardStore.get(boardId);
    expect(board?.workspace.nodes["pricing-old"]?.statement).toMatchObject({
      status: "superseded",
    });

    // -- Ask: "why did we change pricing?" from the evolution section -----------
    h.provider.requests.length = 0;
    const asked = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "why did we change the pricing between meetings?" }),
    });
    expect(asked.status).toBe(200);
    expect(asked.body.answer).toContain(wednesday.id);
    expect(asked.body.answer).toContain(monday.id);
    expect(asked.body.answer).toContain("turn 0");
    // Citations resolve: both meetings + the superseding node.
    const citationKinds = asked.body.citations.map((c: any) => `${c.kind}:${c.id}`);
    expect(citationKinds).toContain(`meeting:${wednesday.id}`);
    expect(citationKinds).toContain(`meeting:${monday.id}`);
    expect(citationKinds).toContain("node:pricing-new");
    // The provider's context carried the evolution section with both origins,
    // turn indices, and NO truncation (two meetings fit).
    const seen = h.provider.requests[0]!;
    expect(seen.boardDigest).toContain("Statement evolution");
    expect(seen.boardDigest).toContain(`from meeting ${wednesday.id}`);
    expect(seen.boardDigest).toContain(`from meeting ${monday.id}`);
    expect(seen.meetingsTruncated).toBe(false);
    expect(seen.meetings[0]!.turns[0]!.index).toBe(0);

    // -- Turn-precision scope: Wednesday turn 0 lists exactly its objects ------
    // (The web computes this client-side from the workspace; the e2e asserts
    // the same scan against the server's stored board — one source.)
    const ws = board!.workspace;
    const turnObjects: string[] = [];
    for (const node of Object.values(ws.nodes)) {
      const records = [node.provenance, node.statement?.provenance];
      for (const r of records) {
        if (
          r?.meetingId === wednesday.id &&
          r.turnRange &&
          0 >= r.turnRange[0] &&
          0 <= r.turnRange[1]
        ) {
          turnObjects.push(node.id);
          break;
        }
      }
    }
    expect(turnObjects.sort()).toEqual(["pricing-new"]);

    // -- The timeline: meetings + statement events in order --------------------
    const timeline = await api(h, `/api/boards/${boardId}/history`, { token: alice.token });
    expect(timeline.status).toBe(200);
    const statementRows = timeline.body.items.filter((i: any) => i.statementEvent);
    expect(statementRows).toHaveLength(2);
    // Both statement events carry the decision + topic; the correction
    // supersedes; the events point at their nodes.
    expect(statementRows[1].statementEvent).toMatchObject({
      kind: "decision",
      status: "resolved",
      topic: "pricing",
      nodeId: "pricing-old",
    });
    expect(statementRows[0].statementEvent).toMatchObject({
      kind: "decision",
      status: "resolved",
      topic: "pricing",
      supersedes: ["pricing-old"],
      nodeId: "pricing-new",
    });

    // -- The meetings-window scope: a window that excludes Monday --------------
    // The ask route windows meetings by the oldest VISIBLE revision's
    // timestamp. Insert 25 revisions AFTER Wednesday on a Free org (depth 25):
    // Monday's meeting + revision fall outside, and the projection must say
    // so without ever containing Monday.
    for (let i = 0; i < 25; i += 1) {
      await h.boardStore.appendOp({
        boardId,
        ops: [{ op: "CREATE_NODE", id: `noise-${i}`, nodeType: "step", label: `N${i}` }],
        by: alice.id,
        label: `noise ${i}`,
        at: Date.now() - 23 * 3_600_000 + i * 60_000,
        actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
      });
    }
    h.provider.requests.length = 0;
    const windowed = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "why did we change the pricing between meetings?" }),
    });
    expect(windowed.status).toBe(200);
    const windowSeen = h.provider.requests[0]!;
    // CONTEXT SCOPE: Monday's TRANSCRIPT never reached the model — the
    // meetings section is window content. (The digest's [from meeting ...]
    // brackets still render for visible nodes: the node carrying Monday's
    // provenance is itself visible, and its origin tag is board state, not
    // window content. The evolution line therefore still names the meeting
    // of origin — the chain stays readable; the exact WORDS of the old
    // meeting are what the window withholds.)
    expect(windowSeen.meetings.map((m) => m.id)).not.toContain(monday.id);
    // The revision window's truncation is disclosed (the history side of
    // the honest window). meetingsTruncated is a DIFFERENT disclosure — the
    // digest's own 10-meeting cap — and is asserted below where it bites.
    expect(windowSeen.historyTruncated).toBe(true);

    // -- The digest cap discloses itself too (meetingsTruncated) ----------
    // 11 meetings inside the visible window: the 10-cap drops the oldest,
    // and the projection says so.
    for (let i = 0; i < 11; i += 1) {
      await h.meetingStore.insert({
        boardId,
        orgId,
        startedAt: Date.now() - 20 * 3_600_000 + i * 60_000,
        endedAt: Date.now() - 20 * 3_600_000 + i * 60_000,
        turns: [{ speaker: "Bo", at: Date.now(), text: " filler", kind: "requirement" }],
        createdBy: alice.id,
        createdAt: Date.now(),
      });
    }
    h.provider.requests.length = 0;
    const capped = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what did we decide about pricing?" }),
    });
    expect(capped.status).toBe(200);
    const cappedSeen = h.provider.requests[0]!;
    expect(cappedSeen.meetings).toHaveLength(10);
    expect(cappedSeen.meetingsTruncated).toBe(true);

    // -- The end route is idempotent ------------------------------------------
    const live = await h.meetingStore.insert({
      boardId,
      orgId,
      startedAt: Date.now(),
      endedAt: null,
      turns: [],
      createdBy: alice.id,
      createdAt: Date.now(),
    });
    const end1 = await api(h, `/api/boards/${boardId}/meetings/${live.id}/end`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ endedAt: Date.now() }),
    });
    expect(end1.status).toBe(200);
    const end2 = await api(h, `/api/boards/${boardId}/meetings/${live.id}/end`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ endedAt: Date.now() + 1000 }),
    });
    expect(end2.status).toBe(200);
    expect(end2.body.endedAt).toBe(end1.body.endedAt); // a read, not a second effect

    // -- The ✦ contract: the stored provenance carries the turnRange the
    // canvas jump needs (the same fields citationTarget reads).
    const newNode = (await h.boardStore.get(boardId))!.workspace.nodes["pricing-new"]!;
    expect(newNode.provenance).toMatchObject({
      meetingId: wednesday.id,
      turnRange: [0, 0],
    });
  });
});
