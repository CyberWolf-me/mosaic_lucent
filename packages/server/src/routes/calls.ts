import type { IncomingMessage, ServerResponse } from "node:http";
import type { RegisterRoutes } from "./context.js";
import type { StoredBoard } from "../boards.js";
import type { StoredUser } from "../identity.js";
import {
  CALL_ATTRIBUTES,
  callRoomName,
  isCallHost,
  newCallMeta,
  withHost,
  withRemoved,
  type CallRoom,
  type CallTrackSource,
} from "../calls.js";

/**
 * The board call's room controls (docs/28 A3.2, S4 and S5):
 *
 *   GET  /api/boards/:id/call          who is in the call, who hosts it (viewer)
 *   POST /api/boards/:id/call/state    raise or lower your hand; mark that you
 *                                      transcribe, or that you'd rather not be
 *                                      transcribed; a host lowers someone's hand
 *   POST /api/boards/:id/call/mute     host: mute one person, or everyone
 *   POST /api/boards/:id/call/remove   host: remove someone for this call
 *   POST /api/boards/:id/call/hosts    host: make someone a co-host
 *   POST /api/boards/:id/call/end      host: end the call for everyone
 *
 * Joining is `POST /api/livekit/token`, which also decides who hosts. The
 * board role is the floor for everything here (viewer: speaking in a meeting
 * is not editing the board, docs/28 §9.3); the host powers come from the
 * call's own host list, which only the server writes (calls.ts).
 */

const MUTABLE_SOURCES: readonly CallTrackSource[] = ["microphone", "camera", "screen_share"];

