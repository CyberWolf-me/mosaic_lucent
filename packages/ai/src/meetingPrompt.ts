/**
 * The meeting extraction's prompt pieces (docs/28 M2), shared by the two
 * places that extract: the browser's live loop, and the server's
 * end-of-meeting automation (docs/26 A5), which extracts the turns nobody
 * did. One wording, so a meeting reads the same to the model either way.
 */

/** What a turn is doing in the conversation — the extract board's tags. */
export type TurnKind =
  | "problem"
  | "hypothesis"
  | "solution"
  | "decision"
  | "action"
  | "requirement";

/**
 * Classify one turn for the extract board. A keyword heuristic, not a model
 * call: the classification is a *draft* the meeting owner can correct before
 * saving, and a model round-trip per line would cost real money for output
 * the user overrides anyway. The keywords are deliberately few — each one
 * must justify itself by catching turns the alternatives miss.
 *
 * A rejection ("no, we're not doing X") classifies as a DECISION: in the
 * statement-kind model it is the strongest decision signal there is — it
 * closes an option — and the differential prompt teaches the extraction to
 * mark what it superseded (found by the meeting-eval suite: the disagreement
 * fixture's "No, we're not doing usage-based pricing" fell through every
 * branch and rendered unclassified).
 */
export function classifyTurn(text: string): TurnKind | undefined {
  const t = text.toLowerCase();
  if (
    /\b(we'?ll|we will|let's|decided|agree[d]?|we'?re not doing|we are not doing|no, we'?re not)\b/.test(
      t,
    )
  )
    return "decision";
  if (/\b(problem|bug|broken|fails?|can'?t|blocked)\b/.test(t)) return "problem";
  if (/\b(we need|require[sd]?|must|should)\b/.test(t)) return "requirement";
  if (/\b(action|todo|task|next step|i'?ll|assign)\b/.test(t)) return "action";
  if (/\b(maybe|perhaps|what if|might|could try|assume)\b/.test(t)) return "hypothesis";
  if (/\b(solution|fix|instead|workaround|so we)\b/.test(t)) return "solution";
  return undefined;
}

/**
 * The differential prompt: only the NEW turns, plus an explicit statement of
 * what the board already holds, so the model adds rather than rebuilds.
 */
export function differentialPrompt(
  turns: ReadonlyArray<{ speaker?: string; text: string; kind?: string }>,
): string {
  const lines = turns.map((t) => {
    const tag = t.kind ? ` [${t.kind}]` : "";
    const who = t.speaker ? `${t.speaker}:` : "";
    return `${who}${tag} ${t.text}`.trim();
  });
  return [
    "New turns from the live meeting (the board already shows everything captured earlier — do NOT rebuild it):",
    "",
    ...lines,
    "",
    "Add ONLY what these new turns introduce that is not on the board yet: new concepts as nodes, new relationships as connections, new topics as a new group with a fitting diagram kind (mindmap, flowchart, journey, orgchart, decisiontree, process, or architecture). Connect new nodes to related existing ones. If a turn refines or corrects something already on the board, update that node's label or connections — do not duplicate it. Emit no DELETE operations and do not regenerate existing regions.",
    "",
    "Statement kinds — get these right; they are how the board earns trust:",
    "- A node that IS a statement carries one via SET_STATEMENT: kind is one of decision / proposal / question / action / requirement / risk, status one of open / resolved / rejected / superseded. Set a short kebab-case topic (e.g. 'pricing') when the subject is clear — and REUSE a topic key the board already carries when the subject matches (existing statement topics appear in the board summary); minting 'pricing-model' beside an existing 'pricing' splits the group.",
    "- Decisions ('okay, let's…', 'we'll…', 'agreed') are the only decided things: create the node AND SET_STATEMENT kind=decision status=resolved. An undecided 'decision' is a proposal.",
    "- Proposals ('maybe', 'what if', 'we could try') are NEVER decisions: kind=proposal status=open.",
    "- A REJECTION ('no, we're not doing X') updates the existing X statement: UPDATE_STATEMENT status=rejected, or relabel the node 'Rejected: X'. Both statements must not survive as if both were true.",
    "- A CORRECTION ('actually…', 'no, I meant…') replaces the earlier statement in place: update its label, and if the new wording is itself decided, its SET_STATEMENT may list the old node's id in supersedes — the board marks the old statement superseded by itself. Never a second contradictory node.",
    "- Turn-kind mapping: decision → kind=decision; hypothesis → kind=proposal; action → kind=action; requirement → kind=requirement; problem and solution turns stay as plain nodes (they are context, not statements).",
    "- ATTRIBUTION: when the conversation establishes a GENUINE commitment or action, create the action node AND emit a SET_ISSUE giving it to the person who committed to it or was explicitly tasked with it — in ANY meeting style, not only planning sessions. A hedged or speculative mention ('we should probably ask Sarah', 'I'll think about it', 'I'll see if that's possible', 'can you imagine if…') is NOT a commitment: no assignee, and often no action at all. A mention is never an owner — 'we should talk to Sarah about pricing' is an action 'Discuss pricing with Sarah' owned by the SPEAKER, not an action owned by Sarah.",
    "- DEADLINES (Stage D1): when a commitment's words name a deadline — 'by Friday', 'before the 15th', 'next Monday', 'end of the week' — resolve it to the SET_ISSUE dueDate as YYYY-MM-DD against the MEETING's date (the transcript header carries it). NEVER store the word ('Friday' is not a date); if the words name no date, set no dueDate. A commitment with an owner and a deadline starts status=assigned (the canonical vocabulary: open/assigned/in_progress/blocked/completed/cancelled); with an owner but no deadline it is also assigned; with neither it is open. These are initialization conventions, not derived rules — no issue field ever changes another.",
    "- If a turn is small talk, a joke, or off-topic, emit nothing for it.",
  ].join("\n");
}
