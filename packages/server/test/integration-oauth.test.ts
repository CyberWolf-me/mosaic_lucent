import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryIntegrationStore } from "../src/integrations/integrations.js";
import { InMemoryIntegrationCredentialStore } from "../src/integrations/credentials.js";
import { FakeProvider } from "../src/integrations/fake.js";
import { tokenBox } from "../src/integrations/tokenBox.js";
import { pkceVerifier, signState, verifyState } from "../src/integrations/oauth.js";
import { connectionState } from "../src/integrations/health.js";

/**
 * OAuth connect for Linear and Jira (docs/26 A5), against a stub of each
 * provider's token and site endpoints: the owner who started it finishes it,
 * the tokens are sealed at rest, the provider is reached with a fresh token,
 * and a refresh the provider refuses asks the owner to connect again.
 */

const KEY = randomBytes(32).toString("base64");
const CLOUD = "11111111-2222-3333-4444-555555555555";

describe("sealing and signing (unit)", () => {
  it("seals a token to its row: another row, key or a changed byte doesn't open it", () => {
    const box = tokenBox(KEY)!;
    const sealed = box.seal("lin_oauth_secret", "org_a:linear");
    expect(sealed).not.toContain("lin_oauth_secret");
    expect(box.open(sealed, "org_a:linear")).toBe("lin_oauth_secret");
    expect(() => box.open(sealed, "org_b:linear")).toThrow();
    expect(() =>
      tokenBox(randomBytes(32).toString("base64"))!.open(sealed, "org_a:linear"),
    ).toThrow();
    const [v, iv, tag, body] = sealed.split(".");
    const bytes = Buffer.from(body!, "base64url");
    bytes[0] = bytes[0]! ^ 0x01;
    const flipped = `${v}.${iv}.${tag}.${bytes.toString("base64url")}`;
    expect(() => box.open(flipped, "org_a:linear")).toThrow();
    expect(tokenBox(undefined)).toBeNull();
    expect(() => tokenBox(Buffer.from("short").toString("base64"))).toThrow(/32 random bytes/);
  });

  it("signs the state: tampered, expired or another secret's is refused", () => {
    const { token, state } = signState(
      "secret-a",
      { o: "org", u: "usr", p: "linear", c: { teamId: "t" } },
      1_000,
    );
    expect(verifyState("secret-a", token, 2_000)).toMatchObject({ o: "org", u: "usr" });
    expect(verifyState("secret-b", token, 2_000)).toBeNull();
    expect(verifyState("secret-a", token, state.e + 1)).toBeNull();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...state, o: "someone-elses-org" })).toString(
      "base64url",
    );
    expect(verifyState("secret-a", `${forged}.${sig}`, 2_000)).toBeNull();
    expect(verifyState("secret-a", body!, 2_000)).toBeNull();
    expect(pkceVerifier("secret-a", state.n)).toBe(pkceVerifier("secret-a", state.n));
  });
});

/* ------------------------------------------------------------ the flow */

interface Stub {
  url: string;
  close(): Promise<void>;
  /** The PKCE challenge the authorize URL carried, to hold the exchange to. */
  expectChallenge(challenge: string | null): void;
  refuseRefresh(): void;
  tokenRequests: Array<Record<string, string>>;
}

async function stubProvider(): Promise<Stub> {
  let challenge: string | null = null;
  let refuse = false;
  const tokenRequests: Array<Record<string, string>> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/resources") {
        return json(200, [{ id: CLOUD, url: "https://acme.atlassian.net", name: "Acme" }]);
      }
      const fields: Record<string, string> = (req.headers["content-type"] ?? "").includes("json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      tokenRequests.push(fields);
      if (fields.client_secret !== "app-secret") return json(401, { error: "invalid_client" });
      if (fields.grant_type === "authorization_code") {
        if (fields.code !== "good-code") return json(400, { error: "invalid_grant" });
        if (challenge !== null) {
          const s256 = createHash("sha256")
            .update(fields.code_verifier ?? "")
            .digest("base64url");
          if (s256 !== challenge) return json(400, { error: "invalid_grant", why: "pkce" });
        }
        return json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      }
      if (fields.grant_type === "refresh_token") {
        if (refuse || fields.refresh_token !== "rt-1") return json(400, { error: "invalid_grant" });
        return json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 });
      }
      json(400, { error: "unsupported_grant_type" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    expectChallenge: (c) => (challenge = c),
    refuseRefresh: () => (refuse = true),
    tokenRequests,
  };
}

