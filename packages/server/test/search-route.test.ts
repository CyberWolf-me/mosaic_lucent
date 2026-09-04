import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryMeetingStore, type MeetingTurn } from "../src/meetings.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { PLAN_LADDER } from "../src/plans.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";

/**
 * The board search route (Stage C4), end to end. The one behavior this file
 * exists for is THE ACCEPTANCE CRITERION: search and Ask see exactly the same
 * window. A revision and a meeting whose content matches the query but sits
 * OUTSIDE a Free caller's 25-revision window must not be findable — not
 * filtered from results, absent from the corpus. Inside the window, the
 * corpus the digest never shows IS findable: an unclassified turn, the
 * content no projection surfaces, is search's first citizen.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  meetingStore: InMemoryMeetingStore;
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
  const meetingStore = new InMemoryMeetingStore();
  const usage = new InMemoryUsageStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
    headers: { "content-type": "application/json" },
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

async function makeBoard(h: Harness, token: string, name: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: JSON.stringify({ name, workspace: createWorkspace() }),
    headers: { "content-type": "application/json" },
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

interface SeedRevision {
  label: string;
  ops?: Operation[];
  at?: number;
}

/** Seed one revision per entry, in order; returns the seqs assigned. */
async function seedRevisions(
  h: Harness,
  boardId: string,
  userId: string,
  revisions: SeedRevision[],
  baseAt = Date.now() - revisions.length * 60_000,
): Promise<number[]> {
  const seqs: number[] = [];
  for (let i = 0; i < revisions.length; i += 1) {
    const rev = revisions[i]!;
    const append = await h.boardStore.appendOp({
      boardId,
      ops: rev.ops ?? [{ op: "CREATE_NODE", id: `n${i + 1}`, nodeType: "step", label: rev.label }],
      by: userId,
      label: rev.label,
      at: rev.at ?? baseAt + (i + 1) * 60_000,
      actor: { actorType: "user", actorId: userId, initiatedBy: userId },
    });
    expect(append.ok).toBe(true);
    if (append.ok) seqs.push(append.seq);
  }
  return seqs;
}

function turn(speaker: string, text: string, at: number, kind?: MeetingTurn["kind"]): MeetingTurn {
  return kind ? { speaker, at, text, kind } : { speaker, at, text };
}

