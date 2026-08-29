import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { MockProvider, MockImageProvider, summarizeWorkspace } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore, type UserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore, type OrgInviteStore } from "../src/invites.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryUsageStore, newUsageEventId, type UsageKind } from "../src/usageStore.js";
import { PLAN_LADDER } from "../src/plans.js";

/**
 * M4: the entitlement gates on the HTTP surface.
 *
 * Free-tier assertions need no seeding -- `createEntitlements` falls back to the
 * compiled-in Free plan when an org has no subscription row, which is the state
 * every fresh signup is in. Only the upgrade cases seed `PLAN_LADDER` and write
 * a subscription.
 *
 * The numbers asserted here are Free's, from plans.ts: 3 boards, 1 seat, 50 AI
 * generations a month, PNG-only exports. They are deliberately repeated as
 * literals rather than imported -- a test that reads its expectations from the
 * same constant it is testing would pass through a pricing change that broke
 * every gate.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";
const EMPTY_SUMMARY = summarizeWorkspace(createWorkspace());

interface Harness {
  usage: InMemoryUsageStore | undefined;
  userStore: UserStore;
  inviteStore: OrgInviteStore;
  close: () => Promise<void>;
  signup: (
    email: string,
    name?: string,
  ) => Promise<{ cookies: string; csrf: string; userId: string; orgId: string }>;
  api: (
    cookies: string,
    init: { method?: string; path: string; body?: unknown; csrf?: string },
  ) => Promise<{ status: number; body: any }>;
}

/** `billing: false` leaves `usageStore` unwired, which must disable every gate. */
async function harness({ billing = true }: { billing?: boolean } = {}): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const inviteStore = new InMemoryOrgInviteStore();
  const usage = billing ? new InMemoryUsageStore() : undefined;
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(50, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    orgStore: new InMemoryOrgStore(),
    inviteStore,
    notifications: new InMemoryNotificationStore(),
    ...(usage ? { usageStore: usage } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  function pickCookie(setCookie: string, name: string): string | undefined {
    for (const raw of setCookie.split(/,(?=[^;]+=)/)) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      if (raw.slice(0, eq).trim() !== name) continue;
      return raw.slice(eq + 1).split(";")[0] ?? "";
    }
    return undefined;
  }

  const api: Harness["api"] = async (cookies, init) => {
    const headers: Record<string, string> = { origin: ORIGIN, cookie: cookies };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.csrf) headers["x-csrf-token"] = init.csrf;
    const res = await fetch(`${base}${init.path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  };

  const signup: Harness["signup"] = async (email, name) => {
    const csrfRes = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
    const csrfBody = (await csrfRes.json()) as { token: string };
    const csrfCookie = pickCookie(csrfRes.headers.get("set-cookie") ?? "", "lucent_csrf");
    if (!csrfCookie) throw new Error("csrf route did not set a cookie");
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie: `lucent_csrf=${csrfCookie}`,
        "x-csrf-token": csrfBody.token,
      },
      body: JSON.stringify({ email, password: "password123", name: name ?? email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string } };
    const session = pickCookie(res.headers.get("set-cookie") ?? "", "lucent_session");
    if (!session) throw new Error("signup did not set a session cookie");
    const cookies = `lucent_session=${session}; lucent_csrf=${csrfCookie}`;
    const me = await api(cookies, { path: "/api/auth/me" });
    const orgId = (me.body.memberships as Array<{ orgId: string }>)[0]!.orgId;
    return { cookies, csrf: csrfBody.token, userId: body.user.id, orgId };
  };
  return { usage, userStore, inviteStore, close, signup, api };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/**
 * Metering is fire-and-forget by design (a failed usage write must not turn a
 * delivered generation into a 500), so the assertion has to wait for a write the
 * response did not await.
 */
async function meteredCount(h: Harness, orgId: string, kind: UsageKind, want: number) {
  const store = h.usage!;
  for (let i = 0; i < 100; i += 1) {
    const n = await store.monthToDate(orgId, kind, Date.now());
    if (n >= want) return n;
    await new Promise((r) => setTimeout(r, 5));
  }
  return store.monthToDate(orgId, kind, Date.now());
}

/** Put the org on a paid tier, the way a completed checkout will. */
async function upgrade(h: Harness, orgId: string, plan: string, seats = 1) {
  const now = Date.now();
  await h.usage!.seedPlans(PLAN_LADDER, now);
  await h.usage!.putSubscription({
    orgId,
    plan,
    seats,
    status: "active",
    periodStart: now,
    periodEnd: now + 30 * 24 * 60 * 60 * 1000,
    cancelAt: null,
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function makeBoard(h: Harness, who: { cookies: string; csrf: string }, name: string) {
  return h.api(who.cookies, {
    method: "POST",
    path: "/api/boards",
    csrf: who.csrf,
    body: { name, workspace: createWorkspace() },
  });
}
describe("the boards ceiling", () => {
  it("refuses the fourth board on Free with a structured 402", async () => {
    const h = (open = await harness());
    const alice = await h.signup("boards@example.test");
    for (let i = 0; i < 3; i += 1) {
      expect((await makeBoard(h, alice, `B${i}`)).status).toBe(201);
    }
    const refused = await makeBoard(h, alice, "B4");
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({
      reason: "plan_limit",
      key: "boards",
      plan: "free",
      planName: "Free",
      limit: 3,
      used: 3,
      upgradeUrl: "/settings/billing",
    });
    // The refusal has to name a way out, or it is a dead end rather than a
    // paywall. `suggestedPlan` is what the upgrade button binds to.
    expect(refused.body.suggestedPlan).toBeTruthy();
  });

  it("still saves an existing board when the org is at its ceiling", async () => {
    const h = (open = await harness());
    const alice = await h.signup("boards-update@example.test");
    const first = await makeBoard(h, alice, "First");
    for (let i = 0; i < 2; i += 1) await makeBoard(h, alice, `Filler${i}`);
    expect((await makeBoard(h, alice, "Over")).status).toBe(402);
    // A downgrade routinely leaves an org above its new ceiling. Stranding the
    // work already in there behind the paywall would be a data-loss bug.
    const saved = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/boards",
      csrf: alice.csrf,
      body: { id: first.body.id, name: "Renamed" },
    });
    expect([200, 201]).toContain(saved.status);
    const read = await h.api(alice.cookies, { path: `/api/boards/${first.body.id}` });
    expect(read.body.name).toBe("Renamed");
  });

  it("lifts the ceiling on a paid tier", async () => {
    const h = (open = await harness());
    const alice = await h.signup("boards-paid@example.test");
    await upgrade(h, alice.orgId, "team", 3);
    for (let i = 0; i < 5; i += 1) {
      expect((await makeBoard(h, alice, `B${i}`)).status).toBe(201);
    }
  });
});
describe("the export gate", () => {
  it("allows the format Free includes, refuses the ones it sells, and meters both", async () => {
    const h = (open = await harness());
    const alice = await h.signup("export@example.test");
    const board = await makeBoard(h, alice, "Exportable");
    const path = `/api/boards/${board.body.id}/export`;

    const png = await h.api(alice.cookies, {
      method: "POST",
      path,
      csrf: alice.csrf,
      body: { format: "png" },
    });
    expect(png.status).toBe(200);
    expect(png.body).toMatchObject({ ok: true, format: "png" });
    expect(await meteredCount(h, alice.orgId, "export", 1)).toBe(1);

    const pdf = await h.api(alice.cookies, {
      method: "POST",
      path,
      csrf: alice.csrf,
      body: { format: "pdf" },
    });
    expect(pdf.status).toBe(402);
    expect(pdf.body).toMatchObject({ reason: "plan_feature", key: "export.formats", plan: "free" });
    // A refused export is not a billable export.
    expect(await h.usage!.monthToDate(alice.orgId, "export", Date.now())).toBe(1);
  });

  it("rejects an unknown format as a bad request, not a paywall", async () => {
    const h = (open = await harness());
    const alice = await h.signup("export-bad@example.test");
    const board = await makeBoard(h, alice, "Exportable");
    const res = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/boards/${board.body.id}/export`,
      csrf: alice.csrf,
      body: { format: "dwg" },
    });
    expect(res.status).toBe(400);
  });

  it("opens every format on a paid tier", async () => {
    const h = (open = await harness());
    const alice = await h.signup("export-paid@example.test");
    await upgrade(h, alice.orgId, "pro");
    const board = await makeBoard(h, alice, "Exportable");
    for (const format of ["png", "svg", "pdf", "json", "mermaid"]) {
      const res = await h.api(alice.cookies, {
        method: "POST",
        path: `/api/boards/${board.body.id}/export`,
        csrf: alice.csrf,
        body: { format },
      });
      expect(res.status, format).toBe(200);
    }
  });
});
describe("the seats ceiling", () => {
  it("refuses an invite once the paid seats are full, and counts pending ones", async () => {
    const h = (open = await harness());
    const alice = await h.signup("seats@example.test");
    // Free is one seat and Alice is already in it.
    const refused = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/orgs/${alice.orgId}/invites`,
      csrf: alice.csrf,
      body: { email: "bob@example.test", role: "editor" },
    });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ reason: "plan_limit", key: "seats", limit: 1, used: 1 });

    await upgrade(h, alice.orgId, "team", 3);
    const sent = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/orgs/${alice.orgId}/invites`,
      csrf: alice.csrf,
      body: { email: "bob@example.test", role: "editor" },
    });
    expect(sent.status).toBe(204);
    // The invite now occupies a seat nobody sits in yet: used is 2, not 1.
    const live = await h.inviteStore.listForOrg(alice.orgId, Date.now());
    expect(live).toHaveLength(1);
  });

  it("refuses a stranger redeeming an invite into a full org", async () => {
    const h = (open = await harness());
    const alice = await h.signup("seats-accept@example.test");
    const bob = await h.signup("seats-bob@example.test");
    // Written straight into the store: the send-side gate would have refused
    // this, and the point is that an org can also fill up while an invite sits
    // in someone's inbox for a week.
    const token = randomBytes(32).toString("base64url");
    await h.inviteStore.create({
      orgId: alice.orgId,
      email: "seats-bob@example.test",
      role: "editor",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      invitedBy: alice.userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    const res = await h.api(bob.cookies, {
      method: "POST",
      path: "/api/invites/accept",
      csrf: bob.csrf,
      body: { token },
    });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ reason: "plan_limit", key: "seats" });
    // Refused means not joined -- a 402 that still writes the row is worse than
    // no gate at all.
    expect(await h.userStore.countMembers(alice.orgId)).toBe(1);
  });
});
describe("the seats ceiling does not break idempotence", () => {
  it("lets an existing member redeem an invite into a full org", async () => {
    const h = (open = await harness());
    const alice = await h.signup("seats-idem@example.test");
    const token = randomBytes(32).toString("base64url");
    await h.inviteStore.create({
      orgId: alice.orgId,
      email: "seats-idem@example.test",
      role: "editor",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      invitedBy: alice.userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    // Alice already holds a row in this org, so redeeming takes no new seat. The
    // gate has to notice that, or a second click on an accept link 402s once the
    // org fills up.
    const res = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/invites/accept",
      csrf: alice.csrf,
      body: { token },
    });
    expect(res.status).toBe(200);
  });
});

