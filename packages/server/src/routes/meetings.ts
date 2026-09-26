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
  const { send, requireBoardRole, requireCsrf, readBody, meetings, orgPolicy, meetingConnectors } =
    s;

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
    send(res, 200, row);
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

    const { validateTurns } = await import("../meetings.js");
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
    const saved = await meetings.insert({
      boardId,
      orgId: guard.board.orgId,
      startedAt: Date.now(),
      endedAt: Date.now(),
      turns: checked.turns,
      createdBy: guard.user.id,
      createdAt: Date.now(),
    });
    send(res, 201, { ...saved, source: source.name });
  });
};
