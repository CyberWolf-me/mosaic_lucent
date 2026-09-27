# 0047 — Trust is stamped where the actor is known

- Status: Accepted
- Date: 2026-09-27

## Context

docs/26 A2 ends when "nothing AI-extracted becomes trusted without a visible
human step". J5 gives statements a `trust` field (_ai-suggested ·
human-approved · human-edited · human-created · system_), separate from their
lifecycle status, and a Review center where people approve, edit, reject or
assign what the AI produced. J6 asks for a record of every AI run: which
model, what context, who approved.

What the code knows today, per path:

- **Canvas requests** are generated on the server, but the server isn't told
  the board, and the client applies the result itself. Either it goes straight
  to the board, or, above the approval threshold, it goes through a proposal.
  The WebSocket carries no actor, so every AI batch the browser applies is
  logged as the user's own.
- **Live meeting extraction** always becomes a proposal. A person applies it
  as a whole ("Apply all"), and the server commits it as an AI actor approved
  by that person.
- **The voice agent** writes through the ops route with a board grant, as an
  AI actor. **The MCP server** writes through the same route with a bearer
  token, so it is logged as the user.
- **Nodes carry no author**, and statements nothing about who made them.
- The model's tool schema derives from the operation union, so any field
  added to a statement is a field the model can emit.

## Decision

**A statement's trust is stamped by the party that knows who is acting, at
the moment it commits. The model never sets it, and an agent can never raise
it.**

- `StatementFields.trust?: StatementTrust`. `UPDATE_STATEMENT` may set it,
  which is how a promotion is an ordinary validated, logged, undoable op.
  Absent means the statement predates trust; it is shown without a badge and
  is never assumed to be reviewed.
- **The model's output never carries trust.** The generate pipeline strips it
  from every operation before returning. The prompt doesn't mention it.
- **The browser** stamps what a person commits:
  - AI output they asked for (a typed or spoken request, or a canvas proposal
    they applied) is `human-approved`. The person asked and saw the result.
  - A statement carrying **meeting evidence** stays `ai-suggested`, even after
    "Apply all". Bulk-applying an extraction isn't a review of each claim;
    that happens per item in the Review center.
  - A statement a person creates by hand is `human-created`.
  - Relabelling a statement that is still `ai-suggested` makes it
    `human-edited`.
- **The server** stamps what it commits, and overrides anything claimed:
  - A proposal approved on the server: a meeting proposal is `ai-suggested`;
    any other is `human-approved`.
  - Writes from the voice agent or the MCP client are `ai-suggested`, and a
    trust change they try to make is stripped.
  - An accepted inbound integration change is `system`.
  - Review-center actions are `human-approved`, or `human-edited` for an
    edited statement.
- **The Review center** (`GET /api/orgs/:id/review`) gathers, from the boards
  the caller can read, the four queues that wait on a person:
  - `ai-suggested` statements, from the index, which now stores trust;
  - pending proposals;
  - pending external actions;
  - pending inbound changes.
    Statement actions (approve, edit, reject, assign) are composed into
    operations on the server and committed through the same path as the ops
    route, as the person who decided. Rejecting deletes the node. The op log
    keeps it, and undo brings it back.
- **AI runs.** An `ai_runs` row is written wherever a model is called or an
  agent writes on a board:
  - where: canvas and meeting generation, Ask, notes, the meeting recap, and
    voice-agent and MCP writes;
  - what it records: who initiated the run, the surface, the provider and
    model, the context scope, the tools, a hash of the output and the
    operation count.
  - Generation returns a `runId`. When the browser commits that output over
    the WebSocket, it sends the id back: the op log then records an AI actor
    initiated and approved by the person (no longer "user"), and the run
    gains the sequence number.
  - A proposal created from a run carries the id, so approving it records who
    approved.
  - The server honours a run id only for the user and board it was issued
    to.
- **Notifications** gain four kinds with a clear recipient:
  - `work.assigned` and `work.blocked` go to the org member the work's
    assignee names, matched exactly by name or email. They come from the
    index's per-board diff.
  - `meeting.summarized` goes to the meeting's creator when the recap is
    written.
  - `review.pending` goes to the board's owner when new AI suggestions land,
    at most once per board per hour.

## Consequences

- One nullable column on the index, a `run_id` on proposals, and a new
  `ai_runs` table (migration 0037). Nothing existing is rewritten.
  Statements made before this ADR have no trust. They are neither listed for
  review nor presented as reviewed.
- A browser client could claim `human-approved` for what it commits. That is
  accepted: the browser is the person, and a person may approve. Every path
  that isn't a person — the model, the voice agent, MCP, the server's own
  appliers — is stamped on the server, where claims are overridden.
- The WebSocket commit gains an optional `runId`. Old clients that don't send
  it keep being logged as the user, exactly as before.
- `decision.superseded` has no clear recipient yet (statements have no
  author) and waits.
