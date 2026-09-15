import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import type { LLMProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore, PostgresOrgStore } from "../src/orgs.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import {
  effectiveSettings,
  parseOrgSettings,
  checkOutboundFor,
  type OrgSettings,
} from "../src/classification.js";

/**
 * docs/24 Phase B: the org policy plane (docs/23 S2).
 *
 * The three properties the acceptance names, and the one the plan says the
 * direction matters for:
 *
 *   1. INHERITANCE, not copy-on-write: a policy set today governs a board
 *      created yesterday, with nothing rewritten (the gates read the org at
 *      decision time).
 *   2. POLICY BEATS BOARD: a board-level label can only ever be stricter
 *      than the org floor, never looser (`stricterOf`), and an org-wide
 *      denial refuses regardless of the board's tier.
 *   3. Every settings change writes an audit row naming the actor and the
 *      CHANGED KEYS.
 *
 * The fail-closed rule (an uninterpretable stored value = the restrictive
 * answer) is asserted here as a unit and against real Postgres; the routes
 * validate every write, so garbage only arrives through a direct database
 * write — the same discipline classification.ts documents for tiers.
 */

const SECRET = "test-secret-at-least-16-chars";

const EXTERNAL_STUB = {
  name: "vendor-stub",
  async generate(): Promise<never> {
    throw new Error("the provider must not be reached: the gate answers first");
  },
  async generateAnswer(): Promise<never> {
    throw new Error("the provider must not be reached: the gate answers first");
  },
} as unknown as LLMProvider;

describe("org settings policy (unit)", () => {
  it("defaults an untouched org to the permissive plane — Phase A behavior", () => {
    expect(effectiveSettings(undefined)).toEqual({
      classificationFloor: "internal",
      aiDisabled: false,
      sharingDisabled: false,
      agentDisabled: false,
      recordingDisabled: false,
    });
    expect(effectiveSettings({}).classificationFloor).toBe("internal");
  });

  it("fails CLOSED on unintelligible stored values — absence is the only default", () => {
    const garbage = effectiveSettings({
      settings: {
        classificationFloor: "secret" as never,
        sharingDisabled: "false" as never, // a STRING false is not a boolean
      } as OrgSettings,
    });
    expect(garbage.classificationFloor).toBe("restricted");
    expect(garbage.sharingDisabled).toBe(true);
    // An unknown `ai` value refuses generation (the restrictive answer).
    expect(effectiveSettings({ settings: { ai: "maybe" as never } }).aiDisabled).toBe(true);
  });

  it("checkOutboundFor raises the tier by the floor and says so honestly", () => {
    // Policy beats board: an explicitly-internal board under a confidential
    // floor still refuses sharing — and the message names the FLOOR as the
    // cause, not a classification the board never got.
    const refusal = checkOutboundFor(
      { classification: "internal" },
      { settings: { classificationFloor: "confidential" } },
      "sharing",
    );
    expect(refusal).not.toBeNull();
    expect(refusal!.boundary).toBe("sharing");
    expect(refusal!.classification).toBe("confidential"); // effective tier
    expect(refusal!.error).toContain("organization's classification floor");
    expect(refusal!.error).not.toMatch(/^this board is classified/);
    // The board's OWN stricter label is never loosened by a laxer floor.
    expect(
      checkOutboundFor(
        { classification: "restricted" },
        { settings: { classificationFloor: "internal" } },
        "ai",
        { provider: { name: "anthropic" } },
      ),
    ).not.toBeNull();
  });

  it("the org booleans deny regardless of tier, and ai: disabled reaches the mock", () => {
    const org = { settings: { agentDisabled: true } as OrgSettings };
    expect(checkOutboundFor({ classification: "internal" }, org, "agent")?.boundary).toBe("agent");
    // The strictest AI switch covers the in-process exemption: `ai: disabled`
    // is "no AI in this workspace", not "no AI leaving it".
    const off = { settings: { ai: "disabled" } as OrgSettings };
    expect(
      checkOutboundFor({ classification: "internal" }, off, "ai", { provider: { name: "mock" } }),
    ).not.toBeNull();
    // While a restricted FLOOR alone keeps the mock working (the §24 fallback).
    expect(
      checkOutboundFor(
        { classification: "internal" },
        { settings: { classificationFloor: "restricted" } },
        "ai",
        { provider: { name: "mock" } },
      ),
    ).toBeNull();
  });

  it("parseOrgSettings is strict — unknown keys and bad values are named, never stored", () => {
    expect(parseOrgSettings({}).ok).toBe(true);
    expect(parseOrgSettings({ classificationFloor: "confidential" }).ok).toBe(true);
    expect(parseOrgSettings({ sharingDisabled: true }).ok).toBe(true);
    for (const body of [
      { sharingDisabled: "yes" },
      { classificationFloor: "PUBLIC" },
      { ai: "sometimes" },
      { typoInKey: true },
      { ai: 1 },
    ]) {
      const res = parseOrgSettings(body);
      expect(res.ok, JSON.stringify(body)).toBe(false);
      if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    }
  });
});

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  orgStore: InMemoryOrgStore;
  close: () => Promise<void>;
}

