# 0003 — httpOnly cookie sessions for browsers, bearer tokens for programmatic clients

- Status: Accepted
- Date: 2026-08-28

## Context

The prototype authenticated browsers with a stateless HMAC token kept in
`localStorage`. That is readable by any script on the page, cannot be revoked
before expiry, and travels in URLs when used for WebSocket auth.

## Decision

Browsers get an opaque session id in a `lucent_session` cookie —
`httpOnly`, `SameSite=Lax`, `Secure` off only for loopback origins — backed by a
`sessions` row that carries `revokedAt`, `expiresAt`, `lastSeenAt`, user agent
and IP, and is consulted on every authenticated request. `tokenVersion` on the
user gives bulk invalidation ("sign out everywhere"). Bearer tokens remain for
programmatic clients (MCP, CI, integrations). WebSockets authenticate with a
short-lived single-use ticket minted over HTTP, never a long-lived credential in
a query string.

## Consequences

- XSS can no longer read the session credential, and an administrator can end a
  session immediately.
- Cookies mean CSRF, so state-changing routes require a double-submit token plus
  an `Origin` check; that machinery is now mandatory rather than optional.
- Every authenticated request costs a session lookup. That is one indexed read,
  and it buys revocation, which the stateless token could never have.
- Programmatic clients keep a simple, scriptable auth path, at the cost of two
  code paths in `authenticate()` — the bearer path deliberately skips
  `tokenVersion`, so bulk invalidation of API tokens needs its own mechanism.
