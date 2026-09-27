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
import { InMemoryNotificationStore } from "../src/notifications.js";
import type { Mailer, MailMessage } from "../src/email/mailer.js";
import {
  InMemoryMeetingStore,
  meetingStatus,
  scheduledMeetingAt,
  validateSchedule,
  type MeetingTranscript,
} from "../src/meetings.js";
import { foldLine, icsText, icsTime, meetingIcs } from "../src/calendar.js";

/**
 * docs/28 A3.4: a meeting can be scheduled. The plan lives on the meeting's
 * own row (ADR 0045); invitees who can read the board get a notification and
 * a mail with the calendar invite; the host can change or cancel it; and the
 * recording that starts in its window becomes it, keeping its id.
 */

const HOUR = 60 * 60 * 1000;
const SECRET = "test-secret-at-least-16-chars";

describe("the calendar invite (RFC 5545)", () => {
  const base = {
    meetingId: "mtg_1",
    method: "REQUEST" as const,
    sequence: 7,
    start: Date.UTC(2026, 9, 3, 14, 0),
    durationMin: 30,
    title: "Pricing; review, v2",
    description: "Line one\nLine two",
    url: "https://lucent.test/?board=b&meeting=mtg_1",
    organizer: { name: 'Ada "A" Lovelace', email: "ada@example.com" },
    attendees: [{ name: "Bo", email: "bo@example.com" }],
    now: Date.UTC(2026, 9, 1, 9, 0),
    domain: "lucent.test",
  };

  it("names the event by the meeting, in UTC, with every attendee", () => {
    const ics = meetingIcs(base);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const flat = ics.replace(/\r\n /g, "");
    expect(flat).toContain("METHOD:REQUEST");
    expect(flat).toContain("UID:mtg_1@lucent.test");
    expect(flat).toContain("SEQUENCE:7");
    expect(flat).toContain("DTSTART:20261003T140000Z");
    expect(flat).toContain("DTEND:20261003T143000Z");
    expect(flat).toContain("SUMMARY:Pricing\\; review\\, v2");
    expect(flat).toContain('ORGANIZER;CN="Ada A Lovelace":mailto:ada@example.com');
    expect(flat).toContain('ATTENDEE;CN="Bo";ROLE=REQ-PARTICIPANT');
    expect(flat).toContain("STATUS:CONFIRMED");
    expect(meetingIcs({ ...base, method: "CANCEL" })).toContain("STATUS:CANCELLED");
  });

  it("escapes text and folds long lines without splitting a character", () => {
    expect(icsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    expect(icsTime(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("20260102T030405Z");
    const long = "SUMMARY:" + "é".repeat(60);
    const folded = foldLine(long);
    expect(folded.split("\r\n ").join("")).toBe(long);
    expect(folded.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});

describe("the plan's rules", () => {
  const now = Date.UTC(2026, 9, 1, 12, 0);

  it("wants a future time, a sane length and account ids", () => {
    const ok = validateSchedule(
      {
        scheduledFor: now + HOUR,
        durationMin: 30,
        invitees: ["usr_a", "usr_a"],
        template: "retro",
      },
      now,
    );
    expect(ok).toEqual({
      ok: true,
      schedule: {
        scheduledFor: now + HOUR,
        durationMin: 30,
        invitees: ["usr_a"],
        template: "retro",
      },
    });
    expect(validateSchedule({ scheduledFor: now - HOUR, durationMin: 30 }, now)).toEqual({
      ok: false,
      error: "Pick a time in the future.",
    });
    expect(validateSchedule({ durationMin: 30 }, now)).toMatchObject({ ok: false });
    expect(validateSchedule({ scheduledFor: now + HOUR, durationMin: 2 }, now)).toMatchObject({
      ok: false,
    });
    expect(
      validateSchedule({ scheduledFor: now + HOUR, durationMin: 30, invitees: ["<x>"] }, now),
    ).toMatchObject({ ok: false });
    expect(
      validateSchedule({ scheduledFor: now + HOUR, durationMin: 30, template: "party" }, now),
    ).toMatchObject({ ok: false });
  });

  it("finds the meeting a recording starts: the open window nearest now", () => {
    const planned = (id: string, at: number, extra: Partial<MeetingTranscript> = {}) =>
      ({
        id,
        boardId: "b",
        orgId: "o",
        startedAt: at,
        endedAt: null,
        turns: [],
        createdBy: "u",
        createdAt: 0,
        schedule: { scheduledFor: at, durationMin: 30, invitees: [] },
        ...extra,
      }) as MeetingTranscript;
    const list = [
      planned("far", now + 3 * HOUR),
      planned("soon", now + 10 * 60_000),
      planned("earlier", now - 20 * 60_000),
      planned("cancelled", now, { cancelledAt: now - 1 }),
    ];
    expect(scheduledMeetingAt(list, now)?.id).toBe("soon");
    expect(scheduledMeetingAt([planned("late", now - 2 * HOUR)], now)).toBeUndefined();
    expect(meetingStatus(list[0]!)).toBe("scheduled");
    expect(meetingStatus(list[3]!)).toBe("cancelled");
  });
});

// --- the routes ---------------------------------------------------------------

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  mail: MailMessage[];
  close: () => Promise<void>;
}
interface Actor {
  token: string;
  id: string;
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://lucent.test" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const mail: MailMessage[] = [];
  const mailer: Mailer = {
    async send(msg) {
      mail.push(msg);
    },
  };
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
    meetings: new InMemoryMeetingStore(),
    notifications: new InMemoryNotificationStore(),
    mailer,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, userStore, mail, close: async () => close() };
}

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any; text: string; type: string | null }> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      origin: h.base,
    },
  });
  const text = await res.text();
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON (the calendar file) */
  }
  return { status: res.status, body, text, type: res.headers.get("content-type") };
}

