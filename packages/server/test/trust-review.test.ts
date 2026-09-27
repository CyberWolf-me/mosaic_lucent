import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import {
  applyOperations,
  createWorkspace,
  stampAuthorship,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { reviewOps } from "../src/routes/review.js";

/**
 * Trust (docs/26 A2, ADR 0047): "nothing AI-extracted becomes trusted without
 * a visible human step". Trust is stamped by whoever commits — the model
 * never sets it, an agent never raises it — and the Review center is where a
 * person takes that step. Every AI run is on record, with who approved it.
 */

const SECRET = "test-secret-at-least-16-chars";
const EMPTY_SUMMARY = {
  diagramKind: "flowchart",
  nodes: [],
  edges: [],
  shapes: [],
  shapeLinks: [],
  groups: [],
  comments: [],
  reactions: [],
  wireframes: [],
};

const suggestion = (id: string, trust?: string): Operation[] => [
  { op: "CREATE_NODE", id, nodeType: "process", label: id.replace(/-/g, " ") },
  {
    op: "SET_STATEMENT",
    id,
    statement: { kind: "decision", status: "resolved", ...(trust ? { trust } : {}) },
  } as Operation,
];

interface Harness {
  base: string;
  ws: string;
  close: () => Promise<void>;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
  api: (
    path: string,
    init?: RequestInit & { token?: string; mcp?: boolean },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string, name?: string) => Promise<{ token: string; id: string; org: string }>;
  board: (token: string, name: string, workspace?: Workspace, id?: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const boardStore = new InMemoryBoardStore();
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetings: new InMemoryMeetingStore(),
    notifications: new InMemoryNotificationStore(),
    proposals: new InMemoryProposalStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api: Harness["api"] = async (path, init = {}) => {
    const { token, mcp, ...rest } = init;
    const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
    if (token) headers.authorization = `Bearer ${token}`;
    if (mcp) headers["x-lucent-client"] = "mcp";
    if (rest.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const signup: Harness["signup"] = async (email, name) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: name ?? email.split("@")[0] }),
    });
    expect(status).toBe(201);
    const user = await userStore.findByEmail(email);
    if (user) await userStore.setEmailVerified(user.id, Date.now());
    return { token: body.token, id: body.user.id, org: `org_personal_${body.user.id}` };
  };
  const board: Harness["board"] = async (token, name, workspace = createWorkspace(), id) => {
    const { status, body } = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ ...(id ? { id } : {}), name, workspace }),
    });
    expect([200, 201]).toContain(status);
    return body.id as string;
  };
  return {
    base,
    ws: `ws://127.0.0.1:${port}`,
    close,
    boardStore,
    userStore,
    api,
    signup,
    board,
  };
}

let h: Harness | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await h?.close();
  h = undefined;
});

const trustOf = async (boardId: string, nodeId: string) =>
  (await h!.boardStore.get(boardId))?.workspace.nodes[nodeId]?.statement?.trust;

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("trust is stamped by whoever commits", () => {
  it("a person's own statement is human-created; an agent's is a suggestion it can't promote", async () => {
    h = await harness();
    const owner = await h.signup("owner@example.com");
    const id = await h.board(owner.token, "Pricing");

    const mine = await h.api(`/api/boards/${id}/ops`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ ops: suggestion("by-hand") }),
    });
    expect(mine.status).toBe(200);
    expect(await trustOf(id, "by-hand")).toBe("human-created");

    // The MCP client claims more than it may.
    const agent = await h.api(`/api/boards/${id}/ops`, {
      method: "POST",
      token: owner.token,
      mcp: true,
      body: JSON.stringify({ ops: suggestion("from-agent", "human-approved") }),
    });
    expect(agent.status).toBe(200);
    expect(await trustOf(id, "from-agent")).toBe("ai-suggested");
    const log = await h.boardStore.loadLog(id);
    expect(log.at(-1)!.actor).toMatchObject({
      actorType: "ai",
      actorId: "mcp",
      initiatedBy: owner.id,
    });

    await h.api(`/api/boards/${id}/ops`, {
      method: "POST",
      token: owner.token,
      mcp: true,
      body: JSON.stringify({
        ops: [{ op: "UPDATE_STATEMENT", id: "from-agent", trust: "human-approved" }],
      }),
    });
    expect(await trustOf(id, "from-agent")).toBe("ai-suggested");

    // Every agent write is an AI run on record.
    const runs = await h.api(`/api/boards/${id}/ai-runs`, { token: owner.token });
    expect(runs.body.runs[0]).toMatchObject({
      surface: "mcp",
      initiatedBy: owner.id,
      initiatedByName: "owner",
      approvedBy: null,
    });
    expect(runs.body.runs.map((r: { opSeqs: number[] }) => r.opSeqs.length)).toEqual([1, 1]);
  });

  it("an approved meeting extraction stays a suggestion; a reviewed canvas request is the person's", async () => {
    h = await harness();
    const owner = await h.signup("po@example.com");
    const id = await h.board(owner.token, "Meeting board");
    const propose = async (ops: Operation[], meetingId?: string) => {
      const created = await h!.api(`/api/boards/${id}/proposals`, {
        method: "POST",
        token: owner.token,
        body: JSON.stringify({
          operations: ops,
          request: "extract",
          ...(meetingId ? { meetingId } : {}),
        }),
      });
      expect(created.status).toBe(201);
      const approved = await h!.api(
        `/api/boards/${id}/proposals/${created.body.proposal.id}/approve`,
        {
          method: "POST",
          token: owner.token,
        },
      );
      expect(approved.status).toBe(200);
    };
    await propose(suggestion("heard-it", "human-approved"), "mtg_x");
    expect(await trustOf(id, "heard-it")).toBe("ai-suggested");
    await propose(suggestion("asked-for-it"));
    expect(await trustOf(id, "asked-for-it")).toBe("human-approved");
  });
});

