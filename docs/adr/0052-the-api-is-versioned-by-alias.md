# 0052 — The API is versioned by alias, and policy sees one path

- Status: Accepted
- Date: 2026-09-28
- Builds on: ADR 0051 (API tokens' limits)

## Context

API tokens (ADR 0051) let scripts and agents call Lucent, and Lucent's own
MCP server is one of them. They were calling the same unversioned `/api/…`
routes the web app calls. Those routes change when the app needs them to,
and nothing marked which of them an outside caller could rely on.

A versioned API has two common shapes:

- **A fork.** A separate `/v1` router with its own handlers.
- **An alias.** The same handlers under a second name.

A fork gives every route two policies to keep in step. The token rules are
a path list (`apiTokenRefusal`), and a list kept twice is one that drifts —
`/api/v1/auth/…` would be a way around a rule written for `/api/auth/…`.

## Decision

**`/api/v1/…` is an alias of `/api/…`, resolved before anything else looks
at the request** (`server/src/apiVersion.ts`):

- The version is read after the access log takes its label and before the
  API-token admission. `/api/v1/boards/b1?x` is rewritten to
  `/api/boards/b1?x`. The token rules, CSRF, the role guards and every
  handler see only the canonical path.
- Only observability sees the versioned name. Metrics and logs label
  `/api/v1/boards/:id`, so it's visible who uses which name.
- A versioned response carries `Lucent-Api-Version: 1`.
- `GET /api/v1` describes the API: how to authenticate, and the resources
  Lucent's own agent client relies on. Every other `/api` route is reachable
  under v1 on the same terms.
- An unknown version (`/api/v2/…`) is a 404 that names the versions there
  are. It is never silently served as v1.
- The unversioned paths stay. They are what the web app calls.
- The MCP server speaks `/api/v1`.

**What the prefix promises.** A change that would break a v1 caller keeps
the old shape reachable under v1 and ships the new one as v2. Adding a
field, a route or an optional parameter is not breaking. Removing or
renaming one, or changing what a field means, is.

## Consequences

- One policy governs both names. A rule added to the token list, a guard
  or a handler applies to v1 at once, with nothing to mirror.
- v2, when it comes, is where the alias ends. Its first breaking route gets
  a real handler, and v1 keeps the old one. The resolver already refuses
  versions it doesn't know, so a caller asking early gets a clear 404.
- The index lists a curated set, not every route. It's a promise about
  what's stable, and a list of everything would promise too much.
