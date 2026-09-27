import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createApp, type App } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * Follow-up after a meeting (docs/28 S11): "Notify owners" tells each person
 * the reviewed, open actions they own from that meeting — one notification
 * each — and says which owners matched nobody. Suggestions still waiting,
 * other meetings' actions and finished ones stay out.
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
    meetings: new InMemoryMeetingStore(),
    notifications: new InMemoryNotificationStore(),
    secret: "meeting-followup-secret-16",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const signup = async (email: string, name: string) => {
    const r = await api("POST", "/api/auth/signup", undefined, {
      email,
      password: "password123",
      name,
    });
    return { token: r.body.token as string, id: r.body.user.id as string };
  };
  const owner = await signup("olive@acme.com", "Olive");
  const orgId = (await api("POST", "/api/orgs", owner.token, { name: "Acme" })).body.id as string;
  const ed = await signup("ed@acme.com", "Ed");
  await userStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  await orgStore.setMembership({ userId: ed.id, orgId, role: "editor" });
  const boardId = (await api("POST", "/api/boards", owner.token, { name: "Pricing", orgId })).body
    .id as string;
  const meeting = (
    await api("POST", `/api/boards/${boardId}/meetings`, owner.token, {
      turns: [{ speaker: "Olive", at: Date.now(), text: "Let's go annual." }],
      endedAt: Date.now() + 1000,
    })
  ).body;
  await api("PATCH", `/api/boards/${boardId}/meetings/${meeting.id}`, owner.token, {
    title: "Pricing review",
  });
  return { api, owner, ed, boardId, meetingId: meeting.id as string };
}

const action = (
  id: string,
  meetingId: string,
  assignee: string,
  status: "open" | "resolved" = "open",
) => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: "process",
    label: `Do ${id}`,
    provenance: { meetingId, turnRange: [0, 0] },
  },
  { op: "SET_STATEMENT", id, statement: { kind: "action", status } },
  { op: "SET_ISSUE", id, issue: { type: "task", status: "assigned", assignee } },
];

describe("notify owners after a meeting", () => {
  it("tells each owner what they own from it, once, and names who matched nobody", async () => {
    const h = await harness();
    await h.api("POST", `/api/boards/${h.boardId}/ops`, h.owner.token, {
      label: "reviewed",
      ops: [
        ...action("page", h.meetingId, "Ed"),
        ...action("copy", h.meetingId, "ed@acme.com"),
        ...action("invoices", h.meetingId, "Olive"),
        ...action("legal", h.meetingId, "Zed"),
        ...action("done", h.meetingId, "Ed", "resolved"),
        ...action("elsewhere", "mtg_other", "Ed"),
      ],
    });
    // Still a suggestion: not sent to anyone until a person reviews it.
    await h.api(
      "POST",
      `/api/boards/${h.boardId}/ops`,
      h.owner.token,
      { label: "agent", ops: action("guess", h.meetingId, "Ed") },
      { "x-lucent-client": "mcp" },
    );

    const sent = await h.api(
      "POST",
      `/api/boards/${h.boardId}/meetings/${h.meetingId}/notify-owners`,
      h.owner.token,
    );
    expect(sent.status).toBe(200);
    expect(sent.body.actions).toBe(4);
    expect(sent.body.unmatched).toEqual(["Zed"]);
    expect(sent.body.told).toEqual(
      expect.arrayContaining([
        { name: "Ed", you: false, actions: 2 },
        { name: "Olive", you: true, actions: 1 },
      ]),
    );

    const inbox = await h.api("GET", "/api/notifications", h.ed.token);
    const followups = (inbox.body.notifications as Array<{ kind: string; title: string }>).filter(
      (n) => n.kind === "meeting.followup",
    );
    expect(followups).toHaveLength(1);
    expect(followups[0]!.title).toBe('Olive sent you your 2 actions from "Pricing review"');
    // The sender isn't told about their own.
    const mine = await h.api("GET", "/api/notifications", h.owner.token);
    expect(
      (mine.body.notifications as Array<{ kind: string }>).some(
        (n) => n.kind === "meeting.followup",
      ),
    ).toBe(false);
  });

  it("is an editor's to send", async () => {
    const h = await harness();
    const stranger = (
      await h.api("POST", "/api/auth/signup", undefined, {
        email: "out@example.com",
        password: "password123",
        name: "Out",
      })
    ).body.token as string;
    const refused = await h.api(
      "POST",
      `/api/boards/${h.boardId}/meetings/${h.meetingId}/notify-owners`,
      stranger,
    );
    expect(refused.status).toBe(404);
  });
});
