import type { IncomingMessage, ServerResponse } from "node:http";
import type { RegisterRoutes } from "./context.js";
import type { StoredBoard } from "../boards.js";
import type { StoredUser } from "../identity.js";
import {
  CALL_ATTRIBUTES,
  callRoomName,
  isCallHost,
  newCallMeta,
  publishScopeFor,
  withAnswered,
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
    if (typeof input.captions === "boolean") {
      attributes[CALL_ATTRIBUTES.captions] = input.captions ? "1" : "";
    }
    if (Object.keys(attributes).length === 0) {
      return send(res, 400, { error: "send hand, capture, transcribe or captions" });
    }
    // Someone else's state: a host may lower a hand (as in Meet), nothing more.
    if (target !== call.user.id) {
      if (!call.host) return send(res, 403, { error: "Only the host can do that." });
      if (
        input.hand !== false ||
        input.capture !== undefined ||
        input.transcribe !== undefined ||
        input.captions !== undefined
      ) {
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
    const removed = input.identity;
    await calls.updateMeta(call.room, (current) =>
      withRemoved(current ?? newCallMeta(call.user.id, Date.now()), removed),
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

  // docs/28 S5 (A6): a host answers a guest who asked to join — let them in,
  // or keep them out of this call.
  router.post("/api/boards/:id/call/admit", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/admit";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    if (typeof input.userId !== "string" || typeof input.allow !== "boolean") {
      return send(res, 400, { error: "send the userId and allow" });
    }
    const guestId = input.userId;
    const allow = input.allow;
    if (!(call.state.meta?.waiting ?? []).some((w) => w.userId === guestId)) {
      return send(res, 404, { error: "They're not waiting to join." });
    }
    await calls.updateMeta(call.room, (current) =>
      withAnswered(current ?? newCallMeta(call.user.id, Date.now()), guestId, allow),
    );
    await auditRow(
      req,
      call.user.id,
      call.board.orgId,
      allow ? "board.call.guest_admitted" : "board.call.guest_denied",
      call.board.id,
      { userId: guestId },
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
    const promoted = input.identity;
    const meta = await calls.updateMeta(call.room, (current) =>
      withHost(current ?? newCallMeta(call.user.id, Date.now()), promoted),
    );
    // A co-host may present even when only hosts may.
    if (meta?.hostsOnlyShare) await calls.setPublishScope(call.room, promoted, "all");
    await auditRow(req, call.user.id, call.board.orgId, "board.call.host_added", call.board.id, {
      userId: input.identity,
    });
    send(res, 200, { ok: true });
  });

  // The host's call settings (Zoom's "Lock meeting", "Share screen: host
  // only"). Restricting sharing takes effect at once: every non-host loses
  // the right to publish a screen, and a screen they're presenting stops.
  router.post("/api/boards/:id/call/settings", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/call/settings";
    const call = await inCall(req, res, ctx.param("id"), route, { host: true });
    if (!call || !calls) return;
    const input = await body(req, res);
    if (!input) return;
    // Applied on top of the latest metadata, in turn with every other change.
    let before = newCallMeta(call.user.id, Date.now());
    const next =
      (await calls.updateMeta(call.room, (current) => {
        before = current ?? before;
        const changed = { ...before };
        if (typeof input.locked === "boolean") {
          if (input.locked) changed.locked = true;
          else delete changed.locked;
        }
        if (typeof input.hostsOnlyShare === "boolean") {
          if (input.hostsOnlyShare) changed.hostsOnlyShare = true;
          else delete changed.hostsOnlyShare;
        }
        // docs/28 S5 (A6): guests come in without asking.
        if (typeof input.openToGuests === "boolean") {
          if (input.openToGuests) changed.openToGuests = true;
          else delete changed.openToGuests;
        }
        return changed;
      })) ?? before;
    if (Boolean(next.hostsOnlyShare) !== Boolean(before.hostsOnlyShare)) {
      for (const p of call.state.participants) {
        const scope = publishScopeFor(next, p.identity);
        await calls.setPublishScope(call.room, p.identity, scope);
        if (scope === "no-screen") {
          for (const t of p.tracks) {
            if ((t.source === "screen_share" || t.source === "screen_share_audio") && !t.muted) {
              await calls.mute(call.room, p.identity, t.sid);
            }
          }
        }
      }
    }
    await auditRow(
      req,
      call.user.id,
      call.board.orgId,
      "board.call.settings_changed",
      call.board.id,
      {
        locked: Boolean(next.locked),
        hostsOnlyShare: Boolean(next.hostsOnlyShare),
        openToGuests: Boolean(next.openToGuests),
      },
    );
    send(res, 200, {
      ok: true,
      locked: Boolean(next.locked),
      hostsOnlyShare: Boolean(next.hostsOnlyShare),
      openToGuests: Boolean(next.openToGuests),
    });
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
