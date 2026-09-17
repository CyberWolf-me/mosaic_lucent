# Security policy

Lucent operates both as a hosted cloud service and as a self-hosted platform.
We take the security of your boards, transcripts, and AI integrations seriously.
Below is our vulnerability disclosure process and response targets.

## Supported versions

| Version    | Supported                           |
| ---------- | ----------------------------------- |
| `main`     | Yes — fixes land here first         |
| Latest tag | Yes — the fix ships in the next tag |
| Older tags | No                                  |
| Forks      | No — you carry the patch yourself   |

There are no long-term-support branches and no backports. If you run something
other than current `main` or the most recent tag, treat every fix as one you
need to pick up.

## Reporting a vulnerability

Report privately, through GitHub's private vulnerability reporting:

**<https://github.com/lucent/lucent/security/advisories/new>**

Please do not open a public issue, discussion, or pull request first: a patch in
a public PR is a working exploit for everyone still on the previous commit.

What helps, in rough order of usefulness:

- The commit or tag you tested, and steps that reproduce it.
- What an attacker gets — read another org's boards, forge a session, run script
  in a viewer's browser, and so on.
- The configuration it needs: whether authentication was required
  (`LUCENT_REQUIRE_AUTH`), whether the deployment used Postgres or the
  in-memory store, and whether the request was authenticated at all.

Please test against an instance you own — `docker compose up` gives you one in a
minute — and do not read, change, or copy other people's data to prove a point.

## What to expect

Targets from a small maintainer group, not a contract:

| Stage                                             | Target                                |
| ------------------------------------------------- | ------------------------------------- |
| First reply from a human                          | 5 business days                       |
| Triage decision (accepted, not a vuln, need more) | 10 business days                      |
| Fix or documented mitigation, accepted high+      | 30 days                               |
| Lower severity                                    | Tracked as an issue, no date promised |

If a target is going to slip, we would rather say so in the advisory thread than
go quiet. If ten business days pass with no reply at all, post again in the same
thread — a missed notification is the likeliest explanation.

## Disclosure

Coordinated disclosure. We ask for 90 days from your report, or until a fix
ships if that is sooner, before public detail. When the fix lands we publish a
GitHub advisory describing the issue, the affected versions and the fix, and
request a CVE where one is warranted. You are credited by the name or handle you
ask for unless you would rather stay anonymous. There is no monetary reward.

If you believe the issue is being actively exploited, say so in the report and
we will drop the 90-day request.

## Scope notes

In scope: anything an unauthenticated request can reach; reading or writing
another organization's or board's data; session, CSRF or share-link bypass;
injection through the operation log or SQL; script execution from board content,
comments, or model output, including the export and print paths; and anything
that sends board content outside the deployment.

Out of scope — real bugs, but file them as ordinary issues:

- Anything that requires `LUCENT_REQUIRE_AUTH=0`, the documented opt-out for
  single-user localhost work.
- Advisories in development-only dependencies (vitest, drizzle-kit, eslint).
  CI reports those; the gate covers the tree that actually ships.
- Documentation that claims more than the build delivers. Tracked in
  [`docs/checklist.md`](./docs/checklist.md), not a vulnerability.
- Missing hardening on a dev server bound to `127.0.0.1`, self-XSS, or findings
  that need a user to paste attacker-supplied JavaScript into their own console.

The current posture — what is enforced, what is optional, and what is still
open — is written down in
[`docs/06-tech-stack-and-security.md`](./docs/06-tech-stack-and-security.md).
