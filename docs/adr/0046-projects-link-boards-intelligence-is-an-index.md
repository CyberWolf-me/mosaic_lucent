# 0046 — Projects link boards; workspace intelligence is an index

- Status: Accepted
- Date: 2026-09-27

## Context

docs/26 A1 ("workspace spine") ends when a user sees every decision, meeting
and open question across boards. Two joins make that possible:

- **J2, projects.** An org holds boards and nothing between them. docs/26 §12
  decision 3 locks projects as first-class objects — identity, objective,
  members, status, the boards and meetings they gather — "not folders".
- **J3, the intelligence index.** Statements live on nodes (ADR 0021): a
  decision, question, action, requirement, risk or proposal is a node with a
  `statement`, often an `issue`, and provenance back to the meeting turn that
  produced it (ADR 0022). Every intelligence surface today reads one board's
  workspace in the browser. Home's cross-board pulse reads the open board plus
  up to twelve local ones and says outright that "the server has no
  cross-board aggregation".

Two constraints shape both:

- ADR 0040: intelligence is **derived**. A materialized projection must carry
  its derivation source, be droppable and rebuildable, and never accept
  writes.
- The web app already uses "project" for the open board (`projectId`,
  `lucent.projects` in localStorage). The new concept must not be confused
  with it in code.

## Decision

**A project is an org-scoped record that links boards. Workspace intelligence
is a rebuildable index of every board's statements, derived at the one seam
every commit passes through, and read only through board access.**

Projects:

- `projects` (id `prj_…`, org, name, objective, status `active | paused |
done`, lead, members as user ids, created by/at, updated at, archived at)
  and `project_boards` (project, board, added by/at) — many-to-many, because
  a board can serve two initiatives and a project spans many boards.
- Meetings are not linked separately: a project's meetings are the meetings
  on its boards (ADR 0045: a meeting is on one board). When meetings span
  boards, they join projects through those boards; no second link to drift.
- A project grants nothing. Every board in it is still read through board
  access, so a caller sees a project's boards, meetings and statements only
  where they can read the board. An org member sees every project in the org;
  an outside collaborator sees only projects holding a board shared with
  them, listing only those boards.
- An org editor or owner creates, edits and links; a viewer reads. Linking
  requires the board to be in the same org. Each change is audited
  (`project.created`, `.updated`, `.archived`, `.board_linked`,
  `.board_unlinked`).
- In web code the type is `OrgProject` and the module `orgProjects.ts`, so it
  cannot be mistaken for the local-board "project" of `persistence.ts`.

The intelligence index:

- One pure derivation in core, `statementIndexRows(workspace)`, shared by the
  board's own Intelligence view and the index, so the two can never disagree.
  It also carries whether an action is blocked. Overdue is computed on read,
  from the due date and today, because it changes with the calendar and not
  with the board.
- Rows `(board, node)` with the board's org, kind, status, label, topic,
  supersedes, assignee, due date, execution status, blocked, meeting and turn
  range; plus one state row per board recording the board revision
  (`updatedAt`) the rows were derived from — the derivation source.
- Maintained where every commit already lands: `BoardStore.put`, which the
  realtime room, the ops route, whole-board saves and imports all end in. A
  decorator schedules a per-board reindex (debounced) after each put and drops
  the rows when a board is deleted. It is in-process, so it works the same on
  the in-memory store and on Postgres, and on every instance of a cluster.
- Read-time repair makes it honest regardless: a query reindexes any readable
  board whose state row is missing or older than the board. It is bounded per
  request and reports what it skipped. An org owner can drop and rebuild the
  whole index. The index never accepts writes from a route.
- Read through access, never around it. `GET /api/orgs/:id/intelligence`
  answers from the boards the caller can read (the two scopes of
  `GET /api/orgs/:id/meetings`), filtered by kind, status, project, board and
  assignee, with board names attached. It never returns a row the caller
  couldn't see by opening the board.

## Consequences

- Two migrations' worth of tables (projects, project boards, the index and
  its state). All are new tables; nothing existing is rewritten. Rolling back
  drops them: projects lose their links, and the index loses nothing, being
  derived.
- The browser stops aggregating. Home and workspace Intelligence read the
  server; the local pulse remains only for signed-out, local-only use.
- Reading the org's boards for access still goes through `BoardStore`. The
  index saves the per-board derivation, not the board list. A summary-only
  board listing is a later optimization with its own measurement.
- The debounced reindex means a statement can lag its commit by about a
  second. Read-time repair bounds how stale an answer can be: the state row
  is compared with the board on every read.
- Trust (J5) and AI run records (J6) add columns to these rows in A2; search
  and scoped Ask (J4) read this index in A4.
