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
import { InMemoryBoardStore, type StoredBoard } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryStatementIndexStore, StatementIndexer } from "../src/statementIndex.js";
import { validateProjectInput } from "../src/projects.js";

/**
 * The workspace spine (docs/26 A1, ADR 0046): projects that link boards and
 * grant nothing, and one intelligence index across every board a caller can
 * read. The HTTP matrix pins the one rule both share — nothing reaches a
 * caller that opening the board wouldn't have shown them.
 */

const SECRET = "test-secret-at-least-16-chars";

function statements(ops: Operation[]): Workspace {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "test-user"));
}

function statement(id: string, kind: string, status = "open"): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "process", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind, status } } as Operation,
  ];
}

function task(id: string, fields: { status?: string; assignee?: string } = {}): Operation[] {
  return [
    ...statement(id, "action"),
    {
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: fields.status ?? "open",
        ...(fields.assignee ? { assignee: fields.assignee } : {}),
      },
    } as Operation,
  ];
}

interface Harness {
  close: () => Promise<void>;
  boardStore: InMemoryBoardStore;
  api: (
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string, name?: string) => Promise<{ token: string; id: string; org: string }>;
  board: (token: string, name: string, workspace: Workspace, id?: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const boardStore = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore,
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetings: new InMemoryMeetingStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api: Harness["api"] = async (path, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const signup: Harness["signup"] = async (email, name) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: name ?? email.split("@")[0] }),
    });
    expect(status).toBe(201);
    const id = body.user.id as string;
    return { token: body.token as string, id, org: `org_personal_${id}` };
  };
  const board: Harness["board"] = async (token, name, workspace, id) => {
    const { status, body } = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ ...(id ? { id } : {}), name, workspace }),
    });
    expect([200, 201]).toContain(status);
    return body.id as string;
  };
  return { close, boardStore, api, signup, board };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("the intelligence index, across boards", () => {
  it("answers every statement on the boards the caller can read, with counts and board names", async () => {
    h = await harness();
    const owner = await h.signup("ada@example.com", "Ada");
    await h.board(
      owner.token,
      "Pricing",
      statements([
        ...statement("ship-friday", "decision", "resolved"),
        ...statement("grandfather-customers", "question"),
      ]),
    );
    await h.board(
      owner.token,
      "Launch",
      statements([
        ...task("write-announcement", { assignee: "Ada" }),
        ...statement("churn", "risk"),
      ]),
    );

    const all = await h.api(`/api/orgs/${owner.org}/intelligence`, { token: owner.token });
    expect(all.status).toBe(200);
    expect(all.body.boards).toBe(2);
    expect(all.body.total).toBe(4);
    expect(all.body.counts.question).toEqual({ total: 1, open: 1 });
    expect(all.body.counts.decision).toEqual({ total: 1, open: 0 });
    const question = all.body.statements.find(
      (s: { id: string }) => s.id === "grandfather-customers",
    );
    expect(question).toMatchObject({ kind: "question", status: "open", boardName: "Pricing" });

    const open = await h.api(`/api/orgs/${owner.org}/intelligence?kind=question,risk&status=open`, {
      token: owner.token,
    });
    expect(open.body.statements.map((s: { id: string }) => s.id).sort()).toEqual([
      "churn",
      "grandfather-customers",
    ]);
    // Counts cover the whole scope, not just the filtered list.
    expect(open.body.counts.action.total).toBe(1);

    const mine = await h.api(`/api/orgs/${owner.org}/intelligence?assignee=me`, {
      token: owner.token,
    });
    expect(mine.body.statements.map((s: { id: string }) => s.id)).toEqual(["write-announcement"]);

    expect(
      (await h.api(`/api/orgs/${owner.org}/intelligence?kind=vibe`, { token: owner.token })).status,
    ).toBe(400);
  });

  it("follows the board: a saved change is what the next read shows", async () => {
    h = await harness();
    const owner = await h.signup("grace@example.com");
    const id = await h.board(owner.token, "Plan", statements(statement("which-db", "question")));
    const before = await h.api(`/api/orgs/${owner.org}/intelligence`, { token: owner.token });
    expect(before.body.statements[0]).toMatchObject({ id: "which-db", status: "open" });

    await h.board(
      owner.token,
      "Plan",
      statements([
        ...statement("which-db", "question", "resolved"),
        ...statement("use-postgres", "decision"),
      ]),
      id,
    );
    const after = await h.api(`/api/orgs/${owner.org}/intelligence`, { token: owner.token });
    expect(
      after.body.statements.map((s: { id: string; status: string }) => [s.id, s.status]),
    ).toEqual([
      ["which-db", "resolved"],
      ["use-postgres", "open"],
    ]);
  });

  it("an outside collaborator sees only shared boards; a stranger sees nothing", async () => {
    h = await harness();
    const owner = await h.signup("owner@example.com");
    const guest = await h.signup("guest@example.com");
    const stranger = await h.signup("stranger@example.com");
    const shared = await h.board(
      owner.token,
      "Shared",
      statements(statement("open-q", "question")),
    );
    await h.board(owner.token, "Private", statements(statement("secret-decision", "decision")));
    await h.boardStore.setMember({
      boardId: shared,
      userId: guest.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });

    const theirs = await h.api(`/api/orgs/${owner.org}/intelligence`, { token: guest.token });
    expect(theirs.body.statements.map((s: { id: string }) => s.id)).toEqual(["open-q"]);
    expect(theirs.body.counts.decision.total).toBe(0);

    const nothing = await h.api(`/api/orgs/${owner.org}/intelligence`, { token: stranger.token });
    expect(nothing.body.statements).toEqual([]);
    expect((await h.api(`/api/orgs/${owner.org}/intelligence`)).status).toBe(401);
  });

  it("only the owner rebuilds it", async () => {
    h = await harness();
    const owner = await h.signup("rebuild@example.com");
    const other = await h.signup("other@example.com");
    await h.board(owner.token, "B", statements(statement("q", "question")));
    const ok = await h.api(`/api/orgs/${owner.org}/intelligence/rebuild`, {
      method: "POST",
      token: owner.token,
    });
    expect(ok).toMatchObject({ status: 200, body: { boards: 1 } });
    const refused = await h.api(`/api/orgs/${owner.org}/intelligence/rebuild`, {
      method: "POST",
      token: other.token,
    });
    expect([403, 404]).toContain(refused.status);
  });
});