let app: App | undefined;
let stub: Stub | undefined;
afterEach(async () => {
  await app?.close();
  await stub?.close();
  app = undefined;
  stub = undefined;
});

async function harness() {
  stub = await stubProvider();
  const limits = limitsFromEnv();
  const store = new InMemoryIntegrationStore();
  const credentials = new InMemoryIntegrationCredentialStore();
  const seen: Array<{ credentialRef: string; oauth?: { accessToken: string } }> = [];
  const capture = (conn: { credentialRef: string; oauth?: { accessToken: string } }) => {
    seen.push(conn);
    return new FakeProvider();
  };
  let clock = Date.now();
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "https://lucent.example" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: "oauth-test-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    integrations: {
      store,
      providers: new Map([
        ["linear", capture],
        ["jira", capture],
      ]),
      oauth: {
        apps: {
          linear: { clientId: "lin-client", clientSecret: "app-secret" },
          jira: { clientId: "jira-client", clientSecret: "app-secret" },
        },
        box: tokenBox(KEY)!,
        credentials,
        now: () => clock,
        specs: {
          linear: { tokenUrl: `${stub.url}/token` },
          jira: { tokenUrl: `${stub.url}/token`, resourcesUrl: `${stub.url}/resources` },
        },
      },
    },
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      body: (await res.json().catch(() => null)) as any,
    };
  };
  const signup = async (email: string) => {
    const r = await api("POST", "/api/auth/signup", undefined, {
      email,
      password: "password123",
      name: email.split("@")[0],
    });
    return {
      token: r.body.token as string,
      id: r.body.user.id as string,
      org: r.body.memberships[0].orgId as string,
    };
  };
  return {
    api,
    signup,
    store,
    credentials,
    seen,
    stub: stub!,
    tick: (ms: number) => (clock += ms),
  };
}

/** Start, then come back from the provider the way a browser would. */
async function connect(
  h: Awaited<ReturnType<typeof harness>>,
  who: { token: string; org: string },
  provider: "linear" | "jira",
  config: Record<string, string>,
  finishAs: { token: string } = who,
) {
  const start = await h.api(
    "POST",
    `/api/orgs/${who.org}/integrations/${provider}/oauth`,
    who.token,
    { config },
  );
  if (start.status !== 200) return { start, done: null };
  const url = new URL(start.body.url);
  h.stub.expectChallenge(url.searchParams.get("code_challenge"));
  const done = await h.api(
    "GET",
    `/api/integrations/oauth/${provider}/callback?code=good-code&state=${encodeURIComponent(url.searchParams.get("state")!)}`,
    finishAs.token,
  );
  return { start, url, done };
}

