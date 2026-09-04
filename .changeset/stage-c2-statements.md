---
"@lucent/core": minor
"@lucent/ai": minor
"@lucent/server": minor
"@lucent/mcp": minor
"@lucent/web": minor
---

Stage C2: the semantic lifecycle — statements live on nodes, and meeting evidence finally converges.

- **Statements as operations (`@lucent/core`, ADR 0021)**: `SET_STATEMENT`
  and `UPDATE_STATEMENT` give a node its meaning — decision, proposal,
  question, action, requirement, or risk — with an open/resolved/rejected/
  superseded lifecycle, kebab-case topics, and validated supersession links
  (visible by reducer side effect, cycle-safe, restored exactly on undo).
  The kind set is closed and frozen: new kinds require evidence of a
  distinct lifecycle. A statement survives relabels and transforms.
- **Provenance rides the operation (ADR 0022)**: `CREATE_NODE` gains the
  meeting evidence (id, turn range, kinds, quote) that produced it, attached
  by the meeting loop before commit. The old browser-local stamp never
  reached peers, history, or the server — on shared boards it silently
  vanished, and review-gated extractions stamped nobody. Now the evidence
  lands everywhere the ops land, by construction, and Ask's "why is this
  here?" answers from converged data.
- **The model and agents see meaning (`@lucent/ai`, `@lucent/mcp`)**: the
  build prompt teaches the doctrine as data (decisions are born resolved; a
  rejection supersedes visibly; kind never changes), the board summary
  carries statements so the model can update what it sees, Ask answers
  "what did we decide about pricing?" from statement brackets, and MCP's
  get_board projects them for agents.
- **Visible + editable (`@lucent/web`)**: a kind·status chip on every
  statement node, a HUD editor whose manual edits commit through the same
  validator the AI faces, and the ✦ evidence jump working on shared boards.
