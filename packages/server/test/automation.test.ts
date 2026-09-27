import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import {
  applyOperations,
  createWorkspace,
  stampAuthorship,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryOutbox } from "../src/outbox.js";
import {
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import { InMemoryIntegrationWebhookEventStore } from "../src/integrations/webhook.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";
import {
  AUTOMATION_DEFAULTS,
  effectiveAutomation,
  parseOrgSettings,
} from "../src/classification.js";
import { firstUncoveredTurn, remainderMessage } from "../src/automation.js";
import { REQUEST_LIMITS } from "@lucent/ai";

/**
 * Automation v1 (docs/26 A5): the org's four rules, each through the real
 * app — what triggers it, what it produces, that a person still decides
 * what lands, and that an org which didn't turn a rule on gets nothing.
 */

const SECRET = "automation-test-secret-16";
const WEBHOOK_SECRET = "whsec_automation_a5";

let open: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function harness() {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const boardStore = new InMemoryBoardStore();
  const meetings = new InMemoryMeetingStore();
  const proposals = new InMemoryProposalStore();
  const outbox = new InMemoryOutbox();
  const integrationStore = new InMemoryIntegrationStore();
  const inbound = new InMemoryInboundChangeStore();
  const app: App = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    boardStore,
    meetings,
    proposals,
    outbox,
    notifications: new InMemoryNotificationStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    integrations: {
      store: integrationStore,
      providers: new Map<
        string,
        import("../src/integrations/provider.js").ExecutionProviderFactory
      >([["fake", () => new FakeProvider()]]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
      webhookEvents: new InMemoryIntegrationWebhookEventStore(),
      inbound,
    },
  });
  open = app;
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (rest.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const signup = async (email: string, name: string) => {
    const created = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name }),
    });
    const user = await userStore.findByEmail(email);
    if (user) await userStore.setEmailVerified(user.id, Date.now());
    const orgs = await api("/api/orgs", { token: created.body.token });
    return {
      id: created.body.user.id as string,
      token: created.body.token as string,
      org: orgs.body.orgs[0].id as string,
    };
  };
  const board = async (token: string, name: string, ops: Operation[] = [], by = "u") => {
    const workspace: Workspace = applyOperations(createWorkspace(), stampAuthorship(ops, by));
    const created = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name, workspace }),
    });
    return created.body.id as string;
  };
  const rules = (token: string, org: string, automation: Record<string, unknown>) =>
    api(`/api/orgs/${org}/settings`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ automation }),
    });
  const notificationsOf = async (token: string) =>
    ((await api("/api/notifications?limit=50", { token })).body.notifications ?? []) as Array<{
      kind: string;
      title: string;
    }>;
  return {
    app,
    api,
    base,
    signup,
    board,
    rules,
    notificationsOf,
    meetings,
    proposals,
    outbox,
    orgStore,
    boardStore,
    integrationStore,
    inbound,
  };
}

describe("the automation settings", () => {
  it("resolve to their defaults, and a rule nobody can read does not run", () => {
    expect(effectiveAutomation(undefined)).toEqual(AUTOMATION_DEFAULTS);
    expect(effectiveAutomation({ meetingExtract: true })).toMatchObject({
      meetingExtract: true,
      overdueNotify: true,
    });
    expect(effectiveAutomation({ overdueNotify: "yes", externalClose: 1 })).toMatchObject({
      overdueNotify: false,
      externalClose: false,
    });
    expect(Object.values(effectiveAutomation("garbage"))).toEqual([false, false, false, false]);
    expect(parseOrgSettings({ automation: { meetingExtract: true, decisionPlan: null } }).ok).toBe(
      true,
    );
    expect(parseOrgSettings({ automation: { autopilot: true } })).toMatchObject({ ok: false });
    expect(parseOrgSettings({ automation: { meetingExtract: "on" } })).toMatchObject({
      ok: false,
    });
  });

  it("are the owner's to set, one rule at a time, audited", async () => {
    const h = await harness();
    const owner = await h.signup("owner@example.com", "Olive Owner");
    const first = await h.rules(owner.token, owner.org, { meetingExtract: true });
    expect(first.status).toBe(200);
    const second = await h.rules(owner.token, owner.org, { externalClose: true });
    expect(second.body.effective.automation).toEqual({
      meetingExtract: true,
      decisionPlan: false,
      overdueNotify: true,
      externalClose: true,
    });
    // null returns a rule to its default.
    const cleared = await h.rules(owner.token, owner.org, { meetingExtract: null });
    expect(cleared.body.settings.automation).toEqual({ externalClose: true });
    expect((await h.rules(owner.token, owner.org, { autopilot: true })).status).toBe(400);
    const audit = await h.orgStore.auditFor(owner.org, 10);
    expect(audit.some((a) => a.action === "org.settings")).toBe(true);
  });
});

