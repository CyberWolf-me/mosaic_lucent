/**
 * The versioned API (docs/26 A6, ADR 0052): `/api/v1/…` is the stable name
 * for `/api/…`, for scripts, agents and API tokens.
 *
 * v1 is an alias, not a fork. A versioned request is rewritten to its
 * canonical path before anything else looks at it — the API-token scope
 * rules, CSRF, the role guards, every handler — so one policy governs both
 * names and `/api/v1/auth/…` can't slip past a rule written for
 * `/api/auth/…`. Only the observability layer sees the versioned path, so
 * the logs and metrics say which name a caller used.
 *
 * The unversioned paths stay: they are what the web app calls. When a
 * change would break a v1 caller, the old shape stays reachable under v1 and
 * the new one ships as v2 — that is the promise the prefix makes.
 */

export const API_VERSIONS = [1] as const;
export const API_VERSION_HEADER = "lucent-api-version";

export type ApiVersionMatch =
  /** A v1 path, and the canonical URL it names (query kept). */
  | { kind: "v1"; url: string }
  /** `/api/v1` itself: the discovery document. */
  | { kind: "index" }
  /** A version this server doesn't speak. */
  | { kind: "unknown"; version: string };

/** Read a request URL for an API version prefix; null when it has none. */
export function apiVersionOf(url: string): ApiVersionMatch | null {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q);
  const m = /^\/api\/(v\d{1,3})(\/.*)?$/.exec(path);
  if (!m) return null;
  if (m[1] !== "v1") return { kind: "unknown", version: m[1]! };
  const rest = m[2] ?? "";
  if (rest === "" || rest === "/") return { kind: "index" };
  return { kind: "v1", url: `/api${rest}${query}` };
}

/**
 * What `GET /api/v1` answers: enough for a script or an agent to find its
 * way without reading the source. The resources listed are the ones Lucent's
 * own agent client (the MCP server) relies on; every other `/api` route is
 * reachable under v1 too, on the same terms.
 */
export function apiIndex(): Record<string, unknown> {
  return {
    api: "lucent",
    version: 1,
    versions: [...API_VERSIONS],
    auth: {
      scheme: "Authorization: Bearer <API token>",
      tokens:
        "Create one in Settings → Security → API tokens. A token acts as its person in one workspace; a read token can only GET.",
    },
    resources: [
      "GET /api/v1/auth/me",
      "GET /api/v1/orgs",
      "GET /api/v1/boards?orgId={orgId}",
      "POST /api/v1/boards",
      "GET /api/v1/boards/{boardId}",
      "POST /api/v1/boards/{boardId}/ops",
      "GET /api/v1/boards/{boardId}/integrations/links",
      "GET /api/v1/boards/{boardId}/integrations/inbound",
      "GET /api/v1/boards/{boardId}/meetings/{meetingId}",
      "GET /api/v1/orgs/{orgId}/search?q={query}",
      "GET /api/v1/orgs/{orgId}/intelligence",
      "GET /api/v1/orgs/{orgId}/projects/{projectId}",
    ],
  };
}
