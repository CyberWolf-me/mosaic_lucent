# 27 — More than one kind of picture, and notes worth keeping

- Status: **Accepted 2026-09-24** — executing in the order of §5
- Date: 2026-09-24 · branch `lucent/atelier`
- Inputs: founder questions ("can the model create more types of diagrams,
  like Miro?" and "note taking should function like Granola / Otter"), and
  three research passes done that day against the vendors' own help centres,
  blogs and API references (Miro, Granola, Otter, Recraft). Sources are cited
  in the research notes; this doc keeps only the conclusions.

## 1. What Miro actually has — and what that means for Lucent

**The finding that matters:** most of Miro's catalogue is _shape packs and
templates_ — thousands of static shapes arranged by hand. Only a handful of
its visuals are structured objects that stay editable as meaning: Mermaid
diagrams (flowchart for sure; sequence, class, ER partly), the mind map and
org chart widgets, and one record set shown as Table / Timeline / Kanban.
**Miro's AI generates exactly five diagram types** from a prompt: mind map,
flowchart, ER, UML class, UML sequence.

Lucent's model — a typed semantic graph, a deterministic layout engine,
validated operations, provenance — already produces more _structured_ kinds
than that (flowchart, architecture, mind map, journey, decision tree, process
swimlanes, org chart, BPMN, plus sequence / ER / Kanban / wireframe lenses).
The gap is **breadth of families** and **one model, many views** — not
shape count. So Lucent adds families the way it adds everything: as semantic
kinds with their own geometry, never as a pile of loose shapes.

### Families to add (ranked by value × fit)

| #   | Family                                                   | Why                                                                           | How in Lucent                                                                                                                          |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Timeline / roadmap**                                   | Miro's most-used planning view; ties straight to actions' due dates           | New kind `timeline`: time runs left→right; placement by `issue.dueDate`, else by flow order; one lane per group; milestones as markers |
| 2   | **Matrix** (2×2, SWOT, prioritisation, RACI-style grids) | Workshops live on these; Miro has only templates                              | New kind `matrix`: each group is a cell; cells laid out as a grid; the AI picks the cell, never a coordinate                           |
| 3   | **State machine**                                        | Code-only in Miro — an easy, real win for engineering boards                  | New kind `statemachine`: states, guarded transitions, start/end pseudo-states                                                          |
| 4   | **UML class**                                            | In Miro's AI five; natural next to ER                                         | Node compartments (fields, methods) — needs a node "details" field                                                                     |
| 5   | **User story map**                                       | Template-only in Miro; a backlog grid is semantic by nature                   | `matrix` geometry with activity columns × release rows                                                                                 |
| 6   | **C4** (context → container → component)                 | Miro renders it as a static image; zoom-between-levels suits a semantic model | Architecture + nested regions + level navigation                                                                                       |
| 7   | **Fishbone, Venn, sitemaps**                             | Common workshop artefacts                                                     | After the above, as geometry proves needed                                                                                             |

### AI capabilities to add (Miro's, done Lucent's way)

1. **Stickies → structure**: select stickies → "cluster by theme" into titled
   frames, or "make these a flowchart / matrix". Every result is a proposal.
2. **Mermaid in and out**: paste Mermaid (flowchart, state, mind map) and it
   becomes a real semantic diagram; copy any board as Mermaid (already built).
   Miro standardised on Mermaid for agents — Lucent's MCP should speak it too.
3. **Expand a node** with questions / ideas / sub-topics (the inspector's
   Expand exists; make it three focused verbs).
4. **Photo or sketch → diagram** (a whiteboard photo becomes a semantic graph).
5. **Reviewer agents** on a board (architecture well-architected review,
   risk critique) — they write statements (risks, questions), not prose.

## 2. How Granola and Otter take notes — and what Lucent should do

**Granola** (desktop, no bot): a blank notepad; you type terse notes during
the call while it transcribes; when the call ends it **enhances your notes**
into a structured document — _your lines stay black, the AI's additions are
grey_, and each point has a magnifier to its transcript source. Templates set
the sections; "recipes" are saved prompts; chat works over one meeting or many.
Audio isn't kept. What users praise: no bot, and _the note is the product —
my notes steer it_. What they complain about: speakers are only "Me" / "Them",
and there's no audio to check against.

**Otter** (bot joins the call): a live transcript with speaker names, a live
summary that refreshes every few minutes, highlights and action items anyone
can add during the call, slide capture, synced playback, and "Hey Otter" in
the meeting. What users complain about: the bot spreading itself, speaker
errors, generic summaries — and both companies are in court over consent and
training defaults.

### What Lucent does (it hosts the room, so it can do both, better)

1. **A private notepad in every meeting.** Terse typing, `#` / `-` / `[ ]`;
   every line is stamped with the transcript turn it was typed at.
2. **Enhance at the end** (and on demand): the user's lines stay verbatim in
   primary ink; AI additions are muted and **every AI sentence cites its
   turns** — hover shows the quote, click jumps to the transcript.
3. **Human lines are never overwritten.** Editing an AI line makes it yours;
   re-enhancing or switching template keeps what you wrote.
4. **Real speaker names** from per-participant tracks — the thing Granola
   can't do.
5. **Templates by meeting type** (general, 1:1, standup, design review,
   customer call, retro): each is a set of sections and instructions.
6. **One record, two views**: the decisions, actions, questions and risks in
   the note are the same statements the canvas holds — edit one, the other
   follows (they already carry meeting provenance).
7. **A live outline** during the meeting (chapters every few minutes) beside
   the extracted statements.
8. **Private ask** ("what did I miss?") answered only to you; the spoken
   wake-phrase agent stays the public one.
9. **Consent Lucent can guarantee**: a visible "transcribing · AI notes on"
   indicator for everyone, per-person STT mute, host stop — and **no model
   training on meetings, ever**; no auto-emailed summaries.
10. **Follow-ups through the existing human gate**: recap drafts, tasks to
    Linear/Jira — nothing sent without a confirm.

## 3. What does not change

Operations stay the only contract; the model never places things; every AI
change is reversible and provenanced; restricted boards keep their
boundaries. Notes are a new object, not a new rule.

## 4. Decisions taken here

- New diagram families are **kinds with geometry**, not shape templates.
- A family ships with: the kind, its layout strategy, its route style, its
  label, prompt guidance, a starter template, tests on the benchmark harness.
- Notes are **per person, private by default**; the enhanced note is shared
  only when its owner shares it.
- Enhanced notes cite turns; a sentence without a citation is shown as the
  user's own or not at all.

## 5. Order

```text
D1  timeline, matrix, statemachine kinds + prompt + templates       (now)
N1  notepad (stamped lines) + enhance with citations + templates     (next)
D2  Mermaid import; stickies → cluster / structure                  (then)
N2  live outline, private ask, speaker names everywhere
D3  UML class (node details), story map, C4 levels
N3  follow-up drafts through the gate; cross-meeting chat
```
