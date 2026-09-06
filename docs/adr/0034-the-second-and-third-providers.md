# 0034 — The second and third providers: the capability-honesty layer, the hardened recovery, and the boundary Figma/Slack refuse to cross

- Status: Accepted
- Date: 2026-09-06

## Context

ADR 0032 promised D8 as "the factory map is the last interface change
external providers will force: D8's GitHub/Jira/Figma/Slack adapters are
each one file + one map entry + one config field, exactly as ADR 0030
promised." Building it delivered on the formula for two providers and
found its honest limit for the other two — the owner's review (9.4 →
10/10 with the fixes folded in) sharpened the promise, named the
capability-honesty contract the review's central ask, hardened the
recovery, and required the SSRF boundary.

**The contract paragraph:** D8 ships GitHub and Jira as the second and
third real ExecutionProviders, proving the adapter formula end to end:
one provider implementation + one factory entry + one
provider-specific configuration schema. The interface stays frozen
except for two optional methods added through its documented-evolution
path: capabilityWarnings (the honesty layer — what the provider cannot
represent faithfully, shown in the preview and ack-gated before
execution) and the hardened recoverCreate contract (0/1/>1 + a poll
budget, restated as a contract for all search-based providers). Figma
and Slack are NOT adapters: a design-artifact surface and a
communication surface are different seams, recorded as future
interface families of their own, not forced into the task abstraction.

## Decision

**THE REFINED OUTBOUND-AUTHORITATIVE DOCTRINE** (replacing D6's
phrasing, per the review): *Lucent is authoritative for the fields it
explicitly manages; each provider must either represent those fields
faithfully or surface an explicit loss/unsupported-field warning before
execution.* "Lucent owns status" was misleading for GitHub — fidelity
is a per-provider contract now, not an assumption.

**THE CAPABILITY-HONESTY LAYER** (the review's #1, the stage's core):
nothing drops silently. The interface gains the optional
`capabilityWarnings(input) → [{field, reason}]`; the propose route
calls it per item and STORES the warnings on the action record's
items; the preview carries them; **the approve route refuses a
warning-carrying record with 409 unless the body says
`acknowledgeWarnings: true`** — the human gate covers capability
loss, not just effect scope. The panel renders the warning rows and
the button reads Send anyway. GitHub warns: dueDate (no native
field — the recorded divergence), every non-open Lucent status (the
lossy collapse to GitHub "open"), unresolvable assignees (omitted).
Jira warns: a Lucent status with no well-known counterpart
(blocked/cancelled). Linear/Fake warn nothing (fully faithful).

**THE HARDENED recoverCreate CONTRACT** (the review's #5+#6, applies
to Linear retroactively as documentation): **0 matches after the
polling budget → retry the create; 1 → recover; >1 → the honest
ambiguous failure ("ambiguous recovery: N issues carry the marker") —
never a guess, never a duplicate.** The poll budget (500ms/1s/2s
default, injectable) exists because a just-created issue may not be
indexed yet — declaring not-found on the first empty search is how
duplicates slip through the eventual-index window. The logic stays
INSIDE the provider (the executor is untouched); the search is scoped
(GitHub `repo:owner/name` + the token; Jira `text ~ marker AND
project = KEY`); the marker must be unique per connection (it is:
derived from the per-item idempotency key). The D8 acceptance
demonstrates the >1 arm LIVE: a re-proposed node reuses its
idempotency key, so both wire issues carry the marker, and the
recovery refuses — the ambiguity the D6 scheme could not see.

