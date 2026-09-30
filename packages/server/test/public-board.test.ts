import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
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

/**
 * docs/26: public read-only board sharing. An editor opts a board in; anyone
 * with the token reads a sanitized snapshot without an account; revoking makes
 * it go dark. The GET is the one unauthenticated route, so its boundary — only
 * tokened boards, stripped of authorship/PII, nothing else — is the whole test.
 */

const SECRET = "public-board-secret-16chars";

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

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
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
  init: { method?: string; body?: unknown; token?: string; origin?: boolean } = {},
) {
  const res = await fetch(`${h.base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.origin === false ? {} : { origin: h.base }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function signup(h: Harness, email: string): Promise<string> {
  const r = await api(h, "/api/auth/signup", {
    method: "POST",
    body: { email, password: "password123", name: email },
  });
  expect(r.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return r.body.token as string;
}

async function makeBoard(h: Harness, token: string): Promise<string> {
  // createWorkspace() initializes comments/votes/reactions as {} — so a raw
  // snapshot would carry those keys, and the assertions below prove the route
  // strips them.
  const r = await api(h, "/api/boards", {
    method: "POST",
    token,
    body: { name: "Roadmap", workspace: createWorkspace() },
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("public board sharing", () => {
  it("publishes read-only, serves it without an account, and revokes it", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "owner@acme.com");
    const board = await makeBoard(h, owner);

    // Publish (editor) → token.
    const pub = await api(h, `/api/boards/${board}/public`, { method: "POST", token: owner });
    expect(pub.status).toBe(200);
    const token = pub.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(pub.body.path).toBe(`/p/${token}`);
    // Idempotent: publishing again returns the same token.
    const again = await api(h, `/api/boards/${board}/public`, { method: "POST", token: owner });
    expect(again.body.token).toBe(token);

    // Read it with NO credentials at all (not even an Origin), even though
    // the deployment requires auth.
    const view = await api(h, `/api/public/boards/${token}`, { origin: false });
    expect(view.status).toBe(200);
    expect(view.body.name).toBe("Roadmap");
    expect(view.body.workspace).toBeTruthy();
    // Sanitized: the authorship/collaboration layer is gone, and nothing about
    // the record leaks.
    expect(view.body.workspace.comments).toBeUndefined();
    expect(view.body.workspace.votes).toBeUndefined();
    expect(view.body.workspace.reactions).toBeUndefined();
    expect(view.body.orgId).toBeUndefined();
    expect(view.body.publicToken).toBeUndefined();
    expect(view.body.workspace.nodes).toBeDefined();

    // Revoke → the token goes dark.
    const del = await api(h, `/api/boards/${board}/public`, { method: "DELETE", token: owner });
    expect(del.status).toBe(200);
    expect((await api(h, `/api/public/boards/${token}`, { origin: false })).status).toBe(404);
  });

  it("only an editor can publish, and an unknown token is a 404", async () => {
    const h = (open = await harness());
    const owner = await signup(h, "ow@acme.com");
    const board = await makeBoard(h, owner);
    const stranger = await signup(h, "st@acme.com");

    const denied = await api(h, `/api/boards/${board}/public`, { method: "POST", token: stranger });
    expect([403, 404]).toContain(denied.status);
    // The stranger's failed attempt did not publish anything.
    expect((await api(h, "/api/public/boards/nonexistent-token", { origin: false })).status).toBe(
      404,
    );
    // Anonymous can't publish either.
    expect((await api(h, `/api/boards/${board}/public`, { method: "POST" })).status).toBe(401);
  });
});
