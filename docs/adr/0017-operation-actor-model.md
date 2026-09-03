# 0017 — The actor model: who produced it, who asked, who authorized

- Status: Accepted
- Date: 2026-09-02

## Context

Every log entry recorded one `by`. That was honest for human edits and a lie
for gated ones: when Alex asks Lucent to map the pricing flow and Sarah
approves the proposal, the commit's `by` is Sarah — the log could name the
approver or the requester, never both, and never the model.

## Decision

`op_log` gains a three-part accountability record, kept deliberately separate
from workspace authorship:

```
actorType   user | ai | system   WHO/WHAT produced the batch
actorId     usr_… | "lucent"     the actor's stable id
initiatedBy WHO ASKED — the user behind the meeting or prompt
approvedBy  WHO AUTHORIZED — for review-gated AI proposals
```

`by` (and `stampAuthorship` on the workspace side) is **unchanged**: the person
who pressed approve remains the author of record for comments/votes/reactions,
and `assistant` stays the AI's workspace-level id. The actor model is
log-level accountability; it migrates no workspace data.

Scope decisions, per the Stage B plan:

- An agent acting through `POST /api/boards/:id/ops` is `{user, caller}` — the
  agent acts under the accountable human's token, not a fourth actor kind.
- `system` is reserved; no producer exists yet.
- The AI is **not** a room participant — no socket, no presence, no lifecycle.
  Semantic participation and network presence are different problems; the
  auditability this model buys does not need the architecture the other costs.
  Promoting the AI to a real participant stays open for a UX-driven decision
  ("Lucent is working…", AI cursors, specialized agents).

## Consequences

- The history can say both true things at once: "✦ Lucent created 4 nodes"
  and "initiated by Alex, approved by Sarah."
- Migration 0018 backfills existing rows as `{user, by, by}` — no legacy row
  claims `ai`.
- Stage C's audit/history layer has the fields it needs without redesigning
  multiplayer.