async function harness(provider: LLMProvider = new MockProvider()): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider,
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
    meetings: new InMemoryMeetingStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, orgStore, close };
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
      ...(rest.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

interface Actor {
  id: string;
  token: string;
  orgId: string;
}

async function signup(h: Harness, email: string): Promise<Actor> {
  const created = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(created.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  const orgs = await api(h, "/api/orgs", { token: created.body.token });
  return {
    id: created.body.user.id as string,
    token: created.body.token as string,
    orgId: orgs.body.orgs[0].id as string,
  };
}

async function newBoard(h: Harness, owner: Actor, name: string): Promise<string> {
  const created = await api(h, "/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ name }),
  });
  return created.body.id as string;
}

async function setPolicy(h: Harness, actor: Actor, settings: Record<string, unknown>) {
  return api(h, `/api/orgs/${actor.orgId}/settings`, {
    method: "PATCH",
    token: actor.token,
    body: JSON.stringify(settings),
  });
}

describe("org policy plane: the admin API", () => {
  it("owner reads and writes; the effective plane resolves defaults; the audit names changed keys", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.policy@example.com");

    // The write the plan names as the shape: partial PATCH, full resolve.
    const patched = await setPolicy(h, alice, { classificationFloor: "confidential" });
    expect(patched.status).toBe(200);
    expect(patched.body.settings).toEqual({ classificationFloor: "confidential" });
    expect(patched.body.effective.classificationFloor).toBe("confidential");
    expect(patched.body.changed).toEqual({
      classificationFloor: { from: "internal", to: "confidential" },
    });

    const read = await api(h, `/api/orgs/${alice.orgId}/settings`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(read.body.effective.sharingDisabled).toBe(false);

    // The trail: action + the CHANGED KEY with from→to (docs/24 §4 acceptance).
    const trail = await api(h, `/api/orgs/${alice.orgId}/audit`, { token: alice.token });
    expect(trail.status).toBe(200);
    const row = trail.body.entries.find((e: { action: string }) => e.action === "org.settings");
    expect(row).toBeTruthy();
    expect(row.actorId).toBe(alice.id);
    expect(row.metadata.changed.classificationFloor).toEqual({
      from: "internal",
      to: "confidential",
    });
    expect(row.metadata.requested).toEqual({ classificationFloor: "confidential" });
  });

  it("a no-op write changes nothing and audits an empty change set", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.policy.noop@example.com");
    const first = await setPolicy(h, alice, { sharingDisabled: true });
    expect(Object.keys(first.body.changed)).toEqual(["sharingDisabled"]);
    const again = await setPolicy(h, alice, { sharingDisabled: true });
    expect(again.status).toBe(200);
    expect(again.body.changed).toEqual({});
  });

  it("a bad PATCH is a 400 naming the problem, and the stored plane is untouched", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.policy.bad@example.com");
    for (const body of [
      { classificationFloor: "PUBLIC" },
      { sharingDisabled: "false" },
      { extraKey: 1 },
    ]) {
      const res = await setPolicy(h, alice, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof res.body.error).toBe("string");
    }
    const read = await api(h, `/api/orgs/${alice.orgId}/settings`, { token: alice.token });
    expect(read.body.settings).toEqual({});
  });

  it("a stranger cannot read or write another org's policy (404, ids unguessable)", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.policy.who@example.com");
    const eve = await signup(h, "eve.policy.who@example.com");
    const read = await api(h, `/api/orgs/${alice.orgId}/settings`, { token: eve.token });
    expect(read.status).toBe(404);
    const write = await api(h, `/api/orgs/${alice.orgId}/settings`, {
      method: "PATCH",
      token: eve.token,
      body: JSON.stringify({ ai: "disabled" }),
    });
    expect(write.status).toBe(404);
    const after = await api(h, `/api/orgs/${alice.orgId}/settings`, { token: alice.token });
    expect(after.body.settings).toEqual({});
  });
});