describe("the Review center", () => {
  it("lists what waits on a person, and each decision is an ordinary committed op", async () => {
    h = await harness();
    const owner = await h.signup("rev@example.com");
    const viewer = await h.signup("viewer@example.com");
    const stranger = await h.signup("stranger@example.com");
    const id = await h.board(owner.token, "Launch");
    await h.api(`/api/boards/${id}/ops`, {
      method: "POST",
      token: owner.token,
      mcp: true,
      body: JSON.stringify({
        ops: [...suggestion("a"), ...suggestion("b"), ...suggestion("c"), ...suggestion("d")],
      }),
    });
    await h.api(`/api/boards/${id}/proposals`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ operations: suggestion("later"), request: "add a later step" }),
    });
    await h.boardStore.setMember({
      boardId: id,
      userId: viewer.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });

    const queue = await h.api(`/api/orgs/${owner.org}/review`, { token: owner.token });
    expect(queue.status).toBe(200);
    expect(queue.body.counts).toEqual({ statements: 4, proposals: 1, actions: 0, inbound: 0 });
    expect(queue.body.boards[id]).toEqual({ name: "Launch", canDecide: true });
    expect(queue.body.statements[0]).toMatchObject({ boardName: "Launch", trust: "ai-suggested" });
    expect(queue.body.proposals[0]).toMatchObject({
      boardName: "Launch",
      request: "add a later step",
    });

    const decide = (body: object, token = owner.token) =>
      h!.api(`/api/boards/${id}/review`, { method: "POST", token, body: JSON.stringify(body) });
    expect((await decide({ nodeIds: ["a"], action: "approve" })).status).toBe(200);
    expect(await trustOf(id, "a")).toBe("human-approved");
    expect((await decide({ nodeIds: ["b"], action: "edit", label: "Ship on Friday" })).status).toBe(
      200,
    );
    const afterEdit = (await h.boardStore.get(id))!.workspace.nodes.b!;
    expect([afterEdit.label, afterEdit.statement!.trust]).toEqual([
      "Ship on Friday",
      "human-edited",
    ]);
    expect(
      (await decide({ nodeIds: ["c"], action: "assign", assignee: "Ada", dueDate: "2026-10-01" }))
        .status,
    ).toBe(200);
    const assigned = (await h.boardStore.get(id))!.workspace.nodes.c!;
    expect(assigned.issue).toMatchObject({ assignee: "Ada", dueDate: "2026-10-01" });
    expect(assigned.statement!.trust).toBe("human-approved");
    expect((await decide({ nodeIds: ["d"], action: "reject" })).status).toBe(200);
    expect((await h.boardStore.get(id))!.workspace.nodes.d).toBeUndefined();

    const after = await h.api(`/api/orgs/${owner.org}/review`, { token: owner.token });
    expect(after.body.counts.statements).toBe(0);
    // Each decision is logged as the person who made it.
    expect((await h.boardStore.loadLog(id)).at(-1)!.actor).toMatchObject({ actorType: "user" });

    // A viewer sees the board's queue but can't decide; a stranger sees nothing.
    const theirs = await h.api(`/api/orgs/${owner.org}/review`, { token: viewer.token });
    expect(theirs.body.boards[id]).toEqual({ name: "Launch", canDecide: false });
    expect([403, 404]).toContain(
      (await decide({ nodeIds: ["a"], action: "approve" }, viewer.token)).status,
    );
    const none = await h.api(`/api/orgs/${owner.org}/review`, { token: stranger.token });
    expect(none.body.statements).toEqual([]);
  });

  it("refuses what isn't a statement, and edits and assigns one at a time", () => {
    const ws = applyOperations(createWorkspace(), stampAuthorship(suggestion("x"), "u"));
    expect(reviewOps(ws, ["nope"], "approve")).toMatchObject({ ok: false });
    expect(reviewOps(ws, ["x"], "edit", { label: "  " })).toMatchObject({ ok: false });
    expect(reviewOps(ws, ["x"], "assign", {})).toMatchObject({ ok: false });
    expect(reviewOps(ws, ["x"], "approve")).toEqual({
      ok: true,
      ops: [{ op: "UPDATE_STATEMENT", id: "x", trust: "human-approved" }],
    });
  });
});

