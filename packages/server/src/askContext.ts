import type { AnswerRequest, AnswerMeetingSummary, AnswerRetrievalHit } from "@lucent/ai";
import type { Node, ProvenanceFields, Workspace } from "@lucent/core";
import { canonicalizeTopic, derivedExecution, topicsAreVariants } from "@lucent/core";
import type { LoggedOpEntry } from "./boards.js";
import type { MeetingTranscript } from "./meetings.js";
import { buildSearchCorpus, retrieve, SEARCH_LIMITS } from "./retrieval.js";

/**
 * The Ask context projection (Stage C1).
 *
 * THIS MODULE IS A PROJECTION, NOT A MEMORY LAYER. It renders disposable
 * context for one answer call: everything it returns is derived from
 * canonical state (the board workspace, the op log, meeting transcripts) and
 * nothing it computes is ever stored back. When Stage C2 builds the semantic
 * lifecycle — decisions, proposals, supersessions — it builds on the
 * canonical sources, never on this file's output. The day this module starts
 * persisting anything is the day Lucent has two sources of truth (the exact
 * failure mode the "statements on nodes only" decision exists to prevent).
 *
 * Two rules govern the windowing, both review amendments:
 *
 * 1. The ENTIRE context is bounded by the caller's history.depth entitlement,
 *    not just the history list. The caller (routes/ask.ts) has already
 *    windowed the log and filtered the meetings; this module trusts those
 *    inputs and adds no board state that predates them — the board digest
 *    describes current state, which every revision in the window produced.
 * 2. The projection is honest about truncation: historyTruncated reaches the
 *    prompt, the prompt tells the model to disclose the limit, and the
 *    MockProvider demonstrates the disclosure so offline runs show it.
 *
 * What the model may cite is exactly what appears here: the node index, the
 * history window's revision numbers, and the visible meetings. Citation
 * validation at the route mirrors this set — the model cannot smuggle a fact
 * in through a citation the projection never offered.
 */

/**
 * Size budgets for the digest. Deliberately small: the answer path answers
 * questions about the work, it does not re-derive the board. Nodes and edges
 * are the semantic graph (what "what is on this board?" needs); shapes and
 * votes are not included — an answer that needs a sticky note's exact wording
 * should cite the node the note annotates or the meeting it came from.
 */
export const ASK_DIGEST_LIMITS = {
  nodes: 200,
  nodeLabel: 80,
  edges: 400,
  groups: 40,
  quote: 160,
  meetings: 10,
  meetingTurns: 12,
  meetingTurnText: 400,
  history: 200,
  nodeIndex: 200,
  /** Distinct topic groups rendered in the statements-by-topic section. */
  topics: 20,
  /** Statements listed per topic group. */
  topicStatements: 8,
} as const;

/** What the route knows about the window, distilled for the projection. */
export interface AskWindowInput {
  /** The caller's history.depth entitlement; null when unlimited. */
  depth: number | null;
  /** True when older revisions exist beyond the visible window. */
  hasMore: boolean;
}

/** The route-level inputs the projection derives everything from. */
export interface AskContextInput {
  /** The user's question — the projection carries it; it never invents one. */
  question: string;
  boardName: string;
  workspace: Workspace;
  /** The caller's visible window of the op log, NEWEST FIRST. */
  log: LoggedOpEntry[];
  /** Display names by actor id ("lucent" included); unknown ids miss. */
  actorNames: ReadonlyMap<string, string>;
  /** Meetings already filtered to the caller's window, newest first. */
  meetings: MeetingTranscript[];
  window: AskWindowInput;
  /** Recent conversation turns, so follow-ups resolve. */
  conversation?: AnswerRequest["conversation"];
}

/**
 * The provenance stamp the web app writes onto nodes it extracted from a
 * meeting (workspace.tsx applyStamped). Declared here so the digest renders
 * it without the server importing web code — the shape is the contract.
 */
interface MeetingProvenance {
  meetingId?: unknown;
  quote?: unknown;
  extractedAt?: unknown;
  turnRange?: unknown;
  turnKinds?: unknown;
}

function asMeetingProvenance(value: unknown): MeetingProvenance | undefined {
  return typeof value === "object" && value !== null ? (value as MeetingProvenance) : undefined;
}

/** A number that is a real [start, end] pair, or nothing. */
function asTurnRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }
  return [Math.floor(start), Math.floor(end)];
}

/** A short string or nothing — never a thrown error on hostile metadata. */
function shortText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

/** The actor's display name for a log entry: the map first, then the raw id. */
function actorDisplayName(entry: LoggedOpEntry, names: ReadonlyMap<string, string>): string {
  const actor = entry.actor;
  if (!actor) return names.get(entry.by) ?? entry.by;
  if (actor.actorType === "ai") return "Lucent";
  return names.get(actor.actorId) ?? actor.actorId;
}

