# 0002 — `node:http` and a small typed router, no web framework

- Status: Accepted
- Date: 2026-08-28

## Context

The server needs routing with path parameters, middleware (auth, CSRF, org
guard, request id, metrics), a body cap and a WebSocket upgrade on the same
port. Express/Fastify each solve this, at the cost of a dependency whose types
are looser than ours (`req.body: any`) and whose middleware contract invites
`any` at every seam.

## Decision

Keep `node:http` + `ws`, and own a ~250-line typed router
(`packages/server/src/http/router.ts`): pattern matching with `:param` capture,
composable middleware with a typed per-request `state`, a memoised body reader
with an explicit byte limit, and a `send` that no-ops after `headersSent`.

## Consequences

- Every handler gets `RouteContext<S>` with typed `params` and `state`; there is
  no `any` at the HTTP boundary.
- Middleware exists as a real concept, so CSRF, authentication, tenancy guards,
  request ids and RED metrics are declared once per route group instead of being
  re-called by hand in each handler.
- We carry the maintenance of the router itself, including the parts frameworks
  give away: no ecosystem plugins, no `content-type` negotiation, no cookie
  parsing (we own `cookies.ts`), no schema binding.
- The dependency budget stays at four runtime packages, which keeps the audit
  surface and the container small.