const post = (h: Harness, path: string, who: Actor, body: unknown = {}) =>
  api(h, path, { method: "POST", token: who.token, body: JSON.stringify(body) });

async function signup(h: Harness, name: string): Promise<Actor> {
  const email = `${name.toLowerCase()}.${Math.random().toString(36).slice(2, 7)}@example.com`;
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

/** Ada's board, shared with Bo (editor) and Cy (viewer); Eve is a stranger. */
async function team(h: Harness) {
  const ada = await signup(h, "Ada");
  const bo = await signup(h, "Bo");
  const cy = await signup(h, "Cy");
  const eve = await signup(h, "Eve");
  const created = await post(h, "/api/boards", ada, {
    name: "Launch",
    workspace: createWorkspace(),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  for (const [who, role] of [
    [bo, "editor"],
    [cy, "viewer"],
  ] as const) {
    const link = await post(h, `/api/boards/${boardId}/share`, ada, { role });
    expect(
      (await post(h, `/api/boards/${boardId}/join`, who, { token: link.body.token })).status,
    ).toBe(200);
  }
  return { ada, bo, cy, eve, boardId };
}

const plan = (extra: Record<string, unknown> = {}) => ({
  title: "Launch sync",
  scheduledFor: Date.now() + 2 * HOUR,
  durationMin: 45,
  template: "standup",
  ...extra,
});

describe("scheduling a meeting (docs/28 A3.4)", () => {
  it("offers the people who can read the board, and invites them with a calendar file", async () => {
    const h = (open = await harness());
    const { ada, bo, cy, eve, boardId } = await team(h);

    const invitable = await api(h, `/api/boards/${boardId}/meetings/invitable`, {
      token: ada.token,
    });
    expect(invitable.body.people.map((p: { name: string }) => p.name)).toEqual(["Bo", "Cy"]);
    // A viewer can't schedule; the board guard answers 404 below its floor, as everywhere.
    expect(
      (await api(h, `/api/boards/${boardId}/meetings/invitable`, { token: cy.token })).status,
    ).toBe(404);

    expect(
      (await post(h, `/api/boards/${boardId}/meetings/schedule`, ada, plan({ title: " " }))).body
        .error,
    ).toBe("Add a title.");
    const stranger = await post(
      h,
      `/api/boards/${boardId}/meetings/schedule`,
      ada,
      plan({ invitees: [bo.id, eve.id] }),
    );
    expect(stranger.status).toBe(400);
    expect(stranger.body.error).toBe("Eve can't open this board. Share it with them first.");

    const made = await post(
      h,
      `/api/boards/${boardId}/meetings/schedule`,
      ada,
      plan({ invitees: [bo.id, cy.id] }),
    );
    expect(made.status).toBe(201);
    expect(made.body.invited).toBe(2);
    const id = made.body.meeting.id as string;

    const toBo = h.mail.find((m) => m.to.startsWith("bo."));
    expect(toBo?.subject).toContain('Ada invited you to "Launch sync"');
    const ics = toBo?.attachments?.[0];
    expect(ics?.filename).toBe("invite.ics");
    expect(ics?.contentType).toContain("method=REQUEST");
    expect(ics?.content).toContain(`UID:${id}@lucent.test`);
    expect(h.mail.some((m) => m.to.startsWith("ada."))).toBe(false);

    const tray = await api(h, "/api/notifications", { token: cy.token });
    expect(tray.body.notifications[0]).toMatchObject({
      kind: "meeting.invited",
      link: `/?board=${boardId}&view=meeting&meeting=${id}`,
    });

    const list = await api(h, `/api/orgs/${made.body.meeting.orgId}/meetings`, {
      token: ada.token,
    });
    expect(list.body.meetings[0]).toMatchObject({
      id,
      status: "scheduled",
      title: "Launch sync",
      durationMin: 45,
      inviteeCount: 2,
    });

    const people = await api(h, `/api/boards/${boardId}/meetings/${id}/people`, {
      token: cy.token,
    });
    expect(people.body).toMatchObject({
      host: { name: "Ada" },
      invitees: [{ name: "Bo" }, { name: "Cy" }],
      youHost: false,
    });

    // An invitee finds it wherever the board lives; a stranger finds nothing.
    const mine = await api(h, "/api/meetings/invited", { token: bo.token });
    expect(mine.body.meetings.map((m: { id: string }) => m.id)).toEqual([id]);
    expect(mine.body.meetings[0]).toMatchObject({ boardName: "Launch", status: "scheduled" });
    expect((await api(h, "/api/meetings/invited", { token: eve.token })).body.meetings).toEqual([]);

    const file = await api(h, `/api/boards/${boardId}/meetings/${id}/calendar.ics`, {
      token: cy.token,
    });
    expect(file.type).toContain("text/calendar");
    expect(file.text).toContain("METHOD:PUBLISH");
  });

  it("only the host changes or cancels it, and the invitees are told", async () => {
    const h = (open = await harness());
    const { ada, bo, cy, boardId } = await team(h);
    const made = await post(
      h,
      `/api/boards/${boardId}/meetings/schedule`,
      ada,
      plan({ invitees: [bo.id, cy.id] }),
    );
    const id = made.body.meeting.id as string;
    h.mail.length = 0;

    const later = Date.now() + 5 * HOUR;
    expect(
      (
        await post(
          h,
          `/api/boards/${boardId}/meetings/${id}/reschedule`,
          bo,
          plan({ scheduledFor: later, invitees: [bo.id] }),
        )
      ).status,
    ).toBe(403);
    const moved = await post(
      h,
      `/api/boards/${boardId}/meetings/${id}/reschedule`,
      ada,
      plan({ scheduledFor: later, invitees: [bo.id] }),
    );
    expect(moved.status).toBe(200);
    expect(moved.body.startedAt).toBe(later);
    // Bo is told it moved; Cy, dropped, gets the cancellation.
    expect(h.mail.find((m) => m.to.startsWith("bo."))?.subject).toContain('"Launch sync" changed');
    const toCy = h.mail.find((m) => m.to.startsWith("cy."));
    expect(toCy?.subject).toContain('Ada cancelled "Launch sync"');
    expect(toCy?.attachments?.[0]?.content).toContain("METHOD:CANCEL");

    h.mail.length = 0;
    const cancelled = await post(h, `/api/boards/${boardId}/meetings/${id}/cancel`, ada);
    expect(cancelled.status).toBe(200);
    expect(meetingStatus(cancelled.body)).toBe("cancelled");
    expect(h.mail.map((m) => m.subject)).toEqual(['Ada cancelled "Launch sync"']);
    // Idempotent, and no second round of mail.
    expect((await post(h, `/api/boards/${boardId}/meetings/${id}/cancel`, ada)).status).toBe(200);
    expect(h.mail).toHaveLength(1);
    const again = await post(h, `/api/boards/${boardId}/meetings/${id}/reschedule`, ada, plan());
    expect(again.status).toBe(409);
  });

  it("the recording that starts in its window becomes the meeting, once", async () => {
    const h = (open = await harness());
    const { ada, bo, boardId } = await team(h);
    const made = await post(
      h,
      `/api/boards/${boardId}/meetings/schedule`,
      ada,
      plan({ scheduledFor: Date.now() + 5 * 60_000, invitees: [bo.id] }),
    );
    const id = made.body.meeting.id as string;

    // Nothing appends to a meeting that hasn't started.
    const early = await post(h, `/api/boards/${boardId}/meetings/${id}/turns`, bo, {
      turns: [{ speaker: "Bo", at: 1, text: "hello" }],
    });
    expect(early.status).toBe(404);

    const startedAt = Date.now();
    const first = await post(h, `/api/boards/${boardId}/meetings`, bo, {
      startedAt,
      turns: [{ speaker: "Bo", at: startedAt, text: "Let's begin." }],
      mode: "intelligence",
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ id, title: "Launch sync", startedAt, mode: "intelligence" });
    expect(meetingStatus(first.body)).toBe("live");

    const second = await post(h, `/api/boards/${boardId}/meetings`, ada, {
      startedAt,
      turns: [{ speaker: "Ada", at: startedAt, text: "Another room." }],
    });
    expect(second.body.id).not.toBe(id);
    expect((await post(h, `/api/boards/${boardId}/meetings/${id}/cancel`, ada)).status).toBe(409);
  });
});
