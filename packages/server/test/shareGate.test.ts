import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryTokenStore, InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import type { MailMessage } from "../src/email/index.js";

/**
 * The signup-to-share path over the real HTTP wiring (M1.4).
 *
 * This is the loop the unit tests could not see. `POST /api/boards/:id/share`
 * refuses while `emailVerifiedAt` is null, but signup issued no verification
 * token and sent no mail, and nothing in the product ever called
 * `POST /api/auth/verify/request` — so the only way a board ever got shared in
 * a test was `collab.e2e.test.ts` reaching into the user store and setting
 * `emailVerifiedAt` by hand. That shortcut is what let the gap ship: every
 * layer was individually correct and the product was still unusable.
 *
 * The assertions here therefore take no shortcut: sign up, read the token out
 * of the mail that signup itself sent, redeem it through the public endpoint,
 * and only then mint a link.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  mail: MailMessage[];
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const userStore = new InMemoryUserStore();
  const mail: MailMessage[] = [];
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
    // The two deps that make the flow reachable at all. main.ts already passes
    // both in production; the older fixtures omitted them, which is why no
    // test ever exercised the mail.
    mailer: {
      send: async (msg: MailMessage) => {
        mail.push(msg);
      },
    },
    verificationTokens: new InMemoryTokenStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, mail, userStore, close };
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Pull the token out of the most recent verification mail. */
function tokenFromMail(h: Harness): string {
  const last = [...h.mail].reverse().find((m) => /verify your/i.test(m.subject));
  if (!last) throw new Error(`no verification mail was sent (saw ${h.mail.length} messages)`);
  const match = /token=([A-Za-z0-9_%-]+)/.exec(last.text);
  if (!match) throw new Error(`no token in the mail body: ${last.text}`);
  return decodeURIComponent(match[1]!);
}

describe("share link requires a verified email", () => {
  it("signup mails a token that unlocks sharing, end to end", async () => {
    const h = (open = await harness());

    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com", password: "password123", name: "Owner" }),
    });
    expect(signup.status).toBe(201);
    const token = signup.body.token as string;
    // Signup itself sent the mail — nothing else had to be called.
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0]!.to).toBe("owner@example.com");

    const board = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Gated" }),
    });
    expect(board.status).toBe(201);
    const boardId = board.body.id as string;

    // The gate: a verified email is required before a board can be shared
    // publicly, so a spammer cannot sign up with someone else's address and
    // invite people to a board in the victim's name.
    const blocked = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toMatch(/verify your email/i);

    const confirm = await api(h, "/api/auth/verify/confirm", {
      method: "POST",
      body: JSON.stringify({ token: tokenFromMail(h) }),
    });
    expect(confirm.status).toBe(200);

    const allowed = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.token).toBeTruthy();
    expect(allowed.body.role).toBe("viewer");
  });

  it("creating and editing boards still works while unverified", async () => {
    // The gate sits at sharing, not at signup: an unconfirmed mailbox must not
    // block the product's core loop.
    const h = (open = await harness());
    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "unverified@example.com", password: "password123", name: "U" }),
    });
    const token = signup.body.token as string;
    expect((await h.userStore.findByEmail("unverified@example.com"))!.emailVerifiedAt).toBeNull();

    const board = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "Mine" }),
    });
    expect(board.status).toBe(201);
    const rename = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ id: board.body.id, name: "Mine, renamed" }),
    });
    expect(rename.status).toBe(201);
  });

  it("a spent verification token cannot open the gate for a second account", async () => {
    const h = (open = await harness());
    const first = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "a@example.com", password: "password123", name: "A" }),
    });
    expect(first.status).toBe(201);
    const spent = tokenFromMail(h);
    const redeemed = await api(h, "/api/auth/verify/confirm", {
      method: "POST",
      body: JSON.stringify({ token: spent }),
    });
    expect(redeemed.status).toBe(200);

    const second = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "b@example.com", password: "password123", name: "B" }),
    });
    const bToken = second.body.token as string;
    // Single-use: a replay is a 400 and the second account stays gated, so one
    // verified mailbox cannot be laundered into many sharing-capable accounts.
    const replay = await api(h, "/api/auth/verify/confirm", {
      method: "POST",
      body: JSON.stringify({ token: spent }),
    });
    expect(replay.status).toBe(400);
    expect((await h.userStore.findByEmail("b@example.com"))!.emailVerifiedAt).toBeNull();

    const board = await api(h, "/api/boards", {
      method: "POST",
      token: bToken,
      body: JSON.stringify({ name: "B" }),
    });
    const blocked = await api(h, `/api/boards/${board.body.id as string}/share`, {
      method: "POST",
      token: bToken,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(blocked.status).toBe(403);
  });
});
