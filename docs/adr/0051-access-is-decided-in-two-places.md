# 0051 — Access is decided in two places, and the workspace's limits live there

- Status: Accepted
- Date: 2026-09-28
- Builds on: ADR 0045 (org scope), ADR 0046 (workspace reads)

## Context

Two things arrived in docs/26 A6 that limit access beyond a person's role:

- **A two-step requirement.** A workspace can require two-step
  verification. Anyone without it is kept out: member, team, or a guest
  given one board.
- **Personal API tokens.** A token acts as its person, but only in one
  workspace and only up to its scope. It is the credential an agent uses
  (Lucent's MCP server reads `LUCENT_MCP_TOKEN`).

Each could have been a check in the routes that matter. There are a
hundred-odd routes, a realtime room and a dozen workspace reads, and a
limit enforced in most of them is one that isn't enforced.

## Decision

**Access is decided in two places, and both limits live there and nowhere
else** (`accessPolicy.ts`):

- **The org role**, `orgRoleFor`. Every org guard, and the lookup every
  board role consults.
- **The board role**, `memberRole`. The board store is wrapped once,
  outermost, after team grants. Direct grants (a guest) pass through it too.

`AccessPolicy.blocked(user, org)` names why someone can't reach a workspace
right now, and `allow` applies it to a role:

- `two_factor`: the workspace requires it and they don't have it.
- `token_scope`: the request is an API token's, and this isn't its
  workspace.

An API token also caps the role: `read` acts as a viewer, `write` as an
editor at most. A token never acts as an owner, so sharing, settings,
members and administration refuse it without knowing tokens exist.

**The request knows it's a token's.** Every request carrying an `lct_`
bearer is admitted before any route. The token must be live, its workspace
must allow tokens, and the route must be one a token may use. It then runs
inside `AsyncLocalStorage` as that token. `authenticate` names the person
from it, first, so a cookie riding along can't lift a request out of the
token's limits. The policy reads its limits from it.

What a token may never do is a short list, not a scope:

- manage the account (sign-in, 2FA, sessions, deletion, export);
- mint or list tokens;
- pay;
- join anything new: an invite, a share link, a new workspace;
- open a realtime socket, because a ticket outlives the request and the
  limits couldn't follow it.

Tokens are `lct_` plus 32 random bytes. Only a SHA-256 is stored: the token
is high-entropy, so a slow hash buys nothing. It is shown once.

**Membership isn't access.** Some questions are about the membership itself:

- Is this person a teammate or a guest?
- Whom may an owner remove?
- Can this person leave?

These read `storedOrgRole`, the policy aside. A member a requirement keeps
out is still a member, and can still leave.

**Nobody is locked out by the switch.** An owner can't require two-step
verification before having it. Nobody can turn theirs off while a workspace
they're in requires it.

## Consequences

- A limit added later (an IP allowlist, a session age) is one more reason in
  `blocked`. Every guard, the room and every read follow it at once.
- Paths that enumerate memberships to list content ask `blocked` directly:
  workspace reads, the board list, the activity feed, shared-with-me,
  assets, org meetings. A new such path has to as well. That is the one
  place this can be forgotten.
- The requirement is read with a 15-second cache per process, and a
  settings write clears it in the writing process. A board's org is cached
  for a minute. In a multi-instance deployment another instance sees a
  change within those windows.
- An open realtime socket keeps the role it joined with until it rejoins,
  as with team grants.
- A token's "last used" is written at most once a minute per process.
- "Sign out everywhere" doesn't revoke tokens; they're revoked one by one,
  by their person or an owner, or all at once by turning tokens off for the
  workspace. Removing the person from the workspace ends their tokens'
  reach at once.
- SAML SSO trusts the identity provider's factors: an SSO sign-in isn't
  asked for Lucent's code. OAuth sign-in is, like a password sign-in.
- Enrollment shows a key and an `otpauth:` link, not a QR code; drawing one
  needs a dependency or an encoder this change didn't take on.