export const registerCallRoutes: RegisterRoutes = (router, s) => {
  const { send, requireBoardRole, requireCsrf, readBody, calls, auditRow } = s;

  async function body(req: IncomingMessage, res: ServerResponse) {
    try {
      const raw = await readBody(req);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      send(res, 400, { error: "expected a JSON object" });
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    return null;
  }

  /**
   * The shared guard: CSRF, the board's viewer floor, a configured call
   * service, and a running call. With `host`, the caller must host it.
   */
  async function inCall(
    req: IncomingMessage,
    res: ServerResponse,
    boardId: string,
    route: string,
    options: { host: boolean },
  ): Promise<
    | { user: StoredUser; board: StoredBoard; room: string; state: CallRoom; host: boolean }
    | undefined
  > {
    if (!requireCsrf(req, res, route)) return undefined;
    const guard = await requireBoardRole(req, res, boardId, "viewer", route);
    if (!guard.ok) return undefined;
    if (!calls) {
      send(res, 503, { error: "Video calls aren't set up on this server." });
      return undefined;
    }
    const room = callRoomName(boardId);
    const state = await calls.read(room);
    if (!state) {
      send(res, 404, { error: "No call is running on this board." });
      return undefined;
    }
    const host = isCallHost(state.meta, guard.user.id);
    if (options.host && !host) {
      send(res, 403, { error: "Only the host can do that." });
      return undefined;
    }
    return { user: guard.user, board: guard.board, room, state, host };
  }

  router.get("/api/boards/:id/call", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call";
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", route);
    if (!guard.ok) return;
    if (!calls) return send(res, 503, { error: "Video calls aren't set up on this server." });
    const state = await calls.read(callRoomName(boardId));
    const participants = (state?.participants ?? []).map((p) => ({
      identity: p.identity,
      name: p.name,
      host: isCallHost(state?.meta ?? null, p.identity),
      joinedAt: p.joinedAt,
    }));
    send(res, 200, {
      live: participants.length > 0,
      participants,
      startedAt: state?.meta?.startedAt ?? null,
      you: { host: isCallHost(state?.meta ?? null, guard.user.id) },
    });
  });

  router.post("/api/boards/:id/call/state", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/state";
    const call = await inCall(req, res, ctx.param("id"), route, { host: false });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    const target = typeof input.identity === "string" ? input.identity : call.user.id;
    const attributes: Record<string, string> = {};
    if (typeof input.hand === "boolean") {
      attributes[CALL_ATTRIBUTES.hand] = input.hand ? String(Date.now()) : "";
    }
    if (typeof input.capture === "boolean") {
      attributes[CALL_ATTRIBUTES.capture] = input.capture ? String(Date.now()) : "";
    }
    if (typeof input.transcribe === "boolean") {
      attributes[CALL_ATTRIBUTES.optOut] = input.transcribe ? "" : "1";
    }
    if (Object.keys(attributes).length === 0) {
      return send(res, 400, { error: "send hand, capture or transcribe" });
    }
    // Someone else's state: a host may lower a hand (as in Meet), nothing more.
    if (target !== call.user.id) {
      if (!call.host) return send(res, 403, { error: "Only the host can do that." });
      if (input.hand !== false || input.capture !== undefined || input.transcribe !== undefined) {
        return send(res, 403, { error: "A host can only lower someone's hand." });
      }
    }
    if (!call.state.participants.some((p) => p.identity === target)) {
      return send(res, 409, {
        error: target === call.user.id ? "You're not in this call." : "They're not in this call.",
      });
    }
    await calls.setAttributes(call.room, target, attributes);
    send(res, 200, { ok: true });
  });

  router.post("/api/boards/:id/call/mute", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/mute";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    const source = (input.source ?? "microphone") as CallTrackSource;
    if (!MUTABLE_SOURCES.includes(source)) {
      return send(res, 400, { error: "source is microphone, camera or screen_share" });
    }
    let targets = call.state.participants;
    if (input.everyone === true) {
      targets = targets.filter((p) => p.identity !== call.user.id);
    } else {
      if (typeof input.identity !== "string") {
        return send(res, 400, { error: "send identity, or everyone: true" });
      }
      targets = targets.filter((p) => p.identity === input.identity);
      if (targets.length === 0) return send(res, 404, { error: "They're not in this call." });
    }
    let muted = 0;
    for (const p of targets) {
      for (const t of p.tracks) {
        if (t.source !== source || t.muted) continue;
        await calls.mute(call.room, p.identity, t.sid);
        muted++;
      }
    }
    send(res, 200, { ok: true, muted });
  });

  router.post("/api/boards/:id/call/remove", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/remove";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    if (typeof input.identity !== "string" || input.identity.length === 0) {
      return send(res, 400, { error: "send the identity to remove" });
    }
    if (input.identity === call.user.id) {
      return send(res, 400, { error: "Leave the call instead of removing yourself." });
    }
    // The removal is recorded before the disconnect, so the client's own
    // reconnect attempt already meets a refusal at the token route.
    await calls.setMeta(
      call.room,
      withRemoved(call.state.meta ?? newCallMeta(call.user.id, Date.now()), input.identity),
    );
    if (call.state.participants.some((p) => p.identity === input.identity)) {
      await calls.remove(call.room, input.identity);
    }
    await auditRow(
      req,
      call.user.id,
      call.board.orgId,
      "board.call.participant_removed",
      call.board.id,
      {
        userId: input.identity,
      },
    );
    send(res, 200, { ok: true });
  });

  router.post("/api/boards/:id/call/hosts", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/hosts";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    if (typeof input.identity !== "string") return send(res, 400, { error: "send the identity" });
    if (!call.state.participants.some((p) => p.identity === input.identity)) {
      return send(res, 404, { error: "They're not in this call." });
    }
    await calls.setMeta(
      call.room,
      withHost(call.state.meta ?? newCallMeta(call.user.id, Date.now()), input.identity),
    );
    await auditRow(req, call.user.id, call.board.orgId, "board.call.host_added", call.board.id, {
      userId: input.identity,
    });
    send(res, 200, { ok: true });
  });

  router.post("/api/boards/:id/call/end", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/end";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    await calls.end(call.room);
    await auditRow(req, call.user.id, call.board.orgId, "board.call.ended", call.board.id, {
      participants: call.state.participants.length,
    });
    send(res, 200, { ok: true });
  });
};
