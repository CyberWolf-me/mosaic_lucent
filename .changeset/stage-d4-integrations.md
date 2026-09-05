---
"@lucent/server": minor
---

Stage D4: the integration platform — the ExecutionProvider abstraction, proven fake-first (ADR 0030). One interface every external execution system will implement; the core Action model learns nothing about any of them.

- **The seam**: `ExecutionProvider` (createTask/updateTask/getTask/
  searchTasks/mapStatus, optional subscribeToChanges) + the normalized
  `ExternalTask` shape, in @lucent/server — injected like the LLM provider,
  zero core changes. `mapStatus` translates provider vocabularies INTO the
  D1 canonical execution statuses at the adapter boundary.
- **The FakeProvider**: not a stub — deterministic ids, a different
  external vocabulary so the translation is real, recorded calls, and the
  D7 change-bus seam live in-memory.
- **The store**: org-scoped connections (credential REFERENCE, never the
  secret; idempotent upserts; disable-not-delete; fingerprinted admin
  views) + board-scoped task links (nodeId → externalId/url/status) — the
  workspace blob stays free of provider strings, asserted end to end.
- **The routes + the acceptance**: the connection CRUD (owner floor), the
  link read (viewer floor), and the sync route (editor floor, active
  connection required) proving the owner's gate — 10 actions → 10/10
  external tasks + links in one call, idempotent re-sync, drift-only
  updates, the core untouched throughout.
