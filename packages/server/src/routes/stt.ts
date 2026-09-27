import type { ServerResponse } from "node:http";
import type { RegisterRoutes } from "./context.js";
import type { SttSessionEntry, SttUtterance } from "../stt.js";

/**
 * Server-hosted diarizing STT (docs/25 V1 — the fourth STT slot).
 *
 *   POST /api/stt/sessions              open a session (CSRF, metered)
 *   POST /api/stt/sessions/:id/audio    offer an audio chunk, get new finals
 *   POST /api/stt/sessions/:id/close    flush, meter voice minutes, destroy
 *
 * Guard order follows the generate ladder: CSRF → user → meter → liveness →
 * org STT policy → monthly allowance. Audio never touches Postgres — sessions
 * are process-local and ephemeral (`stt.ts`), with the same sticky-session
 * caveat rooms already carry. A refused or failed request never bills:
 * metering happens once, on close, from the session's own audio clock.
 */

const MAX_CHUNK_BYTES = 1024 * 1024;

function utteranceView(u: SttUtterance): Record<string, unknown> {
  return {
    text: u.text,
    ...(u.speaker !== undefined ? { speaker: u.speaker } : {}),
    ...(u.startedAt !== undefined ? { start: u.startedAt } : {}),
    ...(u.endedAt !== undefined ? { end: u.endedAt } : {}),
    ...(u.confidence !== undefined ? { confidence: u.confidence } : {}),
  };
}

export const registerSttRoutes: RegisterRoutes = (router, s) => {
  const {
    stt,
    sttSessions,
    send,
    readRawBody,
    requireUser,
    requireCsrf,
    meter,
    trace,
    resolveAiContext,
    gateMonthly,
    meterUsage,
    sttGate,
    telemetry,
  } = s;

  router.post("/api/stt/sessions", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/stt/sessions";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    // Fail open like LiveKit: an unconfigured deployment has no hosted STT,
    // and speaking into a standby mock would bill attention for nothing.
    if (!stt.live) {
      send(res, 503, { error: "server transcription is not configured on this deployment" });
      return;
    }
    // Billing org, image-route pattern: the caller's first org, since chunks
    // carry no board. An orgless caller has no allowance to spend and no
    // policy to consult — allowed, unmetered.
    const aiCtx = await resolveAiContext(user.id, undefined);
    if (aiCtx.orgId && !(await sttGate(req, res, aiCtx.orgId, route))) return;
    if (aiCtx.orgId) {
      const allowance = await gateMonthly(req, res, aiCtx.orgId, "voice.minutes", route);
      if (allowance === false) return;
    }
    const entry = sttSessions.create(user.id, aiCtx.orgId, stt.createSession());
    send(res, 200, {
      sessionId: entry.id,
      expiresAt: entry.lastSeenAt + 15 * 60_000,
      // docs/28 F22: say whether finals arrive during the session or only at
      // close — this used to answer "live" whatever the provider did.
      mode: stt.streaming ? "live" : "at-close",
      provider: stt.name,
    });
  });

  async function lookup(
    res: ServerResponse,
    sessionId: string,
    userId: string,
  ): Promise<SttSessionEntry | undefined> {
    const entry = sttSessions.get(sessionId);
    // Same masking every id-bearing route uses: unknown, expired, or
    // another user's session are all one 404 — ids stay unguessable.
    if (!entry || entry.userId !== userId) {
      send(res, 404, { error: "unknown or expired session" });
      return undefined;
    }
    return entry;
  }

  router.post("/api/stt/sessions/:id/audio", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/stt/sessions/:id/audio";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const entry = await lookup(res, ctx.param("id"), user.id);
    if (!entry) return;
    // Deterministic 413 for well-formed oversize uploads: `readRawBody`
    // destroys the socket past the cap (the assets route's shape), which
    // wins the race against any response — so a declared over-cap length
    // is refused before a byte is read. Chunked bodies without a length
    // take the reader's path instead.
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) {
      send(res, 413, { error: "audio chunk too large" });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readRawBody(req, MAX_CHUNK_BYTES);
    } catch {
      send(res, 413, { error: "audio chunk too large" });
      return;
    }
    if (bytes.byteLength === 0) {
      send(res, 400, { error: "empty audio chunk" });
      return;
    }
    let pushed: import("../stt.js").SttChunkResult;
    try {
      pushed = await entry.handle.push(
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
    } catch (err) {
      telemetry.record({
        kind: "error",
        route,
        status: 502,
        message: (err as Error).message,
        requestId: trace(req),
      });
      send(res, 502, { error: "transcription provider failed", detail: (err as Error).message });
      return;
    }
    sttSessions.touch(entry, bytes.byteLength);
    // docs/25 V5: the sidecar's VAD verdict rides along (null when
    // unoffered). No consumer reads it yet — turn-taking does, at V8.
    send(res, 200, { finals: pushed.utterances.map(utteranceView), speech: pushed.speech });
  });

  router.post("/api/stt/sessions/:id/close", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/stt/sessions/:id/close";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const entry = await lookup(res, ctx.param("id"), user.id);
    if (!entry) return;
    let flushed: SttUtterance[];
    let audioSeconds: number;
    try {
      ({ utterances: flushed, audioSeconds } = await entry.handle.close());
    } catch (err) {
      telemetry.record({
        kind: "error",
        route,
        status: 502,
        message: (err as Error).message,
        requestId: trace(req),
      });
      send(res, 502, { error: "transcription provider failed", detail: (err as Error).message });
      return;
    }
    sttSessions.remove(entry.id);
    // Whole minutes (`voice.minute` counts units): a session under a minute
    // costs nothing, which is also what makes aborted mic clicks free. The
    // close is the only metering point, so a refusal or a crash never bills.
    const minutes = Math.floor(audioSeconds / 60);
    if (entry.orgId && minutes > 0) {
      meterUsage(entry.orgId, "voice.minute", minutes, {
        session: entry.id,
        provider: stt.name,
      });
    }
    send(res, 200, {
      finals: flushed.map(utteranceView),
      audioSeconds,
      minutes,
    });
  });
};
