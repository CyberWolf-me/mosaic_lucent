import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
import { answerConfidence } from "../src/confidence.js";
import { parseThreadScope } from "../src/threads.js";

/**
 * Ask everywhere (docs/26 A4, ADR 0048): Search and Ask read a scope — a
 * board, a meeting, a project, the workspace, a time range — resolved through
 * what the caller can open; every answer says how well it is supported; a
 * conversation is its author's thread on a scope.
 */

const SECRET = "test-secret-at-least-16-chars";

const board = (ops: Operation[]): Workspace =>
  applyOperations(createWorkspace(), stampAuthorship(ops, "u"));
const statement = (
  id: string,
  label: string,
  kind = "decision",
  status = "resolved",
): Operation[] => [
  { op: "CREATE_NODE", id, nodeType: "process", label },
  { op: "SET_STATEMENT", id, statement: { kind, status } } as Operation,
];

interface Harness {
  close: () => Promise<void>;
  meetings: InMemoryMeetingStore;
  boards: InMemoryBoardStore;
  api: (
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string) => Promise<{ token: string; id: string; org: string }>;
  save: (token: string, name: string, workspace: Workspace) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const meetings = new InMemoryMeetingStore();
  const boards = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: boards,
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetings,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api: Harness["api"] = async (path, init = {}) => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (rest.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const signup: Harness["signup"] = async (email) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(status).toBe(201);
    return { token: body.token, id: body.user.id, org: `org_personal_${body.user.id}` };
  };
  const save: Harness["save"] = async (token, name, workspace) => {
    const { status, body } = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name, workspace }),
    });
    expect(status).toBe(201);
    return body.id as string;
  };
  return { close, meetings, boards, api, signup, save };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("answerConfidence", () => {
  it("is computed from the evidence that survived, never asked of the model", () => {
    expect(answerConfidence([]).level).toBe("none");
    expect(answerConfidence([{ kind: "node", key: "a", label: "A" }]).level).toBe("low");
    expect(
      answerConfidence([
        { kind: "node", key: "a", label: "A" },
        { kind: "node", key: "b", label: "B" },
      ]),
    ).toMatchObject({ level: "medium", reason: "2 sources, all of one kind." });
    expect(
      answerConfidence([
        { kind: "node", key: "a", label: "A" },
        { kind: "node", key: "a", label: "A" }, // the same evidence twice is one source
        { kind: "node", key: "b", label: "B" },
        { kind: "meeting", key: "m", label: "Kickoff" },
      ]),
    ).toMatchObject({ level: "high", sources: 3, kinds: 2 });
    const moved = answerConfidence([
      { kind: "node", key: "a", label: "Use MySQL", statementStatus: "superseded" },
      { kind: "node", key: "b", label: "B" },
      { kind: "meeting", key: "m", label: "M" },
    ]);
    expect(moved).toMatchObject({ level: "low", superseded: ["Use MySQL"] });
  });
});

describe("workspace search", () => {
  it("finds a statement, a spoken line, a comment and a board across boards, each where it lives", async () => {
    h = await harness();
    const owner = await h.signup("s@example.com");
    const pricing = await h.save(
      owner.token,
      "Pricing",
      board(statement("pg", "Use Postgres for billing")),
    );
    const infra = await h.save(owner.token, "Infra", board([]));
    await h.meetings.insert({
      boardId: infra,
      orgId: owner.org,
      startedAt: Date.UTC(2026, 8, 20),
      turns: [
        { speaker: "Ada", at: Date.UTC(2026, 8, 20, 10), text: "Postgres failover worries me" },
      ],
      createdBy: owner.id,
      createdAt: 1,
      title: "Database review",
    });
    const withComment = board(statement("n", "Cache layer"));
    withComment.comments.c1 = {
      id: "c1",
      targetId: "n",
      body: "Why not Postgres here?",
      by: owner.id,
      createdAt: Date.UTC(2026, 8, 21),
    };
    await h.save(owner.token, "Postgres notes", withComment);

    const all = await h.api(`/api/orgs/${owner.org}/search?q=postgres`, { token: owner.token });
    expect(all.status).toBe(200);
    const kinds = all.body.results.map(
      (r: { kind: string; boardName: string }) => `${r.kind}@${r.boardName}`,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "node@Pricing",
        "turn@Infra",
        "comment@Postgres notes",
        "board@Postgres notes",
      ]),
    );
    const turn = all.body.results.find((r: { kind: string }) => r.kind === "turn");
    expect(turn).toMatchObject({ meetingTitle: "Database review", speaker: "Ada", turnIndex: 0 });

    // A board scope, and a time range that leaves only what was said then.
    const one = await h.api(`/api/orgs/${owner.org}/search?q=postgres&board=${pricing}`, {
      token: owner.token,
    });
    expect(one.body.results.map((r: { kind: string }) => r.kind)).toEqual(["node"]);
    const week = await h.api(
      `/api/orgs/${owner.org}/search?q=postgres&since=2026-09-20&until=2026-09-20T23:59:59Z`,
      { token: owner.token },
    );
    expect(week.body.results.map((r: { kind: string }) => r.kind)).toEqual(["turn"]);

    // Nothing reaches someone who can't open the boards.
    const stranger = await h.signup("x@example.com");
    const theirs = await h.api(`/api/orgs/${owner.org}/search?q=postgres`, {
      token: stranger.token,
    });
    expect(theirs.body.results).toEqual([]);
    expect(
      (
        await h.api(`/api/orgs/${owner.org}/search?q=postgres&board=${infra}`, {
          token: stranger.token,
        })
      ).status,
    ).toBe(404);
  });
});

