# 0045 — A meeting is its record, extended as its features arrive

- Status: Accepted
- Date: 2026-09-27

## Context

docs/26 J1 makes meetings workspace objects: a meeting with a title, a
lifecycle, a host, participants, a schedule and 0..n boards, listed across
the workspace. Today a meeting is a row in `meeting_transcripts` owned by one
board, and that row's id (`mtg_…`) is already load-bearing in four places:
statement provenance on the board (`provenance.meetingId`), proposals
(`proposals.meeting_id`), private notes (`meeting_notes`, keyed by meeting and
user) and every deep link (`?meeting=`). A separate `meetings` table would
need its own ids and a production backfill that re-keys all four — the risky
kind of migration docs/26 §13 warns about, on a database that main deploys to.

Most of J1's fields also have no feature behind them yet. A `status` column
would say "scheduled" before anything can schedule and "summarized" before
anything summarizes; a `starts_at` would be empty everywhere.

## Decision

**The meeting is the `meeting_transcripts` row. Its id is the meeting id. J1's
fields arrive as columns when the feature that gives them meaning ships —
never before.**

A3.1 adds exactly what the workspace list and the past-meeting page need:

- `title` — a nullable column. Absent means "untitled": the reader shows the
  board and the date, and nothing is backfilled.
- `status` — derived, not stored: `live` while `ended_at` is null, `ended`
  after. The stored lifecycle (`scheduled`, `summarized`, `reviewed`) lands
  with scheduling (A3.4), the end-of-meeting pass (A3.3) and the review
  center (A2), each with its own migration.
- The workspace list, `GET /api/orgs/:id/meetings`, returns meetings on the
  boards the caller can read — every board in the org for a member, the
  caller's own grants for an outside collaborator, the same two scopes as
  `GET /api/boards` — as summaries (no turns), newest first.
- One board per meeting, as today. Linking a meeting to several boards (and
  to none) arrives with the feature that links them, as a join table
  backfilled from `board_id`.

## Consequences

- The migration is one nullable column. No row is rewritten; rolling back
  drops the column and loses only titles typed since.
- Nothing downstream changes key: provenance, proposals, notes and links keep
  working unchanged.
- `board_id` stays `NOT NULL … ON DELETE CASCADE`, so deleting a board still
  deletes its meetings. When meetings can span boards, that rule changes with
  the join table — deleting one board must not delete a meeting another board
  still shows.
- The shape grows in steps, and each step says which feature pays for it. A
  reader looking for a field J1 names and not finding it should look at the
  roadmap slice that brings it (docs/28 §8), not assume it was forgotten.

## Follow-up (2026-09-27)

- **A3.3** stored the summary (`summary`, migration 0033); `summarized` is
  derived from it.
- **A3.4** stored the plan (`scheduled_for`, `duration_min`, `invitees`,
  `template`, `cancelled_at`, `cancelled_by`; migration 0035). The status
  stayed derived rather than stored, as with `summarized`: `scheduled` is
  "has a plan, no turns, still open", `cancelled` is "has `cancelled_at`". A
  scheduled row carries its planned start in `started_at` until the recording
  that starts it sets the real one — on the same row, so the id the invites
  carry is the id the transcript keeps.
