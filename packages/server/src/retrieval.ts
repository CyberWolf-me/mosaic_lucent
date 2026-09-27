import type { Workspace } from "@lucent/core";
import type { LoggedOpEntry } from "./boards.js";
import type { MeetingTranscript } from "./meetings.js";

/**
 * Lexical retrieval (Stage C4, ADR 0024): one seam, one boundary.
 *
 * THE SEAM is `retrieve(query, corpus)`. Two consumers share it — the search
 * route (ranked results for ⌘K) and the ask route (evidence beyond the digest
 * caps) — and a future embeddings scorer swaps in behind the same signature
 * without touching either. The scorer here is weighted lexical on purpose:
 * deterministic, cheap, explainable (every hit carries the query tokens that
 * fired, so the UI can say "Matching: pricing, 20" instead of "similarity
 * 0.83"), and runnable offline in tests. Embeddings arrive only when real
 * usage shows lexical misses ("how do we make money?" vs "monetization
 * strategy") — and they need their own ADR first, per ADR 0023's rule that
 * derived state gets durability only through a decision record.
 *
 * THE BOUNDARY is the corpus contract: `buildSearchCorpus` receives data the
 * CALLER already windowed (the ask/search routes load it with the same
 * `loadVisibleLog` + `visibleMeetings` arithmetic every other read uses), so
 * the retriever cannot reach anything outside the caller's entitlement. A
 * Free user's "revision 26" never gets filtered out of results — it was
 * never in the corpus. Search sees exactly what Ask sees; that is the C4
 * acceptance criterion, and it holds by construction.
 *
 * What the digest caps hide is real search space: unclassified turns are
 * projected nowhere (the C1 comment in askContext named them search's
 * corpus), meetings beyond the 10-meeting cap and nodes beyond the 200-node
 * cap are invisible to the model — retrieval reaches all of it, inside the
 * window. Nothing here is persisted; a corpus is rebuilt per request from
 * canonical state, like every other read-side projection.
 */

export const SEARCH_LIMITS = {
  /** Hard ceiling on returned hits, whatever the caller asks. */
  resultsMax: 20,
  /** A search query is not a message; 200 chars bounds the absurd. */
  queryMaxChars: 200,
  /** The most query tokens any scan considers. */
  queryTokens: 12,
  /** Evidence budget inside one answer request. */
  forAsk: 8,
  /** Transcript snippet length for turn hits. */
  snippet: 160,
} as const;

/* -------------------------------------------------------------------------- */
/* Hits — what the two consumers consume                                       */
/* -------------------------------------------------------------------------- */

/** The statement fields a search result displays (the chip's content). */
export interface HitStatement {
  kind: "decision" | "proposal" | "question" | "action" | "requirement" | "risk";
  status: "open" | "resolved" | "rejected" | "superseded";
  topic?: string;
}

/** A matching node. Navigates via the existing node citation (?reveal=). */
export interface NodeSearchHit {
  kind: "node";
  id: string;
  label: string;
  nodeType: string;
  statement?: HitStatement;
  /** The query tokens (as typed, normalized) that matched this hit. */
  matched: string[];
  score: number;
}

/**
 * A matching transcript turn — this is also how meetings surface in search:
 * meetings carry no title, so the turns are the meeting's searchable text.
 * Navigates via the existing meeting citation (?meeting= + ?turn=).
 */
export interface TurnSearchHit {
  kind: "turn";
  meetingId: string;
  /** The turn's stable index — the same coordinate turnRange and ?turn= use. */
  turnIndex: number;
  speaker: string;
  /** Match-anchored extract of the turn's text. */
  snippet: string;
  matched: string[];
  score: number;
}

/** A matching revision label. Navigates via the revision citation (?rev=). */
export interface RevisionSearchHit {
  kind: "revision";
  seq: number;
  label: string;
  at: number;
  actorName?: string;
  matched: string[];
  score: number;
}

export type SearchHit = NodeSearchHit | TurnSearchHit | RevisionSearchHit;

/* -------------------------------------------------------------------------- */
/* Normalization — the user's list, no more: lowercase, NFKD fold, punctuation */
/* split, plural fold, prefix, shared stem                                      */
/* -------------------------------------------------------------------------- */

/** Combining marks, stripped after the NFKD fold (café → cafe). */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Normalize text to a comparable form: case-folded, accent-stripped, with
 * everything that isn't a letter or digit acting as a token separator — so
 * "$15" reads as the token "15" and "user's" reads as "user" + "s".
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The comparison form of a token: a single plural fold. `ies` → `y`
 * (policies → policy); otherwise drop a trailing `s` (prices → price,
 * services → service). No second `es` rule — an over-eager one breaks the
 * regular plurals (prices → pric), and the prefix/shared-stem matchers below
 * rescue the irregular ones (classes → classe still matches class). The fold
 * is applied to BOTH sides, so it is symmetric: even a linguistically wrong
 * fold only ever compares equal against another token folded the same way.
 */
