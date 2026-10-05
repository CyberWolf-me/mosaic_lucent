import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate } from "../accounts.js";
import { bearerToken } from "../auth.js";
import { PROMETHEUS_CONTENT_TYPE } from "../obs/metrics.js";
import type { AppRouter, RouteServices } from "./context.js";

/**
 * Health and the two metrics surfaces.
 *
 * `/health` is deliberately minimal -- versions, uptime and the provider name
 * live behind the authenticated metrics routes, so a public probe learns nothing
 * about the deployment.
 */
export function registerSystemRoutes(router: AppRouter, s: RouteServices): void {
  const { config, send } = s;

  /**
   * Both metrics routes are gated identically: route templates, counts and
   * latencies are exactly what an unauthenticated prober should not be handed.
   * `authenticate` directly rather than `requireUser`, because the gate is
   * conditional on `requireAuth` -- with auth off these are open, which is what
   * makes a local dev scrape work without a session.
   */
  const metricsGateOpen = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!config.requireAuth) return true;
    const user = await authenticate(
      s.authCtx,
      req.headers.cookie ?? null,
      bearerToken(req.headers.authorization),
    );
    if (!user) {
      send(res, 401, { error: "authentication required" });
      return false;
    }
    return true;
  };

  router.get("/health", (ctx) => {
    send(ctx.res, 200, { ok: true });
  });

  /**
   * Local telemetry. Message bodies are redacted unless
   * LUCENT_METRICS_VERBOSE=1, because error messages can carry provider
   * payloads.
   */
  const handleMetrics = async (ctx: { req: IncomingMessage; res: ServerResponse }) => {
    if (!(await metricsGateOpen(ctx.req, ctx.res))) return;
    const snap = s.telemetry.snapshot();
    send(ctx.res, 200, {
      ...(config.metricsVerbose
        ? snap
        : {
            ...snap,
            recentErrors: snap.recentErrors.map((e) => ({ ...e, message: "[redacted]" })),
          }),
      usage: { ...s.usage.snapshot(), limits: s.limits },
      provider: s.provider.name,
    });
  };

  router.get("/metrics", handleMetrics);
  router.get("/api/metrics", handleMetrics);

  /**
   * The same registry in the Prometheus text exposition format.
   *
   * On its own path rather than content-negotiated on /metrics, because
   * /metrics is a JSON contract the suite asserts on (security.test.ts reads
   * `recentErrors` out of the body) and a scraper wants one unambiguous path --
   * `metrics_path: /metrics/prometheus` in the scrape config.
   */
  router.get("/metrics/prometheus", async (ctx) => {
    if (!(await metricsGateOpen(ctx.req, ctx.res))) return;
    ctx.res.writeHead(200, {
      "content-type": PROMETHEUS_CONTENT_TYPE,
      "access-control-allow-origin": config.webOrigin,
    });
    ctx.res.end(s.metrics.render());
  });
}
