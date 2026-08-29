# Oncall

The first five minutes after a page. Engineered for someone who has
never paged in their life and the SRE who has paged in their life 200
times — both will land on this doc, and both need to act in seconds.

## The first five minutes

1. **Acknowledge the page** in PagerDuty / Opsgenie. This stops the
   escalation timer; the user is the next human up the chain.
2. **Open the runbook entry that owns the alert**. Every alert in
   `ops/alerts.yaml` names a `runbook_url`; if it does not, the alert
   itself is broken — file a bug, do not improvise.
3. **Open the dashboards**. The summary dashboards are listed in
   `ops/runbooks/dashboards.md` (to come). The two that matter today:
   `/metrics/prometheus` and `/metrics` (text format).
4. **Decide: investigate or escalate**. Three signals tell you which:
   - The alert text says `severity: page` → investigate. Otherwise the
     caller can wait for you to read the dashboard.
   - Multiple alerts fire together → bigger than one symptom. Jump to
     `incident.md`. Do not investigate the first symptom in isolation.
   - Your own accessibility tells you the deployment is unreachable →
     jump to `incident.md`. The pager arrived because the dashboard
     cannot; trust the pager first.

## When you do investigate

Start at the top of the stack, not the bottom.

- **Public surface**: a request to `curl https://lucent.example.com/health`
  with a 200 answer is enough to say "the deployment is up". Do that
  first; it takes 5 seconds.
- **Auth**: `curl -sf https://lucent.example.com/api/auth/csrf -H "Origin: …"`
  with `200` and a `lucent_csrf` cookie is enough to say "the origin
  gate works".
- **Database**: `psql $LUCENT_DATABASE_URL -c "SELECT 1"` is enough
  to say "Postgres is reachable from where you are".
- **Realtime**: `wscat -c wss://lucent.example.com/ws -H "cookie: …"`
  and seeing a `welcome` frame is enough to say "WebSockets hand out".
- **AI**: `curl -X POST https://lucent.example.com/api/generate -d '…' -H '…'`
  with a 200 + ops JSON is enough to say "the model is wired".

If any of those fail, the runbook named in the alert's
`runbook_url` points at where to look next.

## Errors you should recognise on sight

- **`EAI_AGAIN`, `ENOTFOUND`**: DNS or egress problem. Look at
  `kubectl exec … curl https://api.anthropic.com/health` to see
  whether _that_ DNS is the broken one. Jump to `incident.md`.
- **`ECONNRESET` from upstream**: the AI provider or Stripe is having
  a moment. Check their status page before paging anyone.
- **Postgres `authentication failed for user "lucent"`**: secret
  rotation did not propagate. `docs/runbooks/rotate-secrets.md`.
- **429 from `/api/generate`**: in-budget rate limit; legitimate
  users in a hurry are not your concern. Do not page out.
- **Empty prometheus output**: `/metrics` route is up but the
  registry is empty — the server hasn't seen a request yet. Bind a
  client and verify; this is rarely an outage.
- **`pg_advisory_unlock(1279479111)` errors on every boot**: leftover
  from a migration lock; resolves on next deploy. No action.

## When you escalate

Escalation is not "another human knows". Escalation is "this doc did
not solve it; the next human needs the full picture".

Captured in the page:

1. **What you tried** (the runbook step + the command output).
2. **What you ruled out** (the green checks above).
3. **What is still on fire** (the dashboards that are still red).

If the next human is a customer-success or finance human, that
handoff goes through Slack — there is a `#oncall-handoff` channel —
and a copy goes to the SRE on shift via the escalation policy.

## What you must NOT do

- Do **not** roll the database back during an open incident without
  the SRE on shift in the room. `docs/runbooks/restore.md` documents
  the correct procedure; the only thing faster than it is "lose
  twenty minutes of data on top of the incident".
- Do **not** push a code change to fix a symptom you saw on a
  dashboard. Dashboards lie; logs are closer to ground truth; only
  logs reproduce the symptom is a thing to fix in code.
- Do **not** delete pods in CrashLoopBackOff without first reading
  their last log. A delete is a "lose state" operation; the same pod
  in five minutes will be a new pod, and the new pod will hit the
  same crash.

## Quietude

The on-call rotation gets one PR review per week as compensation.
Tickets with the label `oncall-noise` reviewed by the next-day SRE
get prioritized; the goal is fewer pages per quarter, not just
fewer pages this week. If an alert has paged three times without a
single incident behind it, the alert gets retired in the next
`ops/alerts.yaml` change.