describe("AI runs", () => {
  async function join(boardId: string, token: string): Promise<WebSocket> {
    const ticket = (await h!.api("/api/realtime/ticket", { method: "POST", token })).body.ticket;
    const socket = new WebSocket(`${h!.ws}/ws?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const welcome = new Promise((resolve) =>
      socket.on("message", (d) => {
        if (JSON.parse(String(d)).type === "welcome") resolve(true);
      }),
    );
    socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
    await welcome;
    return socket;
  }
  const commit = (socket: WebSocket, ops: Operation[], runId?: string) =>
    new Promise<number>((resolve, reject) => {
      const requestId = `req_${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => reject(new Error("no ack")), 4000);
      socket.on("message", (d) => {
        const msg = JSON.parse(String(d));
        if (msg.type === "op-ack" && msg.requestId === requestId) {
          clearTimeout(timer);
          resolve(msg.seq as number);
        }
      });
      socket.send(
        JSON.stringify({ type: "op", requestId, label: "t", ops, ...(runId ? { runId } : {}) }),
      );
    });

  it("a generation is a run; committing its output under it logs AI, asked for and approved by the person", async () => {
    h = await harness();
    const owner = await h.signup("runs@example.com");
    const other = await h.signup("other@example.com");
    const id = await h.board(owner.token, "Runs");

    const generated = await h.api("/api/generate", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        message: "build a checkout flow",
        summary: EMPTY_SUMMARY,
        run: { boardId: id, surface: "canvas" },
      }),
    });
    expect(generated.status).toBe(200);
    const runId = generated.body.runId as string;
    expect(runId).toMatch(/^run_/);

    const socket = await join(id, owner.token);
    const seq = await commit(socket, generated.body.operations, runId);
    const entry = (await h.boardStore.loadLog(id)).find((e) => e.seq === seq)!;
    expect(entry.actor).toMatchObject({
      actorType: "ai",
      initiatedBy: owner.id,
      approvedBy: owner.id,
    });
    const run = await waitFor(async () => {
      const r = (await h!.api(`/api/boards/${id}/ai-runs`, { token: owner.token })).body.runs[0];
      return r?.opSeqs.includes(seq) ? r : undefined;
    });
    expect(run).toMatchObject({ surface: "canvas", provider: "mock", approvedBy: owner.id });

    // Someone else's run can't be borrowed: the batch is logged as theirs.
    const theirs = await h.api("/api/generate", {
      method: "POST",
      token: other.token,
      body: JSON.stringify({ message: "x", summary: EMPTY_SUMMARY, run: { boardId: id } }),
    });
    // …and a run can't even be pinned to a board its requester can't read.
    const orgRuns = await h.api(`/api/orgs/${owner.org}/ai-runs`, { token: owner.token });
    expect(orgRuns.body.runs.some((r: { id: string }) => r.id === theirs.body.runId)).toBe(false);
    const seq2 = await commit(socket, suggestion("mine"), theirs.body.runId);
    const entry2 = (await h.boardStore.loadLog(id)).find((e) => e.seq === seq2)!;
    expect(entry2.actor ?? { actorType: "user" }).toMatchObject({ actorType: "user" });

    // The org's run list is the owner's.
    expect([403, 404]).toContain(
      (await h.api(`/api/orgs/${owner.org}/ai-runs`, { token: other.token })).status,
    );
  });
});

describe("notifications from the index", () => {
  it("work that newly names someone tells them", async () => {
    h = await harness();
    const owner = await h.signup("ada@example.com", "Ada");
    const task = (assignee?: string) =>
      applyOperations(
        createWorkspace(),
        stampAuthorship(
          [
            { op: "CREATE_NODE", id: "rollout", nodeType: "process", label: "Roll out" },
            { op: "SET_STATEMENT", id: "rollout", statement: { kind: "action", status: "open" } },
            {
              op: "SET_ISSUE",
              id: "rollout",
              issue: { type: "task", status: "open", ...(assignee ? { assignee } : {}) },
            },
          ] as Operation[],
          "u",
        ),
      );
    const id = await h.board(owner.token, "Launch", task());
    // The index learns the board first — catching up is not news.
    await h.api(`/api/orgs/${owner.org}/intelligence`, { token: owner.token });
    await h.board(owner.token, "Launch", task("Ada"), id);
    await h.api(`/api/orgs/${owner.org}/intelligence`, { token: owner.token });
    const note = await waitFor(async () => {
      const list = await h!.api("/api/notifications", { token: owner.token });
      return (list.body.notifications as Array<{ kind: string; title: string }> | undefined)?.find(
        (n) => n.kind === "work.assigned",
      );
    });
    expect(note.title).toBe('You own "Roll out"');
  });
});
