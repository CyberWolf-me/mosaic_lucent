---
"@lucent/server": minor
"@lucent/ai": minor
"@lucent/web": minor
---

Bundled release for the M5–M7 milestone work.

- Streaming generation end-to-end: providers stream natively (OpenAI-compatible tool-call/prose lanes, Anthropic `input_json_delta`), `POST /api/generate/stream` serves the same validated pipeline over SSE, and the web client shows receipts as the payload arrives. Opt-in BYO provider keys behind `LUCENT_ALLOW_BYO_KEYS`.
- SCIM 2.0 gateway for enterprise provisioning (`/scim/v2/Users`, bearer-token auth, deactivate = session invalidation) with the `scim_identities` migration.
- OAuth sign-in (Google, GitHub) linking by verified email only; asset upload gateway with byte caps and org scoping; owner-visible org analytics trend; SLO document.