describe("rule 1 — a meeting ends: what it left unextracted is proposed", () => {
  it("knows which turns the board already covers", () => {
    const ws = applyOperations(
      createWorkspace(),
      stampAuthorship(
        [
          {
            op: "CREATE_NODE",
            id: "a",
            nodeType: "process",
            label: "A",
            provenance: { meetingId: "m1", turnRange: [0, 3] },
          },
          {
            op: "CREATE_NODE",
            id: "b",
            nodeType: "process",
            label: "B",
            provenance: { meetingId: "other", turnRange: [0, 40] },
          },
        ] as Operation[],
        "u",
      ),
    );
    expect(firstUncoveredTurn("m1", ws, [])).toBe(4);
    expect(
      firstUncoveredTurn("m1", ws, [
        { meetingId: "m1", status: "rejected", provenance: { turnRange: [4, 6] } } as never,
        { meetingId: "m1", status: "superseded", provenance: { turnRange: [7, 9] } } as never,
      ]),
    ).toBe(7);
  });

  it("fits as many turns as the request allows — never an oversized prompt", () => {
    const long = Array.from({ length: 400 }, (_, i) => ({
      speaker: "Ada",
      at: i,
      text: `Point ${i}: we should look at the pricing page and the billing flow together.`,
    }));
    const fitted = remainderMessage({ startedAt: Date.UTC(2026, 8, 20) }, long)!;
    expect(fitted.message.length).toBeLessThanOrEqual(REQUEST_LIMITS.messageChars);
    expect(fitted.count).toBeGreaterThan(20);
    expect(fitted.count).toBeLessThan(400);
    expect(fitted.message).toContain("on 2026-09-20 has ended");
  });

  it("a live-loop batch of ordinary speech fits the generate route (it used to be refused)", async () => {
    const h = await harness();
    const owner = await h.signup("batch@example.com", "Bea Batch");
    const { differentialPrompt } = await import("@lucent/ai");
    const batch = Array.from({ length: 8 }, (_, i) => ({
      speaker: "Bea",
      text: `Turn ${i}: we talked through the pricing page, the billing flow and who owns each piece.`,
    }));
    const message = differentialPrompt(batch);
    expect(message.length).toBeGreaterThan(4_000);
    const res = await h.api("/api/generate", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        message,
        summary: {
          diagramKind: "flowchart",
          nodes: [],
          edges: [],
          shapes: [],
          shapeLinks: [],
          groups: [],
          comments: [],
          reactions: [],
          wireframes: [],
        },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("proposes the rest for the person who recorded it, only when the org turned it on", async () => {
    const h = await harness();
    const owner = await h.signup("rec@example.com", "Rae Recorder");
    const boardId = await h.board(owner.token, "Pricing", []);
    const turns = [
      "Should we offer annual plans?",
      "Yes, let's go annual.",
      "I'll prepare the launch brief by Friday.",
      "We need a new pricing page.",
      "Maybe a student discount too.",
    ].map((text, i) => ({ speaker: i % 2 ? "Bo" : "Rae", at: Date.UTC(2026, 8, 20, 10, i), text }));
    const meeting = await h.meetings.insert({
      boardId,
      orgId: owner.org,
      startedAt: Date.UTC(2026, 8, 20, 10),
      endedAt: Date.UTC(2026, 8, 20, 11),
      turns,
      createdBy: owner.id,
      createdAt: 1,
      mode: "intelligence",
      title: "Pricing sync",
    });
    // The live loop already extracted the first two turns.
    const ops = await h.api(`/api/boards/${boardId}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        label: "live",
        ops: [
          {
            op: "CREATE_NODE",
            id: "annual",
            nodeType: "process",
            label: "Offer annual plans",
            provenance: { meetingId: meeting.id, turnRange: [0, 1] },
          },
        ],
      }),
    });
    expect(ops.status).toBe(200);

    expect((await h.app.automations.extractMeetingRest(boardId, meeting.id)).outcome).toBe("off");
    await h.rules(owner.token, owner.org, { meetingExtract: true });
    const result = await h.app.automations.extractMeetingRest(boardId, meeting.id);
    expect(result.outcome).toBe("proposed");
    const proposal = result.proposal!;
    expect(proposal).toMatchObject({
      status: "pending",
      meetingId: meeting.id,
      createdBy: owner.id,
      provenance: { turnRange: [2, 4] },
    });
    expect(proposal.request).toContain("Pricing sync");
    expect(proposal.operations.length).toBeGreaterThan(0);
    // What it creates carries the meeting's evidence, like the live loop's.
    const created = proposal.operations.find((o) => o.op === "CREATE_NODE") as {
      provenance?: { meetingId?: string; turnRange?: number[] };
    };
    expect(created.provenance).toMatchObject({ meetingId: meeting.id, turnRange: [2, 4] });
    // Nothing landed: the board holds only what the live loop made.
    const stored = await h.boardStore.get(boardId);
    expect(Object.keys(stored!.workspace.nodes)).toEqual(["annual"]);
    // The recorder is told, and the run is on record as the system's.
    const told = await h.notificationsOf(owner.token);
    expect(told.some((n) => n.kind === "automation.proposed")).toBe(true);
    const runs = await h.api(`/api/orgs/${owner.org}/ai-runs`, { token: owner.token });
    expect(runs.body.runs?.[0]).toMatchObject({ initiatedBy: null, surface: "meeting" });

    // Its pending proposal covers those turns: a second pass proposes nothing.
    expect((await h.app.automations.extractMeetingRest(boardId, meeting.id)).outcome).toBe(
      "covered",
    );
    // One pending proposal per board: another meeting's rest waits for a person.
    const next = await h.meetings.insert({
      boardId,
      orgId: owner.org,
      startedAt: Date.UTC(2026, 8, 21, 10),
      endedAt: Date.UTC(2026, 8, 21, 11),
      turns: [{ speaker: "Rae", at: Date.UTC(2026, 8, 21, 10, 1), text: "We'll hire a designer." }],
      createdBy: owner.id,
      createdAt: 2,
    });
    expect((await h.app.automations.extractMeetingRest(boardId, next.id)).outcome).toBe("busy");
    // Rejected: those turns were looked at — nothing is proposed twice.
    const rejected = await h.api(`/api/boards/${boardId}/proposals/${proposal.id}/reject`, {
      method: "POST",
      token: owner.token,
    });
    expect(rejected.status).toBe(200);
    expect((await h.app.automations.extractMeetingRest(boardId, meeting.id)).outcome).toBe(
      "covered",
    );
    expect((await h.app.automations.extractMeetingRest(boardId, next.id)).outcome).toBe("proposed");
  });

  it("leaves a record-mode meeting and a live one alone", async () => {
    const h = await harness();
    const owner = await h.signup("quiet@example.com", "Quinn Quiet");
    await h.rules(owner.token, owner.org, { meetingExtract: true });
    const boardId = await h.board(owner.token, "Quiet");
    const base = {
      boardId,
      orgId: owner.org,
      startedAt: 1,
      turns: [{ speaker: "Q", at: 2, text: "We'll ship on Monday." }],
      createdBy: owner.id,
      createdAt: 1,
    };
    const recorded = await h.meetings.insert({ ...base, endedAt: 5, mode: "record" });
    const live = await h.meetings.insert({ ...base, endedAt: null });
    expect((await h.app.automations.extractMeetingRest(boardId, recorded.id)).outcome).toBe(
      "record-mode",
    );
    expect((await h.app.automations.extractMeetingRest(boardId, live.id)).outcome).toBe(
      "not-ended",
    );
  });
});

describe("rule 2 — a decision approved in Review: its plan is proposed", () => {
  it("announces the approval, and proposes a gated plan for the approver", async () => {
    const h = await harness();
    const owner = await h.signup("plan@example.com", "Pat Planner");
    const boardId = await h.board(owner.token, "Launch", [
      { op: "CREATE_NODE", id: "go-annual", nodeType: "process", label: "Offer annual plans" },
      {
        op: "SET_STATEMENT",
        id: "go-annual",
        statement: { kind: "decision", status: "resolved", trust: "ai-suggested" },
      } as Operation,
      {
        op: "CREATE_NODE",
        id: "annual-billing",
        nodeType: "process",
        label: "Billing takes annual",
      },
      {
        op: "SET_STATEMENT",
        id: "annual-billing",
        statement: { kind: "requirement", status: "open", trust: "human-created" },
      } as Operation,
    ]);
    const approved = await h.api(`/api/boards/${boardId}/review`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ action: "approve", nodeIds: ["go-annual"] }),
    });
    expect(approved.status).toBe(200);
    const events = await h.outbox.pending(20);
    expect(events.find((e) => e.type === "DecisionApproved")).toMatchObject({
      boardId,
      payload: { nodeIds: ["go-annual"], by: owner.id },
    });

    expect((await h.app.automations.planDecisions(boardId, ["go-annual"], owner.id)).outcome).toBe(
      "off",
    );
    await h.rules(owner.token, owner.org, { decisionPlan: true });
    const result = await h.app.automations.planDecisions(boardId, ["go-annual"], owner.id);
    expect(result.outcome).toBe("proposed");
    const proposal = result.proposal!;
    expect(proposal.createdBy).toBe(owner.id);
    expect(proposal.request).toContain("Offer annual plans");
    // The plan gate: creation and organization only.
    const kinds = new Set(proposal.operations.map((o) => o.op));
    for (const op of ["UPDATE_STATEMENT", "DELETE_NODE", "CHANGE_TEXT"]) {
      expect(kinds.has(op as Operation["op"])).toBe(false);
    }
    // Everything it creates traces to the decision.
    const created = proposal.operations.filter((o) => o.op === "CREATE_NODE") as Array<{
      provenance?: { createdFrom?: string[] };
    }>;
    expect(created.length).toBeGreaterThan(0);
    for (const node of created) expect(node.provenance?.createdFrom).toContain("go-annual");
  });

  it("does nothing for a suggestion nobody approved", async () => {
    const h = await harness();
    const owner = await h.signup("unapproved@example.com", "Una");
    await h.rules(owner.token, owner.org, { decisionPlan: true });
    const boardId = await h.board(owner.token, "Maybe", [
      { op: "CREATE_NODE", id: "d", nodeType: "process", label: "Maybe annual" },
      {
        op: "SET_STATEMENT",
        id: "d",
        statement: { kind: "decision", status: "resolved", trust: "ai-suggested" },
      } as Operation,
    ]);
    expect((await h.app.automations.planDecisions(boardId, ["d"], owner.id)).outcome).toBe(
      "not-a-decision",
    );
  });
});

describe("rule 3 — overdue work: its owner is told, once", () => {
  it("tells the person the work names, once per due date, and only where the rule is on", async () => {
    const h = await harness();
    const owner = await h.signup("late@example.com", "Lee Late");
    await h.board(owner.token, "Plan", [
      { op: "CREATE_NODE", id: "brief", nodeType: "process", label: "Write the brief" },
      { op: "SET_STATEMENT", id: "brief", statement: { kind: "action", status: "open" } },
      {
        op: "SET_ISSUE",
        id: "brief",
        issue: { type: "task", status: "assigned", assignee: "Lee Late", dueDate: "2025-01-15" },
      },
      { op: "CREATE_NODE", id: "done", nodeType: "process", label: "Done already" },
      { op: "SET_STATEMENT", id: "done", statement: { kind: "action", status: "open" } },
      {
        op: "SET_ISSUE",
        id: "done",
        issue: {
          type: "task",
          status: "completed",
          assignee: "Lee Late",
          dueDate: "2025-01-15",
        },
      },
    ] as Operation[]);
    // On by default.
    expect(await h.app.automations.sweepOverdue()).toEqual({ told: 1 });
    const told = await h.notificationsOf(owner.token);
    const overdue = told.filter((n) => n.kind === "work.overdue");
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.title).toContain("Write the brief");
    expect(await h.app.automations.sweepOverdue()).toEqual({ told: 0 });

    const other = await h.signup("off@example.com", "Otto Off");
    await h.rules(other.token, other.org, { overdueNotify: false });
    await h.board(other.token, "Off", [
      { op: "CREATE_NODE", id: "x", nodeType: "process", label: "Late too" },
      { op: "SET_STATEMENT", id: "x", statement: { kind: "action", status: "open" } },
      {
        op: "SET_ISSUE",
        id: "x",
        issue: { type: "task", status: "open", assignee: "Otto Off", dueDate: "2025-01-15" },
      },
    ] as Operation[]);
    expect(await h.app.automations.sweepOverdue()).toEqual({ told: 0 });
  });
});

describe("rule 4 — a tracker marks linked work done: the board completes it", () => {
  it("applies 'done' as the integration where the org allows it, and only 'done'", async () => {
    const h = await harness();
    const owner = await h.signup("sync@example.com", "Sy Sync");
    const task = (id: string): Operation[] => [
      { op: "CREATE_NODE", id, nodeType: "task", label: id },
      { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
      { op: "SET_ISSUE", id, issue: { type: "task", status: "open" } },
    ];
    const boardId = await h.board(owner.token, "Synced", [...task("t1"), ...task("t2")]);
    process.env.LUCENT_TEST_AUTOMATION_WEBHOOK = WEBHOOK_SECRET;
    await h.integrationStore.putConnection(
      {
        orgId: owner.org,
        provider: "fake",
        credentialRef: "LUCENT_TEST_CRED",
        scopes: [],
        createdBy: owner.id,
        config: { webhookSecretRef: "LUCENT_TEST_AUTOMATION_WEBHOOK" },
      },
      Date.now(),
    );
    for (const [nodeId, externalId] of [
      ["t1", "FAKE-1"],
      ["t2", "FAKE-2"],
    ] as const) {
      await h.integrationStore.linkTask(
        {
          orgId: owner.org,
          boardId,
          nodeId,
          provider: "fake",
          externalId,
          lastSyncedStatus: "todo",
        },
        1,
      );
    }
    const fire = async (identifier: string, state: string) => {
      const body = JSON.stringify({
        action: "update",
        type: "Issue",
        data: { identifier, state: { name: state } },
      });
      const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
      await fetch(`${h.base}/api/integrations/fake/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-signature": signature },
        body,
      });
    };
    const statusOf = async (id: string) =>
      (await h.boardStore.get(boardId))!.workspace.nodes[id]!.issue!.status;

    // Off (the default): the change waits for a person.
    await fire("FAKE-1", "done");
    expect(await statusOf("t1")).toBe("open");
    expect((await h.inbound.forBoard(boardId))[0]).toMatchObject({ status: "pending" });

    await h.rules(owner.token, owner.org, { externalClose: true });
    await fire("FAKE-2", "done");
    expect(await statusOf("t2")).toBe("completed");
    const log = await h.boardStore.loadLog(boardId, 0);
    const entry = [...log].reverse().find((e) => e.label.includes("automation"));
    expect(entry?.actor).toMatchObject({ actorType: "system", actorId: "fake" });
    const audit = await h.orgStore.auditFor(owner.org, 20);
    expect(audit.find((a) => a.action === "automation.external-close")).toMatchObject({
      actorId: null,
    });
    // Anything but done still waits for a person.
    await fire("FAKE-1", "in progress");
    expect(await statusOf("t1")).toBe("open");
    // And the earlier "done" was not applied behind anyone's back.
    expect(await statusOf("t1")).not.toBe("completed");
  });
});
