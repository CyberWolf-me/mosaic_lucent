import type { AnswerRequest, AnswerMeetingSummary } from "@lucent/ai";
import type { Node, Workspace } from "@lucent/core";
import type { LoggedOpEntry } from "./boards.js";
import type { MeetingTranscript } from "./meetings.js";

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

  return lines.join("\n");
}

/**
 * Project the visible meetings: id, date, speakers, and ONLY the classified
 * turns (decision/action/problem/hypothesis/solution/requirement). Unclassified
 * turns stay in the transcript where search can find them later — not every
 * sentence deserves context-window space, the same judgment the "statements
 * on nodes" decision made about board objects.
 */
export function projectMeetings(
  meetings: MeetingTranscript[],
): AnswerMeetingSummary[] {
  return meetings.slice(0, ASK_DIGEST_LIMITS.meetings).map((m) => {
    const classified = m.turns
      .filter((t): t is typeof t & { kind: NonNullable<typeof t.kind> } => Boolean(t.kind))
      .slice(0, ASK_DIGEST_LIMITS.meetingTurns)
      .map((t) => ({
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
  return {
    question: input.question,
    boardName: input.boardName,
    boardDigest: renderBoardDigest(input),
    history,
    historyTruncated: input.window.hasMore,
    historyDepth: input.window.depth,
    meetings: projectMeetings(input.meetings),
    nodeIndex: Object.entries(input.workspace.nodes)
      .slice(0, ASK_DIGEST_LIMITS.nodeIndex)
      .map(([id, node]) => ({ id, label: node.label.slice(0, ASK_DIGEST_LIMITS.nodeLabel) })),
    ...(input.conversation ? { conversation: input.conversation } : {}),
  };
}
