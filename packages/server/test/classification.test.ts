import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import type { LLMProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore, type StoredBoard } from "../src/boards.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import {
  BOARD_CLASSIFICATIONS,
  checkOutbound,
  classificationOf,
  integrationBoundary,
  isBoardClassification,
  providerLeavesProcess,
  stricterOf,
  type BoardClassification,
  type OutboundBoundary,
} from "../src/classification.js";

/**
 * Phase A of docs/24: board classification and the boundaries it gates.
 *
 * The rule this file exists to enforce (docs/23 S1, docs/17's freeze rule): a
 * tier that gates nothing is a lie, so every advertised tier↔boundary cell has
 * an assertion, and every route that crosses a gated boundary has a
 * route-level test that the refusal actually reaches the client.
 *
 * The unit table below is the policy; the route tests below it are the proof
 * that the policy is wired to something. A passing unit test with an unwired
 * route is exactly the "validated but unreachable" defect class this repo has
 * been bitten by before (see the header of crossTenant.test.ts).
 */

const SECRET = "test-secret-at-least-16-chars";

describe("classification policy (unit)", () => {
  it("defaults an unset board to internal, so old rows keep working", () => {
    expect(classificationOf({})).toBe("internal");
    expect(classificationOf({ classification: undefined })).toBe("internal");
    expect(classificationOf({ classification: "confidential" })).toBe("confidential");
  });

  it("recognizes exactly the three declared tiers", () => {
    for (const tier of BOARD_CLASSIFICATIONS) expect(isBoardClassification(tier)).toBe(true);
    for (const junk of ["", "PUBLIC", "secret", "Internal", null, 3, {}]) {
      expect(isBoardClassification(junk)).toBe(false);
    }
  });

  /**
   * Fail closed on garbage. A value that is neither unset nor a declared tier
   * is only reachable through a direct database write — the column is plain
   * text (no CHECK), and every route validates — and a gate that read such a
   * row as `internal` would open every boundary for exactly the rows nobody
   * can interpret. Unset stays `internal`: that is the documented migration
   * default, not an interpretation.
   */
  it("resolves an unknown stored value to the strictest tier, not the default", () => {
    expect(classificationOf({ classification: "secret" as never })).toBe("restricted");
    expect(classificationOf({ classification: "" as never })).toBe("restricted");
    expect(classificationOf({ classification: null as never })).toBe("internal");
    // And the resolution is load-bearing: a gate reading such a row refuses.
    const refusal = checkOutbound(classificationOf({ classification: "PUBLIC" as never }), "ai", {
      provider: { name: "anthropic" },
    });
    expect(refusal?.boundary).toBe("ai");
    expect(refusal?.classification).toBe("restricted");
  });

  it("orders tiers least → most restrictive", () => {
    expect(stricterOf("internal", "confidential")).toBe("confidential");
    expect(stricterOf("confidential", "internal")).toBe("confidential");
    expect(stricterOf("restricted", "confidential")).toBe("restricted");
    expect(stricterOf("internal", "internal")).toBe("internal");
  });

  /**
   * The whole matrix, written out rather than derived — a derived table would
   * pass if the implementation and the test shared the same mistake.
   */
  it("gates exactly the cells the policy documents", () => {
    const allowed: Record<BoardClassification, OutboundBoundary[]> = {
      internal: ["ai", "integration", "sharing", "agent"],
      confidential: ["ai", "agent"],
      restricted: [],
    };
    const boundaries: OutboundBoundary[] = ["ai", "integration", "sharing", "agent"];
    for (const tier of BOARD_CLASSIFICATIONS) {
      for (const boundary of boundaries) {
        const refusal = checkOutbound(tier, boundary, { provider: { name: "anthropic" } });
        if (allowed[tier].includes(boundary)) {
          expect(refusal, `${tier}/${boundary} should be allowed`).toBeNull();
        } else {
          expect(refusal, `${tier}/${boundary} should be refused`).not.toBeNull();
          // The refusal names the tier and the boundary, so a client can render
          // a specific message rather than a generic 403.
          expect(refusal!.classification).toBe(tier);
          expect(refusal!.boundary).toBe(boundary);
          expect(refusal!.error).toContain(tier);
        }
      }
    }
  });

  /**
   * The §24 fallback: a `restricted` board still works offline. The mock
   * provider never leaves the process, so it is not an outbound boundary.
   */
  it("lets a restricted board use an in-process provider but not a real one", () => {
    expect(checkOutbound("restricted", "ai", { provider: { name: "mock" } })).toBeNull();
    expect(checkOutbound("restricted", "ai", { provider: { name: "anthropic" } })).not.toBeNull();
    // Fail closed: an unrecognized name is external.
    expect(checkOutbound("restricted", "ai", { provider: { name: "gateway" } })).not.toBeNull();
  });

  it("treats only the offline mocks as in-process", () => {
    expect(providerLeavesProcess({ name: "mock" })).toBe(false);
    // The image placeholder draws its SVG locally.
    expect(providerLeavesProcess({ name: "mock-image" })).toBe(false);
    for (const name of [
      "anthropic",
      "openai",
      "openai-compatible",
      "bedrock",
      "pollinations",
      "",
    ]) {
      expect(providerLeavesProcess({ name })).toBe(true);
    }
  });

  it("integrationBoundary returns a body only when the tier forbids integrations", () => {
    expect(integrationBoundary({ classification: "internal" })).toBeUndefined();
    expect(integrationBoundary({})).toBeUndefined();
    for (const tier of ["confidential", "restricted"] as const) {
      const refusal = integrationBoundary({ classification: tier });
      expect(refusal?.boundary).toBe("integration");
      expect(refusal?.classification).toBe(tier);
    }
  });
});

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