/**
 * Render the board digest: current state with provenance. This is the
 * projection Build's summary deliberately omits — `metadata.meeting` is
 * invisible to `summarizeWorkspace`, but "why is this node here?" is the
 * question Ask exists for, so provenance rides here.
 *
 * First-party rendering of collaborator-authored content (labels, quotes),
 * and the prompt harness escapes it again when it interpolates — defence in
 * depth, same as the build path's board context.
 */
export function renderBoardDigest(input: AskContextInput): string {
  const ws = input.workspace;
  const lines: string[] = [`Board: ${input.boardName} (diagram kind: ${ws.diagramKind})`];
  // Stage D3: the derived execution state, computed once per digest — the
  // manual/derived split rendered side by side (status is the human's call;
  // blockedBy/atRiskBy are computed truth).
  const derivedMap = derivedExecution(ws, Date.now());
  const derivedFor = (id: string) => derivedMap.get(id);

  const nodeIds = Object.keys(ws.nodes).slice(0, ASK_DIGEST_LIMITS.nodes);
  if (nodeIds.length) {
    lines.push("Nodes (current state):");
    for (const id of nodeIds) {
      const node: Node = ws.nodes[id]!;
      const label = node.label.slice(0, ASK_DIGEST_LIMITS.nodeLabel);
      const parts = [`  ${id} (${node.nodeType}): ${label}`];
      if (node.groupId) parts.push(`[group: ${node.groupId}]`);
      const issue = node.issue;
      if (issue) {
        parts.push(`[issue: ${issue.type} · ${issue.status}${issue.assignee ? ` · @${issue.assignee}` : ""}]`);
      }
      // The derived execution truth (Stage D3): computed per digest read —
      // blockedBy/atRiskBy from the dependency graph, so "what's blocking
      // us?" is answered from structure. Never stored, never aliased onto
      // the manual status above.
      const derived = derivedFor(node.id);
      if (derived) {
        if (derived.blockedBy.length) {
          parts.push(`[blocked by: ${derived.blockedBy.slice(0, 6).join(", ")}]`);
        }
        if (derived.atRiskBy.length) {
          parts.push(`[at risk: ${derived.atRiskBy.slice(0, 6).join(", ")}]`);
        }
      }
      // The statement (Stage C2): what this node IS. This is the line that
      // answers "what did we decide about pricing?" — the digest the
      // historian prompt's statement clause teaches the model to read.
      const statement = node.statement;
      if (statement) {
        parts.push(
          `[${statement.kind} · ${statement.status}${
            statement.topic ? ` · topic: ${statement.topic}` : ""
          }${statement.supersedes?.length ? ` · supersedes: ${statement.supersedes.join(", ")}` : ""}]`,
        );
      }
      // Provenance: the reason Ask exists. Quote plus the stable turn range,
      // which survives where the quote cannot (Stage A). The op-level field
      // (Stage C2, ADR 0022) is canonical; the old metadata stamp is the
      // fallback for boards whose meetings predate the contract.
      const prov = node.provenance ?? asMeetingProvenance(node.metadata?.meeting);
      if (prov) {
        const quote = shortText("quote" in prov ? prov.quote : undefined, ASK_DIGEST_LIMITS.quote);
        const turnRange = asTurnRange(prov.turnRange);
        parts.push(
          `[from meeting ${shortText(prov.meetingId, 120) ?? "?"}${
            turnRange ? ` turns ${turnRange[0]}–${turnRange[1]}` : ""
          }${quote ? `: "${quote}"` : ""}]`,
        );
      }
      lines.push(parts.join(" "));
    }
  } else {
    lines.push("Nodes (current state): (none)");
  }

  const edgeIds = Object.keys(ws.edges).slice(0, ASK_DIGEST_LIMITS.edges);
  if (edgeIds.length) {
    lines.push(
      `Edges:\n${edgeIds
        .map((id) => {
          const e = ws.edges[id]!;
          return `  ${e.source} --${e.relationship}--> ${e.target}`;
        })
        .join("\n")}`,
    );
  }

  const groupIds = Object.keys(ws.groups).slice(0, ASK_DIGEST_LIMITS.groups);
  if (groupIds.length) {
    lines.push(
      `Groups:\n${groupIds
        .map((id) => {
          const g = ws.groups[id]!;
          return `  ${id}: ${g.label} (${g.children.length} members)`;
        })
        .join("\n")}`,
    );
  }

  // Statement evolution (Stage C3): the cross-meeting chain, first-class.
  // Every statement that supersedes another renders as one line — what it
  // is, where it came from, and what it replaced, with that target's own
  // origin — so "why did we change pricing?" is answered by READING the
  // digest rather than correlating supersedes ids against node lines.
  // Derivable entirely from the current workspace (canonical state), same
  // as the rest of the digest.
  const evolution = Object.values(ws.nodes)
    .filter((n): n is Node & { statement: NonNullable<Node["statement"]> } =>
      Boolean(n.statement?.supersedes?.length),
    )
    .slice(0, ASK_DIGEST_LIMITS.groups)
    .map((n) => {
      // Stage D2: provenance now carries either evidence kind — the origin
      // bracket renders meeting evidence when present, and the plan link
      // when that is what the node carries (a plan item names its sources).
      const origin = (p: ProvenanceFields | undefined): string => {
        if (!p) return "";
        const meeting = p.meetingId ? `, from meeting ${p.meetingId}` : "";
        const planned = p.createdFrom?.length
          ? `, planned from ${p.createdFrom.join(", ")}`
          : "";
        return meeting + planned;
      };
      const targets = n.statement.supersedes!
        .map((id) => {
          const t = ws.nodes[id];
          if (!t?.statement) return `  (unknown: ${id})`;
          return `  replacing ${t.id} (${t.statement.kind} · ${t.statement.status}${
            t.statement.topic ? ` · topic: ${t.statement.topic}` : ""
          }${origin(t.provenance ?? t.statement.provenance)})`;
        })
        .join("\n");
      return `  ${n.id} (${n.statement.kind} · ${n.statement.status}${
        n.statement.topic ? ` · topic: ${n.statement.topic}` : ""
      }${origin(n.provenance ?? n.statement.provenance)})\n${targets}`;
    });
  if (evolution.length) {
    lines.push(
      `Statement evolution (newest statements superseding older ones — this is how the work changed across meetings):\n${evolution.join("\n")}`,
    );
  }

  // Statements by topic (Stage C5): the grouping payoff. Statements grouped
  // by TOPIC IDENTITY — canonicalizeTopic normalizes morphology (plurals,
  // stems, case), then variant-related keys merge under one representative
  // (the fold's own rule: shortest, then lexicographic) — so a human's
  // authored 'pricing-model' beside 'pricing' still answers "what happened
  // with pricing?" as one section. Every authored spelling is noted (the
  // board's own text is the truth; the header is only the grouping). Still
  // a pure projection of current state; still derived, never persisted.
  const topicGroups: Array<{
    header: string;
    authored: Set<string>;
    statements: Array<{ id: string; kind: string; status: string }>;
  }> = [];
  for (const node of Object.values(ws.nodes)) {
    const topic = node.statement?.topic;
    if (!topic) continue;
    const key = canonicalizeTopic(topic) || topic;
    let group = topicGroups.find((g) => topicsAreVariants(g.header, key));
    if (!group) {
      group = { header: key, authored: new Set(), statements: [] };
      topicGroups.push(group);
      if (topicGroups.length > ASK_DIGEST_LIMITS.topics) break;
    }
    group.authored.add(topic);
    if (group.statements.length < ASK_DIGEST_LIMITS.topicStatements) {
      group.statements.push({
        id: node.id,
        kind: node.statement!.kind,
        status: node.statement!.status,
      });
    }
  }
  const topicSections = topicGroups
    .slice(0, ASK_DIGEST_LIMITS.topics)
    .map((g) => {
      const authored = [...g.authored];
      // The representative the fold would choose: shortest, then
      // lexicographic — the grouping and the fold converge on the same key.
      const representative = [...authored]
        .map(canonicalizeTopic)
        .sort((x, y) => x.length - y.length || x.localeCompare(y))[0]!;
      const note =
        authored.length > 1 || authored[0] !== representative
          ? ` (authored: ${authored.join(", ")})`
          : "";
      const rows = g.statements.map((s) => `  ${s.id}: ${s.kind} · ${s.status}`);
      return `topic ${representative}${note}:\n${rows.join("\n")}`;
    });
  if (topicSections.length) {
    lines.push(
      `Statements by topic (each topic's statements grouped — the answer to "what happened with X?" is one section):\n${topicSections.join("\n")}`,
    );
  }

  return lines.join("\n");
}

