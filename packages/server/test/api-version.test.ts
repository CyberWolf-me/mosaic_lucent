import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp, routeLabel, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { apiVersionOf } from "../src/apiVersion.js";

/**
 * The versioned API (docs/26 A6, ADR 0052): `/api/v1/…` names the same
 * routes as `/api/…`, answers the same, and is held to the same rules — a
 * token's limits can't be dodged by spelling the path the other way.
 */

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function harness() {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    orgStore,
    boardStore: new InMemoryBoardStore(),
    secret: "api-version-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      version: res.headers.get("lucent-api-version"),
      body: (await res.json().catch(() => null)) as any,
    };
  };
  const signup = await api("POST", "/api/auth/signup", undefined, {
    email: "owner@acme.com",
    password: "password123",
    name: "Olive",
  });
  const session = signup.body.token as string;
  const orgId = (await api("POST", "/api/orgs", session, { name: "Acme" })).body.id as string;
  const board = (await api("POST", "/api/boards", session, { name: "Roadmap", orgId })).body
    .id as string;
  const mint = async (scopes: string[]) =>
    (await api("POST", "/api/me/tokens", session, { name: "script", orgId, scopes })).body
      .token as string;
  return { api, orgId, board, mint };
}

describe("/api/v1", () => {
  it("answers exactly as the unversioned route, and says which version it is", async () => {
    const h = await harness();
    const token = await h.mint(["read", "write"]);
    const plain = await h.api("GET", `/api/boards/${h.board}`, token);
    const v1 = await h.api("GET", `/api/v1/boards/${h.board}`, token);
    expect(v1.status).toBe(200);
    expect(v1.body).toEqual(plain.body);
    expect(v1.version).toBe("1");
    expect(plain.version).toBeNull();
    // The query string travels with the rewrite.
    const listed = await h.api("GET", `/api/v1/boards?orgId=${h.orgId}`, token);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(h.board);
    // And a write lands like any other.
    const wrote = await h.api("POST", `/api/v1/boards/${h.board}/ops`, token, {
      label: "via v1",
      ops: [{ op: "CREATE_NODE", id: "n_v1", nodeType: "process", label: "From a script" }],
    });
    expect(wrote.status).toBe(200);
    const after = await h.api("GET", `/api/boards/${h.board}`, token);
    expect(after.body.workspace.nodes.n_v1.label).toBe("From a script");
  });

  it("holds a token to the same rules under either name", async () => {
    const h = await harness();
    const read = await h.mint(["read"]);
    const wrote = await h.api("POST", `/api/v1/boards/${h.board}/ops`, read, {
      label: "nope",
      ops: [{ op: "CREATE_NODE", id: "n_x", nodeType: "process", label: "x" }],
    });
    expect(wrote.status).toBe(403);
    expect(wrote.body.error).toMatch(/can only read/);
    for (const [method, path] of [
      ["GET", "/api/v1/me/tokens"],
      ["POST", "/api/v1/auth/signout-all"],
      ["POST", "/api/v1/realtime/ticket"],
      ["GET", `/api/v1/orgs/${h.orgId}/tokens`],
    ] as const) {
      expect((await h.api(method, path, read)).status, `${method} ${path}`).toBe(403);
    }
    // Without credentials, a v1 route is as closed as its twin.
    expect((await h.api("GET", `/api/v1/boards/${h.board}`)).status).toBe(401);
  });

  it("describes itself, and refuses versions it doesn't speak", async () => {
    const h = await harness();
    const index = await h.api("GET", "/api/v1");
    expect(index.status).toBe(200);
    expect(index.body).toMatchObject({ api: "lucent", version: 1, versions: [1] });
    expect(index.body.resources).toContain("POST /api/v1/boards/{boardId}/ops");
    expect((await h.api("POST", "/api/v1/")).status).toBe(405);
    const v2 = await h.api("GET", `/api/v2/boards/${h.board}`);
    expect(v2.status).toBe(404);
    expect(v2.body).toEqual({ error: "Lucent has no API v2 — use /api/v1", versions: [1] });
    // A route whose name only starts with "v" is not a version.
    expect(apiVersionOf("/api/vector")).toBeNull();
  });

  it("parses the prefix, and labels metrics by the name the caller used", () => {
    expect(apiVersionOf("/api/v1/boards/b1?x=1")).toEqual({
      kind: "v1",
      url: "/api/boards/b1?x=1",
    });
    expect(apiVersionOf("/api/v1")).toEqual({ kind: "index" });
    expect(apiVersionOf("/api/v1/")).toEqual({ kind: "index" });
    expect(apiVersionOf("/api/boards")).toBeNull();
    expect(apiVersionOf("/api/v10/boards")).toEqual({ kind: "unknown", version: "v10" });
    // The same label as the unversioned route, with the version in it — even
    // at the deepest path the server defines.
    for (const path of [
      "/api/boards/brd_1a2b3c4d5e/ops",
      "/api/orgs/org_1a2b3c4d5e/projects/prj_1a2b3c4d5e",
      "/api/boards/brd_1a2b3c4d5e/meetings/mtg_1a2b3c4d5e",
    ]) {
      const plain = routeLabel(path);
      expect(plain).not.toBe("/api/other");
      expect(routeLabel(path.replace("/api/", "/api/v1/"))).toBe(
        plain.replace("/api/", "/api/v1/"),
      );
    }
  });
});