describe("OAuth connect", () => {
  it("Linear: the owner connects, the token is sealed, the provider gets it fresh", async () => {
    const h = await harness();
    const owner = await h.signup("owner@example.com");
    const listed = await h.api("GET", `/api/orgs/${owner.org}/integrations`, owner.token);
    expect(listed.body.available).toContainEqual({
      provider: "linear",
      kind: "tracker",
      supportsInbound: true,
      oauth: true,
    });

    const { url, done } = await connect(h, owner, "linear", { teamId: "team-1" });
    expect(url!.origin + url!.pathname).toBe("https://linear.app/oauth/authorize");
    expect(url!.searchParams.get("redirect_uri")).toBe(
      "https://lucent.example/api/integrations/oauth/linear/callback",
    );
    expect(url!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(done!.status).toBe(302);
    expect(done!.location).toContain("oauth=connected");

    const connection = (await h.store.connection(owner.org, "linear"))!;
    expect(connection).toMatchObject({ credentialRef: "oauth", config: { teamId: "team-1" } });
    const row = (await h.credentials.get(owner.org, "linear"))!;
    expect(row.accessToken).not.toContain("at-1");
    expect(row.refreshToken).not.toContain("rt-1");
    expect(row.obtainedBy).toBe(owner.id);

    const check = await h.api(
      "POST",
      `/api/orgs/${owner.org}/integrations/linear/check`,
      owner.token,
    );
    expect(check.body).toMatchObject({ ok: true, integration: { via: "oauth", state: "active" } });
    expect(h.seen.at(-1)!.oauth).toEqual({ accessToken: "at-1" });

    // An hour on: the token is refreshed before it's used, and the rotated
    // pair is kept.
    h.tick(3_600_000);
    await h.api("POST", `/api/orgs/${owner.org}/integrations/linear/check`, owner.token);
    expect(h.seen.at(-1)!.oauth).toEqual({ accessToken: "at-2" });
    expect(h.stub.tokenRequests.at(-1)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });

    // Disconnecting forgets the token.
    await h.api("DELETE", `/api/orgs/${owner.org}/integrations/linear`, owner.token);
    expect(await h.credentials.get(owner.org, "linear")).toBeUndefined();
  });

  it("a refresh the provider refuses asks the owner to connect again", async () => {
    const h = await harness();
    const owner = await h.signup("expire@example.com");
    await connect(h, owner, "linear", { teamId: "team-1" });
    h.stub.refuseRefresh();
    h.tick(3_600_000);
    const check = await h.api(
      "POST",
      `/api/orgs/${owner.org}/integrations/linear/check`,
      owner.token,
    );
    expect(check.body.ok).toBe(false);
    expect(check.body.detail).toMatch(/Linear refused the token request/);
    expect(connectionState((await h.store.connection(owner.org, "linear"))!)).toBe("needs-reauth");
  });

  it("Jira: finds the site the token reaches and addresses it through the gateway", async () => {
    const h = await harness();
    const owner = await h.signup("jira@example.com");
    const { url, done } = await connect(h, owner, "jira", { projectKey: "ENG" });
    expect(url!.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url!.searchParams.get("scope")).toContain("offline_access");
    expect(done!.location).toContain("oauth=connected");
    expect((await h.store.connection(owner.org, "jira"))!.config).toEqual({
      projectKey: "ENG",
      site: "https://acme.atlassian.net",
      cloudId: CLOUD,
    });
  });

  it("only the owner who started it can finish it, with an untouched state", async () => {
    const h = await harness();
    const owner = await h.signup("starter@example.com");
    const other = await h.signup("other@example.com");
    const { done } = await connect(h, owner, "linear", { teamId: "team-1" }, other);
    expect(done!.location).toContain("oauth=error");
    expect(new URL(done!.location!).searchParams.get("reason")).toMatch(/owner who started it/);
    expect(await h.store.connection(owner.org, "linear")).toBeUndefined();

    const tampered = await h.api(
      "GET",
      "/api/integrations/oauth/linear/callback?code=good-code&state=abc.def",
      owner.token,
    );
    expect(tampered.location).toContain("oauth=error");

    // What the provider needs is asked for up front; a provider with no app
    // on this server isn't offered.
    const incomplete = await h.api(
      "POST",
      `/api/orgs/${owner.org}/integrations/linear/oauth`,
      owner.token,
      { config: {} },
    );
    expect(incomplete).toMatchObject({ status: 400, body: { error: "fill in teamId first" } });
    const none = await h.api(
      "POST",
      `/api/orgs/${owner.org}/integrations/github/oauth`,
      owner.token,
      {
        config: {},
      },
    );
    expect(none.status).toBe(404);
  });
});
