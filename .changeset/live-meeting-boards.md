---
"@lucent/core": minor
"@lucent/server": minor
"@lucent/web": minor
---

Milestone 2: boards that grow without rearranging — the spatial-additivity invariant and the live meeting loop (ADR 0015).

- commit() now relayouts ONLY the group a batch touches, at its current origin: every other node keeps its exact committed position (relayoutRegion + separateRegions in core; a growth overlap shifts just the overlapped neighbours). Verified live: a 22-node board held pixel-identical through a second topic's extraction.
- Meeting capture extracts DIFFERENTIALLY while recording — hybrid trigger (speaker-pause OR burst OR overdue, debounced, one generation in flight), an additive-only auto-apply list, and a review gate for destructive/oversized batches. The prompt updates rather than duplicates: live topic-switch test UPDATED the existing Pricing region (5→7 members, one region, no "Pricing #2").
- Speaker identity through the STT seam: LiveKit segments' participant identity is read; the browser provider fires per-utterance finals (segment mode) instead of one blob at stop.
- Transcript checkpoints: a capture opens its server transcript at start and appends after each extraction (new POST /:mid/turns route, in-memory + Postgres parity) — a refresh mid-meeting loses nothing; ended meetings stay immutable; stop auto-saves.
- Provenance: meeting-extracted nodes carry the meeting id, quoted turns, and timestamp; the node HUD shows a ✦ whose tooltip quotes the discussion that created it.