**THE SSRF BOUNDARY** (the review's #7+#8): a provider's connection
config can define where the SERVER sends requests — Jira's `site` is
a per-org base URL, an owner-configured outbound HTTP destination.
`assertSafeOutboundUrl` is authoritative at FACTORY time (the
connect-time 400): https only, no userinfo, no localhost, no
private/loopback/link-local IP literals (127/8, 10/8, 172.16/12,
192.168/16, 169.254/16, 0/8, ::1, fc00::/7, fe80::/10). Self-hosted
Jira on a real public host passes; the server's internal network is
never a target. DNS-level evasion (a public name resolving to a
private IP) is named as out of scope for the owner-configured env-ref
era — the configuration is owner-entered with an audit trail, not
anonymous input. GitHub's `repo` validates the exact owner/repo shape
INCLUDING the dot-segment traversal check (`../` matches the charset;
segments are checked explicitly).

**THE WIRE CONTRACTS** (pinned by scripted responders, never a live
account — the linear.ts discipline): GitHub REST v3 (Bearer +
X-GitHub-Api-Version + the mandatory User-Agent; number-as-externalId;
the close word splits across state + state_reason; dueDate never
sends). Jira REST v3 (Basic auth; ADF descriptions with the marker in
a text node; **status moves only through the transitions API** — 0
matching → the honest "no transition to X is available"; >1 → the
ambiguous failure — the review's #9, the assignee-resolution
philosophy applied to state machines, never the first match; the
conservative mapStatus: To Do/Todo/Backlog/In Progress/Done only,
every company-managed custom status undefined — future complaints
are evidence for a Jira status-configuration mechanism, never for
hardcoding fifty states).

**THE ASSIGNEE LADDERS — only reliable strategies** (the review's
#10): GitHub: exact login > unique partial against the repo's
assignable-users index; EMAIL IS DELIBERATELY NOT OFFERED (a PAT's
search scope cannot reliably map email→login — documented, not
guessed); unresolvable → the warning + quiet omission. Jira: exact
email > exact name > unique partial → accountId (all three reliable
in the v3 user search); ambiguous throws; not-found omits — the same
contract, per the review's alignment.

**THE WEBHOOK SCHEME REGISTRY** (the D7 evolution): the receiver
keeps the generic half (claim ledger, org resolution, dedupe, queue
ingest); each `WebhookScheme` owns the provider half (the header
name, the verify, the parse). linearWebhookScheme = the two D7
functions unchanged; githubWebhookScheme: `x-hub-signature-256` with
the `sha256=<hex>` prefix (a bare Linear-shaped hex is REJECTED —
pinned), opened/reopened/closed emit with the COMPOSED externalValue
("closed:not_planned" — the exact observation the queue stores, the
D7 separation), edited is ignored (status-first). A provider with no
scheme answers the honest 404 — **Jira inbound is deferred, named
honestly: Atlassian's webhook authentication is the Connect
framework's JWT/QSH scheme, its own project, not a guess to make.**
The dedupe key stays raw bytes (D7 consistency; GitHub redeliveries
are byte-identical — the duplicate regression runs per provider);
`X-GitHub-Delivery` is recorded as the future id-based seam if a
provider ever redelivers varying bytes.

**supportsInbound** rides the connections GET (a scheme exists = the
label says "Sync with"; no scheme = "Send to" — the label follows the
architecture, the review's #18).

**THE Figma/Slack BOUNDARY** (the review's #2, the interface
finding): Figma is a design-artifact surface and Slack is a
communication/notification surface; neither has a task entity or a
status vocabulary to map. Forcing them into ExecutionProvider would
require `mapStatus("message")` — a garbage guess to satisfy an
interface. The long-term shape is recorded: ExecutionProvider ←
Linear/GitHub/Jira; ArtifactProvider ← Figma; CommunicationProvider ←
Slack/Teams. Those interfaces are NOT built in D8 — the boundary is
the finding, not a scope cut; each earns its own ADR when a real
integration demands it.

## Consequences

- The formula held where it applies: GitHub and Jira shipped with
  ZERO changes to the routes, queue, ledger, decide paths, or stores —
  the D8 acceptance drives all three providers through the untouched
  D5-D7 machinery on one board, including cross-provider links
  (one action → github #N + jira KEY-N + linear LIN-N) and unlink
  isolation (dropping the github link leaves the jira + linear links).
- The capability gate makes lossy providers safe to ship: GitHub's
  missing dueDate and collapsing status are now first-class preview
  facts with an explicit consent, not silent drops a user discovers
  by comparing systems later.
- The 0/1/>1 recovery contract closed the last duplicate window:
  the eventual-index poll handles the just-created-not-yet-indexed
  case, and the ambiguous arm turns key-reuse corruption into an
  honest failure instead of a guessed link.
- Two test-harness lessons: the D6 executionTimeoutMs injection is
  required for ANY e2e with a hang arm (the D8 acceptance timed out
  in the full-suite budget until it got the 20ms race); and e2e arms
  that add nodes mid-story change every later count — the Linear
  duplicate-approval arm had to run before the recovery arm's extra
  nodes, and the cross-provider assertion grew to three links when
  the Linear arm moved up. Both are recorded so future acceptances
  order their arms deliberately.
