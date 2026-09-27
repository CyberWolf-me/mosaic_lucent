import type { IncomingMessage, ServerResponse } from "node:http";
import type { RegisterRoutes } from "./context.js";
import type { StoredBoard } from "../boards.js";
import type { StoredUser } from "../identity.js";
import type { MeetingTranscript } from "../meetings.js";
import { icsAttachment, meetingIcs, type MeetingEvent } from "../calendar.js";
import { meetingPath } from "../notifications.js";

/**
 * Scheduled meetings (docs/28 A3.4, S2 and S3):
 *
 *   GET  /api/boards/:id/meetings/invitable        who can be invited (editor)
 *   POST /api/boards/:id/meetings/schedule         schedule one; invites go out (editor)
 *   POST /api/boards/:id/meetings/:mid/reschedule  change the plan (host)
 *   POST /api/boards/:id/meetings/:mid/cancel      call it off (host)
 *   GET  /api/boards/:id/meetings/:mid/people      the host and invitees, by name (viewer)
 *   GET  /api/boards/:id/meetings/:mid/calendar.ics  Add to calendar (viewer)
 *
 * A scheduled meeting is a meeting row with a plan and no turns yet (ADR
 * 0045); the recording that starts in its window becomes it (the save route,
 * routes/meetings.ts). Invitees must be able to read the board — an invite to
 * a meeting you can't open is a broken promise — and each gets the in-app
 * notification and, by their preference, a mail with the calendar invite.
 * The host is the person who scheduled it; the board's owner may act for
 * them.
 */