/**
 * Project the visible meetings: id, date, speakers, and ONLY the classified
 * turns (decision/action/problem/hypothesis/solution/requirement), each
 * carrying its stable INDEX (Stage C3) — the same coordinate turnRange and
 * the transcript jump key on, so an answer naming "turn 4 of meeting M"
 * lands on the exact words. Unclassified turns stay in the transcript where
 * search can find them later — not every sentence deserves context-window
 * space, the same judgment the "statements on nodes" decision made about
 * board objects.
 */
export function projectMeetings(
  meetings: MeetingTranscript[],
): AnswerMeetingSummary[] {
  return meetings.slice(0, ASK_DIGEST_LIMITS.meetings).map((m) => {
    const classified = m.turns
      .map((t, index) => ({ t, index }))
      .filter(
        (entry): entry is { t: typeof entry.t & { kind: NonNullable<typeof entry.t.kind> }; index: number } =>
          Boolean(entry.t.kind),
      )
      .slice(0, ASK_DIGEST_LIMITS.meetingTurns)
      .map(({ t, index }) => ({
        index,
        speaker: t.speaker.slice(0, 120),
        at: t.at,
        kind: t.kind,
        text: t.text.slice(0, ASK_DIGEST_LIMITS.meetingTurnText),
      }));
    const speakers = [...new Set(m.turns.map((t) => t.speaker))].slice(0, 12);
    return { id: m.id, startedAt: m.startedAt, speakers, turns: classified };
  });
}

