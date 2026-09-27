import {
  NOTE_TEMPLATES,
  assembleNotes,
  fallbackNotesDraft,
  isNoteTemplateId,
  keepEdits,
  type EnhancedNote,
  type NoteTemplateId,
  type NotesRequest,
} from "@lucent/ai";
import { providerFact } from "../modelRouter.js";
import { notesPutSchema, sanitizeEnhanced, type MeetingNotesRecord } from "../meetingNotes.js";
import type { RegisterRoutes } from "./context.js";
import { outputHash } from "../aiRuns.js";

/**
 * Meeting notes routes (docs/27 N1) — one person's notes on one meeting:
 *
 *   GET  /api/boards/:id/meetings/:mid/notes          the caller's notes
 *   PUT  /api/boards/:id/meetings/:mid/notes          save lines / template / edited note
 *   POST /api/boards/:id/meetings/:mid/notes/enhance  turn them into the structured note
 *
 * Viewer floor: taking notes on a meeting you can read changes nothing on
 * the board, and the row is keyed to the caller, so nobody reads or writes
 * anyone else's. Enhancing reads the transcript into a model prompt, so the
 * board's AI boundary and the org's provider policy decide — and when the
 * boundary refuses, the person still gets a note, made by the offline
 * enhancer, which sends nothing anywhere.
 */
export const registerMeetingNotesRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireCsrf,
    requireUser,
    requireBoardRole,
    meetings,
    meetingNotes,
    outboundRefusal,
    providerGate,
    provider,
    config,
    resolveAiContext,
    gateMonthly,
    meterUsage,
    meter,
  } = s;

  const load = async (
    ctx: Parameters<Parameters<typeof router.get>[1]>[0],
    route: string,
    csrf: boolean,
  ) => {
    const { req, res } = ctx;
    if (csrf && !requireCsrf(req, res, route)) return null;
    const user = await requireUser(req, res);
    if (!user) return null;
    if (csrf && !meter(req, res, route)) return null;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", route, user);
    if (!guard.ok) return null;
    if (!meetings || !meetingNotes) {
      send(res, 503, { error: "meeting notes are not configured" });
      return null;
    }
    const meeting = await meetings.get(boardId, ctx.param("mid"));
    if (!meeting) {
      send(res, 404, { error: "meeting not found" });
      return null;
    }
    const existing = await meetingNotes.get(meeting.id, user.id);
    const record: MeetingNotesRecord = existing ?? {
      meetingId: meeting.id,
      boardId,
      orgId: guard.board.orgId,
      userId: user.id,
      template: "general",
      lines: [],
      enhanced: null,
      updatedAt: Date.now(),
    };
    return { user, board: guard.board, meeting, record, store: meetingNotes };
  };

  router.get("/api/boards/:id/meetings/:mid/notes", async (ctx) => {
    const got = await load(ctx, "/api/boards/:id/meetings/:mid/notes", false);
    if (!got) return;
    send(ctx.res, 200, got.record);
  });

  router.put("/api/boards/:id/meetings/:mid/notes", async (ctx) => {
    const route = "/api/boards/:id/meetings/:mid/notes";
    const got = await load(ctx, route, true);
    if (!got) return;
    let body;
    try {
      const raw = await readBody(ctx.req);
      body = notesPutSchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      send(ctx.res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const next: MeetingNotesRecord = {
      ...got.record,
      ...(body.template ? { template: body.template } : {}),
      ...(body.lines ? { lines: body.lines } : {}),
      ...(body.enhanced !== undefined
        ? {
            enhanced: body.enhanced
              ? sanitizeEnhanced(body.enhanced as EnhancedNote, got.meeting.turns.length)
              : null,
          }
        : {}),
      updatedAt: Date.now(),
    };
    send(ctx.res, 200, await got.store.put(next));
  });

  router.post("/api/boards/:id/meetings/:mid/notes/enhance", async (ctx) => {
    const route = "/api/boards/:id/meetings/:mid/notes/enhance";
    const got = await load(ctx, route, true);
    if (!got) return;
    const { req, res } = ctx;
    let template: NoteTemplateId = got.record.template;
    let today: string | undefined;
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { template?: unknown; today?: unknown }) : {};
      if (body.template !== undefined) {
        if (!isNoteTemplateId(body.template)) {
          send(res, 400, {
            error: `template must be one of: ${Object.keys(NOTE_TEMPLATES).join(", ")}`,
          });
          return;
        }
        template = body.template;
      }
      if (typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today))
        today = body.today;
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    const request: NotesRequest = {
      template,
      ...(today ? { today } : {}),
      transcript: got.meeting.turns.map((t) => ({ speaker: t.speaker, text: t.text })),
      notes: got.record.lines,
    };
    const now = Date.now();

    // The transcript goes into a model prompt only where the board allows it.
    const refusal = await outboundRefusal(got.board, "ai", { provider });
    let note: EnhancedNote;
    let offline: string | null = null;
    if (refusal || !provider.generateNotes) {
      note = assembleNotes(request, fallbackNotesDraft(request), "fallback", now);
      offline = refusal ? "policy" : "no-model";
    } else {
      if (
        !(await providerGate(
          req,
          res,
          got.board.orgId,
          providerFact({ provider, byok: false }, config.aiSelfHosted),
          route,
        ))
      )
        return;
      const aiCtx = await resolveAiContext(got.user.id, got.board);
      const billTo = aiCtx.orgId ?? got.board.orgId;
      const allowance = await gateMonthly(req, res, billTo, "ai.generationsPerMonth", route);
      if (allowance === false) return;
      try {
        const draft = await provider.generateNotes(request);
        note = assembleNotes(request, draft, "model", now, draft.model);
        meterUsage(billTo, "ai.generation", 1, {
          boardId: got.board.id,
          provider: provider.name,
          mode: "notes",
          ...(draft.model ? { model: draft.model } : {}),
        });
        void s.recordRun({
          orgId: billTo,
          boardId: got.board.id,
          initiatedBy: got.user.id,
          surface: "notes",
          provider: provider.name,
          model: draft.model ?? null,
          contextScope: "meeting",
          tools: [],
          outputHash: outputHash(draft),
          opCount: 0,
          createdAt: now,
        });
      } catch {
        // A model failure still leaves the person with their notes, placed
        // and cited offline — and says so.
        note = assembleNotes(request, fallbackNotesDraft(request), "fallback", now);
        offline = "model-failed";
      }
    }
    // Lines the person rewrote in the last note are theirs; a re-enhance keeps them.
    note = keepEdits(got.record.enhanced, note);
    const saved = await got.store.put({ ...got.record, template, enhanced: note, updatedAt: now });
    send(res, 200, { ...saved, ...(offline ? { offline } : {}) });
  });
};
