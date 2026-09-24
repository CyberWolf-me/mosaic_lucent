import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider, type LLMProvider } from "@lucent/ai";
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
import { InMemoryMeetingStore } from "../src/meetings.js";

/**
 * docs/27 N1: meeting notes over HTTP. Notes are private to their author,
 * enhancement keeps the author's lines and cites the transcript, and a board
 * whose AI boundary refuses still gets a note — made offline, and labelled.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}
let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(provider: LLMProvider = new MockProvider()): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config,
    provider,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    meetings: new InMemoryMeetingStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, close: async () => close() };
}

async function api(
  h: Harness,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
) {
  const res = await fetch(`${h.base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      origin: h.base,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function signup(h: Harness, email: string): Promise<{ token: string; id: string }> {
  const r = await api(h, "/api/auth/signup", {
    method: "POST",
    body: { email, password: "password123", name: email },
  });
  expect(r.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: r.body.token, id: r.body.user.id };
}

const TURNS = [
  { speaker: "Maya", at: 1, text: "Let's start with pricing." },
  { speaker: "Sam", at: 2, text: "We decided to go with usage-based pricing." },
  { speaker: "Maya", at: 3, text: "I'll draft the pricing page by Friday." },
];

async function meetingOn(h: Harness, token: string, extra: Record<string, unknown> = {}) {
  const board = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: { name: "B", workspace: createWorkspace(), ...extra },
  });
  expect(board.status).toBe(201);
  const m = await api(h, `/api/boards/${board.body.id}/meetings`, {
    method: "POST",
    token,
    body: { turns: TURNS, startedAt: 1, endedAt: 4 },
  });
  expect(m.status).toBe(201);
  return { boardId: board.body.id as string, meetingId: m.body.id as string };
}

describe("meeting notes", () => {
  it("are private to their author: each member reads and writes only their own", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "an@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const path = `/api/boards/${boardId}/meetings/${meetingId}/notes`;

    const empty = await api(h, path, { token: alice.token });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ lines: [], enhanced: null, template: "general" });

    const saved = await api(h, path, {
      method: "PUT",
      token: alice.token,
      body: { lines: [{ text: "pricing → usage", turn: 2 }], template: "design_review" },
    });
    expect(saved.status).toBe(200);
    expect((await api(h, path, { token: alice.token })).body.lines).toEqual([
      { text: "pricing → usage", turn: 2 },
    ]);

    // A stranger can't reach the meeting at all.
    const eve = await signup(h, "ev@example.com");
    expect((await api(h, path, { token: eve.token })).status).toBe(404);
  });

  it("enhances: the author's line verbatim, AI lines cited to real turns", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "en@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const base = `/api/boards/${boardId}/meetings/${meetingId}/notes`;
    await api(h, base, {
      method: "PUT",
      token: alice.token,
      body: { lines: [{ text: "maya: page fri", turn: 3 }] },
    });

    const r = await api(h, `${base}/enhance`, {
      method: "POST",
      token: alice.token,
      body: { template: "general" },
    });
    expect(r.status).toBe(200);
    const note = r.body.enhanced;
    expect(note).toMatchObject({ template: "general", by: "model", model: "mock" });
    const items = note.sections.flatMap((s: any) => s.items);
    expect(items).toContainEqual({ text: "maya: page fri", source: "user", line: 0 });
    const ai = items.filter((i: any) => i.source === "ai");
    expect(ai.length).toBeGreaterThan(0);
    for (const i of ai) {
      expect(i.turns[0]).toBeGreaterThanOrEqual(0);
      expect(i.turns[1]).toBeLessThan(TURNS.length);
    }
    // Stored: a reload shows the same note.
    expect((await api(h, base, { token: alice.token })).body.enhanced).toEqual(note);
  });

  it("an edited note is re-checked: a citation pointing outside the meeting is dropped", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "ed@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const base = `/api/boards/${boardId}/meetings/${meetingId}/notes`;
    const r = await api(h, base, {
      method: "PUT",
      token: alice.token,
      body: {
        enhanced: {
          template: "general",
          generatedAt: 1,
          by: "model",
          sections: [
            {
              title: "Decisions",
              items: [
                { text: "Usage-based pricing.", source: "ai", turns: [1, 1] },
                { text: "Invented.", source: "ai", turns: [7, 9] },
                { text: "My own words now.", source: "user" },
              ],
            },
          ],
        },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.enhanced.sections[0].items).toEqual([
      { text: "Usage-based pricing.", source: "ai", turns: [1, 1] },
      { text: "My own words now.", source: "user" },
    ]);
  });

  it("re-enhancing keeps a line the author rewrote", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "re@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const base = `/api/boards/${boardId}/meetings/${meetingId}/notes`;
    const first = await api(h, `${base}/enhance`, { method: "POST", token: alice.token, body: {} });
    expect(first.status).toBe(200);
    const edited = structuredClone(first.body.enhanced);
    const target = edited.sections.find((s: any) => s.items.some((i: any) => i.source === "ai"));
    const idx = target.items.findIndex((i: any) => i.source === "ai");
    target.items[idx] = { text: "Pricing is usage-based; I own the page.", source: "user" };
    await api(h, base, { method: "PUT", token: alice.token, body: { enhanced: edited } });

    const again = await api(h, `${base}/enhance`, { method: "POST", token: alice.token, body: {} });
    expect(again.status).toBe(200);
    const section = again.body.enhanced.sections.find((s: any) => s.title === target.title);
    expect(section.items).toContainEqual({
      text: "Pricing is usage-based; I own the page.",
      source: "user",
    });
  });

  it("a board that keeps meetings from AI still gets a note — offline, and labelled", async () => {
    // The in-process mock is exempt from the AI boundary (nothing leaves the
    // deployment), so stand in a provider that would send data out.
    const cloud = new MockProvider() as unknown as LLMProvider;
    Object.defineProperty(cloud, "name", { value: "cloud-model" });
    const h = (open = await harness(cloud));
    const alice = await signup(h, "rs@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const cls = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: { id: boardId, classification: "restricted" },
    });
    expect(cls.status).toBe(201);
    const r = await api(h, `/api/boards/${boardId}/meetings/${meetingId}/notes/enhance`, {
      method: "POST",
      token: alice.token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.body.offline).toBe("policy");
    expect(r.body.enhanced.by).toBe("fallback");
  });

  it("a provider without the notes call, or one that fails, falls back honestly", async () => {
    const noNotes = new MockProvider() as unknown as LLMProvider;
    (noNotes as { generateNotes?: unknown }).generateNotes = undefined;
    let h = (open = await harness(noNotes));
    let alice = await signup(h, "nn@example.com");
    let ids = await meetingOn(h, alice.token);
    let r = await api(h, `/api/boards/${ids.boardId}/meetings/${ids.meetingId}/notes/enhance`, {
      method: "POST",
      token: alice.token,
      body: {},
    });
    expect(r.body.offline).toBe("no-model");
    await h.close();

    const failing = new MockProvider() as unknown as LLMProvider;
    failing.generateNotes = async () => {
      throw new Error("model down");
    };
    h = open = await harness(failing);
    alice = await signup(h, "mf@example.com");
    ids = await meetingOn(h, alice.token);
    r = await api(h, `/api/boards/${ids.boardId}/meetings/${ids.meetingId}/notes/enhance`, {
      method: "POST",
      token: alice.token,
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.body.offline).toBe("model-failed");
  });

  it("refuses a malformed save and an unknown template", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "bd@example.com");
    const { boardId, meetingId } = await meetingOn(h, alice.token);
    const base = `/api/boards/${boardId}/meetings/${meetingId}/notes`;
    expect(
      (
        await api(h, base, {
          method: "PUT",
          token: alice.token,
          body: { lines: [{ text: "x", turn: -1 }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(h, base, { method: "PUT", token: alice.token, body: { template: "nope" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await api(h, `${base}/enhance`, {
          method: "POST",
          token: alice.token,
          body: { template: "nope" },
        })
      ).status,
    ).toBe(400);
  });
});
