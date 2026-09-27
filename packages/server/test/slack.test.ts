import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
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
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryIntegrationStore } from "../src/integrations/integrations.js";
import {
  SlackError,
  httpSlackPoster,
  recapMessage,
  slackWebhookUrl,
  type SlackMessage,
} from "../src/integrations/slack.js";
import { connectionState } from "../src/integrations/health.js";

/**
 * Slack, outbound (docs/26 A5): a meeting's summary posted to the org's
 * channel — only to Slack's own webhook host, never from a board whose tier
 * keeps content inside Lucent, and with the channel's answers as the
 * connection's health.
 */

const HOOK = "https://hooks.slack.com/services/T000/B000/XXXX";

describe("the Slack pieces (unit)", () => {
  it("accepts only Slack's webhook host, over https", () => {
    expect(slackWebhookUrl(HOOK, "SLACK_URL").hostname).toBe("hooks.slack.com");
    for (const bad of [
      "http://hooks.slack.com/services/x",
      "https://evil.example.com/services/x",
      "https://hooks.slack.com/api/x",
      "not a url",
    ]) {
      expect(() => slackWebhookUrl(bad, "SLACK_URL")).toThrow(SlackError);
    }
    expect(() => slackWebhookUrl(undefined, "SLACK_URL")).toThrow(/not set in the environment/);
  });

  it("writes a short summary: escaped, capped, linked", () => {
    const message = recapMessage({
      title: "Pricing <sync>",
      boardName: "Q4 & co",
      link: "https://lucent.example/?board=b&view=meeting&meeting=m",
      sections: [
        { title: "Decisions", items: [{ text: "Go annual" }] },
        { title: "Empty", items: [] },
        {
          title: "Actions",
          items: Array.from({ length: 8 }, (_, i) => ({ text: `Task ${i}` })),
        },
      ],
    });
    const text = JSON.stringify(message.blocks);
    expect(text).toContain("Pricing &lt;sync&gt;");
    expect(text).toContain("Q4 &amp; co");
    expect(text).not.toContain("Empty");
    expect(text).toContain("…and 2 more");
    expect(message.text).toBe("Pricing <sync> — summary from Q4 & co");
  });

  it("reads a revoked webhook as the credential's problem", async () => {
    const poster = httpSlackPoster(
      (async () => new Response("no_service", { status: 404 })) as unknown as typeof fetch,
    );
    await expect(poster.post(new URL(HOOK), { text: "hi" })).rejects.toMatchObject({
      status: 403,
    });
  });
});

let open: App | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
  delete process.env.LUCENT_TEST_SLACK_URL;
});

async function harness() {
  const limits = limitsFromEnv();
  const posts: Array<{ url: string; message: SlackMessage }> = [];
  const store = new InMemoryIntegrationStore();
  const meetings = new InMemoryMeetingStore();
  const boardStore = new InMemoryBoardStore();
  let refuse: number | null = null;
  const app = createApp({
    config: {
      ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "https://lucent.example" }),
      requireAuth: true,
    },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore,
    meetings,
    secret: "slack-test-secret-16chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    integrations: {
      store,
      providers: new Map(),
      slack: {
        async post(url, message) {
          if (refuse !== null) throw new SlackError(`slack responded ${refuse}`, refuse);
          posts.push({ url: url.toString(), message });
        },
      },
    },
  });
  open = app;
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
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
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const signup = await api("POST", "/api/auth/signup", undefined, {
    email: "slack@example.com",
    password: "password123",
    name: "Sam Slack",
  });
  const token = signup.body.token as string;
  const orgId = signup.body.memberships[0].orgId as string;
  const board = await api("POST", "/api/boards", token, { name: "Launch", orgId });
  const meeting = await meetings.insert({
    boardId: board.body.id,
    orgId,
    startedAt: Date.UTC(2026, 8, 20, 10),
    endedAt: Date.UTC(2026, 8, 20, 11),
    turns: [
      { speaker: "Sam", at: Date.UTC(2026, 8, 20, 10, 1), text: "We'll go annual." },
      { speaker: "Bo", at: Date.UTC(2026, 8, 20, 10, 2), text: "I'll update the pricing page." },
    ],
    createdBy: signup.body.user.id,
    createdAt: 1,
    title: "Pricing sync",
  });
  return {
    app,
    api,
    token,
    orgId,
    boardId: board.body.id as string,
    meetingId: meeting.id,
    posts,
    store,
    boardStore,
    refuse: (status: number | null) => {
      refuse = status;
    },
  };
}

describe("Slack, through the app", () => {
  it("connects, says hello, and posts each meeting's summary", async () => {
    const h = await harness();
    const listed = await h.api("GET", `/api/orgs/${h.orgId}/integrations`, h.token);
    expect(listed.body.available).toContainEqual({
      provider: "slack",
      kind: "notifier",
      supportsInbound: false,
    });
    process.env.LUCENT_TEST_SLACK_URL = HOOK;
    const put = await h.api("PUT", `/api/orgs/${h.orgId}/integrations/slack`, h.token, {
      credentialRef: "LUCENT_TEST_SLACK_URL",
    });
    expect(put.body.integration).toMatchObject({ kind: "notifier", state: "active" });
    const check = await h.api("POST", `/api/orgs/${h.orgId}/integrations/slack/check`, h.token);
    expect(check.body).toMatchObject({ ok: true });
    expect(h.posts[0]!.message.text).toMatch(/Lucent is connected/);

    const written = await h.app.writeMeetingRecap(h.boardId, h.meetingId);
    expect(written.outcome).toBe("written");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.posts).toHaveLength(2);
    const summary = JSON.stringify(h.posts[1]!.message);
    expect(summary).toContain("Pricing sync");
    expect(summary).toContain(
      `https://lucent.example/?board=${h.boardId}&view=meeting&meeting=${h.meetingId}`,
    );
    expect(h.posts[1]!.url).toBe(HOOK);
  });

  it("never posts from a board whose tier keeps content in Lucent", async () => {
    const h = await harness();
    process.env.LUCENT_TEST_SLACK_URL = HOOK;
    await h.api("PUT", `/api/orgs/${h.orgId}/integrations/slack`, h.token, {
      credentialRef: "LUCENT_TEST_SLACK_URL",
    });
    const board = (await h.boardStore.get(h.boardId))!;
    await h.boardStore.put({ ...board, classification: "restricted" });
    await h.app.writeMeetingRecap(h.boardId, h.meetingId);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.posts).toEqual([]);
  });

  it("a channel that stops answering needs a new webhook", async () => {
    const h = await harness();
    process.env.LUCENT_TEST_SLACK_URL = HOOK;
    await h.api("PUT", `/api/orgs/${h.orgId}/integrations/slack`, h.token, {
      credentialRef: "LUCENT_TEST_SLACK_URL",
    });
    h.refuse(403);
    await h.app.writeMeetingRecap(h.boardId, h.meetingId);
    await new Promise((r) => setTimeout(r, 50));
    expect(connectionState((await h.store.connection(h.orgId, "slack"))!)).toBe("needs-reauth");
    // An unset variable reads the same way at check time.
    delete process.env.LUCENT_TEST_SLACK_URL;
    h.refuse(null);
    const check = await h.api("POST", `/api/orgs/${h.orgId}/integrations/slack/check`, h.token);
    expect(check.body).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not set in the environment"),
      integration: { state: "needs-reauth" },
    });
  });
});
