# Rotate secrets

Two situations, different urgency:

- **A credential leaked** (committed, pasted into a ticket, in a log, on a lost
  laptop). Rotate now; user-visible disruption is acceptable.
- **Scheduled rotation.** Choose the window and do the least disruptive form.

## What secrets exist

| Secret                                                   | Where it is used                                                            | Rotating it costs                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LUCENT_SESSION_SECRET`                                  | HMAC over session tokens (`auth.ts:62`) and the CSRF cookie (`csrf.ts:103`) | **Every user is logged out.** Nothing else breaks.                                                          |
| `LUCENT_DATABASE_URL` password                           | Postgres connection                                                         | A restart; connections are re-established on boot                                                           |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `LUCENT_AI_KEY` | LLM provider (`packages/ai/src/provider.ts`)                                | AI generation fails until the new key is live                                                               |
| `LUCENT_IMAGE_KEY`                                       | Image provider                                                              | Image generation fails until replaced                                                                       |
| `LUCENT_SMTP_PASSWORD` / `LUCENT_SMTP_URL`               | SMTP mail transport                                                         | Verification / reset / invite mail stops                                                                    |
| `LUCENT_MAIL_API_KEY`                                    | HTTP mail transport                                                         | Same. Note a half-configured transport silently falls back to `console`, so mail "works" and reaches nobody |

Not secrets, and not rotatable here: password hashes (scrypt, per-user salt),
email-verification and password-reset tokens, and share-link tokens — all stored
hashed. TOTP secrets belong to the user, not the deployment.

## Rotating the session secret

This is the only rotation with a user-visible cost, and it is the one a leak most
often forces. There is no dual-secret verification path, so old and new cannot be
accepted at once: the change is a hard cut.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

1. Put the new value in the deployment's secret store.
2. Restart with it (a normal deploy — see [deploy.md](./deploy.md)).
3. Every existing cookie now fails its signature check, so every user lands on
   the login screen. Tell them first if you can.
4. Verify: log in fresh, then perform a mutating action (rename a board). The
   second step matters because CSRF is signed with the same secret; if only the
   session path were verified, a broken CSRF cookie would look fine until a user
   tried to save something.

Below 16 characters `sessionSecret()` throws in production rather than falling
back, so a truncated value fails at boot with a config error instead of quietly
weakening every session.

### Targeted alternative

If the exposure is one user's session rather than the secret, revoke instead of
rotating: `SessionStore.revoke(id)` and `revokeAllForUser(userId)`
(`packages/server/src/sessions.ts:47`) log out one person, and sessions are rows
that carry `revokedAt`. No redeploy, nobody else disturbed.

## Rotating the database password

1. Create the new password on the Postgres role (`ALTER ROLE … PASSWORD …`).
2. Update `LUCENT_DATABASE_URL` and restart. The pool reconnects on boot; there
   is no live re-auth path.
3. Verify `/health`, then open a board — `/health` does not touch the database,
   so it stays green against a broken connection string.

Provisioning a second role and moving over is gentler than rotating in place if
your provider allows it: both work at once, so the cutover is a restart rather
than a race.

## Rotating a provider or mail key

1. Mint the new key at the provider; keep the old one live if it allows overlap.
2. Update the env var and restart.
3. Verify the feature end to end, not the config: run one AI generation, or
   trigger one password-reset mail and confirm it arrives. For mail this is not
   optional — a transport with a missing credential falls back to `console`
   rather than refusing to boot, so the only proof is a delivered message.
4. Revoke the old key at the provider. Rotation is not finished until the old
   credential stops working; a key that is merely unused is still a live key.

## If a secret reached the repository

1. Rotate it first. The rest of this is cleanup; the credential is compromised
   the moment it is pushed, and rewriting history does not un-compromise it.
2. `gitleaks` runs in CI (`.github/workflows/ci.yml`, `audit` job) and will keep
   failing until the value is out of the scanned history — that is the signal
   telling you the cleanup is unfinished, so do not disable it.
3. Purge from history only after rotation, and only with the whole team aware
   that everyone's clones need re-cloning.
4. Add the pattern to the scanner's allowlist only if it is a false positive.
   Never for a real secret you have "handled".
