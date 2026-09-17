import type { RegisterRoutes } from "./context.js";

/**
 * Server voice proxy (docs/25 V7, M6.2):
 *
 *   POST /api/tts/speak   synthesize text to audio (CSRF, metered)
 *
 * Guard order follows the STT session ladder: CSRF → user → meter →
 * liveness → org TTS policy → monthly allowance. Text caps at 2000 chars
 * (the client's own clamp — a longer body is a 400, not a silent cut).
 * Metering is whole voice minutes from ~800 chars/minute, floored, so
 * short answers cost nothing; the close-only rule's analogue here is
 * meter-on-success — a refusal or a provider failure never bills.
 *
 * Speech is metered as `voice.minute` with `sort: "tts"`: the allowance is
 * shared hosted-voice minutes, while the line item keeps transcription and
 * synthesis distinguishable for reconciliation.
 */

const MAX_INPUT_CHARS = 2000;
/** Rough speech rate for minute-granularity billing; documented, not exact. */
const CHARS_PER_MINUTE = 800;

export const registerTtsRoutes: RegisterRoutes = (router, s) => {
  const {
    tts,
    send,
    readBody,
    requireUser,
    requireCsrf,
    meter,
    trace,
    resolveAiContext,
    gateMonthly,
    meterUsage,
    ttsGate,
    telemetry,
  } = s;

  router.post("/api/tts/speak", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/tts/speak";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    // Fail open like STT: an unconfigured deployment has no server voice,
    // and the client falls back to local synthesis on exactly this 503.
    if (!tts.live) {
      send(res, 503, { error: "server voice is not configured on this deployment" });
      return;
    }
    const aiCtx = await resolveAiContext(user.id, undefined);
    if (aiCtx.orgId && !(await ttsGate(req, res, aiCtx.orgId, route))) return;
    if (aiCtx.orgId) {
      const allowance = await gateMonthly(req, res, aiCtx.orgId, "voice.minutes", route);
      if (allowance === false) return;
    }

    let body: { input?: unknown; voice?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    if (typeof body.input !== "string" || body.input.trim() === "") {
      send(res, 400, { error: "input must be a non-empty string" });
      return;
    }
    if (body.input.length > MAX_INPUT_CHARS) {
      send(res, 400, { error: `input exceeds ${MAX_INPUT_CHARS} characters` });
      return;
    }
    const voice =
      typeof body.voice === "string" && body.voice.length > 0 && body.voice.length <= 64
        ? body.voice
        : undefined;

    let audio: Uint8Array;
    let contentType: string;
    try {
      ({ audio, contentType } = await tts.synthesize({
        text: body.input,
        ...(voice ? { voice } : {}),
      }));
    } catch (err) {
      telemetry.record({
        kind: "error",
        route,
        status: 502,
        message: (err as Error).message,
        requestId: trace(req),
      });
      send(res, 502, { error: "voice provider failed", detail: (err as Error).message });
      return;
    }
    if (aiCtx.orgId) {
      const minutes = Math.floor(body.input.length / CHARS_PER_MINUTE);
      if (minutes > 0) {
        meterUsage(aiCtx.orgId, "voice.minute", minutes, {
          sort: "tts",
          provider: tts.name,
        });
      }
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(Buffer.from(audio));
  });
};
