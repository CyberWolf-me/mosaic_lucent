import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
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
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryProposalStore } from "../src/proposals.js";

/**
 * docs/28 F17: the meeting write routes and proposal-create never called
 * `requireCsrf` — every other cookie-authenticated write does. The existing
 * route tests use bearer tokens, which skip CSRF by design, so nothing
 * noticed. This suite drives a real COOKIE session: without the header the
 * write is refused (403, "csrf rejected") before it touches the body; with
 * the minted cookie + header pair it goes through.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

function pickCookie(setCookie: string | null, name: string): string | undefined {
  for (const raw of (setCookie ?? "").split(/,(?=\s*[a-z_]+=)/i)) {
    const eq = raw.indexOf("=");
    if (eq < 0 || raw.slice(0, eq).trim() !== name) continue;
    return raw.slice(eq + 1).split(";")[0] ?? "";
  }
  return undefined;
}

async function harness() {
  const limits = limitsFromEnv();
  const { server, close } = createApp({
    config: readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN }),
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    meetings: new InMemoryMeetingStore(),
    proposals: new InMemoryProposalStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // A browser session: signup through the CSRF-minted pair, keep both cookies.
  const mint = await fetch(`${base}/api/auth/csrf`, { headers: { origin: ORIGIN } });
  const token = ((await mint.json()) as { token: string }).token;
  const csrfCookie = pickCookie(mint.headers.get("set-cookie"), "lucent_csrf");
  if (!csrfCookie) throw new Error("no lucent_csrf cookie");
  const signup = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: `lucent_csrf=${csrfCookie}`,
      "x-csrf-token": token,
    },
    body: JSON.stringify({ email: "csrf@example.com", password: "password123", name: "Csrf" }),
  });
  expect(signup.status).toBe(201);
  const session = pickCookie(signup.headers.get("set-cookie"), "lucent_session");
  if (!session) throw new Error("no session cookie");
  const cookie = `lucent_session=${session}; lucent_csrf=${csrfCookie}`;

  const post = async (path: string, body: unknown, withCsrf: boolean) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        cookie,
        ...(withCsrf ? { "x-csrf-token": token } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const board = await post("/api/boards", { name: "CSRF", workspace: createWorkspace() }, true);
  expect(board.status).toBe(201);
  return { close, post, boardId: board.body.id as string };
}

const TURN = { speaker: "Ada", at: 1_000, text: "We ship Friday." };

describe("board writes refuse a cookie session without the CSRF header (F17)", () => {
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it("the meeting routes and proposal-create answer 403 without it, and work with it", async () => {
    h = await harness();
    const b = `/api/boards/${h.boardId}`;

    // Without the header: every write is refused, and nothing is created.
    const refusals = [
      await h.post(`${b}/meetings`, { turns: [TURN], startedAt: 1_000 }, false),
      await h.post(`${b}/meetings/mtg_x/turns`, { turns: [TURN] }, false),
      await h.post(`${b}/meetings/mtg_x/end`, { endedAt: 2_000 }, false),
      await h.post(`${b}/meetings/import`, { source: "mock", ref: { id: "x" } }, false),
      await h.post(`${b}/proposals`, { operations: [], request: "r", explanation: "e" }, false),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("csrf rejected");
    }

    // With it: the same writes go through.
    const opened = await h.post(`${b}/meetings`, { turns: [TURN], startedAt: 1_000 }, true);
    expect(opened.status).toBe(201);
    const mid = opened.body.id as string;
    expect((await h.post(`${b}/meetings/${mid}/turns`, { turns: [TURN] }, true)).status).toBe(200);
    expect((await h.post(`${b}/meetings/${mid}/end`, { endedAt: 2_000 }, true)).status).toBe(200);
    const proposal = await h.post(
      `${b}/proposals`,
      { operations: [], request: "r", explanation: "e" },
      true,
    );
    expect(proposal.status).not.toBe(403);
  });
});