describe("org policy plane: inheritance and the boundaries", () => {
  it("INHERITANCE: a floor set today governs a board created yesterday, and share mints refuse", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.inherit@example.com");
    const boardId = await newBoard(h, alice, "Before the policy");

    // The board is internal; sharing works...
    const before = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(before.status).toBe(201);

    // ...then the ORG says no, with no board rewrite anywhere.
    const patched = await setPolicy(h, alice, { classificationFloor: "confidential" });
    expect(patched.status).toBe(200);
    const after = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(after.body.classification).toBe("internal"); // the board's own label is untouched
    const refused = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.boundary).toBe("sharing");
    expect(refused.body.error).toContain("classification floor");

    // And lifting the policy lifts the refusal — it is a read, not a lock.
    await setPolicy(h, alice, { classificationFloor: "internal" });
    const again = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(again.status).toBe(201);
  });

  it("POLICY BEATS BOARD: an explicit `internal` label cannot loosen a restricted floor", async () => {
    const h = (open = await harness(EXTERNAL_STUB));
    const alice = await signup(h, "alice.beats@example.com");
    const boardId = await newBoard(h, alice, "Labelled internal");
    // Write the board's own label to internal explicitly: it still means
    // nothing against the org floor.
    await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ id: boardId, classification: "internal" }),
    });
    await setPolicy(h, alice, { classificationFloor: "restricted" });

    const ask = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what is here?" }),
    });
    expect(ask.status).toBe(403);
    expect(ask.body.boundary).toBe("ai");
    expect(ask.body.classification).toBe("restricted"); // effective, not the label

    const ops = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-p", nodeType: "step", label: "p" }],
      }),
    });
    expect(ops.status).toBe(403);
    expect(ops.body.boundary).toBe("agent");
  });

  it("org-wide denials: agentDisabled on an internal board, ai disabled reaching the mock", async () => {
    const h = (open = await harness()); // mock provider throughout
    const alice = await signup(h, "alice.denials@example.com");
    const boardId = await newBoard(h, alice, "Plain internal");

    // baseline: everything works under no policy.
    const opsOk = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-ok", nodeType: "step", label: "ok" }],
      }),
    });
    expect(opsOk.status).toBe(200);
    const genOk = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(genOk.status).toBe(200); // offline mock, no policy

    await setPolicy(h, alice, { agentDisabled: true });
    const ops = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        ops: [{ op: "CREATE_NODE", id: "n-no", nodeType: "step", label: "no" }],
      }),
    });
    expect(ops.status).toBe(403);
    expect(ops.body.boundary).toBe("agent");
    // The marked read follows the same denial...
    const marked = await api(h, `/api/boards/${boardId}`, {
      token: alice.token,
      headers: { "x-lucent-client": "mcp" },
    });
    expect(marked.status).toBe(403);
    // ...and the human's own read does NOT: the agent denial is about agents.
    const human = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(human.status).toBe(200);

    // `ai: "disabled"` is stricter than any floor: the offline mock refuses too.
    await setPolicy(h, alice, { ai: "disabled" });
    const gen = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(gen.status).toBe(403);
    expect(gen.body.boundary).toBe("ai");
  });

  it("recordingDisabled refuses capture writes; the end and the reads stay legal", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.record@example.com");
    const boardId = await newBoard(h, alice, "Meetings");

    const created = await api(h, `/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        turns: [{ speaker: "Alex", text: "ship it", at: Date.now() }],
      }),
    });
    expect(created.status).toBe(201);
    const mid = created.body.id as string;

    await setPolicy(h, alice, { recordingDisabled: true });

    // New capture: refused.
    const refused = await api(h, `/api/boards/${boardId}/meetings`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ turns: [{ speaker: "Alex", text: "more", at: Date.now() }] }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.recordingDisabled).toBe(true);
    // The running capture's append: refused (it is also a capture write).
    const append = await api(h, `/api/boards/${boardId}/meetings/${mid}/turns`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ turns: [{ speaker: "Sam", text: "later", at: Date.now() }] }),
    });
    expect(append.status).toBe(403);
    // But ending it is allowed — stranding a running capture in "in progress"
    // is the policy lying about the record.
    const ended = await api(h, `/api/boards/${boardId}/meetings/${mid}/end`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({}),
    });
    expect(ended.status).toBe(200);
    // The saved transcript is board state: reads untouched.
    const list = await api(h, `/api/boards/${boardId}/meetings`, { token: alice.token });
    expect(list.status).toBe(200);
    expect(list.body.meetings.length).toBe(1);
  });
});

/**
 * Store parity (docs/24 §3's rule, now for org settings): the same
 * `effectiveSettings` resolution in both twins, PG's NULL behaving exactly
 * like the in-memory field-absence, and the value surviving the round trip.
 * Gated on LUCENT_TEST_DATABASE_URL, the repo's convention.
 */
const PG_URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = PG_URL ? describe : describe.skip;

describeIf("PostgresOrgStore persists settings like the in-memory twin", () => {
  let db: Db;
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const orgA = `org_pol_a_${tag}`;
  const orgB = `org_pol_b_${tag}`;

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createDb(PG_URL);
    await migrate(db);
    // No pre-seeded org rows: the test inserts through each store's own
    // `insert` (which is the write path under test), so a raw INSERT here
    // would collide on the primary key and prove nothing.
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [orgA, orgB]) {
      await db.pool.query("DELETE FROM organizations WHERE id = $1", [id]).catch(() => {});
    }
    await closeDb(db);
  });

  it("NULL reads as absence and a written plane reads back whole, identically to InMemory", async () => {
    const pg = new PostgresOrgStore(db);
    const mem = new InMemoryOrgStore();
    for (const store of [pg, mem] as const) {
      await store.insert({ id: orgA, name: "A", createdAt: 1 });
      await store.insert({ id: orgB, name: "B", createdAt: 1 });
    }
    // Absence parity: an org with no settings — PG's NULL, memory's no field.
    const pgUnset = await pg.get(orgA);
    const memUnset = await mem.get(orgA);
    expect(pgUnset!.settings).toBe(memUnset!.settings); // both undefined, not null
    expect(effectiveSettings(pgUnset)).toEqual(effectiveSettings(memUnset));

    const plane: OrgSettings = {
      classificationFloor: "restricted",
      ai: "disabled",
      sharingDisabled: true,
      agentDisabled: false,
      recordingDisabled: true,
    };
    await pg.setSettings(orgB, plane);
    await mem.setSettings(orgB, plane);
    const pgRow = await pg.get(orgB);
    const memRow = await mem.get(orgB);
    expect(pgRow!.settings).toEqual(plane);
    expect(effectiveSettings(pgRow)).toEqual(effectiveSettings(memRow));
    expect(effectiveSettings(pgRow).classificationFloor).toBe("restricted");
    expect(effectiveSettings(pgRow).aiDisabled).toBe(true);
    expect(effectiveSettings(pgRow).agentDisabled).toBe(false);
  });
});
