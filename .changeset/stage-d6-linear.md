---
"@lucent/server": minor
"@lucent/web": minor
"@lucent/i18n": minor
---

Stage D6 — Linear, the first real ExecutionProvider (ADR 0032). The effect contract corrected: at-least-once delivery with provider-specific reconciliation (the lucent-action marker + recoverCreate before any retry). The LinearProvider on the StripeClient seam (raw-key Authorization, mapStatus never guesses, deterministic assignee ladder, once-per-batch workflowStates cache). The provider factory map (per-org credentials through the connection; teamId in connection.config). connectionId on the action record — approve refuses a changed connection (409). The PG pairs (4 tables, migration 0020) + the recovery-first sweeper. Web: ↗ chips, the Sync button's three honest connection states, the IntegrationPanel (the frozen preview rendered, approve/reject/results, the 409 as the panel error). The stage-D6 acceptance: 10→10 issues, the ambiguous-create recovery (1 issue, 1 link, 0 duplicates), partial failure, duplicate approval, viewer 404s, the workspace blob provider-free.
