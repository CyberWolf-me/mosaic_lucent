import { MockImageProvider, MockProvider } from "@lucent/ai";
import type { LLMProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { PostgresOrgStore } from "../src/orgs.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import { closeDb, createDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import type { AddressInfo } from "node:net";

/**
 * docs/24 Phase C live proof: a real HTTP server, real Postgres, and the
 * provider policy enforced at the routes. What is proven, in order:
 *
 *   1. An owner sets `self-hosted-only` through the admin API; the audit row
 *      names the changed key.
 *   2. A member READS the provider policy (the acceptance's "every member
 *      sees it") and cannot read the full plane.
 *   3. A BYO cloud key is refused with a named 403 even with
 *      LUCENT_ALLOW_BYO_KEYS=1 — org policy beats the deployment flag.
 *   4. The same deployment, declared self-hosted, serves generation again.
 *   5. The refusal lands in telemetry as `policy`, distinct from rate/quota.
 *
 * Run: LUCENT_DATABASE_URL=... npx tsx --conditions=development scripts/c-live-check.ts
 */

const url = process.env.LUCENT_DATABASE_URL;
if (!url) {
  console.error("LUCENT_DATABASE_URL is required (this is the live check).");
  process.exit(2);
}

const db = createDb(url);
await migrate(db);

// A provider that THROWS if reached, so "the gate answered first" is proven
// by a clean 403 rather than by the model being kind enough not to run.
const cloudStub = {
  name: "anthropic",
  async generate(): Promise<never> {
    throw new Error("the provider must not be reached: the policy gate answers first");
  },
  async generateAnswer(): Promise<never> {
    throw new Error("the provider must not be reached: the policy gate answers first");
  },
} as unknown as LLMProvider;

const limits = limitsFromEnv();
const telemetry = new Telemetry();
const userStore = new InMemoryUserStore();
const orgStore = new PostgresOrgStore(db);
const boardStore = new PostgresBoardStore(db);

async function boot(opts: { provider: LLMProvider; allowByo: boolean; selfHosted: boolean }) {
  const { server, close } = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }),
      requireAuth: true,
      allowByoKeys: opts.allowByo,
      aiSelfHosted: opts.selfHosted,
    },
    provider: opts.provider,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    orgStore,
    secret: "live-check-secret-at-least-16",
    usage: new UsageTracker(limits),
    limits,
    telemetry,
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetingStore: new InMemoryMeetingStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close };
}

async function api(
  base: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
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
}

