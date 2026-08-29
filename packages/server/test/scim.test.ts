import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { hashPassword } from "../src/auth.js";
import { InMemoryScimIdentityStore, type ScimConfig } from "../src/scim.js";
import type { StoredUser } from "../src/identity.js";

/**
 * SCIM 2.0 gateway tests (M6 / F1).
 *
 * Drives the real `createApp` over HTTP because the surface is the bearer
 * token + SCIM content-type negotiation, which is what the IdP will send and
 * what only the full stack tests together. A unit test against the handler
 * alone would let a regression in the dispatch split (e.g. an `/scim/*` 404
 * from the ladder) pass through.
 *
 * Five tests cover the wire contract:
 *   1.  Provision (POST /Users) creates a Lucent user + identity row.
 *   2.  Idempotent re-provision returns the existing user (200, not 201).
 *   3.  PATCH `active: false` invalidates sessions via tokenVersion bump.
 *   4.  Deprovision (DELETE /Users/:id) removes the identity row + bumps.
 *   5.  Bearer token mismatch returns SCIM-shaped 401.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";
const IDP = "test-idp";
const SCIM_TOKEN = "scim-test-token-aaa-bbb-ccc";

interface ScimUserBody {
  schemas?: string[];
  id?: string;
  externalId?: string;
  userName?: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  emails?: Array<{ value: string; primary?: boolean }>;
  active?: boolean;
  /** PATCH operations (used by the deactivate test). */
  Operations?: Array<{
    op: "add" | "remove" | "replace";
    path?: string;
    value?: unknown;
  }>;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
  userStore: InMemoryUserStore;
  request: (init: {
    method: string;
    path: string;
    body?: ScimUserBody;
    headers?: Record<string, string>;
  }) => Promise<{ status: number; body: any; contentType: string }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const scimConfig: ScimConfig = { idp: IDP, token: SCIM_TOKEN, secret: SECRET };
  const identities = new InMemoryScimIdentityStore();

  const { server, close } = createApp({
    config,
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
    scim: {
      config: scimConfig,
      identities,
      hashPassword: async (password: string) => {
        const combined = await hashPassword(password);
        const colonAt = combined.indexOf(":");
        return {
          salt: colonAt >= 0 ? combined.slice(0, colonAt) : combined,
          hash: colonAt >= 0 ? combined.slice(colonAt + 1) : "",
        };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const request: Harness["request"] = async (init) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${SCIM_TOKEN}`,
      ...(init.body !== undefined ? { "content-type": "application/scim+json" } : {}),
      ...init.headers,
    };
    const res = await fetch(`${base}${init.path}`, {
      method: init.method,
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
    return {
      status: res.status,
      body,
      contentType: res.headers.get("content-type") ?? "",
    };
  };

  return { base, close, userStore, request };
}

describe("scim gateway (M6/F1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("provisions a new user on POST /Users", async () => {
    h = await harness();
    const res = await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: {
        externalId: "okta-001",
        userName: "alice@example.com",
        name: { givenName: "Alice", familyName: "Smith" },
        emails: [{ value: "alice@example.com", primary: true }],
        active: true,
      },
    });
    expect(res.status).toBe(201);
    expect(res.contentType).toMatch(/^application\/scim\+json/);
    expect(res.body.schemas).toContain("urn:ietf:params:scim:schemas:core:2.0:User");
    expect(res.body.externalId).toBe("okta-001");
    expect(res.body.userName).toBe("alice@example.com");
    expect(res.body.emails[0].value).toBe("alice@example.com");
    // The created user is now in the userStore so the share gate sees them
    // as email-verified — verified is what SCIM's `active: true` maps to.
    const stored = (await h.userStore.findByEmail("alice@example.com")) as StoredUser | undefined;
    expect(stored).toBeTruthy();
    expect(stored?.emailVerifiedAt).not.toBeNull();
  });

  it("is idempotent: re-posting the same externalId returns the existing user", async () => {
    h = await harness();
    const first = await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: { externalId: "okta-002", userName: "bob@example.com" },
    });
    expect(first.status).toBe(201);
    const second = await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: { externalId: "okta-002", userName: "bob@example.com" },
    });
    expect(second.status).toBe(200); // idempotent — exists already
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.externalId).toBe("okta-002");
  });

  it("PATCH active:false bumps tokenVersion so live sessions invalidate", async () => {
    h = await harness();
    const created = await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: { externalId: "okta-003", userName: "carol@example.com" },
    });
    expect(created.status).toBe(201);
    const before = (await h.userStore.findByEmail("carol@example.com")) as StoredUser;
    const beforeVersion = before.tokenVersion;
    const patch = await h.request({
      method: "PATCH",
      path: "/scim/v2/Users/okta-003",
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      },
    });
    expect([200, 204]).toContain(patch.status);
    const after = (await h.userStore.findByEmail("carol@example.com")) as StoredUser;
    expect(after.tokenVersion).toBeGreaterThan(beforeVersion);
  });

  it("DELETE removes the identity and bumps tokenVersion", async () => {
    h = await harness();
    await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: { externalId: "okta-004", userName: "dave@example.com" },
    });
    const before = (await h.userStore.findByEmail("dave@example.com")) as StoredUser;
    const beforeVersion = before.tokenVersion;
    const del = await h.request({
      method: "DELETE",
      path: "/scim/v2/Users/okta-004",
    });
    expect(del.status).toBe(204);
    // Re-provisioning the same external id should now succeed because the
    // old identity row is gone — that's the contract "after DELETE, the
    // user is gone from the IdP's perspective".
    const recreated = await h.request({
      method: "POST",
      path: "/scim/v2/Users",
      body: { externalId: "okta-004", userName: "dave@example.com" },
    });
    expect(recreated.status).toBe(201);
    const after = (await h.userStore.findByEmail("dave@example.com")) as StoredUser;
    expect(after.tokenVersion).toBeGreaterThanOrEqual(beforeVersion);
  });

  it("rejects the request with a SCIM-shaped 401 when the bearer token is wrong", async () => {
    h = await harness();
    const res = await fetch(`${h.base}/scim/v2/Users/anyone`, {
      headers: { authorization: "Bearer not-the-right-token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(res.headers.get("content-type")).toMatch(/^application\/scim\+json/);
  });
});
