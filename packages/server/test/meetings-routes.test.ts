import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore, validateTurns } from "../src/meetings.js";
import { MockMeetingSource } from "../src/meetingConnectors.js";

/**
 * Board meeting routes (E3 / R3): save/list/read a board's diarised
 * transcripts.
 *
 * The turn-validation rules are pinned directly (cheap, precise), and the
 * HTTP matrix proves the guards: editor to save, viewer to read, stranger
 * and anonymous refused, board tenancy on the single-meeting fetch — a
 * meeting id leaked from one board must not read on another.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  close: () => Promise<void>;
  boardStore: InMemoryBoardStore;
  api: (
    path: string,
    init: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string) => Promise<{ token: string; id: string }>;
  seedBoard: (token: string, name?: string) => Promise<string>;
}

async function harness(
  connectors?: import("../src/meetingConnectors.js").MeetingConnectorRegistry,
): Promise<Harness> {
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
    ...(connectors ? { meetingConnectors: connectors } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (path, init) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const signup = async (email: string) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(status).toBe(201);
    return { token: body.token as string, id: body.user.id as string };
  };

  const seedBoard = async (token: string, name = "Meeting board") => {
    const { status, body } = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name, workspace: createWorkspace() }),
    });
    expect(status).toBe(201);
    return body.id as string;
  };

  return { base, close, boardStore, api, signup, seedBoard };
}

const TURNS = [
  { speaker: "Ada", at: 1_000, text: "Checkout drops half the carts." },
  { speaker: "Grace", at: 5_000, text: "The Stripe redirect is slow.", kind: "problem" },
  { speaker: "Ada", at: 9_000, text: "We'll add a wallet option.", kind: "decision" },
];

describe("validateTurns", () => {
  it("accepts and trims a well-formed transcript", () => {
    const res = validateTurns([{ speaker: "  Ada  ", at: 1, text: "  hi  ", kind: "action" }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const turn = res.turns[0]!;
      expect(turn.speaker).toBe("Ada");
      expect(turn.text).toBe("hi");
      expect(turn.kind).toBe("action");
    }
  });

  it("rejects each way the shape can be wrong", () => {
    expect(validateTurns("nope").ok).toBe(false);
    expect(validateTurns([]).ok).toBe(false);
    expect(validateTurns([{ at: 1, text: "x" }] as never).ok).toBe(false);
    expect(validateTurns([{ speaker: "A", text: "x" }] as never).ok).toBe(false);
    expect(validateTurns([{ speaker: "A", at: -1, text: "x" }]).ok).toBe(false);
    expect(validateTurns([{ speaker: "A", at: 1, text: "  " }]).ok).toBe(false);
    expect(validateTurns([{ speaker: "A", at: 1, text: "x", kind: "vibe" }]).ok).toBe(false);
  });
});

describe("board meetings routes (E3/R3)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("saves a transcript, lists it, and reads it back", async () => {
    h = await harness();
    const owner = await h.signup("owner@example.com");
    const boardId = await h.seedBoard(owner.token);

    const saved = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS, startedAt: 500, endedAt: 10_000 }),
    });
    expect(saved.status).toBe(201);
    expect(saved.body.turns).toHaveLength(3);
    const mid = saved.body.id as string;

    const list = await h.api(`/api/boards/${boardId}/meetings`, { token: owner.token });
    expect(list.status).toBe(200);
    expect(list.body.meetings).toHaveLength(1);
    expect(list.body.meetings[0].id).toBe(mid);

    const one = await h.api(`/api/boards/${boardId}/meetings/${mid}`, { token: owner.token });
    expect(one.status).toBe(200);
    expect(one.body.turns[1].kind).toBe("problem");
  });

  it("refuses a save with a bad turn shape", async () => {
    h = await harness();
    const owner = await h.signup("owner2@example.com");
    const boardId = await h.seedBoard(owner.token);
    const res = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: [{ speaker: "", at: 1, text: "x" }] }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/speaker/);
  });

  it("records the capture profile on save; a typo is a named 400, never a fifth mode", async () => {
    // docs/24 Phase D: the transcript carries how it was captured.
    h = await harness();
    const owner = await h.signup("owner-mode@example.com");
    const boardId = await h.seedBoard(owner.token);
    const recorded = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS, mode: "record" }),
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body.mode).toBe("record");
    const one = await h.api(`/api/boards/${boardId}/meetings/${recorded.body.id as string}`, {
      token: owner.token,
    });
    expect(one.body.mode).toBe("record");
    // Pre-profile saves carry no mode — absence, not a value.
    const plain = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS }),
    });
    expect(plain.status).toBe(201);
    expect(plain.body.mode).toBeUndefined();
    const bad = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS, mode: "transcribe" }),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/mode must be one of/);
  });

  it("a viewer may read but not save", async () => {
    h = await harness();
    const owner = await h.signup("a@example.com");
    const viewer = await h.signup("b@example.com");
    const boardId = await h.seedBoard(owner.token);
    const boardStore = h.boardStore;
    const saved = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS }),
    });
    expect(saved.status).toBe(201);

    const list = await h.api(`/api/boards/${boardId}/meetings`, { token: viewer.token });
    // Viewer has no membership at all → 404 masking. Grant the seat, then read.
    expect(list.status).toBe(404);
    await boardStore.setMember({
      boardId,
      userId: viewer.id,
      role: "viewer",
      invitedBy: owner.id,
      createdAt: Date.now(),
    });
    const listAfter = await h.api(`/api/boards/${boardId}/meetings`, { token: viewer.token });
    expect(listAfter.status).toBe(200);

    const write = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ turns: TURNS }),
    });
    expect(write.status).toBe(404);
  });

  it("a meeting id from one board does not read on another", async () => {
    h = await harness();
    const owner = await h.signup("c@example.com");
    const b1 = await h.seedBoard(owner.token, "one");
    const b2 = await h.seedBoard(owner.token, "two");
    const saved = await h.api(`/api/boards/${b1}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS }),
    });
    expect(saved.status).toBe(201);
    const mid = saved.body.id as string;

    const cross = await h.api(`/api/boards/${b2}/meetings/${mid}`, { token: owner.token });
    expect(cross.status).toBe(404);
    const own = await h.api(`/api/boards/${b1}/meetings/${mid}`, { token: owner.token });
    expect(own.status).toBe(200);
  });

  it("503s when the store is absent, after the guard (no board oracle)", async () => {
    h = await harness();
    const stranger = await h.signup("d@example.com");
    const missing = await h.api(`/api/boards/brd_missing/meetings`, {
      token: stranger.token,
    });
    expect(missing.status).toBe(404);
  });

  it("401 anonymous", async () => {
    h = await harness();
    const owner = await h.signup("e@example.com");
    const boardId = await h.seedBoard(owner.token);
    const res = await h.api(`/api/boards/${boardId}/meetings`, {});
    expect(res.status).toBe(401);
  });
});

describe("checkpoint append (M2)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });
  it("appends turns to a running meeting and reads the extended transcript back", async () => {
    h = await harness();
    const owner = await h.signup("append1@example.com");
    const boardId = await h.seedBoard(owner.token);
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    expect(opened.status).toBe(201);
    const mid = opened.body.id as string;

    const appended = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(1) }),
    });
    expect(appended.status).toBe(200);
    expect(appended.body.turns).toHaveLength(3);

    const one = await h.api(`/api/boards/${boardId}/meetings/${mid}`, { token: owner.token });
    expect(one.status).toBe(200);
    expect(one.body.turns).toHaveLength(3);
    expect(one.body.turns[2].kind).toBe("decision");
  });

  it("refuses to append to an ended meeting — minutes are immutable", async () => {
    h = await harness();
    const owner = await h.signup("append2@example.com");
    const boardId = await h.seedBoard(owner.token);
    const saved = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS, startedAt: 500, endedAt: 10_000 }),
    });
    const mid = saved.body.id as string;
    const res = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: [{ speaker: "Ada", at: 20_000, text: "late" }] }),
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ended/);
  });

  it("append is board-scoped and anonymous-refused", async () => {
    h = await harness();
    const owner = await h.signup("append3@example.com");
    const other = await h.signup("append4@example.com");
    const boardId = await h.seedBoard(owner.token);
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    const mid = opened.body.id as string;

    const stranger = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: other.token,
      body: JSON.stringify({ turns: [{ speaker: "X", at: 1, text: "x" }] }),
    });
    expect(stranger.status).toBe(404);

    const anon = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      body: JSON.stringify({ turns: [{ speaker: "X", at: 1, text: "x" }] }),
    });
    expect(anon.status).toBe(401);
  });

  it("validateTurns still applies to appends — a bad turn is a 400", async () => {
    h = await harness();
    const owner = await h.signup("append5@example.com");
    const boardId = await h.seedBoard(owner.token);
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    const mid = opened.body.id as string;
    const res = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: [{ speaker: "", at: 1, text: "x" }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("ending a live capture (Stage C3)", () => {
  let h: Harness;
  // stopRecording used to abandon the id — the store said "in progress"
  // forever. The end route gives live captures real boundaries, idempotently.
  it("ends an open meeting, and a second end is the same row, not a second effect", async () => {
    h = await harness();
    const owner = await h.signup("end1@example.com");
    const boardId = await h.seedBoard(owner.token);
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    const mid = opened.body.id as string;

    const ended = await h.api(`/api/boards/${boardId}/meetings/${mid}/end`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ endedAt: 60_000 }),
    });
    expect(ended.status).toBe(200);
    expect(ended.body.endedAt).toBe(60_000);

    // Idempotent: re-end returns the SAME row (still the first endedAt).
    const again = await h.api(`/api/boards/${boardId}/meetings/${mid}/end`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ endedAt: 120_000 }),
    });
    expect(again.status).toBe(200);
    expect(again.body.endedAt).toBe(60_000);

    // And the boundary holds on read.
    const read = await h.api(`/api/boards/${boardId}/meetings/${mid}`, { token: owner.token });
    expect(read.body.endedAt).toBe(60_000);

    // An ended meeting refuses appends, as before.
    const appended = await h.api(`/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: [{ speaker: "X", at: 2, text: "late" }] }),
    });
    expect(appended.status).toBe(404);
  });

  it("refuses an end before the meeting's start", async () => {
    h = await harness();
    const owner = await h.signup("end2@example.com");
    const boardId = await h.seedBoard(owner.token);
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    const mid = opened.body.id as string;
    const res = await h.api(`/api/boards/${boardId}/meetings/${mid}/end`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ endedAt: 500 }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("predate");
  });

  it("viewer floor: ending is a write about the record", async () => {
    h = await harness();
    const owner = await h.signup("end3@example.com");
    const viewer = await h.signup("end3v@example.com");
    const boardId = await h.seedBoard(owner.token);
    const share = await h.api(`/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await h.api(`/api/boards/${boardId}/join`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ token: share.body.token }),
    });
    const opened = await h.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ turns: TURNS.slice(0, 1), startedAt: 1_000 }),
    });
    const res = await h.api(`/api/boards/${opened.body.id}/meetings/${opened.body.id}/end`, {
      method: "POST",
      token: viewer.token,
    });
    // The path is malformed on purpose: a viewer must not learn whether the
    // meeting id exists — the guard answers 404 the same as a stranger.
    expect([403, 404]).toContain(res.status);
  });
});

describe("external import (docs/24 Phase E)", () => {
  let h: Awaited<ReturnType<typeof harness>> | null = null;

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const scripted = () =>
    harness({
      sources: new Map([
        [
          "mock",
          new MockMeetingSource({
            good: { turns: TURNS, title: "Weekly sync" },
            dirty: { turns: [{ speaker: "", at: 1, text: "x" }] },
          }),
        ],
      ]),
    });

  async function importBody(
    hh: NonNullable<typeof h>,
    boardId: string,
    token: string,
    body: unknown,
  ) {
    return hh.api(`/api/boards/${boardId}/meetings/import`, {
      method: "POST",
      token,
      body: JSON.stringify(body),
    });
  }

  it("lands external turns as a transcript, attributed and readable like a native one", async () => {
    h = await scripted();
    const owner = await h.signup("import@example.com");
    const boardId = await h.seedBoard(owner.token);
    const res = await importBody(h, boardId, owner.token, {
      source: "mock",
      ref: { id: "good" },
    });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("mock");
    expect(res.body.turns).toHaveLength(3);
    expect(res.body.turns[0].speaker).toBe("Ada");
    // No capture profile: imported, not recorded under one.
    expect(res.body.mode).toBeUndefined();
    const one = await h.api(`/api/boards/${boardId}/meetings/${res.body.id as string}`, {
      token: owner.token,
    });
    expect(one.body.turns[1].kind).toBe("problem");
  });

  it("unknown sources, bad refs, source failures, and dirty turns are refused loudly", async () => {
    h = await scripted();
    const owner = await h.signup("import-bad@example.com");
    const boardId = await h.seedBoard(owner.token);
    const unknown = await importBody(h, boardId, owner.token, {
      source: "zoom",
      ref: { id: "good" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain("unknown meeting source");
    const badRef = await importBody(h, boardId, owner.token, { source: "mock", ref: {} });
    expect(badRef.status).toBe(400);
    const missing = await importBody(h, boardId, owner.token, {
      source: "mock",
      ref: { id: "nope" },
    });
    expect(missing.status).toBe(502);
    const dirty = await importBody(h, boardId, owner.token, {
      source: "mock",
      ref: { id: "dirty" },
    });
    expect(dirty.status).toBe(502);
    expect(dirty.body.error).toContain("unusable turns");
  });

  it("a viewer cannot import (editor floor — minutes record what was said)", async () => {
    h = await scripted();
    const owner = await h.signup("import-owner@example.com");
    const stranger = await h.signup("import-stranger@example.com");
    const boardId = await h.seedBoard(owner.token);
    const res = await importBody(h, boardId, stranger.token, {
      source: "mock",
      ref: { id: "good" },
    });
    expect(res.status).toBe(404);
  });
});

/**
 * ADR 0045 (docs/26 J1, docs/28 S1/S10): a meeting is its record, with a
 * name, listed across the workspace — on exactly the boards the caller can
 * read.
 */
