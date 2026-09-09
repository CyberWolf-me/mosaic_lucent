import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { applyOperations, actionsFromDecision, createWorkspace, decisionDriveGraph, decisionsBehindAction, inverseOperations, type Operation } from "@lucent/core";
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
 * Stage D2's definition of done — the owner's acceptance fixture as one
 * continuous story:
 *
 *   The 4/6/3/5/4/2 board (4 decisions, 6 actions, 3 requirements, 5
 *   proposals, 4 questions, 2 risks) seeded through the ops route. The mock
 *   generates plan-shaped ops (a region for the decisions, derived actions
 *   for requirements/risks; MECHANICALLY no UPDATE_STATEMENT, no DELETE).
 *   A plan proposal carries the client-convention createdFrom stamps on
 *   every created node. APPROVAL applies it through the room-path AI actor
 *   chain — no plan item appears human-decided. Then verified: the region
 *   exists with its children, every derived action traces createdFrom to
 *   real source statement ids, the existing six actions are untouched, NO
 *   proposal or question node gained an issue, and undo restores the board.
 */

const SECRET = "test-secret-at-least-16-chars";

// Simpler: build with the port captured once listening completes.
async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, boardStore, close: async () => { await close(); } };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function api(h: NonNullable<typeof open>, path: string, init: RequestInit & { token?: string } = {}) {
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

/** The acceptance fixture: 4 decisions, 6 actions, 3 requirements, 5 proposals, 4 questions, 2 risks. */
function fixtureOps(): Operation[] {
  const ops: Operation[] = [];
  const add = (id: string, kind: any, issue?: Record<string, unknown>) => {
    ops.push({ op: "CREATE_NODE", id, nodeType: kind, label: id.replace(/-/g, " ") });
    ops.push({ op: "SET_STATEMENT", id, statement: { kind, status: kind === "decision" ? "resolved" : "open" } });
    if (issue) ops.push({ op: "SET_ISSUE", id, issue: { type: "task", ...issue } } as Operation);
  };
  for (let i = 0; i < 4; i += 1) add(`dec-${i}`, "decision");
  for (let i = 0; i < 6; i += 1) add(`act-${i}`, "action", { status: "assigned", assignee: "Sarah" });
  for (let i = 0; i < 3; i += 1) add(`req-${i}`, "requirement");
  for (let i = 0; i < 5; i += 1) add(`pro-${i}`, "proposal");
  for (let i = 0; i < 4; i += 1) add(`que-${i}`, "question");
  for (let i = 0; i < 2; i += 1) add(`rsk-${i}`, "risk");
  return ops;
}

/** What the mock emits for the plan request, gated and stamped the way the send path does. */
async function planOpsFromMock() {
  const { MockProvider } = await import("@lucent/ai");
  const { summarizeWorkspace } = await import("@lucent/ai");
  const { attachPlanProvenance } = await import("@lucent/core");
  const { applyOperations, createWorkspace } = await import("@lucent/core");
  // The server test cannot import @lucent/web (the C4/C6 precedent) — the
  // real gate is node-tested in the web package (plan-gate.test.ts); here
  // the same allowlist is mirrored inline as the honest contract twin.
  const PLAN_SAFE_OPS = new Set(["CREATE_NODE", "SET_STATEMENT", "SET_ISSUE", "UPDATE_ISSUE", "CREATE_GROUP", "CONNECT_NODES", "SET_GROUP_KIND"]);
  const gatePlanOps = (ops: readonly Operation[]) => ({
    allowed: ops.filter((o) => PLAN_SAFE_OPS.has(o.op)),
    skipped: ops.filter((o) => !PLAN_SAFE_OPS.has(o.op)).map((o) => ({ op: o.op, reason: "gate" })),
  });
  const provider = new MockProvider();
  const summary = summarizeWorkspace(applyOperations(createWorkspace(), fixtureOps()));
  const result = await provider.generateOperations({
    message: "Create the work from these decisions.",
    summary,
  } as never);
  // The send path's composition: gate, then stamp.
  const gated = gatePlanOps(result.operations);
  const stamped = attachPlanProvenance(gated.allowed, ["dec-0", "dec-1", "dec-2", "dec-3", "req-0", "req-1", "req-2", "rsk-0", "rsk-1"]);
  return { raw: result.operations, gated, stamped };
}

describe("Stage D2 definition of done — the acceptance fixture", () => {
  it("the plan proposes, the human approves, and every item traces its sources", async () => {
    const h = (open = await makeHarness());
    const alice = await signup(h, "d2@example.com");

    // -- The fixture board ---------------------------------------------------
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Acceptance board", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const seed = await h.boardStore.appendOp({
      boardId,
      ops: fixtureOps(),
      by: alice.id,
      label: "fixture",
      at: Date.now(),
      actor: { actorType: "user", actorId: alice.id, initiatedBy: alice.id },
    });
    expect(seed.ok).toBe(true);
    const board = await h.boardStore.get(boardId);
    if (!board || !seed.ok) throw new Error("board missing");
    await h.boardStore.put({ ...board, workspace: applyOperations(board.workspace, fixtureOps()) });

    // -- The model's plan, gated and stamped (the send path's composition) --
    const { raw, gated, stamped } = await planOpsFromMock();
    // Plan-shaped: a region for the decisions, derived actions, and NO
    // lifecycle conversion or destruction anywhere in the raw batch.
    expect(raw.some((o) => o.op === "CREATE_GROUP")).toBe(true);
    expect(raw.some((o) => o.op === "UPDATE_STATEMENT")).toBe(false);
    expect(raw.some((o) => o.op === "DELETE_NODE")).toBe(false);
    // Stage E1: the causal edges — one drives CONNECT per derived action,
    // decision as source. The batch carries five (one per derived action).
    const driveOps = raw.filter(
      (o) => o.op === "CONNECT_NODES" && (o as any).relationship === "drives",
    );
    expect(driveOps.length).toBe(5);
    for (const op of driveOps) {
      expect((op as any).source).toMatch(/^dec-\d$/);
      expect((op as any).target).toMatch(/-action$/);
    }
    // The gate keeps everything (the mock is plan-shaped; CONNECT_NODES is
    // in PLAN_SAFE_OPS) and stamps createdFrom on every created node.
    expect(gated.skipped).toEqual([]);
    for (const op of stamped) {
      if (op.op === "CREATE_NODE") {
        expect((op as any).provenance?.createdFrom).toBeDefined();
      }
    }
    expect(stamped.filter((o) => (o as any).relationship === "drives").length).toBe(5);

    // -- The plan proposal through the real route (the client-convention ops) --
    const proposed = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        operations: stamped,
        request: planRequestTextText(),
        explanation: "Organized the board's semantic state into a plan.",
      }),
    });
    expect(proposed.status).toBe(201);
    const pid = proposed.body.proposal.id as string;

    // -- Approval applies it through the AI actor chain ----------------------
    const approved = await api(h, `/api/boards/${boardId}/proposals/${pid}/approve`, {
      method: "POST",
      token: alice.token,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.proposal.appliedSeq).not.toBeNull();

    const after = await h.boardStore.get(boardId);
    const ws = after!.workspace;

    // The region exists, holding the derived work and the decisions.
    const region = ws.groups["plan-region"];
    expect(region).toBeDefined();
    expect(region!.label).toBe("Launch plan");
    expect(region!.children).toContain("req-0-action");

    // Every derived action traces createdFrom to REAL source statement ids.
    for (const id of ["req-0-action", "req-1-action", "req-2-action", "rsk-0-action", "rsk-1-action"]) {
      const node = ws.nodes[id];
      expect(node, `${id} created`).toBeDefined();
      expect(node!.provenance?.createdFrom).toBeDefined();
      expect(node!.statement?.kind).toBe("action");
      expect(node!.issue).toBeDefined();
      for (const source of node!.provenance!.createdFrom!) {
        expect(ws.nodes[source], `source ${source} exists`).toBeDefined();
        expect(ws.nodes[source]!.statement).toBeDefined();
      }
    }

    // The existing six actions are untouched (ids preserved, statements intact).
    for (let i = 0; i < 6; i += 1) {
      const node = ws.nodes[`act-${i}`];
      expect(node, `act-${i} preserved`).toBeDefined();
      expect(node!.issue?.assignee).toBe("Sarah");
      expect(node!.provenance?.createdFrom).toBeUndefined(); // not re-stamped
    }

    // NO proposal or question node gained work or changed kind.
    for (let i = 0; i < 5; i += 1) {
      expect(ws.nodes[`pro-${i}`]?.issue, `pro-${i} has no issue`).toBeUndefined();
      expect(ws.nodes[`pro-${i}`]?.statement?.kind).toBe("proposal");
    }
    for (let i = 0; i < 4; i += 1) {
      expect(ws.nodes[`que-${i}`]?.issue, `que-${i} has no issue`).toBeUndefined();
      expect(ws.nodes[`que-${i}`]?.statement?.kind).toBe("question");
    }

    // Stage E1: the drives edges landed — five causal edges, each from a
    // decision to the derived action it caused, readable in both
    // directions through the graph helpers.
    const driveGraph = decisionDriveGraph(ws);
    const drivenActions = new Set(
      [...driveGraph.values()].reduce<string[]>((acc, ids) => [...acc, ...ids], []),
    );
    for (const id of ["req-0-action", "req-1-action", "req-2-action", "rsk-0-action", "rsk-1-action"]) {
      expect(drivenActions.has(id), `${id} is driven by a decision`).toBe(true);
    }
    const decisionIds = [...driveGraph.keys()];
    expect(decisionIds.length).toBeGreaterThan(0);
    expect(decisionIds.every((id) => /^dec-\d$/.test(id))).toBe(true);
    for (const id of decisionIds) {
      expect(actionsFromDecision(ws, id).length).toBeGreaterThan(0);
    }
    // And every derived action traces back to its decision(s).
    for (const id of ["req-0-action", "rsk-1-action"]) {
      expect(decisionsBehindAction(ws, id).length).toBeGreaterThan(0);
    }

    // Stage E3: the task tree — the workstream sub-groups inside the plan
    // region, every derived action in exactly one, each node's groupId on
    // its workstream, and the region still holding everything.
    const workstreamIds = Object.keys(ws.groups).filter((id) => id.startsWith("plan-ws-"));
    expect(workstreamIds.length).toBe(4); // Research/Design/Engineering/QA
    const assigned = new Set<string>();
    for (const wsid of workstreamIds) {
      const group = ws.groups[wsid]!;
      expect(group.kind).toBeUndefined(); // kindless: container, not lens
      expect(group.children.length).toBeGreaterThan(0);
      for (const child of group.children) {
        expect(child).toMatch(/-action$/);
        expect(assigned.has(child), `${child} in exactly one workstream`).toBe(false);
        assigned.add(child);
        expect(ws.nodes[child]!.groupId).toBe(wsid);
      }
    }
    expect(assigned.size).toBe(5); // all five derived actions
    expect(ws.groups["plan-region"]!.children).toEqual(
      expect.arrayContaining([...assigned, "dec-0", "dec-1", "dec-2", "dec-3"]),
    );

    // -- The log records the approval as the AI actor chain ------------------
    const log = await h.boardStore.loadLog(boardId);
    const planEntry = log.find((e) => e.label === "proposal approved" || (e.actor?.actorType === "ai"));
    expect(planEntry).toBeDefined();
    expect(planEntry!.actor?.actorType).toBe("ai");
    expect(planEntry!.actor?.initiatedBy).toBe(alice.id);
    expect(planEntry!.actor?.approvedBy).toBe(alice.id);

    // -- Undo restores the board (the plan is one reversible batch) ----------
    const planOps = planEntry!.ops;
    const inverse = inverseOperations(planOps, /* pre-state */ (() => {
      const before = applyOperations(createWorkspace(), fixtureOps());
      return before;
    })());
    const undone = applyOperations(ws, inverse);
    expect(undone.groups["plan-region"]).toBeUndefined();
    expect(undone.nodes["req-0-action"]).toBeUndefined();
    expect(undone.nodes["act-0"]?.issue?.assignee).toBe("Sarah"); // untouched throughout
    // Stage E1: undo removes the causal edges with the rest of the batch —
    // one reversible unit, structure and causality together.
    expect(decisionDriveGraph(undone).size).toBe(0);
  });
});

function planRequestTextText(): string {
  return "Create the work from these 9 statements: organize the decisions into a plan region, preserve existing actions with their owners and deadlines, derive new actions for requirements and risks, and link each derived action to the decision that drives it with a drives relationship. Proposals and questions are context — never create confirmed work from them.";
}