describe("GET /api/boards/:id/search", () => {
  it("the acceptance criterion: a Free window hides nothing it may not show, and shows what the digest never did", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const boardId = await makeBoard(h, alice.token, "Acceptance");

    // A meeting BEFORE the window floor, containing a turn that matches the
    // query — it must not be findable.
    const base = Date.now() - 60 * 60_000;
    await h.meetingStore.insert({
      boardId,
      orgId: "org_placeholder",
      startedAt: base,
      endedAt: base + 60_000,
      turns: [turn("Maya", "the old pricing discussion", base)],
      createdBy: alice.id,
      createdAt: base,
    });
    // 30 revisions: Free depth 25 means the oldest 5 are outside the window.
    // Revision 1's label matches the query — it must not be findable.
    const seqs = await seedRevisions(
      h,
      boardId,
      alice.id,
      Array.from({ length: 30 }, (_, i) => ({ label: i === 0 ? "pricing retro" : `change ${i}` })),
      base,
    );
    // A meeting INSIDE the window with an unclassified pricing turn — the
    // corpus no digest ever shows, search's first citizen.
    const inside = base + 35 * 60_000;
    const meeting = await h.meetingStore.insert({
      boardId,
      orgId: "org_placeholder",
      startedAt: inside,
      endedAt: inside + 60_000,
      turns: [turn("Tom", "maybe pricing at $20 for pro", inside)],
      createdBy: alice.id,
      createdAt: inside,
    });

    const res = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`,
      { token: alice.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.historyDepth).toBe(25);
    expect(res.body.windowTruncated).toBe(true);

    const turnHits = res.body.results.filter((r: any) => r.kind === "turn");
    expect(turnHits.map((t: any) => t.meetingId)).toEqual([meeting.id]);
    // The turn hit carries the stable index and the match.
    expect(turnHits[0].turnIndex).toBe(0);
    expect(turnHits[0].snippet).toContain("pricing");

    // The revision outside the window (seq 1, "pricing retro") is NOT in the
    // results — never filtered, absent from the corpus.
    const revisionHits = res.body.results.filter((r: any) => r.kind === "revision");
    expect(revisionHits.map((r: any) => r.seq)).not.toContain(seqs[0]);
    // And the meeting before the floor is not findable either.
    const allMeetingIds = new Set(
      res.body.results.filter((r: any) => r.kind === "turn").map((r: any) => r.meetingId),
    );
    expect(allMeetingIds.size).toBe(1);
  });

  it("finds node labels and statements, ranked by weight", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "nodes@example.com");
    const boardId = await makeBoard(h, alice.token, "Nodes");
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "pricing-decision",
        nodeType: "decision",
        label: "Pricing decision $15",
      },
      {
        op: "SET_STATEMENT",
        id: "pricing-decision",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
      },
      { op: "CREATE_NODE", id: "other", nodeType: "step", label: "mention of pricing in a note" },
    ];
    await seedRevisions(h, boardId, alice.id, [{ label: "statements", ops }]);
    // Mirror the room pipeline: appendOp writes the log, put updates the
    // workspace the corpus scans.
    const board = await h.boardStore.get(boardId);
    if (!board) throw new Error("board missing");
    const { applyOperations } = await import("@lucent/core");
    await h.boardStore.put({ ...board, workspace: applyOperations(board.workspace, ops) });

    const res = await api(h, `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`, {
      token: alice.token,
    });
    expect(res.status).toBe(200);
    const nodes = res.body.results.filter((r: any) => r.kind === "node");
    expect(nodes).toHaveLength(2);
    // The label+topic node outranks the label-only node.
    expect(nodes[0].id).toBe("pricing-decision");
    expect(nodes[0].statement).toEqual({ kind: "decision", status: "resolved", topic: "pricing" });
    expect(nodes[0].matched).toContain("pricing");
  });

  it("a viewer searches; a stranger gets 404, not 403; q is required", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "share@example.com");
    const bob = await signup(h, "bob@example.com");
    const mallory = await signup(h, "mallory@example.com");
    const boardId = await makeBoard(h, alice.token, "Shared");
    await seedRevisions(h, boardId, alice.id, [{ label: "pricing call" }]);

    const share = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
      headers: { "content-type": "application/json" },
    });
    expect(share.status).toBe(201);
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ token: share.body.token }),
      headers: { "content-type": "application/json" },
    });

    const asViewer = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`,
      { token: bob.token },
    );
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.results.length).toBeGreaterThan(0);

    const asStranger = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`,
      { token: mallory.token },
    );
    expect(asStranger.status).toBe(404);

    const noQuery = await api(h, `/api/boards/${boardId}/search`, { token: alice.token });
    expect(noQuery.status).toBe(400);
  });

  it("an upgrade widens the searched window instantly — nothing was hidden by deletion", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "upgrade@example.com");
    const boardId = await makeBoard(h, alice.token, "Upgrade");
    await seedRevisions(
      h,
      boardId,
      alice.id,
      Array.from({ length: 30 }, (_, i) => ({ label: i === 0 ? "pricing retro" : `change ${i}` })),
    );

    // Free: the matching old revision is outside the window — not found.
    const before = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("retro")}`,
      { token: alice.token },
    );
    expect(before.status).toBe(200);
    expect(before.body.results).toHaveLength(0);
    expect(before.body.windowTruncated).toBe(true);

    // Put the org on Pro (the completed-checkout path, as history-route tests).
    const memberships = await h.userStore.membershipsFor(alice.id);
    const orgId = memberships[0]!.orgId;
    const now = Date.now();
    await h.usage.seedPlans(PLAN_LADDER, now);
    await h.usage.putSubscription({
      orgId,
      plan: "pro",
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

    const after = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("retro")}`,
      { token: alice.token },
    );
    expect(after.status).toBe(200);
    expect(after.body.historyDepth).toBe(500);
    expect(after.body.windowTruncated).toBe(false);
    const revisionHits = after.body.results.filter((r: any) => r.kind === "revision");
    expect(revisionHits.map((r: any) => r.seq)).toContain(1);
  });

  it("caps results at 20 and reports the window honestly when it is full", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "caps@example.com");
    const boardId = await makeBoard(h, alice.token, "Caps");
    await seedRevisions(
      h,
      boardId,
      alice.id,
      Array.from({ length: 40 }, (_, i) => ({ label: `pricing change ${i}` })),
    );

    const res = await api(
      h,
      `/api/boards/${boardId}/search?q=${encodeURIComponent("pricing")}`,
      { token: alice.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(20);
    expect(res.body.windowTruncated).toBe(true);
    expect(res.body.historyDepth).toBe(25);
  });
});