describe("projects", () => {
  it("gather boards, and through them meetings and statements", async () => {
    h = await harness();
    const owner = await h.signup("lead@example.com");
    const pricing = await h.board(
      owner.token,
      "Pricing",
      statements([
        ...statement("which-tier", "question"),
        ...task("blocked-work", { status: "blocked" }),
      ]),
    );
    const unrelated = await h.board(
      owner.token,
      "Unrelated",
      statements(statement("other-q", "question")),
    );

    const created = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({
        name: "Q4 pricing",
        objective: "Ship annual plans",
        boardIds: [pricing],
      }),
    });
    expect(created.status).toBe(201);
    const pid = created.body.id as string;
    expect(created.body).toMatchObject({
      name: "Q4 pricing",
      status: "active",
      leadId: owner.id,
      members: [owner.id],
      boards: [{ id: pricing, name: "Pricing" }],
    });

    const list = await h.api(`/api/orgs/${owner.org}/projects`, { token: owner.token });
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].stats).toEqual({
      openQuestions: 1,
      openActions: 1,
      blocked: 1,
      decisions: 0,
      openRisks: 0,
    });

    const page = await h.api(`/api/orgs/${owner.org}/projects/${pid}`, { token: owner.token });
    expect(page.status).toBe(200);
    // Only the project's boards: the unrelated board's question isn't here.
    expect(page.body.statements.map((s: { id: string }) => s.id).sort()).toEqual([
      "blocked-work",
      "which-tier",
    ]);
    expect(page.body.meetings).toEqual([]);

    const linked = await h.api(`/api/orgs/${owner.org}/projects/${pid}/boards/${unrelated}`, {
      method: "PUT",
      token: owner.token,
    });
    expect(linked.body.boards.map((b: { id: string }) => b.id)).toEqual([pricing, unrelated]);
    const onBoard = await h.api(`/api/boards/${unrelated}/projects`, { token: owner.token });
    expect(onBoard.body.projects).toEqual([{ id: pid, name: "Q4 pricing", status: "active" }]);
    const unlinked = await h.api(`/api/orgs/${owner.org}/projects/${pid}/boards/${unrelated}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(unlinked.body.boards.map((b: { id: string }) => b.id)).toEqual([pricing]);

    const edited = await h.api(`/api/orgs/${owner.org}/projects/${pid}`, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ status: "paused", objective: "Annual plans, later" }),
    });
    expect(edited.body).toMatchObject({ status: "paused", objective: "Annual plans, later" });

    await h.api(`/api/orgs/${owner.org}/projects/${pid}`, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ archived: true }),
    });
    expect(
      (await h.api(`/api/orgs/${owner.org}/projects`, { token: owner.token })).body.projects,
    ).toEqual([]);
    const archived = await h.api(`/api/orgs/${owner.org}/projects?archived=1`, {
      token: owner.token,
    });
    expect(archived.body.projects[0].archivedAt).toBeTypeOf("number");
  });

  it("grant nothing: a collaborator sees the project only through boards shared with them", async () => {
    h = await harness();
    const owner = await h.signup("po@example.com");
    const guest = await h.signup("pg@example.com");
    const shared = await h.board(
      owner.token,
      "Shared",
      statements(statement("shared-q", "question")),
    );
    const hidden = await h.board(
      owner.token,
      "Hidden",
      statements(statement("hidden-q", "question")),
    );
    const withShared = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Visible", boardIds: [shared, hidden] }),
    });
    const onlyHidden = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Invisible", boardIds: [hidden] }),
    });
    await h.boardStore.setMember({
      boardId: shared,
      userId: guest.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });

    const list = await h.api(`/api/orgs/${owner.org}/projects`, { token: guest.token });
    expect(list.body.projects.map((p: { name: string }) => p.name)).toEqual(["Visible"]);
    expect(list.body.projects[0].boards.map((b: { id: string }) => b.id)).toEqual([shared]);

    const page = await h.api(`/api/orgs/${owner.org}/projects/${withShared.body.id}`, {
      token: guest.token,
    });
    expect(page.body.statements.map((s: { id: string }) => s.id)).toEqual(["shared-q"]);
    expect(
      (await h.api(`/api/orgs/${owner.org}/projects/${onlyHidden.body.id}`, { token: guest.token }))
        .status,
    ).toBe(404);
    expect(
      (
        await h.api(`/api/orgs/${owner.org}/intelligence?project=${onlyHidden.body.id}`, {
          token: guest.token,
        })
      ).status,
    ).toBe(404);

    // A board viewer can't create or edit projects in someone else's org.
    const create = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: guest.token,
      body: JSON.stringify({ name: "Mine now" }),
    });
    expect([403, 404]).toContain(create.status);
  });

  it("refuses boards from another workspace and people outside it", async () => {
    h = await harness();
    const owner = await h.signup("a@example.com");
    const other = await h.signup("b@example.com");
    const theirs = await h.board(other.token, "Theirs", createWorkspace());
    const foreignBoard = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "P", boardIds: [theirs] }),
    });
    expect(foreignBoard.status).toBe(400);
    const foreignMember = await h.api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "P", members: [other.id] }),
    });
    expect(foreignMember).toMatchObject({
      status: 400,
      body: { error: /members of this workspace/ },
    });
  });
});

describe("validateProjectInput", () => {
  it("needs a name to create and refuses unknown fields", () => {
    expect(validateProjectInput({}, "create").ok).toBe(false);
    expect(validateProjectInput({ name: "  " }, "create").ok).toBe(false);
    expect(validateProjectInput({ name: "x", colour: "red" }, "create")).toMatchObject({
      ok: false,
      error: 'unknown field "colour"',
    });
    expect(validateProjectInput({ status: "someday" }, "update").ok).toBe(false);
    expect(validateProjectInput({ boardIds: ["b"] }, "update").ok).toBe(false);
    expect(validateProjectInput({ name: " Launch ", status: "done" }, "create")).toEqual({
      ok: true,
      value: { name: "Launch", status: "done" },
    });
  });
});

describe("StatementIndexer", () => {
  function stored(id: string, workspace: Workspace, updatedAt: number): StoredBoard {
    return {
      id,
      orgId: "org_1",
      ownerId: "usr_1",
      name: id,
      workspace,
      createdAt: 1,
      updatedAt,
    } as StoredBoard;
  }

  it("re-derives a board after a put, and forgets it when it's deleted", async () => {
    const store = new InMemoryStatementIndexStore();
    const indexer = new StatementIndexer(store, { debounceMs: 5 });
    const boards = indexer.observe(new InMemoryBoardStore());
    await boards.put(stored("brd_a", statements(statement("q", "question")), 10));
    await indexer.flush();
    expect((await store.query(["brd_a"])).map((r) => r.id)).toEqual(["q"]);
    await boards.delete("brd_a");
    expect(await store.query(["brd_a"])).toEqual([]);
    expect((await store.sourcesFor(["brd_a"])).size).toBe(0);
  });

  it("repairs on read: a board newer than its rows is re-derived, within a budget", async () => {
    const store = new InMemoryStatementIndexStore();
    const indexer = new StatementIndexer(store);
    const a = stored("brd_a", statements(statement("q1", "question")), 10);
    const b = stored("brd_b", statements(statement("q2", "question")), 10);
    expect(await indexer.freshen([a, b], 1)).toEqual({ reindexed: 1, stale: 1 });
    expect(await indexer.freshen([a, b], 1)).toEqual({ reindexed: 1, stale: 0 });
    expect(await indexer.freshen([a, b])).toEqual({ reindexed: 0, stale: 0 });
    const newer = stored("brd_a", statements(statement("q1", "question", "resolved")), 20);
    expect(await indexer.freshen([newer, b])).toEqual({ reindexed: 1, stale: 0 });
    expect((await store.query(["brd_a"]))[0]!.status).toBe("resolved");
  });
});
