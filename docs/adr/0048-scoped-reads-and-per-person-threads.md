# 0048 — Search and Ask are scoped reads; a conversation is a person's thread

- Status: Accepted
- Date: 2026-09-27

## Context

docs/26 A4 ends when "Why are we doing this?" answers with the decision, the
meeting and the turn. Four gaps stand in the way:

- **Board-only reads.** Search and Ask each read one stored board. A
  question about a project, or "everything from this week", has nowhere to go.
  Ask refuses local boards outright.
- **Confidence is prose.** Ask's citations are validated, but the answer
  doesn't say how well supported it is. "The board doesn't say" exists only as
  a line in the prompt.
- **Conversations are browser state.** The canvas chat lives in
  localStorage per board. The meeting's voice answers are session cards with
  no history. A follow-up spoken in a meeting can't see the question typed a
  minute before.
- **Agents see one board.** MCP clients read a board and write operations,
  nothing across the workspace.

The search index is lexical and in-process (`retrieval.ts`, ADR 0024: keyword
first; embeddings stay gated on evidence). Postgres has no full-text index.

## Decision

**Search and Ask read a scope — a board, a meeting, a project, the workspace
and a time range — and every scope is resolved through the boards the caller
can open. Confidence is computed from evidence, never asked of the model. A
conversation is one person's thread on one scope, kept on the server.**

- **Scopes.** Every workspace read starts from `readableBoards` (ADR 0046):

  - a project narrows to its boards;
  - a meeting to its board and its turns;
  - `since`/`until` bound meetings, turns and comments by their own
    timestamps.

  A scope names nothing the caller couldn't open.

- **Search** (`GET /api/orgs/:id/search`) runs the existing lexical
  retriever over a workspace corpus: nodes and statements, meeting turns and
  titles, comments, and board names, with hits carrying their board. It is
  keyword-first and in-process, like board search. A Postgres full-text index
  waits for a workspace large enough to need one, measured.
- **Ask**:
  - Board Ask (`POST /api/boards/:id/ask`) keeps its context.
  - Scoped Ask (`POST /api/orgs/:id/ask`) builds the same answer request from
    the statement index, the meetings and the retrieval hits in scope.
    Citations are qualified `board:node`, so each one opens where it lives.
  - Local Ask (`POST /api/ask/local`) answers from the workspace the browser
    sends, parsed and bounded like generate's input, with no history or
    meetings to claim.
- **Confidence** rides every answer: `none | low | medium | high`, from the
  citations that survived validation:

  - how many there are;
  - how many independent sources they name (a meeting turn, a statement, a
    revision);
  - whether a cited statement has since been superseded or rejected, which
    caps it at `low` and says so.

  No surviving citation means `none`, shown as "No evidence".

- **Threads.** `threads` + `thread_messages`: one thread per (person, scope).
  Canvas chat, board Ask and the meeting's spoken and typed Ask write to it.
  The last eight turns go with every request, as before, but from the thread.
  - Private: a thread is its author's, like meeting notes.
  - Local boards keep their chat in the browser. There is no server scope to
    hold it.
- **Ask → canvas.** An answer's node citations can be shown together: the
  canvas selects them all and fits the view.
- **MCP v2.** Four read tools over the same routes, derived from the board
  the session serves (its org):
  - `search_workspace`
  - `list_decisions` (the index)
  - `get_meeting`
  - `get_project`

## Consequences

- Two tables (threads and their messages, migration 0038). A thread holds
  what its author typed and what Lucent answered, and is deleted with its
  author. Meeting notes set the privacy precedent.
- Workspace search rebuilds its corpus per request from the readable boards
  it already loads. That's linear in the workspace, bounded per board, and
  fine at today's sizes. The measurement that would move it to Postgres is
  named, not guessed.
- A workspace answer cites across boards, so its citations carry a board id.
  Clients that know only board citations ignore what they can't open.
- Confidence is a count, not a probability. "High" means several
  independent sources agree and none contradicts. It says nothing about
  whether the model read them well.
