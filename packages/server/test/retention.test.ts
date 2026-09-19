import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore, PostgresOrgStore } from "../src/orgs.js";
import { InMemoryMeetingStore, type MeetingStore } from "../src/meetings.js";
import { PostgresMeetingStore } from "../src/store/pg-meetings.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { effectiveSettings, parseOrgSettings, MAX_RETENTION_DAYS } from "../src/classification.js";
import { buildSweepHandlers, sweepRetentionTranscripts } from "../src/sweeps.js";
import type { Job } from "../src/jobs.js";

/**
 * docs/24 Phase H: per-class retention as org policy + the expiry sweep.
 *
 * The rules under test: retention is opt-in per org (absent means board
 * lifetime, zero change); the sweep deletes only ENDED transcripts older
 * than the policy (running captures are immune at every setting); garbage
 * resolves to keep, never to deletion (the deliberate preservation
 * exception to fail-closed); every write audits the changed key.
 */

const SECRET = "test-secret-at-least-16-chars";
const DAY = 24 * 60 * 60 * 1000;

describe("retention policy (unit)", () => {
  it("absent means board lifetime; a set value resolves; garbage keeps", () => {
    expect(effectiveSettings(undefined).retention).toEqual({ transcriptDays: null });
    expect(
      effectiveSettings({ settings: { retention: { transcriptDays: 30 } } }).retention,
    ).toEqual({ transcriptDays: 30 });
    // Preservation exception: uninterpretable lifetimes keep, never delete.
    for (const bad of [
      { transcriptDays: 0 },
      { transcriptDays: -1 },
      { transcriptDays: 1.5 },
      { transcriptDays: "30" },
      { transcriptDays: 999_999_999 },
    ]) {
      expect(
        effectiveSettings({ settings: { retention: bad as never } }).retention,
        JSON.stringify(bad),
      ).toEqual({ transcriptDays: null });
    }
  });

  it("parseOrgSettings accepts null/1..MAX strictly", () => {
    expect(parseOrgSettings({ retention: { transcriptDays: 30 } })).toEqual({
      ok: true,
      settings: { retention: { transcriptDays: 30 } },
    });
    expect(parseOrgSettings({ retention: { transcriptDays: null } })).toEqual({
      ok: true,
      settings: { retention: { transcriptDays: null } },
    });
    expect(parseOrgSettings({ retention: {} })).toEqual({ ok: true, settings: { retention: {} } });
    for (const bad of [
      { retention: "30 days" },
      { retention: { transcriptDays: 0 } },
      { retention: { transcriptDays: 2.5 } },
      { retention: { transcriptDays: MAX_RETENTION_DAYS + 1 } },
      { retention: { transcriptDays: [30] } },
      { retention: { audioDays: 30 } },
    ]) {
      expect(parseOrgSettings(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

function seedable(): { store: InMemoryMeetingStore; ids: Record<string, string> } {
  return { store: new InMemoryMeetingStore(), ids: {} };
}

async function seed(
  store: MeetingStore,
  boardId: string,
  orgId: string,
  endedAt: number | null,
  startedAt = 1_000,
): Promise<string> {
  const row = await store.insert({
    boardId,
    orgId,
    startedAt,
    ...(endedAt === null ? { endedAt: null } : { endedAt }),
    turns: [{ speaker: "A", at: startedAt, text: "x" }],
    createdBy: "usr_1",
    createdAt: startedAt,
  });
  return row.id;
}

describe("MeetingStore.deleteExpired", () => {
  it("deletes only ended rows past the cutoff, oldest first, bounded", async () => {
    const { store } = seedable();
    const now = 100 * DAY;
    const old1 = await seed(store, "b", "o", now - 40 * DAY, 1_000);
    const old2 = await seed(store, "b", "o", now - 31 * DAY, 2_000);
    const recent = await seed(store, "b", "o", now - 10 * DAY, 3_000);
    const running = await seed(store, "b", "o", null, 4_000);
    const foreign = await seed(store, "b", "other-org", now - 40 * DAY, 5_000);
    expect(await store.deleteExpired("o", now - 30 * DAY, 10)).toBe(2);
    expect(await store.get("b", old1)).toBeUndefined();
    expect(await store.get("b", old2)).toBeUndefined();
    expect(await store.get("b", recent)).toBeDefined();
    // Another org's expired rows are not ours to delete.
    expect(await store.get("b", foreign)).toBeDefined();
    // Running captures are immune at every setting — even ancient ones.
    const ancient = await seed(store, "b", "o", null, 10);
    expect(await store.deleteExpired("o", now, 10)).toBe(1); // recent only
    expect(await store.get("b", running)).toBeDefined();
    expect(await store.get("b", ancient)).toBeDefined();
    expect(await store.deleteExpired("o", now - 30 * DAY, 0)).toBe(0);
  });
});

describe("sweepRetentionTranscripts", () => {
  it("sweeps only policy orgs, keeps running captures, counts honestly", async () => {
    const orgs = new InMemoryOrgStore();
    await orgs.insert({ id: "org_keep", name: "K", createdAt: 1 });
    await orgs.insert({ id: "org_sweep", name: "S", createdAt: 1 });
    await orgs.setSettings("org_sweep", { retention: { transcriptDays: 30 } });
    const meetings = new InMemoryMeetingStore();
    const now = 100 * DAY;
    const gone = await seed(meetings, "b", "org_sweep", now - 40 * DAY);
    const keptRecent = await seed(meetings, "b", "org_sweep", now - 5 * DAY);
    const keptRunning = await seed(meetings, "b", "org_sweep", null);
    const keptForeign = await seed(meetings, "b", "org_keep", now - 400 * DAY);
    const result = await sweepRetentionTranscripts({ orgs, meetings, now: () => now });
    expect(result).toEqual({ orgsChecked: 1, transcriptsDeleted: 1 });
    expect(await meetings.get("b", gone)).toBeUndefined();
    expect(await meetings.get("b", keptRecent)).toBeDefined();
    expect(await meetings.get("b", keptRunning)).toBeDefined();
    expect(await meetings.get("b", keptForeign)).toBeDefined();
  });

  it("rides the maintenance family: absent collaborators no-op, counts logged", async () => {
    const JOB = { id: "j1" } as Job;
    const handlers = buildSweepHandlers({
      logger: { info: () => {}, error: () => {} },
    });
    await expect(handlers["sweep-retention"]!(JOB)).resolves.toBeUndefined();
    const calls: string[] = [];
    const orgs = new InMemoryOrgStore();
    await orgs.insert({ id: "o", name: "O", createdAt: 1 });
    await orgs.setSettings("o", { retention: { transcriptDays: 7 } });
    const meetings = new InMemoryMeetingStore();
    await seed(meetings, "b", "o", 1_000);
    const withCtx = buildSweepHandlers({
      logger: {
        info: (event: string) => void calls.push(event),
        error: () => {},
      },
      retention: {
        sweepTranscripts: () => sweepRetentionTranscripts({ orgs, meetings, now: () => 100 * DAY }),
      },
    });
    await withCtx["sweep-retention"]!(JOB);
    expect(calls).toEqual(["retention.swept-transcripts"]);
  });
});

interface Harness {
  base: string;
  close: () => Promise<void>;
}

async function harness(): Promise<
  Harness & {
    api: (
      path: string,
      init?: RequestInit & { token?: string },
    ) => Promise<{ status: number; body: any }>;
    signup: (email: string) => Promise<{ id: string; token: string; orgId: string }>;
  }
> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api = async (
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<{ status: number; body: any }> => {
    const { token, ...rest } = init;
    const res = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const signup = async (email: string) => {
    const created = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(created.status).toBe(201);
    const user = await userStore.findByEmail(email);
    if (user) await userStore.setEmailVerified(user.id, Date.now());
    const orgs = await api("/api/orgs", { token: created.body.token });
    return {
      id: created.body.user.id as string,
      token: created.body.token as string,
      orgId: orgs.body.orgs[0].id as string,
    };
  };
  return { base, close, api, signup };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("retention on the admin surface", () => {
  it("sets, audits, rejects garbage, and clears without a husk", async () => {
    const h = (open = await harness());
    const alice = await h.signup("alice.retention@example.com");
    const set = async (body: unknown) =>
      h.api(`/api/orgs/${alice.orgId}/settings`, {
        method: "PATCH",
        token: alice.token,
        body: JSON.stringify(body),
      });
    const patched = await set({ retention: { transcriptDays: 90 } });
    expect(patched.status).toBe(200);
    expect(patched.body.settings).toEqual({ retention: { transcriptDays: 90 } });
    expect(patched.body.effective.retention).toEqual({ transcriptDays: 90 });
    expect(patched.body.changed.retention).toEqual({
      from: { transcriptDays: null },
      to: { transcriptDays: 90 },
    });
    for (const bad of [
      { retention: { transcriptDays: 0 } },
      { retention: { transcriptDays: "forever" } },
      { retention: { transcriptDays: MAX_RETENTION_DAYS + 1 } },
      { retention: { audioDays: 30 } },
    ]) {
      const res = await set(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const read = await h.api(`/api/orgs/${alice.orgId}/settings`, { token: alice.token });
    expect(read.body.settings).toEqual({ retention: { transcriptDays: 90 } });
    const cleared = await set({ retention: { transcriptDays: null } });
    expect(cleared.status).toBe(200);
    expect("retention" in (cleared.body.settings as object)).toBe(false);
    expect(cleared.body.effective.retention).toEqual({ transcriptDays: null });
  });
});

/**
 * Twin parity for the new primitives (InMemory covered above; PG gated on
 * LUCENT_TEST_DATABASE_URL, the repo's convention): org listing, the
 * retention round-trip through jsonb, and expiry delete on real Postgres.
 */
const PG_URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = PG_URL ? describe : describe.skip;

describeIf("retention parity on Postgres", () => {
  let db: Db;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const orgId = `org_ret_${tag}`;
  const boardId = `brd_ret_${tag}`;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createDb(PG_URL);
    await migrate(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool
      .query("DELETE FROM meeting_transcripts WHERE board_id = $1", [boardId])
      .catch(() => {});
    await db.pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
    await db.pool.query("DELETE FROM users WHERE id LIKE 'usr_ret_%'", []).catch(() => {});
    await closeDb(db);
  });

  it("lists orgs, round-trips retention, and expiry-deletes like the twin", async () => {
    const pgOrgs = new PostgresOrgStore(db);
    const memOrgs = new InMemoryOrgStore();
    for (const store of [pgOrgs, memOrgs] as const) {
      await store.insert({ id: orgId, name: "R", createdAt: 1 });
    }
    // list() sees the row on both twins.
    expect((await pgOrgs.list()).some((o) => o.id === orgId)).toBe(true);
    expect((await memOrgs.list()).some((o) => o.id === orgId)).toBe(true);
    await pgOrgs.setSettings(orgId, { retention: { transcriptDays: 30 } });
    await memOrgs.setSettings(orgId, { retention: { transcriptDays: 30 } });
    expect(effectiveSettings(await pgOrgs.get(orgId))).toEqual(
      effectiveSettings(await memOrgs.get(orgId)),
    );

    // Postgres enforces the board/user FKs the twin cannot see: seed the
    // chain raw (user → board) so the parity assertion compares stores,
    // not constraints.
    const userId = `usr_ret_${tag}`;
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING",
      [userId, `${userId}@example.com`, "Retention", "x"],
    );
    await db.pool.query(
      "INSERT INTO boards (id, org_id, owner_id, name, workspace, created_at, updated_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, 1, 1) ON CONFLICT (id) DO NOTHING",
      [boardId, orgId, userId, "Retention"],
    );

    const pgMeet = new PostgresMeetingStore(db);
    const memMeet = new InMemoryMeetingStore();
    const now = 100 * DAY;
    const mk = (endedAt: number | null) => ({
      boardId,
      orgId,
      startedAt: 1_000,
      ...(endedAt === null ? { endedAt: null } : { endedAt }),
      turns: [{ speaker: "A", at: 1_000, text: "x" }],
      createdBy: userId,
      createdAt: 1_000,
    });
    const pgOld = await pgMeet.insert(mk(now - 40 * DAY));
    const memOld = await memMeet.insert(mk(now - 40 * DAY));
    await pgMeet.insert(mk(null));
    await memMeet.insert(mk(null));
    expect(await pgMeet.deleteExpired(orgId, now - 30 * DAY, 10)).toBe(1);
    expect(await memMeet.deleteExpired(orgId, now - 30 * DAY, 10)).toBe(1);
    expect(await pgMeet.get(boardId, pgOld.id)).toBeUndefined();
    expect(await memMeet.get(boardId, memOld.id)).toBeUndefined();
  });
});