/**
 * The `ai` gate refuses content to providers that leave the process; the
 * offline mock is exempt by policy (classification.ts). Tests that want to see
 * the refusal therefore need a provider whose name is NOT "mock" — this stub
 * is that provider, and it fails loudly if a gate ever lets a call through
 * to it, proving "refused before the provider call" rather than asserting it.
 */
const EXTERNAL_STUB = {
  name: "vendor-stub",
  async generate(): Promise<never> {
    throw new Error("the provider must not be reached: the gate answers first");
  },
  async generateAnswer(): Promise<never> {
    throw new Error("the provider must not be reached: the gate answers first");
  },
} as unknown as LLMProvider;

async function harness(opts: { provider?: LLMProvider } = {}): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: opts.provider ?? new MockProvider(),
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
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    close: async () => {
      await close();
    },
  };
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
  expect(orgs.status).toBe(200);
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
  expect(created.status).toBe(201);
  return created.body.id as string;
}

/** Re-classify a board through the API the client would use. */
async function classify(
  h: Harness,
  boardId: string,
  actor: Actor,
  classification: BoardClassification,
) {
  const res = await api(h, "/api/boards", {
    method: "POST",
    token: actor.token,
    body: JSON.stringify({ id: boardId, classification }),
  });
  // The save route answers 201 on the create path.
  expect(res.status, `classify as ${classification} should succeed`).toBe(201);
  return res;
}