describe("meetings as workspace objects (A3.1)", () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await h.close();
    h = null;
  });

  const save = async (
    hh: Harness,
    token: string,
    boardId: string,
    startedAt: number,
    ended = true,
  ) => {
    const res = await hh.api(`/api/boards/${boardId}/meetings`, {
      method: "POST",
      token,
      body: JSON.stringify({
        turns: TURNS.slice(0, 2),
        startedAt,
        ...(ended ? { endedAt: startedAt + 60_000 } : {}),
      }),
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  it("names a meeting, clears the name, and refuses a bad one", async () => {
    h = await harness();
    const owner = await h.signup("title.owner@example.com");
    const boardId = await h.seedBoard(owner.token);
    const mid = await save(h, owner.token, boardId, 1_000);
    const path = `/api/boards/${boardId}/meetings/${mid}`;

    const named = await h.api(path, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ title: "  Pricing review " }),
    });
    expect(named.status).toBe(200);
    expect(named.body.title).toBe("Pricing review");
    expect((await h.api(path, { token: owner.token })).body.title).toBe("Pricing review");

    const cleared = await h.api(path, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ title: "" }),
    });
    expect(cleared.body.title).toBeUndefined();

    const long = await h.api(path, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ title: "x".repeat(121) }),
    });
    expect(long.status).toBe(400);
    const missing = await h.api(path, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const unknown = await h.api(`/api/boards/${boardId}/meetings/mtg_nope`, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ title: "x" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("a viewer cannot rename a meeting", async () => {
    h = await harness();
    const owner = await h.signup("title.owner2@example.com");
    const viewer = await h.signup("title.viewer@example.com");
    const boardId = await h.seedBoard(owner.token);
    const mid = await save(h, owner.token, boardId, 1_000);
    await h.boardStore.setMember({
      boardId,
      userId: viewer.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });
    const res = await h.api(`/api/boards/${boardId}/meetings/${mid}`, {
      method: "PATCH",
      token: viewer.token,
      body: JSON.stringify({ title: "mine now" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists every meeting on the boards the caller can read, newest first, without turns", async () => {
    h = await harness();
    const owner = await h.signup("list.owner@example.com");
    const orgId = `org_personal_${owner.id}`;
    const a = await h.seedBoard(owner.token, "Board A");
    const b = await h.seedBoard(owner.token, "Board B");
    const older = await save(h, owner.token, a, 1_000);
    const live = await save(h, owner.token, b, 5_000, false);
    await h.api(`/api/boards/${a}/meetings/${older}`, {
      method: "PATCH",
      token: owner.token,
      body: JSON.stringify({ title: "Kickoff" }),
    });

    const list = await h.api(`/api/orgs/${orgId}/meetings`, { token: owner.token });
    expect(list.status).toBe(200);
    const rows = list.body.meetings as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual([live, older]);
    expect(rows[0]).toMatchObject({
      boardId: b,
      boardName: "Board B",
      status: "live",
      title: null,
      turnCount: 2,
      endedAt: null,
    });
    expect(rows[1]).toMatchObject({
      boardId: a,
      boardName: "Board A",
      status: "ended",
      title: "Kickoff",
    });
    expect(rows[0]).not.toHaveProperty("turns");
  });

  it("an outside collaborator sees only the boards they were given; a stranger sees nothing", async () => {
    h = await harness();
    const owner = await h.signup("scope.owner@example.com");
    const guest = await h.signup("scope.guest@example.com");
    const stranger = await h.signup("scope.stranger@example.com");
    const orgId = `org_personal_${owner.id}`;
    const shared = await h.seedBoard(owner.token, "Shared");
    const privateBoard = await h.seedBoard(owner.token, "Private");
    const onShared = await save(h, owner.token, shared, 1_000);
    await save(h, owner.token, privateBoard, 2_000);
    await h.boardStore.setMember({
      boardId: shared,
      userId: guest.id,
      role: "viewer",
      invitedBy: null,
      createdAt: 1,
    });

    const guestList = await h.api(`/api/orgs/${orgId}/meetings`, { token: guest.token });
    expect(guestList.status).toBe(200);
    expect((guestList.body.meetings as Array<{ id: string }>).map((m) => m.id)).toEqual([onShared]);

    const strangerList = await h.api(`/api/orgs/${orgId}/meetings`, { token: stranger.token });
    expect(strangerList.status).toBe(200);
    expect(strangerList.body.meetings).toEqual([]);

    expect((await h.api(`/api/orgs/${orgId}/meetings`, {})).status).toBe(401);
  });
});
