import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import type { LLMProvider } from "@lucent/ai";
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
  providerPolicyRefusal,
  type OrgSettings,
  type ProviderFact,
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
      serverSttDisabled: false,
      serverTtsDisabled: false,
      retention: { transcriptDays: null },
      providerPolicy: { mode: "any", allow: null },
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
    // docs/25 V1: the server-STT switch fails the same way — absent is
    // allowed, present-but-unintelligible is disabled.
    expect(effectiveSettings({}).serverSttDisabled).toBe(false);
    expect(
      effectiveSettings({ settings: { serverStt: "sometimes" as never } }).serverSttDisabled,
    ).toBe(true);
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
      { serverStt: "sometimes" },
      { serverTts: "sometimes" },
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
  telemetry: Telemetry;
  close: () => Promise<void>;
}

async function harness(
  opts: { provider?: LLMProvider; allowByoKeys?: boolean; aiSelfHosted?: boolean } = {},
): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const telemetry = new Telemetry();
  const { server, close } = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }),
      requireAuth: true,
      allowByoKeys: opts.allowByoKeys ?? false,
      aiSelfHosted: opts.aiSelfHosted ?? false,
    },
    provider: opts.provider ?? new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry,
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore,
    meetings: new InMemoryMeetingStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, orgStore, telemetry, close };
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
    const h = (open = await harness({ provider: EXTERNAL_STUB }));
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
 * docs/24 Phase C: the per-org provider policy (docs/23 S3). The unit matrix
 * first (the resolver's answer to every mode × provider fact), then the route
 * the acceptance names: a self-hosted-only org refuses a BYO cloud key even
 * with the deployment flag ON — policy restricts, never widens.
 */
describe("provider policy (unit)", () => {
  const fact = (over: Partial<ProviderFact>): ProviderFact => ({
    name: "anthropic",
    byok: false,
    selfHosted: false,
    ...over,
  });
  const any = effectiveSettings({}).providerPolicy;

  it("any is today's behavior — every provider serves", () => {
    expect(providerPolicyRefusal(any, fact({ byok: true }))).toBeNull();
    expect(providerPolicyRefusal(any, fact({ name: "mock" }))).toBeNull();
  });

  it("byo-forbidden refuses the caller key and only the caller key", () => {
    const p = effectiveSettings({
      settings: { providerPolicy: { mode: "byo-forbidden" } },
    }).providerPolicy;
    expect(providerPolicyRefusal(p, fact({ byok: true }))?.mode).toBe("byo-forbidden");
    expect(providerPolicyRefusal(p, fact({}))).toBeNull();
    // The in-process mock serves regardless (nothing to refuse).
    expect(providerPolicyRefusal(p, fact({ name: "mock" }))).toBeNull();
  });

  it("self-hosted-only refuses a BYO cloud key and an undeclared cloud default", () => {
    const p = effectiveSettings({
      settings: { providerPolicy: { mode: "self-hosted-only" } },
    }).providerPolicy;
    // BYO never self-hosted, whatever the deployment declares.
    expect(providerPolicyRefusal(p, fact({ byok: true, selfHosted: true }))?.mode).toBe(
      "self-hosted-only",
    );
    // A cloud operator provider not marked self-hosted is refused.
    expect(providerPolicyRefusal(p, fact({}))).not.toBeNull();
    // The operator's DECLARATION (config) lets the default through...
    expect(providerPolicyRefusal(p, fact({ selfHosted: true }))).toBeNull();
    // ...and the offline mock always passes (the §24 fallback).
    expect(providerPolicyRefusal(p, fact({ name: "mock" }))).toBeNull();
  });

  it("the allowlist layers under every mode; mock is exempt", () => {
    const p = effectiveSettings({
      settings: { providerPolicy: { mode: "byo-forbidden", allow: ["anthropic", "self-hosted"] } },
    }).providerPolicy;
    expect(providerPolicyRefusal(p, fact({ name: "anthropic" }))).toBeNull();
    expect(providerPolicyRefusal(p, fact({ name: "gorouter" }))!.error).toContain("allows only");
    // byo-forbidden still refuses the key even though "anthropic" is listed.
    expect(providerPolicyRefusal(p, fact({ name: "anthropic", byok: true }))).not.toBeNull();
    expect(providerPolicyRefusal(p, fact({ name: "mock", byok: false }))).toBeNull();
    // The "self-hosted" token matches a declared-self-hosted default.
    expect(providerPolicyRefusal(p, fact({ name: "vllm", selfHosted: true }))).toBeNull();
  });

  it("fails CLOSED: an unknown mode string is the strictest mode", () => {
    const p = effectiveSettings({
      settings: { providerPolicy: { mode: "trust-me" as never } },
    }).providerPolicy;
    expect(p.mode).toBe("self-hosted-only");
    expect(providerPolicyRefusal(p, fact({ name: "anthropic" }))).not.toBeNull();
  });

  it("parseOrgSettings validates providerPolicy strictly", () => {
    expect(parseOrgSettings({ providerPolicy: { mode: "any" } }).ok).toBe(true);
    expect(parseOrgSettings({ providerPolicy: { allow: ["anthropic"] } }).ok).toBe(true);
    for (const bad of [
      { providerPolicy: "self-hosted" },
      { providerPolicy: { mode: "everything" } },
      { providerPolicy: { allow: [] } },
      { providerPolicy: { allow: [1, 2] } },
      { providerPolicy: { typo: true } },
    ]) {
      const res = parseOrgSettings(bad);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("provider policy: enforced at the AI routes", () => {
  it("a self-hosted-only org refuses a BYO cloud key even with LUCENT_ALLOW_BYO_KEYS=1, and spends nothing", async () => {
    const h = (open = await harness({ allowByoKeys: true }));
    const alice = await signup(h, "alice.byo@example.com");
    const boardId = await newBoard(h, alice, "Plain");
    const patched = await setPolicy(h, alice, { providerPolicy: { mode: "self-hosted-only" } });
    expect(patched.status).toBe(200);

    // The stream route is the ONLY BYO path; a cloud key must die there.
    const res = await api(h, "/api/generate/stream", {
      method: "POST",
      token: alice.token,
      headers: {
        "x-lucent-provider-key": "sk-ant-supersecret",
        "x-lucent-provider": "anthropic",
      },
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.policy).toBe("self-hosted-only");
    expect(res.body.boundary).toBe("provider");
    // The refusal never opened the SSE stream (real 403, not an error frame).
    // And it is a POLICY refusal, not a capacity one, in the metrics:
    expect(h.telemetry.snapshot().refusals.policy).toBe(1);
    expect(h.telemetry.snapshot().refusals.rate).toBe(0);
  });

  it("a self-hosted-only org on an undeclared cloud deployment is refused generation outright", async () => {
    const h = (open = await harness({ provider: EXTERNAL_STUB, aiSelfHosted: false }));
    const alice = await signup(h, "alice.cloud@example.com");
    const boardId = await newBoard(h, alice, "Plain");
    await setPolicy(h, alice, { providerPolicy: { mode: "self-hosted-only" } });

    const res = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    // EXTERNAL_STUB.generate THROWS, so reaching the provider would fail the
    // test loudly — a clean 403 here proves "before any spend".
    expect(res.status).toBe(403);
    expect(res.body.boundary).toBe("provider");
    expect(res.body.policy).toBe("self-hosted-only");
  });

  it("the same org on a DECLARED self-hosted deployment generates normally", async () => {
    // Mock provider = in-process, passes self-hosted-only; and a cloud default
    // marked self-hosted (config) also passes. Both must NOT get a provider
    // refusal, proving the operator declaration is what gates it.
    const h = (open = await harness({ provider: new MockProvider(), aiSelfHosted: true }));
    const alice = await signup(h, "alice.selfhost@example.com");
    const boardId = await newBoard(h, alice, "Plain");
    await setPolicy(h, alice, { providerPolicy: { mode: "self-hosted-only" } });
    const res = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(res.body.policy).toBeUndefined();
    expect(res.body.boundary).toBeUndefined();
  });

  it("no-byo at the deployment is never widened by an org saying 'any'", async () => {
    // LUCENT_ALLOW_BYO_KEYS is OFF; the org cannot unlock it — the deployment
    // refusal happens in the resolver before the org is even consulted.
    const h = (open = await harness({ allowByoKeys: false }));
    const alice = await signup(h, "alice.nowiden@example.com");
    await setPolicy(h, alice, { providerPolicy: { mode: "any" } });
    const res = await api(h, "/api/generate/stream", {
      method: "POST",
      token: alice.token,
      headers: { "x-lucent-provider-key": "sk-x", "x-lucent-provider": "anthropic" },
      body: JSON.stringify({
        message: "hi",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(res.status).toBe(403);
    expect(res.body.policy).toBeUndefined(); // the DEPLOYMENT refusal, not org policy
  });
});

/**
 * docs/24 Phase C: the admin + member SURFACES for the provider policy.
 * The plan's web line — "the admin sets it and every member sees it" — is
 * two routes, and this is where each one's floor is locked: the full plane
 * stays the owner's (Phase B's shape, unchanged), and the provider policy
 * gets the one member-readable surface, answering exactly the shape the
 * gates enforce (`effectiveSettings(org).providerPolicy`), never the raw
 * record.
 */
describe("provider policy: the surfaces", () => {
  it("every member reads the provider policy; the full plane stays owner-only", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.surf@example.com");
    await setPolicy(h, alice, {
      providerPolicy: { mode: "self-hosted-only" },
      sharingDisabled: true,
    });
    const bob = await signup(h, "bob.surf@example.com");
    await h.userStore.setMembership({ userId: bob.id, orgId: alice.orgId, role: "editor" });

    // The member-visible provider-policy surface.
    const read = await api(h, `/api/orgs/${alice.orgId}/policy`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      providerPolicy: { mode: "self-hosted-only", allow: null },
      serverStt: "allowed",
      serverTts: "allowed",
    });
    // ...and the FULL plane does not ride it: no floor, no denials. The
    // provider policy is a transparency fact; the rest is the console's.
    expect(JSON.stringify(read.body)).not.toContain("sharingDisabled");
    // The owner's richer surface still refuses the member — the same
    // 404-on-denial shape the whole codebase uses.
    expect((await api(h, `/api/orgs/${alice.orgId}/settings`, { token: bob.token })).status).toBe(
      404,
    );
    // A non-member cannot tell the org exists.
    const carol = await signup(h, "carol.surf@example.com");
    expect((await api(h, `/api/orgs/${alice.orgId}/policy`, { token: carol.token })).status).toBe(
      404,
    );
  });

  it("a mode-only PATCH preserves the stored name filter; `allow: null` clears it", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.merge@example.com");
    const pinned = await setPolicy(h, alice, { providerPolicy: { allow: ["self-hosted"] } });
    expect(pinned.status).toBe(200);
    expect(pinned.body.settings.providerPolicy).toEqual({ allow: ["self-hosted"] });
    // The web control's exact write: mode only. "Absent means unchanged"
    // holds INSIDE the nested policy — the filter must survive.
    const second = await setPolicy(h, alice, { providerPolicy: { mode: "byo-forbidden" } });
    expect(second.status).toBe(200);
    expect(second.body.settings.providerPolicy).toEqual({
      mode: "byo-forbidden",
      allow: ["self-hosted"],
    });
    // The member-visible surface answers what the gates enforce: both halves.
    const surf = await api(h, `/api/orgs/${alice.orgId}/policy`, { token: alice.token });
    expect(surf.body.providerPolicy).toEqual({ mode: "byo-forbidden", allow: ["self-hosted"] });
    // The audit compared RESOLVED objects and named providerPolicy with its
    // mode moved and the filter intact on both sides.
    expect(second.body.changed.providerPolicy).toEqual({
      from: { mode: "any", allow: ["self-hosted"] },
      to: { mode: "byo-forbidden", allow: ["self-hosted"] },
    });
    // An explicit clear removes the filter, leaving the mode.
    const cleared = await setPolicy(h, alice, { providerPolicy: { allow: null } });
    expect(cleared.body.settings.providerPolicy).toEqual({ mode: "byo-forbidden" });
    // Clearing against an absent filter stores NOTHING — no `{}` husk — so
    // the raw record keeps "absent means no policy written here" true.
    const fresh = await signup(h, "fresh.merge@example.com");
    const noopClear = await setPolicy(h, fresh, { providerPolicy: { allow: null } });
    expect("providerPolicy" in (noopClear.body.settings as object)).toBe(false);
    expect(noopClear.body.effective.providerPolicy).toEqual({ mode: "any", allow: null });
    expect(noopClear.body.changed).toEqual({});
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
      // docs/25 V1 rides the same jsonb, so parity carries it too.
      serverStt: "disabled",
      // Phase C's nested object is the one shape PG's jsonb could mangle in
      // transit (an inner NULL vs a missing key), so parity carries it too.
      providerPolicy: { mode: "self-hosted-only", allow: ["self-hosted"] },
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
    expect(effectiveSettings(pgRow).serverSttDisabled).toBe(true);
    expect(effectiveSettings(pgRow).providerPolicy).toEqual({
      mode: "self-hosted-only",
      allow: ["self-hosted"],
    });
  });
});