describe("classification routes: the boundary is actually enforced", () => {
  it("a board starts internal and can be re-classified by its owner", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.cls@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    const initial = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(initial.status).toBe(200);
    expect(initial.body.classification).toBe("internal");

    await classify(h, boardId, alice, "confidential");
    const after = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(after.body.classification).toBe("confidential");

    // The value survives a round trip through the store, not just the response.
    const listed = await api(h, `/api/boards?orgId=${encodeURIComponent(alice.orgId)}`, {
      token: alice.token,
    });
    expect(listed.status).toBe(200);
    const row = listed.body.boards.find((b: { id: string }) => b.id === boardId);
    expect(row.classification).toBe("confidential");
  });

  it("refuses an unknown classification rather than storing it", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.bad@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    // The helper asserts success, so these use the raw call: a bad tier is a
    // 400, not a stored value.
    for (const junk of ["PUBLIC", "secret", "", "Internal"]) {
      const res = await api(h, "/api/boards", {
        method: "POST",
        token: alice.token,
        body: JSON.stringify({ id: boardId, classification: junk }),
      });
      expect(res.status, `classification ${JSON.stringify(junk)} should be rejected`).toBe(400);
    }
    // Nothing was written by any of the refusals.
    const after = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(after.body.classification).toBe("internal");
  });

  it("refuses a re-classification from a non-owner", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.who@example.com");
    const eve = await signup(h, "eve.who@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    // The outsider is refused by the role/organization guard before any
    // classification logic runs: 404, so an outsider cannot confirm the board
    // exists, let alone that it has a tier.
    const refused = await api(h, "/api/boards", {
      method: "POST",
      token: eve.token,
      body: JSON.stringify({ id: boardId, classification: "confidential" }),
    });
    expect(refused.status).toBe(404);
    const after = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(after.body.classification).toBe("internal");
  });

  it("a confidential board refuses share links, and an internal one still mints them", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.share.cls@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    const minted = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(minted.status).toBe(201);

    await classify(h, boardId, alice, "confidential");
    const refused = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.boundary).toBe("sharing");
    expect(refused.body.classification).toBe("confidential");

    // The owner can still move the board back, and sharing works again — the
    // gate is a policy read, not a destructive lock.
    await classify(h, boardId, alice, "internal");
    const again = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(again.status).toBe(201);
  });

  it("a restricted board refuses generate without reaching the provider", async () => {
    const h = (open = await harness({ provider: EXTERNAL_STUB }));
    const alice = await signup(h, "alice.gen@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    // A 400 here means the body never reached the gate; the error names why.
    if (res.status !== 403) {
      throw new Error(`generate answered ${res.status}: ${JSON.stringify(res.body)}`);
    }
    expect(res.body.boundary).toBe("ai");
    expect(res.body.classification).toBe("restricted");
  });

  /**
   * The stream route moved its SSE headers behind every pre-flight gate so
   * the classification refusal arrives as a real 403 — an error frame inside
   * a 200 stream is how a client silently misses a governance refusal.
   */
  it("a restricted board refuses /api/generate/stream with a 403, before the SSE headers", async () => {
    const h = (open = await harness({ provider: EXTERNAL_STUB }));
    const alice = await signup(h, "alice.stream.cls@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await fetch(`${h.base}/api/generate/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({
        boardId,
        message: "make a flowchart",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    const body = (await res.json()) as { boundary?: string };
    expect(body.boundary).toBe("ai");
  });

  it("a restricted board refuses ask before the provider call", async () => {
    const h = (open = await harness({ provider: EXTERNAL_STUB }));
    const alice = await signup(h, "alice.ask.cls@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what is this board about?" }),
    });
    expect(res.status).toBe(403);
    expect(res.body.boundary).toBe("ai");
  });

  it("a confidential board still allows ask, because AI is not gated at that tier", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.ask.ok@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "confidential");

    const res = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what is this board about?" }),
    });
    // The ask itself may fail for other reasons (no entitlement, no content)
    // but it must not fail on the classification gate.
    expect(res.body.boundary).not.toBe("ai");
  });

  /**
   * The §24 fallback applied to the read direction: a restricted board can
   * still be asked about offline. Same exemption the generate test above
   * proves, stated for Ask so the policy covers both directions of the `ai`
   * boundary.
   */
  it("a restricted board still answers ask against the in-process mock provider", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.ask.offline@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await api(h, `/api/boards/${boardId}/ask`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ question: "what is this board about?" }),
    });
    expect(res.body.boundary).not.toBe("ai");
  });

  it("a confidential board refuses the integration routes it would otherwise accept", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.int.cls@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "confidential");

    // Both routes are editor-gated; the classification refusal must land
    // before the "integrations are not configured" 503, so a board that is
    // confidential cannot even begin an outbound flow.
    for (const path of [
      `/api/boards/${boardId}/integrations/linear/sync`,
      `/api/boards/${boardId}/integrations/linear/propose`,
    ]) {
      const res = await api(h, path, {
        method: "POST",
        token: alice.token,
        body: JSON.stringify({}),
      });
      expect(res.status, `${path} should be refused by classification`).toBe(403);
      expect(res.body.boundary).toBe("integration");
    }
  });

  it("a restricted board refuses integration actions too", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.rest.int@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await api(h, `/api/boards/${boardId}/integrations/linear/propose`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(res.body.boundary).toBe("integration");
    expect(res.body.classification).toBe("restricted");
  });

  /**
   * The advisory's §24 fallback, at the route level: a restricted board still
   * generates offline. The mock provider runs in-process, so it crosses no
   * boundary — refusing it would break local dev for no gain.
   */
  it("a restricted board still generates against the in-process mock provider", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.offline@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    const res = await api(h, "/api/generate", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        boardId,
        message: "a flowchart of the signup flow",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
      }),
    });
    // The mock is in-process, so the classification gate must not be what
    // answers. (The generation itself may fail for unrelated reasons.)
    expect(res.body.boundary).not.toBe("ai");
  });
});

