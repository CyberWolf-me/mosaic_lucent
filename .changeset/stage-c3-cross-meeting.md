---
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/web": minor
---

Stage C3: cross-meeting memory — the chain, the reverse link, and the merged timeline. No new store: memory is the reading of state C2 made canonical.

- **Evolution answers (`@lucent/ai`, `@lucent/server`)**: the Ask digest
  renders every statement supersession with each side's meeting of origin,
  and the historian answers "why did we change pricing?" by reading it —
  naming turn indices, which now ride the answer contract alongside an
  honest meetings window (`meetingsTruncated` says when older meetings fell
  outside the digest, the same rule C1 set for revisions).
- **Meetings end for real (`@lucent/server`, `@lucent/web`)**: live
  captures get real boundaries (`MeetingStore.end`, an idempotent end
  route) instead of abandoning the id and leaving the store saying "in
  progress" forever.
- **Reverse provenance (`@lucent/web`)**: a transcript turn lists the board
  objects it produced ("✦ 2 objects · view") — a pure scan of the workspace
  the browser already holds, the payoff of C2's ops-level provenance. The
  canvas ✦ jump now lands on the exact turns (`?turn=`), matching the Ask
  citation contract.
- **The project timeline (`@lucent/web`, `@lucent/server`)**: HistoryView
  becomes the merged chronology — revisions, meeting markers, and statement
  events ("decision made · superseded a previous statement") in one
  day-grouped surface, each row jumping to its evidence. Statement events
  derive from the log's own operations; no new view was added.