function foldToken(token: string): string {
  if (token.length >= 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Length of the shared prefix of two strings. */
function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Does a query token match a corpus token? Four matchers, in order:
 *
 * 1. Equality after folding (prices ≡ price).
 * 2. Prefix: the shorter side (≥ 3 chars) starts the longer (pri → pricing).
 * 3. Shared stem: both ≥ 5 chars with a common prefix ≥ 4 and short tails
 *    on either side (price ↔ pricing; the tail cap keeps "monetization"
 *    away from "monetary").
 */
export function tokensMatch(queryToken: string, corpusToken: string): boolean {
  const q = foldToken(queryToken);
  const c = foldToken(corpusToken);
  if (q === c) return true;
  const [short, long] = q.length <= c.length ? [q, c] : [c, q];
  if (short.length >= 3 && long.startsWith(short)) return true;
  if (q.length >= 5 && c.length >= 5) {
    const common = sharedPrefix(q, c);
    if (common >= 4 && q.length - common <= 4 && c.length - common <= 4) return true;
  }
  return false;
}

/**
 * The query's tokens: normalized, de-duplicated by FOLDED form (a repeated
 * word must not double-score, and "pricing prices" is one word twice),
 * stopword-trimmed by length only (a 1-char token is noise; a real stopword
 * list is a tuning knob, not a C4 dependency), capped at 12 so a pasted
 * paragraph does not scan the corpus 800 times.
 */
export function queryTokensOf(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of normalizeText(query).split(/\s+/)) {
    if (token.length < 2) continue;
    const key = foldToken(token);
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length >= SEARCH_LIMITS.queryTokens) break;
  }
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

/** Field weights. The user's table; node type joins kind/status at 3 so
 * "find all services" works the way "find decisions" does. */
const WEIGHTS = {
  nodeLabel: 5,
  statementTopic: 4,
  statementKindStatus: 3,
  nodeType: 3,
  provenanceQuote: 2,
  revisionLabel: 2,
  turnText: 1,
} as const;

interface CorpusField {
  weight: number;
  /** Pre-folded comparison tokens for this field's text. */
  tokens: string[];
}

function field(weight: number, text: string | undefined): CorpusField | undefined {
  if (!text) return undefined;
  const tokens = normalizeText(text).split(/\s+/).filter(Boolean);
  return tokens.length ? { weight, tokens } : undefined;
}

interface NodeCorpusItem {
  kind: "node";
  id: string;
  label: string;
  nodeType: string;
  statement?: HitStatement;
  fields: CorpusField[];
}

interface TurnCorpusItem {
  kind: "turn";
  meetingId: string;
  turnIndex: number;
  speaker: string;
  /** Raw text, for the match-anchored snippet. */
  text: string;
  fields: CorpusField[];
}

interface RevisionCorpusItem {
  kind: "revision";
  seq: number;
  label: string;
  at: number;
  actorName?: string;
  fields: CorpusField[];
}

export type CorpusItem = NodeCorpusItem | TurnCorpusItem | RevisionCorpusItem;

export interface SearchCorpus {
  items: CorpusItem[];
}

/** What the caller (already-windowed) hands the corpus builder. */
export interface SearchCorpusInput {
  workspace: Workspace;
  meetings: MeetingTranscript[];
  /** The caller's visible window of the op log, newest first. */
  log: LoggedOpEntry[];
  /** Display names by actor id, so revision hits can show who acted. */
  actorNames?: ReadonlyMap<string, string>;
}

/**
 * Assemble the searchable corpus from canonical state. Every input is the
 * caller's windowed read — the route decides visibility, this module trusts
 * it, the same division askContext follows.
 */
export function buildSearchCorpus(input: SearchCorpusInput): SearchCorpus {
  const items: CorpusItem[] = [];

  for (const node of Object.values(input.workspace.nodes)) {
    const fields: CorpusField[] = [];
    const label = field(WEIGHTS.nodeLabel, node.label);
    if (label) fields.push(label);
    const type = field(WEIGHTS.nodeType, node.nodeType);
    if (type) fields.push(type);
    const statement = node.statement;
    if (statement) {
      const topic = field(WEIGHTS.statementTopic, statement.topic);
      if (topic) fields.push(topic);
      const kindStatus = field(
        WEIGHTS.statementKindStatus,
        `${statement.kind} ${statement.status}`,
      );
      if (kindStatus) fields.push(kindStatus);
    }
    const quote = node.provenance?.quote ?? node.statement?.provenance?.quote ?? undefined;
    const quoteField = field(WEIGHTS.provenanceQuote, quote);
    if (quoteField) fields.push(quoteField);
    if (!fields.length) continue;
    items.push({
      kind: "node",
      id: node.id,
      label: node.label,
      nodeType: node.nodeType,
      ...(statement
        ? {
            statement: {
              kind: statement.kind,
              status: statement.status,
              ...(statement.topic ? { topic: statement.topic } : {}),
            },
          }
        : {}),
      fields,
    });
  }

  // Every turn of every visible meeting — classified or not. The
  // unclassified ones are the corpus the digest never shows (C1's promise:
  // "not every sentence deserves context-window space" — search is where
  // those sentences live).
  for (const meeting of input.meetings) {
    meeting.turns.forEach((turn, index) => {
      const text = field(WEIGHTS.turnText, turn.text);
      if (!text) return;
      items.push({
        kind: "turn",
        meetingId: meeting.id,
        turnIndex: index,
        speaker: turn.speaker,
        text: turn.text,
        fields: [text],
      });
    });
  }

  for (const entry of input.log) {
    const label = field(WEIGHTS.revisionLabel, entry.label);
    if (!label) continue;
    const actor = entry.actor;
    const actorId = actor?.actorId ?? entry.by;
    const actorName =
      actor?.actorType === "ai" ? "Lucent" : (input.actorNames?.get(actorId) ?? undefined);
    items.push({
      kind: "revision",
      seq: entry.seq,
      label: entry.label,
      at: entry.at,
      ...(actorName ? { actorName } : {}),
      fields: [label],
    });
  }

  return { items };
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A match-anchored extract: the window around the first match, so a hit in
 * the middle of a 400-character turn still shows the words that matched
 * instead of the turn's opening "so, anyway".
 */
export function snippetAround(text: string, anchor: number, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 1;
  let start = Math.max(0, anchor - half);
  const end = Math.min(text.length, start + max - 2);
  start = Math.max(0, end - max + 2);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** Where in the raw (lowercased) text a matched token first appears. */
export function anchorIndex(rawText: string, token: string): number {
  const direct = rawText.indexOf(token);
  if (direct >= 0) return direct;
  const folded = foldToken(token);
  const viaFold = folded === token ? -1 : rawText.indexOf(folded);
  return viaFold >= 0 ? viaFold : 0;
}

/** Deterministic tie-break order: nodes first (the most actionable hit),
 * then turns, then revisions; equal scores rank by key within a kind. */
const KIND_RANK: Record<CorpusItem["kind"], number> = { node: 0, turn: 1, revision: 2 };

function hitKey(hit: SearchHit): string {
  if (hit.kind === "turn") return `${hit.meetingId}:${hit.turnIndex}`;
  if (hit.kind === "revision") return String(hit.seq);
  return hit.id;
}

/**
 * Retrieve: score every corpus item against the query's tokens, rank
 * score-desc with the deterministic tie-break, cap. Pure — same query, same
 * corpus, same hits, same order, so tests pin behavior and the offline eval
 * stays honest.
 */
export function retrieve(
  query: string,
  corpus: SearchCorpus,
  limit: number = SEARCH_LIMITS.resultsMax,
): SearchHit[] {
  const queryTokens = queryTokensOf(query.slice(0, SEARCH_LIMITS.queryMaxChars));
  if (!queryTokens.length) return [];
  const capped = Math.max(0, Math.min(limit, SEARCH_LIMITS.resultsMax));

  const hits: SearchHit[] = [];
  for (const item of corpus.items) {
    const matched: string[] = [];
    let score = 0;
    for (const token of queryTokens) {
      let weight = 0;
      for (const f of item.fields) {
        if (f.tokens.some((ct) => tokensMatch(token, ct))) weight += f.weight;
      }
      if (weight > 0) {
        matched.push(token);
        score += weight;
      }
    }
    if (!matched.length) continue;

    if (item.kind === "node") {
      hits.push({
        kind: "node",
        id: item.id,
        label: item.label,
        nodeType: item.nodeType,
        ...(item.statement ? { statement: item.statement } : {}),
        matched,
        score,
      });
    } else if (item.kind === "turn") {
      const raw = item.text.toLowerCase();
      const anchorToken = matched
        .map((t) => ({ t, i: anchorIndex(raw, t) }))
        .sort((a, b) => a.i - b.i)[0]!;
      hits.push({
        kind: "turn",
        meetingId: item.meetingId,
        turnIndex: item.turnIndex,
        speaker: item.speaker,
        snippet: snippetAround(item.text, anchorToken.i, SEARCH_LIMITS.snippet),
        matched,
        score,
      });
    } else {
      hits.push({
        kind: "revision",
        seq: item.seq,
        label: item.label,
        at: item.at,
        ...(item.actorName ? { actorName: item.actorName } : {}),
        matched,
        score,
      });
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (rank !== 0) return rank;
    return hitKey(a).localeCompare(hitKey(b));
  });
  return hits.slice(0, capped);
}