/**
 * The `agent` boundary: MCP/agent clients ride the user's token, but the
 * agent's own model is a third party the org never chose. Two surfaces carry
 * it — the op-apply route (agents only; the web client never calls it) and
 * board reads marked `x-lucent-client: mcp` (packages/mcp/src/remote.ts).
 * A human's own read crosses no outbound boundary, so an unmarked GET is
 * untouched by construction, which is also why the marker is honest to be
 * cooperative rather than adversarial.
 */
describe("classification: the agent boundary is actually enforced", () => {
  const AGENT_OPS = [{ op: "CREATE_NODE", id: "n-agent-gate", nodeType: "step", label: "agent" }];

  it("refuses agent ops on a restricted board and applies them on an internal one", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.agent@example.com");
    const boardId = await newBoard(h, alice, "Plan");

    // internal: the same batch lands — the gate must not break the happy path.
    const applied = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: AGENT_OPS }),
    });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(1);

    await classify(h, boardId, alice, "restricted");
    const refused = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: [{ ...AGENT_OPS[0], id: "n-agent-refused" }] }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.boundary).toBe("agent");
    expect(refused.body.classification).toBe("restricted");
    // The refused batch never touched the board: the route refused before
    // parsing, so the second node does not exist while the first does.
    const after = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(after.body.workspace.nodes["n-agent-refused"]).toBeUndefined();
    expect(after.body.workspace.nodes["n-agent-gate"]).toBeTruthy();
  });

  it("allows agent ops on a confidential board — the boundary table says so", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.agent.conf@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "confidential");
    const res = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ ops: AGENT_OPS }),
    });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
  });

  it("refers a marked read on a restricted board, while the human's own read stands", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.agent.read@example.com");
    const boardId = await newBoard(h, alice, "Plan");
    await classify(h, boardId, alice, "restricted");

    // The human in the browser (no marker) still opens their own board —
    // classification gates egress to third parties, not the owner's eyes.
    const human = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(human.status).toBe(200);
    expect(human.body.workspace).toBeTruthy();

    const agent = await api(h, `/api/boards/${boardId}`, {
      token: alice.token,
      headers: { "x-lucent-client": "mcp" },
    });
    expect(agent.status).toBe(403);
    expect(agent.body.boundary).toBe("agent");
    expect(agent.body.workspace).toBeUndefined();

    // confidential allows the agent boundary: the marked read succeeds there.
    await classify(h, boardId, alice, "confidential");
    const conf = await api(h, `/api/boards/${boardId}`, {
      token: alice.token,
      headers: { "x-lucent-client": "mcp" },
    });
    expect(conf.status).toBe(200);
  });
});

/**
 * Store parity (docs/24 Phase A acceptance: "both stores enforce it
 * identically — a parity test, not two tests"). Enforcement lives in the
 * gates above; the storage contract must match. Gated on
 * LUCENT_TEST_DATABASE_URL, the same convention as boardListing.test.ts:
 * what is asserted is that the PG row and the in-memory object are
 * indistinguishable to `classificationOf`, the only reader the gates use.
 */