export const registerMeetingScheduleRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    requireBoardRole,
    requireCsrf,
    readBody,
    meetings,
    boardStore,
    userStore,
    orgStore,
    orgRoleFor,
    notifyUser,
    auditRow,
    authCtx,
  } = s;

  const canRead = async (board: StoredBoard, userId: string): Promise<boolean> =>
    (await boardStore.memberRole(board.id, userId, (uid) => orgRoleFor(uid, board.orgId))) !==
    undefined;

  async function json(req: IncomingMessage, res: ServerResponse) {
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as unknown) : {};
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return body as Record<string, unknown>;
      }
      send(res, 400, { error: "expected a JSON object" });
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    return null;
  }

  const siteOrigin = (): string => authCtx.siteOrigin ?? "http://localhost:5173";
  const domain = (): string => {
    try {
      return new URL(siteOrigin()).hostname || "lucent";
    } catch {
      return "lucent";
    }
  };

  async function people(ids: readonly string[]): Promise<StoredUser[]> {
    const out: StoredUser[] = [];
    for (const id of ids) {
      const u = await userStore.findById(id);
      if (u) out.push(u);
    }
    return out;
  }

  /** The calendar event for a meeting, as its invitees should see it now. */
  async function eventFor(
    meeting: MeetingTranscript,
    board: StoredBoard,
    method: MeetingEvent["method"],
  ): Promise<MeetingEvent | null> {
    if (!meeting.schedule) return null;
    const host = meeting.createdBy ? await userStore.findById(meeting.createdBy) : undefined;
    const invitees = await people(meeting.schedule.invitees);
    return {
      meetingId: meeting.id,
      method,
      sequence: Math.floor(Date.now() / 1000),
      start: meeting.schedule.scheduledFor,
      durationMin: meeting.schedule.durationMin,
      title: meeting.title ?? `Meeting on ${board.name}`,
      description: `A Lucent meeting on "${board.name}". Join from the meeting page.`,
      url: `${siteOrigin()}${meetingPath(board.id, meeting.id)}`,
      organizer: { name: host?.name ?? "Lucent", email: host?.email ?? `meetings@${domain()}` },
      attendees: invitees.map((u) => ({ name: u.name, email: u.email })),
      now: Date.now(),
      domain: domain(),
    };
  }

  /** Tell each invitee (not the host) about the meeting, with the calendar invite. */
  async function invite(
    meeting: MeetingTranscript,
    board: StoredBoard,
    host: StoredUser,
    who: readonly string[],
    updated: boolean,
  ): Promise<number> {
    const event = await eventFor(meeting, board, "REQUEST");
    if (!event || !meeting.schedule) return 0;
    const attachment = icsAttachment(event);
    let sent = 0;
    for (const user of await people(who)) {
      if (user.id === host.id) continue;
      notifyUser({
        kind: "meeting.invited",
        to: { userId: user.id, email: user.email },
        orgId: board.orgId,
        payload: {
          boardId: board.id,
          boardName: board.name,
          meetingId: meeting.id,
          title: event.title,
          scheduledFor: meeting.schedule.scheduledFor,
          durationMin: meeting.schedule.durationMin,
          hostName: host.name,
          updated,
        },
        attachments: [attachment],
      });
      sent++;
    }
    return sent;
  }

  async function uninvite(
    meeting: MeetingTranscript,
    board: StoredBoard,
    by: StoredUser,
    who: readonly string[],
  ): Promise<void> {
    const event = await eventFor(meeting, board, "CANCEL");
    if (!event || !meeting.schedule) return;
    const attachment = icsAttachment(event);
    for (const user of await people(who)) {
      if (user.id === by.id) continue;
      notifyUser({
        kind: "meeting.cancelled",
        to: { userId: user.id, email: user.email },
        orgId: board.orgId,
        payload: {
          boardId: board.id,
          boardName: board.name,
          meetingId: meeting.id,
          title: event.title,
          scheduledFor: meeting.schedule.scheduledFor,
          durationMin: meeting.schedule.durationMin,
          byName: by.name,
        },
        attachments: [attachment],
      });
    }
  }

  /**
   * The plan from a request body, with every invitee checked against the
   * board. The title is required: an untitled invite reads as spam.
   */
  async function readPlan(body: Record<string, unknown>, board: StoredBoard, res: ServerResponse) {
    const { validateMeetingTitle, validateSchedule, validateMeetingMode } = await import(
      "../meetings.js"
    );
    const title = validateMeetingTitle(body.title ?? "");
    if (!title.ok) return void send(res, 400, { error: title.error });
    if (!title.title) return void send(res, 400, { error: "Add a title." });
    const plan = validateSchedule(body, Date.now());
    if (!plan.ok) return void send(res, 400, { error: plan.error });
    const mode = validateMeetingMode(body.mode ?? undefined);
    if (!mode.ok) return void send(res, 400, { error: mode.error });
    for (const id of plan.schedule.invitees) {
      if (!(await canRead(board, id))) {
        const u = await userStore.findById(id);
        return void send(res, 400, {
          error: `${u?.name ?? "Someone you invited"} can't open this board. Share it with them first.`,
        });
      }
    }
    return { title: title.title, schedule: plan.schedule, mode: mode.mode };
  }

  /** The host, or the board's owner acting for them. */
  function mayHost(meeting: MeetingTranscript, user: StoredUser, role: string): boolean {
    return meeting.createdBy === user.id || role === "owner";
  }

  // The meetings you're invited to, wherever the board lives — the Meetings
  // list merges them with the workspace's own (docs/28 S1). Each board is
  // re-checked: an invite doesn't outlive losing access to the board.
  router.get("/api/meetings/invited", async (ctx) => {
    const { req, res } = ctx;
    const user = await s.requireUser(req, res);
    if (!user) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const { summarizeMeeting } = await import("../meetings.js");
    const out = [];
    const boards = new Map<string, StoredBoard | null>();
    for (const m of await meetings.invitedTo(user.id, 100)) {
      if (!boards.has(m.boardId)) {
        const board = await boardStore.get(m.boardId);
        boards.set(m.boardId, board && (await canRead(board, user.id)) ? board : null);
      }
      const board = boards.get(m.boardId);
      if (board) out.push(summarizeMeeting(m, board.name));
    }
    send(res, 200, { meetings: out });
  });

  router.get("/api/boards/:id/meetings/invitable", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/invitable";
    const guard = await requireBoardRole(req, res, ctx.param("id"), "editor", route);
    if (!guard.ok) return;
    const board = guard.board;
    const found = new Map<string, { id: string; name: string; email: string }>();
    const add = (u: { id: string; name: string; email: string }) => {
      if (!found.has(u.id)) found.set(u.id, { id: u.id, name: u.name, email: u.email });
    };
    const owner = await userStore.findById(board.ownerId);
    if (owner) add(owner);
    for (const m of await boardStore.members(board.id)) {
      const u = await userStore.findById(m.userId);
      if (u) add(u);
    }
    if (orgStore) {
      for (const m of await orgStore.membersOf(board.orgId)) {
        add({ id: m.userId, name: m.name, email: m.email });
      }
    }
    const list = [...found.values()]
      .filter((u) => u.id !== guard.user.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    send(res, 200, { people: list });
  });

  router.post("/api/boards/:id/meetings/schedule", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/schedule";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const body = await json(req, res);
    if (!body) return;
    const plan = await readPlan(body, guard.board, res);
    if (!plan) return;
    const now = Date.now();
    const meeting = await meetings.insert({
      boardId,
      orgId: guard.board.orgId,
      startedAt: plan.schedule.scheduledFor,
      endedAt: null,
      turns: [],
      createdBy: guard.user.id,
      createdAt: now,
      title: plan.title,
      schedule: plan.schedule,
      ...(plan.mode ? { mode: plan.mode } : {}),
    });
    const invited = await invite(meeting, guard.board, guard.user, plan.schedule.invitees, false);
    await auditRow(req, guard.user.id, guard.board.orgId, "board.meeting.scheduled", boardId, {
      meetingId: meeting.id,
      invitees: plan.schedule.invitees.length,
    });
    send(res, 201, { meeting, invited });
  });

  router.post("/api/boards/:id/meetings/:mid/reschedule", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/reschedule";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const before = await meetings.get(boardId, ctx.param("mid"));
    if (!before) return send(res, 404, { error: "meeting not found" });
    if (!mayHost(before, guard.user, guard.role)) {
      return send(res, 403, { error: "Only the host can change this meeting." });
    }
    const body = await json(req, res);
    if (!body) return;
    const plan = await readPlan(body, guard.board, res);
    if (!plan) return;
    const after = await meetings.reschedule(boardId, before.id, plan.schedule, plan.title);
    if (!after) {
      return send(res, 409, { error: "This meeting already started or was cancelled." });
    }
    const was = new Set(before.schedule?.invitees ?? []);
    const now = new Set(plan.schedule.invitees);
    const host = (before.createdBy && (await userStore.findById(before.createdBy))) || guard.user;
    // Everyone still invited gets the new time (new people: the invite);
    // anyone dropped gets the cancellation.
    await invite(
      after,
      guard.board,
      host,
      [...now].filter((id) => was.has(id)),
      true,
    );
    await invite(
      after,
      guard.board,
      host,
      [...now].filter((id) => !was.has(id)),
      false,
    );
    await uninvite(
      before,
      guard.board,
      guard.user,
      [...was].filter((id) => !now.has(id)),
    );
    send(res, 200, after);
  });

  router.post("/api/boards/:id/meetings/:mid/cancel", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/cancel";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const before = await meetings.get(boardId, ctx.param("mid"));
    if (!before) return send(res, 404, { error: "meeting not found" });
    if (!mayHost(before, guard.user, guard.role)) {
      return send(res, 403, { error: "Only the host can cancel this meeting." });
    }
    const alreadyCancelled = before.cancelledAt !== undefined;
    const after = await meetings.cancel(boardId, before.id, guard.user.id, Date.now());
    if (!after) return send(res, 409, { error: "This meeting already started." });
    if (!alreadyCancelled) {
      await uninvite(before, guard.board, guard.user, before.schedule?.invitees ?? []);
      await auditRow(req, guard.user.id, guard.board.orgId, "board.meeting.cancelled", boardId, {
        meetingId: before.id,
      });
    }
    send(res, 200, after);
  });

  router.get("/api/boards/:id/meetings/:mid/people", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/people";
    const guard = await requireBoardRole(req, res, ctx.param("id"), "viewer", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const meeting = await meetings.get(guard.board.id, ctx.param("mid"));
    if (!meeting) return send(res, 404, { error: "meeting not found" });
    const host = meeting.createdBy ? await userStore.findById(meeting.createdBy) : undefined;
    const invitees = await people(meeting.schedule?.invitees ?? []);
    const cancelledBy = meeting.cancelledBy
      ? await userStore.findById(meeting.cancelledBy)
      : undefined;
    send(res, 200, {
      host: host ? { id: host.id, name: host.name } : null,
      invitees: invitees.map((u) => ({ id: u.id, name: u.name })),
      cancelledBy: cancelledBy ? { id: cancelledBy.id, name: cancelledBy.name } : null,
      youHost: meeting.createdBy === guard.user.id || guard.role === "owner",
    });
  });

  router.get("/api/boards/:id/meetings/:mid/calendar.ics", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/calendar.ics";
    const guard = await requireBoardRole(req, res, ctx.param("id"), "viewer", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const meeting = await meetings.get(guard.board.id, ctx.param("mid"));
    const event = meeting ? await eventFor(meeting, guard.board, "PUBLISH") : null;
    if (!event) return send(res, 404, { error: "This meeting isn't scheduled." });
    res.writeHead(200, {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${meeting!.id}.ics"`,
      "cache-control": "no-store",
    });
    res.end(meetingIcs(event));
  });
};