/**
 * Project the retrieval hits (Stage C4): `retrieve` over the SAME windowed
 * inputs the rest of the request derives from, distilled to the
 * answer-contract shape. Still a projection — the hits are computed here,
 * never stored, and carry only ids the model may already cite (the corpus
 * is the caller's window). Turn hits surface the meeting id + turn index
 * the model cites through the existing three kinds; the snippet, not the
 * whole turn, is what the answer budget can afford.
 */
export function projectRetrieval(
  question: string,
  input: AskContextInput,
): AnswerRetrievalHit[] {
  const corpus = buildSearchCorpus({
    workspace: input.workspace,
    meetings: input.meetings,
    log: input.log,
    actorNames: input.actorNames,
  });
  return retrieve(question, corpus, SEARCH_LIMITS.forAsk).map((hit) => {
    if (hit.kind === "turn") {
      return {
        kind: "turn" as const,
        id: hit.meetingId,
        meetingId: hit.meetingId,
        turnIndex: hit.turnIndex,
        label: `${hit.speaker}: ${hit.snippet}`,
        matched: hit.matched,
      };
    }
    if (hit.kind === "revision") {
      return {
        kind: "revision" as const,
        id: String(hit.seq),
        label: `rev ${hit.seq} · ${hit.label.slice(0, 80)}${hit.actorName ? ` · ${hit.actorName}` : ""}`,
        matched: hit.matched,
      };
    }
    return {
      kind: "node" as const,
      id: hit.id,
      label: hit.statement
        ? `${hit.label} [${hit.statement.kind} · ${hit.statement.status}${
            hit.statement.topic ? ` · topic: ${hit.statement.topic}` : ""
          }]`
        : hit.label,
      matched: hit.matched,
    };
  });
}

/**
 * Build the whole AnswerRequest. Pure: same inputs, same request, so the
 * route tests can assert on the exact context a Free caller's question
 * produced — the context-scope guarantee (amendment 2) is checkable because
 * this function is exported and deterministic.
 */
export function buildAnswerRequest(input: AskContextInput): AnswerRequest {
  const history = input.log.slice(0, ASK_DIGEST_LIMITS.history).map((entry) => ({
    seq: entry.seq,
    at: entry.at,
    label: entry.label.slice(0, 240),
    actorName: actorDisplayName(entry, input.actorNames),
    actorType: entry.actor?.actorType ?? "user",
    opCount: entry.ops.length,
  }));
  const retrieved = projectRetrieval(input.question, input);
  return {
    question: input.question,
    boardName: input.boardName,
    boardDigest: renderBoardDigest(input),
    history,
    historyTruncated: input.window.hasMore,
    historyDepth: input.window.depth,
    meetings: projectMeetings(input.meetings),
    // The honest meetings window (Stage C3): the digest caps at
    // ASK_DIGEST_LIMITS.meetings, and the model must know when older
    // meetings exist beyond it — the same honesty rule as historyTruncated.
    meetingsTruncated: input.meetings.length > ASK_DIGEST_LIMITS.meetings,
    // Retrieved evidence (Stage C4): keyword hits over the same window the
    // digest rendered — including the unclassified turns and over-cap
    // content no section above shows. Omitted when empty (the prompt layer
    // treats an empty section as noise).
    ...(retrieved.length ? { retrieved } : {}),
    nodeIndex: Object.entries(input.workspace.nodes)
      .slice(0, ASK_DIGEST_LIMITS.nodeIndex)
      .map(([id, node]) => ({ id, label: node.label.slice(0, ASK_DIGEST_LIMITS.nodeLabel) })),
    ...(input.conversation ? { conversation: input.conversation } : {}),
  };
}