const PG_URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = PG_URL ? describe : describe.skip;

describeIf("PostgresBoardStore persists classification like the in-memory twin", () => {
  let db: Db;
  // Unique per run, so this file needs no TRUNCATE: wiping shared tables
  // would race the other pg suites, and every assertion here is scoped to
  // these ids.
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const org = `org_cls_${tag}`;
  const owner = `usr_cls_${tag}`;

  const board = (id: string, classification?: BoardClassification): StoredBoard => ({
    id,
    orgId: org,
    ownerId: owner,
    name: id,
    ...(classification ? { classification } : {}),
    workspace: createWorkspace(),
    createdAt: 1,
    updatedAt: 1,
  });

  beforeAll(async () => {
    if (!PG_URL) return;
    db = createDb(PG_URL);
    await migrate(db);
    // The org and user rows exist only to satisfy the FKs — same fixture
    // pattern as boardListing.test.ts.
    await db.pool.query("INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)", [
      org,
      "Classification",
      1,
    ]);
    await db.pool.query(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)",
      [owner, `${owner}@example.com`, owner, "salt:hash", 1],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool.query("DELETE FROM organizations WHERE id = $1", [org]).catch(() => {});
    await db.pool.query("DELETE FROM users WHERE id = $1", [owner]).catch(() => {});
    await closeDb(db);
  });

  it("round-trips every tier, and the twins resolve identically through the gate's reader", async () => {
    const pg = new PostgresBoardStore(db);
    const mem = new InMemoryBoardStore();
    const rows: StoredBoard[] = [
      board("brd_cls_internal", "internal"),
      board("brd_cls_confidential", "confidential"),
      board("brd_cls_restricted", "restricted"),
      board("brd_cls_unset"),
    ];
    for (const b of rows) {
      await pg.put(b);
      await mem.put(b);
    }
    for (const b of rows) {
      const inPg = await pg.get(b.id);
      const inMem = await mem.get(b.id);
      expect(inPg).toBeTruthy();
      expect(inMem).toBeTruthy();
      // The unset label is ABSENT, not null or "internal", on both twins, so
      // classificationOf's default stays the single source of the answer.
      expect(inPg!.classification).toBe(inMem!.classification);
      expect(classificationOf(inPg!)).toBe(classificationOf(inMem!));
      expect(classificationOf(inPg!)).toBe(b.classification ?? "internal");
    }
  });

  it("hands an uninterpretable label to the gate unmutated, where fail-closed decides", async () => {
    // The column is plain text with no CHECK — the CHECK would be migration
    // churn against rows the routes never write, and the enforcement boundary
    // is the gate, not the storage. What parity guarantees is that BOTH twins
    // hand the garbage up unchanged and classificationOf resolves it to the
    // strictest tier, so a gate never sees a fourth tier it must guess about.
    const pg = new PostgresBoardStore(db);
    await pg.put(board("brd_cls_garbage"));
    await db.pool.query("UPDATE boards SET classification = 'secret' WHERE id = $1", [
      "brd_cls_garbage",
    ]);
    const inPg = await pg.get("brd_cls_garbage");
    expect(inPg!.classification).toBe("secret" as BoardClassification);
    expect(classificationOf(inPg!)).toBe("restricted");
    // The in-memory twin behaves identically with the same value.
    const inMem = await (await memPutGarbage()).get("brd_cls_garbage");
    expect(classificationOf(inMem!)).toBe("restricted");
  });
});

async function memPutGarbage(): Promise<InMemoryBoardStore> {
  const mem = new InMemoryBoardStore();
  await mem.put({
    id: "brd_cls_garbage",
    orgId: "org_cls_mem",
    ownerId: "usr_cls_mem",
    name: "garbage",
    classification: "secret" as never,
    workspace: createWorkspace(),
    createdAt: 1,
    updatedAt: 1,
  });
  return mem;
}