const tag = `${Date.now().toString(36)}`;
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step} — ${detail}`);
}

const { base, close } = await boot({ provider: cloudStub, allowByo: true, selfHosted: false });

// 1. Sign up the owner (verified, so nothing else gates the run).
const created = await api(base, "/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ email: `owner.${tag}@example.com`, password: "password123", name: "Owner" }),
});
if (created.status !== 201) throw new Error(`signup failed: ${created.status} ${JSON.stringify(created.body)}`);
const owner = { token: created.body.token as string, id: created.body.user.id as string };
const found = await userStore.findByEmail(`owner.${tag}@example.com`);
if (found) await userStore.setEmailVerified(found.id, Date.now());
const orgs = await api(base, "/api/orgs", { token: owner.token });
const orgId = orgs.body.orgs[0].id as string;
console.log(`org: ${orgId}`);

// 2. The owner sets the strictest provider mode.
const patched = await api(base, `/api/orgs/${orgId}/settings`, {
  method: "PATCH",
  token: owner.token,
  body: JSON.stringify({ providerPolicy: { mode: "self-hosted-only" } }),
});
record(
  "1. owner PATCHes providerPolicy=self-hosted-only",
  patched.status === 200 && patched.body.effective.providerPolicy.mode === "self-hosted-only",
  `status=${patched.status} effective=${JSON.stringify(patched.body.effective?.providerPolicy)}`,
);
const audit = await api(base, `/api/orgs/${orgId}/audit`, { token: owner.token });
const row = (audit.body.entries ?? []).find((e: any) => e.action === "org.settings");
record(
  "2. the audit row names the changed key",
  Boolean(row) && JSON.stringify(row.metadata.changed).includes("providerPolicy"),
  `action=${row?.action} changed=${JSON.stringify(row?.metadata?.changed)}`,
);

// 3. A member reads the policy but not the full plane.
const member = await api(base, "/api/auth/signup", {
  method: "POST",
  body: JSON.stringify({ email: `member.${tag}@example.com`, password: "password123", name: "Member" }),
});
const memberUser = await userStore.findByEmail(`member.${tag}@example.com`);
if (memberUser) {
  await userStore.setMembership({ userId: memberUser.id, orgId, role: "editor" });
}
const memberRead = await api(base, `/api/orgs/${orgId}/policy`, { token: member.body.token });
record(
  "3. a member reads the provider policy",
  memberRead.status === 200 && memberRead.body.providerPolicy?.mode === "self-hosted-only",
  `status=${memberRead.status} body=${JSON.stringify(memberRead.body)}`,
);
const memberSettings = await api(base, `/api/orgs/${orgId}/settings`, { token: member.body.token });
record(
  "4. ...but not the full plane (404, ids unguessable)",
  memberSettings.status === 404,
  `status=${memberSettings.status}`,
);

// 4. A BYO cloud key dies on the org policy even with the deployment flag ON.
const board = await api(base, "/api/boards", {
  method: "POST",
  token: owner.token,
  body: JSON.stringify({ name: "Live board" }),
});
const boardId = board.body.id as string;
const byo = await api(base, "/api/generate/stream", {
  method: "POST",
  token: owner.token,
  headers: { "x-lucent-provider-key": "sk-ant-live-check", "x-lucent-provider": "anthropic" },
  body: JSON.stringify({
    boardId,
    message: "make a flowchart",
    summary: { diagramKind: "flowchart", nodes: [], edges: [] },
  }),
});
record(
  "5. BYO key refused under self-hosted-only (LUCENT_ALLOW_BYO_KEYS=1)",
  byo.status === 403 && byo.body.boundary === "provider" && byo.body.policy === "self-hosted-only",
  `status=${byo.status} body=${JSON.stringify(byo.body)}`,
);

// 5. The cloud default provider is refused too (not declared self-hosted).
const gen = await api(base, "/api/generate", {
  method: "POST",
  token: owner.token,
  body: JSON.stringify({
    boardId,
    message: "make a flowchart",
    summary: { diagramKind: "flowchart", nodes: [], edges: [] },
  }),
});
record(
  "6. undeclared cloud provider refused (no spend — the stub would throw)",
  gen.status === 403 && gen.body.boundary === "provider",
  `status=${gen.status} body=${JSON.stringify(gen.body)}`,
);
record(
  "7. telemetry counts the refusals as `policy`, apart from rate/quota",
  telemetry.snapshot().refusals.policy === 2 &&
    telemetry.snapshot().refusals.rate === 0 &&
    telemetry.snapshot().refusals.quota === 0,
  `refusals=${JSON.stringify(telemetry.snapshot().refusals)}`,
);

await close();

// 6. A deployment that DECLARES itself self-hosted serves the same org again.
const second = await boot({ provider: new MockProvider(), allowByo: true, selfHosted: true });
const gen2 = await api(second.base, "/api/generate", {
  method: "POST",
  token: owner.token,
  body: JSON.stringify({
    boardId,
    message: "make a flowchart",
    summary: { diagramKind: "flowchart", nodes: [], edges: [] },
  }),
});
record(
  "8. the same org generates on a self-hosted-declared deployment",
  gen2.status === 200 && gen2.body.policy === undefined,
  `status=${gen2.status} policy=${gen2.body.policy ?? "none"}`,
);
await second.close();

await db.pool.query("DELETE FROM organizations WHERE id = $1", [orgId]).catch(() => {});
await closeDb(db);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length > 0) {
  console.error("FAILED:", failed.map((f) => f.step).join("; "));
  process.exit(1);
}
console.log("Phase C live check: all steps passed.");
