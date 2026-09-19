# 0023 — Cross-meeting memory is a projection over canonical state

- Status: Accepted
- Date: 2026-09-04

## Context

The Stage C document named cross-meeting memory as C3's territory: Monday's
decision superseded by Wednesday's correction, answered from the project's
accumulated history; the reverse provenance link (a transcript turn showing
the board objects it produced); and a project timeline. The natural
implementation question for a stage literally called "memory" is what the
memory store looks like.

The C2 ADRs had already promised the answer: C2's amendment says "Stage C3
(cross-meeting memory) builds on the canonical sources, never on this
projection," and the askContext module header has said "a projection, not a
memory layer" since C1. C3's recon confirmed the promise was keepable: a
meeting's contribution to the board is fully recorded in C2's state (nodes
carry `provenance {meetingId, turnRange}` because it rides the ops, and
statements carry lifecycle + supersedes), transcripts are append-only
(the turn index is a stable coordinate), and the revision window is C1's
`historyWindow`. The chain "students → young professionals → back to
students" is three statements, two supersessions, and three meetings that
already exist as rows.

## Decision

**There is no memory store, because none is needed.** C3 ships:

1. **The chain, rendered**: the Ask digest gains a statement-evolution
   section — every supersession as one line naming what superseded what and
   which meeting each side came from. "Why did we change pricing?" becomes a
   read, not a correlation exercise. The historian prompt (v3) teaches the
   model to answer evolution questions from that section plus the meeting
   extracts, naming turn indices.
2. **One coordinate system**: the turn index. `turnRange`, the transcript's
   `?turn=` jump, the Ask projection's `AnswerMeetingTurn.index`, and the
   reverse-provenance scan all key on the same array position — stable
   because transcripts are append-only by design (an edit/renumber feature
   would break every link; it is on the not-built list permanently, and a
   future "normalize" feature must not renumber).
3. **The reverse link, read purely**: `turnObjects`/`objectsByTurn` scan
   the workspace the browser already holds. No server call, because C2 put
   the evidence IN the state rather than in one browser's memory — the
   exact payoff ADR 0022 bought. A turn's row lists "✦ N objects · view",
   jumping through the C1 `?reveal` plumbing.
4. **Real meeting boundaries**: live captures end for real now
   (`MeetingStore.end`, idempotent, editor floor). The old behavior —
   stopRecording abandons the id and the store says "in progress" forever —
   was a store-level lie the chronology would have inherited: meeting rows
   and any duration/overlap reasoning need `endedAt` to mean something.
5. **The honest meetings window**: the Ask digest caps at 10 meetings and
   now SAYS so when it truncates (`meetingsTruncated`), the same honesty
   rule C1 set for revisions — including when the cap leaves the meetings
   section empty, the limit is still stated.
6. **The merged timeline**: the project chronology (revisions + meeting
   markers + statement events) is HistoryView extended, not a new view —
   `mergeChronology` over the C1 history response plus `listMeetings`, with
   statement events derived from the log's own SET/UPDATE_STATEMENT ops.

**Deliberately not built**: a WS meeting-ended broadcast (meeting lists
fetch on view mount; revisit when a live timeline exists), turn-level
citation kinds (indices in the answer text + the meeting citation suffice;
the citation contract stays three kinds), meeting-to-meeting reference
columns in the transcripts table (the chain lives in statements +
provenance — adding `previous_meeting_id` would be exactly the second
source of truth the "statements on nodes" decision refuses), and transcript
editing/renumbering (the index system depends on immutability).

## Consequences

- "Memory" in Lucent means: canonical state (ops, statements, provenance,
  transcripts) plus the ability to read it forwards and backwards. Anything
  that wants a _derived_ memory later (C5's topic entities, summaries) must
  follow askContext's rule: derived, disposable, never persisted, and if it
  ever needs durability it gets its own ADR first.
- Turn indices are now load-bearing in three surfaces; any future change to
  transcript storage must preserve them.
- The evolution section and the timeline both degrade honestly: a board
  with no supersessions renders no evolution lines; a board with no
  meetings and no statements renders exactly the C1 revision list.
- The reverse link inherits C2's convergence by construction: because
  provenance is in the ops, a peer who joined after the meeting computes
  the same turn→objects map as the browser that captured it.