describe("the monthly AI allowance", () => {
  it("refuses generate once the month's allowance is spent", async () => {
    const h = (open = await harness());
    const alice = await h.signup("ai@example.test");
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) {
      await h.usage!.record({
        id: newUsageEventId(),
        orgId: alice.orgId,
        kind: "ai.generation",
        quantity: 1,
        at: now,
      });
    }
    const res = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/generate",
      csrf: alice.csrf,
      body: { message: "draw me a flowchart", summary: EMPTY_SUMMARY },
    });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      reason: "plan_limit",
      key: "ai.generationsPerMonth",
      limit: 50,
      used: 50,
    });
    // The reset date is the whole answer to "when can I use this again", and a
    // monthly allowance that cannot say it is just a dead end.
    expect(typeof res.body.resetsAt).toBe("number");
  });
  it("meters a successful generation, and bills the caller's org for a board they cannot edit", async () => {
    const h = (open = await harness());
    const alice = await h.signup("ai-owner@example.test");
    const eve = await h.signup("ai-eve@example.test");
    const board = await makeBoard(h, alice, "Alice's board");

    // Eve names a board id she holds no grant on. Billing the board's org would
    // let anyone drain a stranger's monthly allowance by guessing an id, so the
    // charge lands on Eve's own org instead.
    const res = await h.api(eve.cookies, {
      method: "POST",
      path: "/api/generate",
      csrf: eve.csrf,
      body: { message: "add a node", summary: EMPTY_SUMMARY, boardId: board.body.id },
    });
    expect(res.status).toBe(200);
    expect(await meteredCount(h, eve.orgId, "ai.generation", 1)).toBe(1);
    expect(await h.usage!.monthToDate(alice.orgId, "ai.generation", Date.now())).toBe(0);
  });

  it("meters an image generation against the allowance it was gated on", async () => {
    const h = (open = await harness());
    const alice = await h.signup("ai-image@example.test");
    const res = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/image",
      csrf: alice.csrf,
      body: { prompt: "a cat" },
    });
    expect(res.status).toBe(200);
    // Deliberately `ai.generation`, not `image.generation`: the gate reads
    // month-to-date for the kind the entitlement maps to, so a separate kind
    // would leave images checked against text usage and never counted. This
    // assertion is the one that fails if the two ever drift apart again.
    expect(await meteredCount(h, alice.orgId, "ai.generation", 1)).toBe(1);
    // The image.line item is recorded too (with billedAs: "ai.generation") so
    // an image is visible as an image in the usage log without doubling the
    // charge against the AI allowance — a reconciliation query sums both kinds
    // and de-duplicates by billedAs.
    expect(await h.usage!.monthToDate(alice.orgId, "image.generation", Date.now())).toBe(1);
  });

  it("refuses an image once the shared allowance is spent", async () => {
    const h = (open = await harness());
    const alice = await h.signup("ai-image-full@example.test");
    for (let i = 0; i < 50; i += 1) {
      await h.usage!.record({
        id: newUsageEventId(),
        orgId: alice.orgId,
        kind: "ai.generation",
        quantity: 1,
        at: Date.now(),
      });
    }
    const res = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/image",
      csrf: alice.csrf,
      body: { prompt: "a cat" },
    });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ key: "ai.generationsPerMonth", used: 50 });
  });
});

