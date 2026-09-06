---
"@lucent/server": minor
"@lucent/web": minor
"@lucent/i18n": minor
"@lucent/mcp": minor
---

Stage D7 — inbound sync, the symmetric human gate (ADR 0033). The webhook receiver copies the Stripe doctrines verbatim (raw-body-is-the-message, verify-before-ledger, signature-is-the-auth) with Linear's X-Signature HMAC; the signature is the org resolution (per-connection webhookSecretRef through the environment, all candidates computed before any match). Every inbound change queues for human accept — nothing auto-applies; the never-guesses rule produces dismiss-only warning rows (accept refuses 409). Accept commits as the system actor's first use (actorType "system", the provider as actorId, the acceptor as initiator) through the room-first + fallback path. Conflict semantics named: outbound-authoritative on explicit sync (supersession + the reported count), the provider's word never silently lost (both decisions update lastSyncedStatus). Three-layer dedupe (delivery/queue/resolution). The PG pairs + migration 0021; the parity contracts; the sweep's refetch-current-truth arm. Web: the External changes section, the Sync badge, the integrations-inbound frame, i18n en+hu. MCP list_external_links — read-only; no tool decides an inbound change.