describe("Ask", () => {
  it("a scoped answer cites across boards, qualified by board, with its confidence", async () => {
    h = await harness();
    const owner = await h.signup("a@example.com");
    const pricing = await h.save(
      owner.token,
      "Pricing",
      board(statement("annual", "Offer annual plans")),
    );
    await h.save(owner.token, "Other", board(statement("x", "Unrelated")));
    const asked = await h.api(`/api/orgs/${owner.org}/ask`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        question: "What did we decide about plans?",
        scope: { board: pricing },
      }),
    });
    expect(asked.status).toBe(200);
    expect(asked.body.scope).toMatchObject({ label: "the board “Pricing”", boards: 1 });
    expect(asked.body.citations[0]).toMatchObject({
      kind: "node",
      id: "annual",
      boardId: pricing,
      boardName: "Pricing",
    });
    expect(asked.body.confidence).toMatchObject({ level: "low", sources: 1 });

    const missing = await h.api(`/api/orgs/${owner.org}/ask`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ question: "q", scope: { project: "prj_nope" } }),
    });
    expect(missing.status).toBe(404);
  });

  it("board answers carry confidence, and a board in this browser can be asked too", async () => {
    h = await harness();
    const owner = await h.signup("b@example.com");
    const id = await h.save(owner.token, "Board", board(statement("d", "Decided thing")));
    const onBoard = await h.api(`/api/boards/${id}/ask`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ question: "what was decided?" }),
    });
    expect(onBoard.body.confidence.level).toBeDefined();

    const local = await h.api("/api/ask/local", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        question: "what is here?",
        name: "My sketch",
        workspace: board(statement("local-node", "Local decision")),
      }),
    });
    expect(local.status).toBe(200);
    expect(local.body.citations[0]).toMatchObject({ kind: "node", id: "local-node" });
    expect(local.body.confidence.level).toBe("low");
    const malformed = await h.api("/api/ask/local", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ question: "q", workspace: "nope" }),
    });
    expect(malformed.status).toBe(400);
  });
});

describe("threads", () => {
  it("a person's conversation on a scope, kept on the server, and theirs alone", async () => {
    h = await harness();
    const owner = await h.signup("t@example.com");
    const viewer = await h.signup("v@example.com");
    const stranger = await h.signup("z@example.com");
    const id = await h.save(owner.token, "Board", board([]));
    await h.boards.setMember({
      boardId: id,
      userId: viewer.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });
    const scope = `board:${id}`;

    const wrote = await h.api("/api/threads", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        scope,
        messages: [
          { role: "user", text: "Which database?", surface: "voice" },
          {
            role: "ai",
            text: "Postgres, decided Tuesday.",
            reply: "Postgres.",
            citations: [{ kind: "node", id: "pg" }],
          },
        ],
      }),
    });
    expect(wrote.status).toBe(201);
    const read = await h.api(`/api/threads?scope=${encodeURIComponent(scope)}`, {
      token: owner.token,
    });
    expect(
      read.body.messages.map((m: { role: string; surface: string }) => [m.role, m.surface]),
    ).toEqual([
      ["user", "voice"],
      ["ai", "chat"],
    ]);
    expect(read.body.messages[1]).toMatchObject({
      reply: "Postgres.",
      citations: [{ kind: "node", id: "pg" }],
    });

    // A viewer on the same board has their own thread — empty.
    const theirs = await h.api(`/api/threads?scope=${encodeURIComponent(scope)}`, {
      token: viewer.token,
    });
    expect(theirs.body.messages).toEqual([]);
    // Someone who can't open the board can't converse there.
    expect(
      (await h.api(`/api/threads?scope=${encodeURIComponent(scope)}`, { token: stranger.token }))
        .status,
    ).toBe(404);
    expect(
      (
        await h.api(`/api/threads?scope=${encodeURIComponent(`meeting:${id}:mtg_nope`)}`, {
          token: owner.token,
        })
      ).status,
    ).toBe(404);

    await h.api(`/api/threads?scope=${encodeURIComponent(scope)}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(
      (await h.api(`/api/threads?scope=${encodeURIComponent(scope)}`, { token: owner.token })).body
        .messages,
    ).toEqual([]);
  });

  it("scopes are named exactly", () => {
    expect(parseThreadScope("board:brd_1")).toMatchObject({ type: "board", boardId: "brd_1" });
    expect(parseThreadScope("meeting:brd_1:mtg_2")).toMatchObject({ meetingId: "mtg_2" });
    expect(parseThreadScope("workspace:org_1")).toMatchObject({ orgId: "org_1" });
    expect(parseThreadScope("board:brd 1")).toBeNull();
    expect(parseThreadScope("room:x")).toBeNull();
    expect(parseThreadScope("meeting:brd_1")).toBeNull();
  });
});
