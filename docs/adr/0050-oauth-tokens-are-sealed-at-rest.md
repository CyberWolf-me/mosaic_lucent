# 0050 — OAuth tokens are sealed at rest; everything else stays a reference

- Status: Accepted
- Date: 2026-09-27
- Amends: ADR 0030 (credentials are references)

## Context

ADR 0030 kept every integration credential out of the database. A
connection names a server environment variable, and the key lives there.
That rule held up, but it has two costs for Linear and Jira (docs/26 A5):

- An owner has to create an API key in the tool, then get an operator to put
  it on the server. A hosted workspace can't ask every customer to do that.
- OAuth, the way these tools expect to be connected, can't work that way.
  The provider hands the token to Lucent, per org, and it expires and
  rotates. There is no variable to name.

ADR 0030 foresaw this: "If a future OAuth flow must persist a token, the TOTP
precedent applies." That precedent stores plaintext and relies on the
database being encrypted at rest. A refresh token is standing access to a
customer's tracker, so it deserves more than that.

## Decision

**OAuth tokens are stored, sealed with a key the database never sees.
Nothing else changes: key-based connections, GitHub and Slack still name a
variable.**

- **Sealing:**
  - AES-256-GCM under `LUCENT_TOKEN_KEY`, 32 random bytes the operator sets
    (`integrations/tokenBox.ts`).
  - Each sealed token is bound to its row (`org:provider` as associated
    data), so a token copied onto another org's row doesn't open.
- **No key, no OAuth.** Without the key the server offers no "Connect with"
  button and stores nothing. A malformed key stops the boot: a server that
  can't seal tokens must not take them.
- **The flow:**
  - Start is an owner's POST, CSRF-checked, answering the provider's
    authorize URL.
  - The `state` is HMAC-signed with the app secret and expires in ten
    minutes. It names the org, the person who started it, the provider and
    what they entered.
  - The callback completes only for that person, signed in and still an
    owner.
  - Linear gets PKCE, the verifier derived from the state's nonce under the
    secret, so nothing is stored between the two requests.
  - Jira's token is asked which sites it reaches: the one the owner named,
    or the only one there is.
- **Use.** The connection's credential reference is the sentinel `oauth`,
  which only the callback can write: `assertSafeCredentialRef` still refuses
  it from the PUT route. Before a provider is built, its token is opened,
  and refreshed a minute before expiry. Atlassian rotates refresh tokens,
  so the new pair is saved. A refresh the provider refuses is the
  connection's `needs-reauth`.
- **Disconnect forgets the token.** Reconnecting asks the provider again.
- **Storage.** `integration_credentials` (migration 0041): one row per
  (org, provider), row-level security on, no PostgREST access, like every
  table.

## Consequences

- Losing `LUCENT_TOKEN_KEY` means every OAuth connection has to connect
  again; nothing else is lost. Rotating it is the same event, until
  re-sealing is worth building.
- Linear and Jira reach the same providers either way. A Jira OAuth
  connection addresses its site through the Atlassian gateway
  (`api.atlassian.com/ex/jira/<cloudId>`) with a bearer token; a key
  connection uses the site and Basic auth, as before.
- The provider isn't asked to revoke the token on disconnect; Lucent forgets
  it. Calling each provider's revoke endpoint is a follow-up.
- Verified against a stub of each provider's token and site endpoints. A run
  against real Linear and Jira apps needs their client ids and secrets.
