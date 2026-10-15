export interface EdgeEnv {
  LUCENT_CACHE?: unknown;
  LUCENT_DB?: unknown;
  LUCENT_ORIGIN?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  CF_PAGES_BRANCH?: string;
}

/**
 * Resolves the upstream backend origin for Cloudflare edge routing.
 *
 * Fail-closed invariant: in production mode (ENVIRONMENT='production' or
 * NODE_ENV='production'), if LUCENT_ORIGIN is missing or empty, execution
 * fails closed with a 502 Bad Gateway response rather than leaking or falling
 * back to unroutable loopback addresses.
 */
export function resolveEdgeOrigin(env: EdgeEnv): { origin: string } | { errorResponse: Response } {
  const isProd =
    env.ENVIRONMENT === "production" ||
    env.NODE_ENV === "production" ||
    (typeof process !== "undefined" && process.env?.NODE_ENV === "production");

  const rawOrigin = env.LUCENT_ORIGIN?.trim();

  if (!rawOrigin) {
    if (isProd) {
      return {
        errorResponse: new Response(
          JSON.stringify({
            error: "misconfigured_origin",
            message: "LUCENT_ORIGIN environment variable is required in production and must not be empty",
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      };
    }
    return { origin: "http://127.0.0.1:4387" };
  }

  return { origin: rawOrigin.replace(/\/+$/, "") };
}
