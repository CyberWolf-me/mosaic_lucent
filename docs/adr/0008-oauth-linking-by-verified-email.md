# 0008 — OAuth account linking is by verified email only

- Status: Accepted
- Date: 2026-08-28

## Context

Federated sign-in (Google, GitHub) must never become an account-takeover
vector. An email address asserted by a provider is only a fact when the provider
vouches it is verified; anyone can set an arbitrary _unverified_ address at a
provider and then present that identity to us.

## Decision

One row per external identity in `oauth_accounts`, keyed by
`(provider, provider_account_id)` — the provider's stable `sub`/id, never the
email. Resolution order at sign-in: identity first (returning user), then
provider-verified email (link to the account that owns it), then account
creation. An unverified email can create nothing and match nothing: it is
refused with an actionable message. OAuth-created accounts carry an unusable
password hash (`oauth:` prefix), so they have no password until a reset mints
one. The flow state is HMAC-signed _and_ mirrored in a short-lived
browser-local cookie, so a replayed callback URL fails before any network call.

## Consequences

- A hostile provider account cannot take over a Lucent account; the takeover
  would require control of a verified mailbox at that provider.
- Users who signed up with a password and later "Continue with Google" using the
  same verified email converge on one account with no support ticket.
- The provider's `select_account` prompt is forced on Google so a shared browser
  cannot silently sign in as whoever was last logged in.