describe("GET /api/orgs/:id/billing", () => {
  it("reports the plan, the month's usage and every ceiling in one response", async () => {
    const h = (open = await harness());
    const alice = await h.signup("billing@example.test");
    await makeBoard(h, alice, "One");
    await makeBoard(h, alice, "Two");

    const res = await h.api(alice.cookies, { path: `/api/orgs/${alice.orgId}/billing` });
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ code: "free", name: "Free", status: null });
    // No subscription row is not the same as a failed payment, and the pane has
    // to be able to tell those apart.
    expect(res.body.plan.fallback).toBe(true);
    expect(res.body.upgradeUrl).toBe("/settings/billing");

    const rows = res.body.limits as Array<{
      key: string;
      limit: number | null;
      used: number | null;
      remaining: number | null;
      unlimited: boolean;
    }>;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("boards")).toMatchObject({ limit: 3, used: 2, remaining: 1 });
    expect(byKey.get("seats")).toMatchObject({ limit: 1, used: 1, remaining: 0 });
    expect(byKey.get("ai.generationsPerMonth")).toMatchObject({ limit: 50, used: 0 });
    // Op-log depth is per board, so there is no org total to show. A zero would
    // read as "you have used none of it".
    expect(byKey.get("history.depth")).toMatchObject({ used: null, remaining: null });
    expect(res.body.exportFormats).toMatchObject({ allowed: ["png"] });
    expect(res.body.exportFormats.all).toContain("pdf");
  });

  it("shows a paid plan as not a fallback, with the ceilings lifted", async () => {
    const h = (open = await harness());
    const alice = await h.signup("billing-paid@example.test");
    await upgrade(h, alice.orgId, "team", 4);
    const res = await h.api(alice.cookies, { path: `/api/orgs/${alice.orgId}/billing` });
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({
      code: "team",
      status: "active",
      fallback: false,
      seats: 4,
    });
    const rows = res.body.limits as Array<{
      key: string;
      limit: number | null;
      unlimited: boolean;
    }>;
    const boards = rows.find((r) => r.key === "boards")!;
    expect(boards).toMatchObject({ limit: null, unlimited: true });
    // A pooled per-seat allowance is reported already multiplied out: 1,500 x 4.
    expect(rows.find((r) => r.key === "ai.generationsPerMonth")!.limit).toBe(6_000);
  });
  it("hides another org's billing behind the same 404 as the org itself", async () => {
    const h = (open = await harness());
    const alice = await h.signup("billing-alice@example.test");
    const eve = await h.signup("billing-eve@example.test");
    const res = await h.api(eve.cookies, { path: `/api/orgs/${alice.orgId}/billing` });
    // Not 403: the org guard answers 404 for "does not exist" and "not yours"
    // alike, so org ids stay unguessable. Spend figures are exactly the kind of
    // thing that must not leak from that seam.
    expect(res.status).toBe(404);
  });

  it("says billing is unconfigured rather than reporting a confident Free plan", async () => {
    const h = (open = await harness({ billing: false }));
    const alice = await h.signup("billing-off@example.test");
    const res = await h.api(alice.cookies, { path: `/api/orgs/${alice.orgId}/billing` });
    // The one place in this file where a missing store does not open the gate:
    // rendering limits nobody enforces is worse than rendering nothing.
    expect(res.status).toBe(503);
  });
});

describe("an unconfigured billing integration", () => {
  it("disables the gates instead of closing them", async () => {
    const h = (open = await harness({ billing: false }));
    const alice = await h.signup("nostore@example.test");
    // Free's ceiling is three. Without a usage store there is no ceiling at
    // all: a deployment that has not wired billing is an unmetered one, not a
    // locked-out one, and a missing Stripe key must never read as an outage.
    for (let i = 0; i < 5; i += 1) {
      expect((await makeBoard(h, alice, `B${i}`)).status).toBe(201);
    }
    const board = await makeBoard(h, alice, "Exportable");
    const pdf = await h.api(alice.cookies, {
      method: "POST",
      path: `/api/boards/${board.body.id}/export`,
      csrf: alice.csrf,
      body: { format: "pdf" },
    });
    expect(pdf.status).toBe(200);
    const generated = await h.api(alice.cookies, {
      method: "POST",
      path: "/api/generate",
      csrf: alice.csrf,
      body: { message: "draw me a flowchart", summary: EMPTY_SUMMARY },
    });
    expect(generated.status).toBe(200);
  });
});
