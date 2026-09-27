import type { StatementKind, StatementStatus } from "@lucent/core";
import type { StoredBoard } from "./boards.js";
import { correctedTurns, type MeetingTranscript } from "./meetings.js";
import {
  anchorIndex,
  normalizeText,
  queryTokensOf,
  SEARCH_LIMITS,
  snippetAround,
  tokensMatch,
} from "./retrieval.js";
import { within } from "./workspaceScope.js";

/**
 * Search across a workspace scope (docs/26 J4, ADR 0048): the same lexical
 * retriever as board search (normalize, fold, prefix and shared-stem
 * matching, weighted fields), over everything the scope's boards hold —
 * nodes and statements, meeting titles and turns (as corrected), comments,
 * and the boards' own names. Every hit carries its board, so it opens where
 * it lives. Pure: same scope, same query, same hits.
 */

const WEIGHTS = {
  boardName: 5,
  nodeLabel: 5,
  meetingTitle: 4,
  statementTopic: 4,
  statementKindStatus: 3,
  nodeType: 3,
  comment: 2,
  provenanceQuote: 2,
  turnText: 1,
} as const;

/** The most hits a workspace search returns. */
export const WORKSPACE_SEARCH_MAX = 30;

interface Field {
  weight: number;
  tokens: string[];
}

function field(weight: number, text: string | undefined): Field | undefined {
  if (!text) return undefined;
  const tokens = normalizeText(text).split(/\s+/).filter(Boolean);
  return tokens.length ? { weight, tokens } : undefined;
}

interface Where {
  boardId: string;
  boardName: string;
}

export type WorkspaceHit = Where & { matched: string[]; score: number } & (
    | {
        kind: "node";
        id: string;
        label: string;
        nodeType: string;
        statement?: { kind: StatementKind; status: StatementStatus; topic?: string };
      }
    | {
        kind: "turn";
        meetingId: string;
        meetingTitle: string | null;
        turnIndex: number;
        speaker: string;
        at: number;
        snippet: string;
      }
    | {
        kind: "comment";
        commentId: string;
        targetId: string;
        by: string;
        createdAt: number;
        snippet: string;
      }
    | { kind: "meeting"; meetingId: string; title: string; startedAt: number }
    | { kind: "board" }
  );

const KIND_RANK: Record<WorkspaceHit["kind"], number> = {
  node: 0,
  meeting: 1,
  board: 2,
  turn: 3,
  comment: 4,
};

export function searchWorkspace(
  query: string,
  scope: {
    boards: readonly StoredBoard[];
    meetings: readonly MeetingTranscript[];
    since?: number;
    until?: number;
  },
  limit: number = WORKSPACE_SEARCH_MAX,
): WorkspaceHit[] {
  const queryTokens = queryTokensOf(query.slice(0, SEARCH_LIMITS.queryMaxChars));
  if (queryTokens.length === 0) return [];
  const timed = scope.since !== undefined || scope.until !== undefined;
  const items: Array<{ fields: Field[]; text?: string; hit: Record<string, unknown> }> = [];
  const names = new Map(scope.boards.map((b) => [b.id, b.name] as const));

  for (const board of scope.boards) {
    const where = { boardId: board.id, boardName: board.name };
    // A board's name and its nodes carry no time of their own: a time-bounded
    // scope searches what was said and written in it, not the standing board.
    if (!timed) {
      const name = field(WEIGHTS.boardName, board.name);
      if (name) items.push({ fields: [name], hit: { kind: "board", ...where } });
      for (const node of Object.values(board.workspace.nodes)) {
        const fields = [
          field(WEIGHTS.nodeLabel, node.label),
          field(WEIGHTS.nodeType, node.nodeType),
          field(WEIGHTS.statementTopic, node.statement?.topic),
          node.statement
            ? field(WEIGHTS.statementKindStatus, `${node.statement.kind} ${node.statement.status}`)
            : undefined,
          field(
            WEIGHTS.provenanceQuote,
            node.provenance?.quote ?? node.statement?.provenance?.quote,
          ),
        ].filter((f): f is Field => f !== undefined);
        if (fields.length === 0) continue;
        items.push({
          fields,
          hit: {
            kind: "node",
            ...where,
            id: node.id,
            label: node.label,
            nodeType: node.nodeType,
            ...(node.statement
              ? {
                  statement: {
                    kind: node.statement.kind,
                    status: node.statement.status,
                    ...(node.statement.topic ? { topic: node.statement.topic } : {}),
                  },
                }
              : {}),
          },
        });
      }
    }
    for (const comment of Object.values(board.workspace.comments ?? {})) {
      if (timed && !within(comment.createdAt, scope)) continue;
      const body = field(WEIGHTS.comment, comment.body);
      if (!body) continue;
      items.push({
        fields: [body],
        text: comment.body,
        hit: {
          kind: "comment",
          ...where,
          commentId: comment.id,
          targetId: comment.targetId,
          by: comment.by,
          createdAt: comment.createdAt,
        },
      });
    }
  }

  for (const meeting of scope.meetings) {
    const where = { boardId: meeting.boardId, boardName: names.get(meeting.boardId) ?? "" };
    if (meeting.title && (!timed || within(meeting.startedAt, scope))) {
      const title = field(WEIGHTS.meetingTitle, meeting.title);
      if (title) {
        items.push({
          fields: [title],
          hit: {
            kind: "meeting",
            ...where,
            meetingId: meeting.id,
            title: meeting.title,
            startedAt: meeting.startedAt,
          },
        });
      }
    }
    correctedTurns(meeting).forEach((turn, index) => {
      if (timed && !within(turn.at, scope)) return;
      const text = field(WEIGHTS.turnText, turn.text);
      if (!text) return;
      items.push({
        fields: [text],
        text: turn.text,
        hit: {
          kind: "turn",
          ...where,
          meetingId: meeting.id,
          meetingTitle: meeting.title ?? null,
          turnIndex: index,
          speaker: turn.speaker,
          at: turn.at,
        },
      });
    });
  }

  const hits: WorkspaceHit[] = [];
  for (const item of items) {
    const matched: string[] = [];
    let score = 0;
    for (const token of queryTokens) {
      let weight = 0;
      for (const f of item.fields)
        if (f.tokens.some((t) => tokensMatch(token, t))) weight += f.weight;
      if (weight > 0) {
        matched.push(token);
        score += weight;
      }
    }
    if (matched.length === 0) continue;
    let snippet: string | undefined;
    if (item.text !== undefined) {
      const raw = item.text.toLowerCase();
      const anchor = matched.map((t) => anchorIndex(raw, t)).sort((a, b) => a - b)[0]!;
      snippet = snippetAround(item.text, anchor, SEARCH_LIMITS.snippet);
    }
    hits.push({
      ...item.hit,
      ...(snippet !== undefined ? { snippet } : {}),
      matched,
      score,
    } as WorkspaceHit);
  }

  const key = (h: WorkspaceHit): string =>
    h.kind === "node"
      ? `${h.boardId}:${h.id}`
      : h.kind === "turn"
        ? `${h.meetingId}:${h.turnIndex}`
        : h.kind === "comment"
          ? h.commentId
          : h.kind === "meeting"
            ? h.meetingId
            : h.boardId;
  hits.sort(
    (a, b) =>
      b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind] || key(a).localeCompare(key(b)),
  );
  return hits.slice(0, Math.max(0, Math.min(limit, WORKSPACE_SEARCH_MAX)));
}
