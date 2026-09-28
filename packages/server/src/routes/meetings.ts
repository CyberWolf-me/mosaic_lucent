import type { RegisterRoutes } from "./context.js";

/**
 * Board meeting routes (E3 / R3 / Stage C3):
 *
 *   POST   /api/boards/:id/meetings            save a diarised transcript (editor)
 *   POST   /api/boards/:id/meetings/:mid/turns  append to a running meeting (editor)
 *   POST   /api/boards/:id/meetings/:mid/end    end a live capture (editor, idempotent)
 *   GET    /api/boards/:id/meetings            list a board's meetings (viewer)
 *   GET    /api/boards/:id/meetings/:mid       one transcript (viewer)
 *
 * Reads are viewer-floor because the transcript is board state, same as the
 * workspace; writes are editor-floor because a transcript records what was
 * said in the meeting — a viewer could fabricate minutes.
 *
 * The CSRF guard runs first on the POSTs: a browser session is the expected
 * caller for capture, and bearer clients (the MCP client, API keys) pass
 * through it by design, as everywhere else.
 */
export const registerMeetingRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    requireBoardRole,
    requireCsrf,
    requireUser,
    readBody,
    meetings,
    orgPolicy,
    meetingConnectors,
    userStore,
    boardStore,
    writeMeetingRecap,
    announceMeetingEnded,
    outboundRefusal,
  } = s;

  router.post("/api/boards/:id/meetings", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/boards/:id/meetings")) return;
    const boardId = ctx.param("id");
    // Guard before store check: a 503 for an unconfigured store must not
    // become an oracle over which boards exist.
    const guard = await requireBoardRole(req, res, boardId, "editor", "/api/boards/:id/meetings");
    if (!guard.ok) return;
    // docs/23 S2: "recording disabled" is an admin call above the board. The
    // refusal creates no capture; END and the reads stay allowed — a policy
    // turned on mid-meeting must let the running capture finalize rather than
    // strand it in-progress (a policy that strands records is a lie about
    // them), and an already-saved transcript is board state a member may read.
    if ((await orgPolicy(guard.board.orgId)).recordingDisabled) {
      send(res, 403, {
        error: "this organization's policy disables meeting capture for every board",
        recordingDisabled: true,
      });
      return;
    }
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });

    let body: {
      turns?: unknown;
      startedAt?: unknown;
      endedAt?: unknown;
      mode?: unknown;
    };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    const startedAt =
      typeof body.startedAt === "number" && Number.isFinite(body.startedAt) && body.startedAt > 0
        ? body.startedAt
        : Date.now();
    const endedAt =
      typeof body.endedAt === "number" && Number.isFinite(body.endedAt) && body.endedAt >= startedAt
        ? body.endedAt
        : null;

    // Imported here rather than module scope so this route file needs no
    // runtime dependency on the meetings domain beyond the store interface.
    const { validateTurns, validateMeetingMode } = await import("../meetings.js");
    const checked = validateTurns(body.turns);
    if (!checked.ok) {
      send(res, 400, { error: checked.error });
      return;
    }
    // docs/24 Phase D: the capture profile rides the save (absent on older
    // clients); a typo is a named 400, never a fifth mode.
    const modeChecked = validateMeetingMode(body.mode);
    if (!modeChecked.ok) {
      send(res, 400, { error: modeChecked.error });
      return;
    }

    // docs/28 A3.4 (§9.6): a recording that starts in a scheduled meeting's
    // window becomes that meeting — its invites already carry the id. Only
    // one recording can start it (the store's precondition); another opens
    // its own transcript below.
    if (endedAt === null) {
      const { scheduledMeetingAt } = await import("../meetings.js");
      const due = scheduledMeetingAt(await meetings.forBoard(boardId, 200), Date.now());
      const started = due
        ? await meetings.start(boardId, due.id, {
            startedAt,
            turns: checked.turns,
            ...(modeChecked.mode !== undefined ? { mode: modeChecked.mode } : {}),
          })
        : undefined;
      if (started) return send(res, 201, started);
    }

    const saved = await meetings.insert({
      boardId,
      orgId: guard.board.orgId,
      startedAt,
      endedAt,
      turns: checked.turns,
      ...(modeChecked.mode !== undefined ? { mode: modeChecked.mode } : {}),
      createdBy: guard.user.id,
      createdAt: Date.now(),
    });
    // Saved whole with an end (the one-shot save): it is already over, so
    // the end-of-meeting pass starts now (docs/28 A3.3).
    if (saved.endedAt !== null) {
      announceMeetingEnded({ boardId, orgId: guard.board.orgId, meetingId: saved.id });
    }
    send(res, 201, saved);
  });

  router.get("/api/boards/:id/meetings", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/meetings");
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const rows = await meetings.forBoard(boardId);
    send(res, 200, { meetings: rows });
  });

  // Checkpoint append (M2): a live capture extends its running transcript so
  // a refresh mid-meeting loses nothing. Ended meetings refuse the append
  // (their minutes are immutable — "editing the minutes" is a new save).
  router.post("/api/boards/:id/meetings/:mid/turns", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/boards/:id/meetings/:mid/turns")) return;
    const boardId = ctx.param("id");
    const mid = ctx.param("mid");
    const guard = await requireBoardRole(
      req,
      res,
      boardId,
      "editor",
      "/api/boards/:id/meetings/:mid/turns",
    );
    if (!guard.ok) return;
    // docs/23 S2: the capture append is a new write of capture, so the org's
    // recording policy governs it (see the save route for the full reasoning).
    if ((await orgPolicy(guard.board.orgId)).recordingDisabled) {
      send(res, 403, {
        error: "this organization's policy disables meeting capture for every board",
        recordingDisabled: true,
      });
      return;
    }
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });

    let body: { turns?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    const { validateTurns } = await import("../meetings.js");
    const checked = validateTurns(body.turns);
    if (!checked.ok) {
      send(res, 400, { error: checked.error });
      return;
    }

    const row = await meetings.appendTo(boardId, mid, checked.turns);
    if (!row) {
      // Either the id is wrong or the meeting already ended — both answer
      // the same so the route is not an oracle over other boards' meetings.
      send(res, 404, { error: "meeting not found or already ended" });
      return;
    }
    send(res, 200, row);
  });

  // End a live capture (Stage C3): stopRecording used to just abandon the
  // id, leaving the store saying "in progress" forever — a lie any meeting
  // chronology would inherit. Editor floor (ending is a write about the
  // record, the same judgment appending gets); idempotent: a re-end returns
  // the row, not a second effect.
  router.post("/api/boards/:id/meetings/:mid/end", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/boards/:id/meetings/:mid/end")) return;
    const boardId = ctx.param("id");
    const mid = ctx.param("mid");
    const guard = await requireBoardRole(
      req,
      res,
      boardId,
      "editor",
      "/api/boards/:id/meetings/:mid/end",
    );
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });

    let endedAt: unknown;
    try {
      const raw = await readBody(req);
      endedAt = raw ? (JSON.parse(raw) as { endedAt?: unknown }).endedAt : undefined;
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const at =
      typeof endedAt === "number" && Number.isFinite(endedAt) && endedAt > 0 ? endedAt : Date.now();
    const existing = await meetings.get(boardId, mid);
    if (!existing) {
      send(res, 404, { error: "meeting not found" });
      return;
    }
    if (at < existing.startedAt) {
      send(res, 400, { error: "endedAt cannot predate the meeting's start" });
      return;
    }
    const row = await meetings.end(boardId, mid, at);
    if (!row) {
      send(res, 404, { error: "meeting not found" });
      return;
    }
    // docs/28 A3.3: the first end (not an idempotent re-end) starts the
    // end-of-meeting pass.
    if (existing.endedAt === null && row.endedAt !== null) {
      announceMeetingEnded({ boardId, orgId: guard.board.orgId, meetingId: mid });
    }
    send(res, 200, row);
  });

  // docs/28 S7 (spec §23): correct what a turn says. Editor, like every
  // meeting write — the speaker can't correct their own line yet because
  // speakers are labels, not accounts (§9.4 waits on per-participant
  // capture). The correction is an overlay: the turn and any earlier
  // correction stay on record, and readers see the latest.
  router.post("/api/boards/:id/meetings/:mid/turns/:n/correction", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/turns/:n/correction";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    // docs/28 §9.4: the person who said it may correct their own line, as
    // well as the board's editors; every correction names who made it.
    const guard = await requireBoardRole(req, res, boardId, "viewer", route);
    if (!guard.ok) return;
    const editor = guard.role === "editor" || guard.role === "owner";
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    let body: { text?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const { MAX_CORRECTION_CHARS } = await import("../meetings.js");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "" || text.length > MAX_CORRECTION_CHARS) {
      send(res, 400, { error: `text must be 1–${MAX_CORRECTION_CHARS} characters` });
      return;
    }
    const mid = ctx.param("mid");
    const meeting = await meetings.get(boardId, mid);
    if (!meeting) return send(res, 404, { error: "meeting not found" });
    const turn = Number(ctx.param("n"));
    if (!Number.isInteger(turn) || turn < 0 || turn >= meeting.turns.length) {
      send(res, 400, { error: "no such turn in this meeting" });
      return;
    }
    if (!editor && meeting.turns[turn]!.speakerId !== guard.user.id) {
      send(res, 403, { error: "Only the person who said it, or an editor, can correct a line." });
      return;
    }
    const updated = await meetings.addCorrection(boardId, mid, {
      turn,
      text,
      by: guard.user.id,
      ...(guard.user.name ? { byName: guard.user.name } : {}),
      at: Date.now(),
    });
    if (!updated) return send(res, 404, { error: "meeting not found" });
    send(res, 200, updated);
  });

  // docs/28 A3.3 / S9: write — or rewrite — the end-of-meeting summary now.
  // Editor, like every meeting write; the job does the same work after an
  // end, and this is how a person asks for it again (or for a capture the
  // idle sweep ended). Always answers with the meeting.
  router.post("/api/boards/:id/meetings/:mid/summary", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/summary";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const result = await writeMeetingRecap(boardId, ctx.param("mid"), {
      replace: true,
      by: guard.user.id,
    });
    switch (result.outcome) {
      case "written":
        return send(res, 200, result.meeting);
      case "not-found":
        return send(res, 404, { error: "meeting not found" });
      case "not-ended":
        return send(res, 409, { error: "the meeting is still running — end it first" });
      case "record-mode":
        return send(res, 422, { error: "Record mode keeps the transcript only" });
      case "empty":
        return send(res, 422, { error: "nothing was said in this meeting" });
      case "unavailable":
        return send(res, 503, { error: "meeting transcripts are not configured" });
    }
  });

  router.get("/api/boards/:id/meetings/:mid", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const mid = ctx.param("mid");
    const guard = await requireBoardRole(
      req,
      res,
      boardId,
      "viewer",
      "/api/boards/:id/meetings/:mid",
    );
    if (!guard.ok) return;
    // docs/23 S1: an agent (MCP) reads a meeting only where the board lets
    // agents read (ADR 0048's get_meeting).
    if (req.headers["x-lucent-client"] === "mcp") {
      const refusal = await outboundRefusal(guard.board, "agent");
      if (refusal) {
        return send(res, 403, {
          error: refusal.error,
          classification: refusal.classification,
          boundary: refusal.boundary,
        });
      }
    }
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const row = await meetings.get(boardId, mid);
    if (!row) {
      send(res, 404, { error: "meeting not found" });
      return;
    }
    send(res, 200, row);
  });

  // External import (docs/24 Phase E, docs/25 V3): a Zoom/Meet/Teams
  // transcript lands as turns in the same store. Editor floor — importing
  // minutes is a write about what was said, the same judgment a manual
  // save gets — and the org's recording policy governs it, because capture
  // from outside is still capture. The connector's only job is turns; the
  // route validates before anything persists, and the saved row carries no
  // mode (imported, not captured under a profile).
  router.post("/api/boards/:id/meetings/import", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/boards/:id/meetings/import")) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(
      req,
      res,
      boardId,
      "editor",
      "/api/boards/:id/meetings/import",
    );
    if (!guard.ok) return;
    if ((await orgPolicy(guard.board.orgId)).recordingDisabled) {
      send(res, 403, {
        error: "this organization's policy disables meeting capture for every board",
        recordingDisabled: true,
      });
      return;
    }
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });

    let body: { source?: unknown; ref?: unknown; credential?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const source =
      typeof body.source === "string" ? meetingConnectors.sources.get(body.source) : undefined;
    if (!source) {
      send(res, 400, {
        error: `unknown meeting source (available: ${[...meetingConnectors.sources.keys()].join(", ") || "none"})`,
      });
      return;
    }
    const ref = body.ref as { id?: unknown; title?: unknown } | undefined;
    if (!ref || typeof ref.id !== "string" || ref.id.trim() === "") {
      send(res, 400, { error: "ref.id must be a non-empty string" });
      return;
    }
    const credential =
      typeof body.credential === "string" && body.credential !== "" ? body.credential : undefined;

    const { validateTurns, validateMeetingTitle } = await import("../meetings.js");
    let fetched: { turns: unknown; title?: string };
    try {
      fetched = await source.fetchTranscript(
        {
          id: ref.id,
          ...(typeof ref.title === "string" && ref.title !== "" ? { title: ref.title } : {}),
        },
        credential,
      );
    } catch (err) {
      send(res, 502, { error: "meeting source failed", detail: (err as Error).message });
      return;
    }
    const checked = validateTurns(fetched.turns);
    if (!checked.ok) {
      send(res, 502, { error: "meeting source returned unusable turns", detail: checked.error });
      return;
    }
    const importedTitle = validateMeetingTitle(fetched.title ?? null);
    const saved = await meetings.insert({
      boardId,
      orgId: guard.board.orgId,
      startedAt: Date.now(),
      endedAt: Date.now(),
      turns: checked.turns,
      createdBy: guard.user.id,
      createdAt: Date.now(),
      // The source's own name for the meeting, when it gives a usable one.
      ...(importedTitle.ok && importedTitle.title ? { title: importedTitle.title } : {}),
    });
    announceMeetingEnded({ boardId, orgId: guard.board.orgId, meetingId: saved.id });
    send(res, 201, { ...saved, source: source.name });
  });

  // ADR 0045 (docs/26 J1): name a meeting. Editor, like every meeting write;
  // null or "" makes it untitled again.
  router.patch("/api/boards/:id/meetings/:mid", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    let body: { title?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    if (!("title" in body)) {
      send(res, 400, { error: "title is required (null clears it)" });
      return;
    }
    const { validateMeetingTitle } = await import("../meetings.js");
    const checked = validateMeetingTitle(body.title);
    if (!checked.ok) {
      send(res, 400, { error: checked.error });
      return;
    }
    const updated = await meetings.setTitle(boardId, ctx.param("mid"), checked.title);
    if (!updated) return send(res, 404, { error: "meeting not found" });
    send(res, 200, updated);
  });

  // ADR 0045 (docs/26 J1, docs/28 S1): every meeting in the workspace the
  // caller can read, as summaries (no turns), newest first. The same two
  // scopes as GET /api/boards: an org member reads every board in the org;
  // an outside collaborator only the boards they were given — so a
  // non-member learns nothing beyond their own grants.
  router.get("/api/orgs/:id/meetings", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const orgId = ctx.param("id");
    const member = (await userStore.membershipsFor(user.id)).some((m) => m.orgId === orgId);
    // docs/26 A6: a workspace that's closed to you right now lists nothing.
    const boards = (await s.access.blocked(user.id, orgId))
      ? []
      : member
        ? await boardStore.listForOrg(orgId)
        : await boardStore.listForUser(orgId, user.id);
    const url = new URL(req.url ?? "/", "http://localhost");
    const requested = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    const names = new Map(boards.map((b) => [b.id, b.name] as const));
    const rows = await meetings.forBoards([...names.keys()], limit);
    const { summarizeMeeting } = await import("../meetings.js");
    send(res, 200, {
      orgId,
      meetings: rows.map((m) => summarizeMeeting(m, names.get(m.boardId) ?? "")),
    });
  });
};
