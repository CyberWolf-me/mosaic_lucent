# 0020 — The answer call type: citations validated at the boundary

- Status: Accepted
- Date: 2026-09-03

## Context

`LLMProvider` had exactly one call type: a request in, validated operations
out. Questions about the board were answered through it by convention — the
prompt told the model to return an empty operations array with the answer in
`explanation` — which meant a question rode the full build contract
(operation validation, repair rounds, proposal thresholds) to deliver prose.

Stage C1 makes "understand my workspace" a first-class direction next to
"change my workspace": the AI pill's Build/Ask toggle, the history timeline,
and questions like "what changed about pricing?" answered from the board's
accumulated history with evidence. Two design questions had to be settled
before any of it was built: what the second call type's contract is, and —
the harder one — where the boundary sits when the model's answer references
things that may not exist.

## Decision

**A second, deliberately separate provider method: `generateAnswer`.** Not a
mode flag on `generateOperations` — the guarantees differ (an answer never
mutates the board, so there is no validator/repair pipeline downstream), and
a union type would have made every existing call site a runtime
discriminant. `AnswerRequest` carries structured, *windowed* context
(history entries, meeting extracts with classified turns, a node index, and a
pre-rendered provenance-aware board digest — the projection Build's summary
deliberately omits, because "why is this node here?" is Ask's core question);
`AnswerResult` returns an answer plus citations, where each citation is a
closed kind (`node` | `meeting` | `revision`) with an id the context actually
showed.

**Citations are validated at the server boundary and dropped, not
repaired.** The model's citations are untrusted output: a hallucinated
`revision 9172` or a node id that never existed must not render as evidence.
The route resolves every citation against real, *caller-visible* state — a
node must be on the board, a meeting inside the caller's window, a revision
inside the window — and the failures land in `warnings` while the answer
survives. This is the Stage A partial-application rule (one bad op never
killed the batch) applied to evidence instead of operations, and it is why
there is no repair round on the answer path: re-asking the model over a bad
citation costs a full provider call to fix the least important part of the
answer.

**The context builder is a projection, not a memory layer.** `askContext.ts`
renders disposable context from canonical state (workspace, op log,
transcripts, proposals) and nothing it computes is ever stored back. The
review's warning is recorded in its module header: the day that module
persists anything is the day Lucent has two sources of truth — the exact
failure mode the "statements live on nodes, no Knowledge collection"
decision exists to prevent. Stage C2 (semantic lifecycle) builds on the
canonical sources, never on this projection.

## Consequences

- Every provider implements two methods; test stubs must say what they want
  (a stub that cannot answer throws, which is a test bug made visible rather
  than a silent gap).
- The offline story stays whole: MockProvider's answer scripts cite only ids
  the context really contains, so the offline demo and CI exercise the same
  citation validation the real provider's output will face — a mock whose
  citations were all dropped would validate nothing.
- The citation contract is small and closed on purpose. When Stage C2 adds
  semantic entities (decisions, proposals with lifecycles), they become new
  citation kinds through this same validation seam — the check widens with
  the context, and the rule (unvalidated evidence never renders) holds.
- No streaming for answers in C1: an answer is short, and the citations only
  exist as a whole. If answer latency ever hurts, the streaming seam the
  build path already has is the template — added then, not now.
