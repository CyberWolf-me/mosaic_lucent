import type { ProvenanceFields, StatementFields, StatementTrust, Workspace } from "@lucent/core";

/**
 * The meeting brief: what a meeting DECIDED, ASSIGNED, LEFT OPEN and FLAGGED,
 * read straight off the board. This is the difference between Lucent and a
 * recorder — the minutes are not a summary somebody writes (or a model
 * paraphrases), they are the typed statements the meeting produced, each one
 * a click from the words that produced it.
 *
 * Deterministic and pure (no model call, no DOM): a statement belongs to a
 * meeting when either of its provenance records — the node's creation
 * evidence or the statement's own — names the meeting's id. The view only
 * lays out what this decides; the web suite tests it without a browser.
 */

/** The order a brief reads in: what was settled, who does what, what is unresolved. */
export const BRIEF_ORDER = [
  "decision",
  "action",
  "question",
  "risk",
  "proposal",
  "requirement",
] as const satisfies ReadonlyArray<StatementFields["kind"]>;

/**
 * The separator line the meeting view splices into extraction prompts at a
 * topic break. It lives here because the live-session check below must
 * recognise a quote that begins with one.
 */
export const TOPIC_BREAK_LINE = "── topic break ──";

/** The id a live capture stamps before (or without) a server transcript. */
const LIVE_SESSION = "live-session";

export interface BriefItem {
  nodeId: string;
  kind: StatementFields["kind"];
  status: StatementFields["status"];
  label: string;
  /** Actions: the owner, from the node's work fields. */
  assignee?: string;
  /** Actions: the ISO due date, from the node's work fields. */
  dueDate?: string;
  /** Inclusive index range into the meeting's turns. */
  turnRange?: [number, number];
  /** The words that produced the statement (the extraction batch, capped at 240). */
  quote?: string;
  /** Statements this one replaces — ids that still exist on the board. */
  supersedes?: string[];
  /** How it came to be trusted (ADR 0047); absent on statements from before trust. */
  trust?: StatementTrust;
}

/** Still waiting on a person's step (docs/28 S9): the AI suggested it and nobody decided. */
export function awaitsReview(item: Pick<BriefItem, "trust">): boolean {
  return item.trust === "ai-suggested";
}

export interface BriefSection {
  kind: StatementFields["kind"];
  items: BriefItem[];
}

export interface MeetingBrief {
  meetingId: string;
  /**
   * True for the "live-session" placeholder: there is no stored transcript
   * behind that id, so its items were matched against the caller's live
   * turns instead — provisional until a real transcript id exists.
   */
  provisional: boolean;
  /** Non-empty sections only, in BRIEF_ORDER. */
  sections: BriefSection[];
  total: number;
  /** How many of them still wait on review (docs/28 S9). */
  suggested: number;
}

export interface BriefMeeting {
  id: string;
  /**
   * The transcript the caller holds, when it holds one. With it, turn ranges
   * are clamped to turns that exist (a citation must land on a real line);
   * for the live-session placeholder it is required — see liveStampMatches.
   */
  turns?: ReadonlyArray<{ text: string }>;
}

/**
 * The "live-session" placeholder is shared by every capture that ran without
 * a server transcript, so an id match alone would pull statements from an
 * earlier capture into this one's brief. A stamp is this capture's only when
 * its quote opens with the words of the turn its range starts at (the quote
 * is the extraction batch joined; a topic-break line may precede it).
 */
function liveStampMatches(
  record: ProvenanceFields,
  turns: ReadonlyArray<{ text: string }>,
): boolean {
  if (!record.turnRange || !record.quote) return false;
  const first = turns[record.turnRange[0]];
  if (!first) return false;
  const head = first.text.trim();
  if (head === "") return false;
  const quote = record.quote.trim();
  return (
    quote.startsWith(head.slice(0, 240)) ||
    quote.startsWith(`${TOPIC_BREAK_LINE} ${head}`.slice(0, 240))
  );
}

/** Clamp a range to the transcript; undefined when it starts past the end. */
function clampRange(
  range: [number, number],
  turnCount: number | undefined,
): [number, number] | undefined {
  const start = Math.max(0, range[0]);
  const end = Math.max(start, range[1]);
  if (turnCount === undefined) return [start, end];
  if (start >= turnCount) return undefined;
  return [start, Math.min(end, turnCount - 1)];
}

/**
 * Build the brief for one meeting. Items are ordered by the turn they were
 * first heard at; statements with no turn range (they belong to the meeting
 * as a whole) follow, in board order.
 */
export function meetingBrief(workspace: Workspace, meeting: BriefMeeting): MeetingBrief {
  const live = meeting.id === LIVE_SESSION;
  const empty: MeetingBrief = {
    meetingId: meeting.id,
    provisional: live,
    sections: [],
    total: 0,
    suggested: 0,
  };
  // No transcript behind the placeholder: nothing can be attributed to it.
  if (live && !meeting.turns) return empty;
  const turnCount = meeting.turns?.length;

  const found: Array<{ item: BriefItem; order: number }> = [];
  let order = 0;
  for (const node of Object.values(workspace.nodes)) {
    order += 1;
    const statement = node.statement;
    if (!statement) continue;
    // The statement's own evidence first: it is about the statement; the
    // creation record is about the node, which may predate the statement.
    const records = [statement.provenance, node.provenance].filter(
      (r): r is ProvenanceFields =>
        r !== undefined &&
        r.meetingId === meeting.id &&
        (!live || liveStampMatches(r, meeting.turns!)),
    );
    if (records.length === 0) continue;

    const rawRange = records.find((r) => r.turnRange)?.turnRange;
    const turnRange = rawRange ? clampRange(rawRange, turnCount) : undefined;
    const quote = records.find((r) => r.quote)?.quote;
    const supersedes = (statement.supersedes ?? []).filter((id) => id in workspace.nodes);
    const item: BriefItem = {
      nodeId: node.id,
      kind: statement.kind,
      status: statement.status,
      label: node.label,
      ...(node.issue?.assignee ? { assignee: node.issue.assignee } : {}),
      ...(node.issue?.dueDate ? { dueDate: node.issue.dueDate } : {}),
      ...(turnRange ? { turnRange } : {}),
      ...(quote ? { quote } : {}),
      ...(supersedes.length > 0 ? { supersedes } : {}),
      ...(statement.trust ? { trust: statement.trust } : {}),
    };
    found.push({ item, order });
  }

  found.sort((a, b) => {
    const ra = a.item.turnRange;
    const rb = b.item.turnRange;
    if (ra && rb) return ra[0] - rb[0] || ra[1] - rb[1] || a.order - b.order;
    if (ra) return -1;
    if (rb) return 1;
    return a.order - b.order;
  });

  const sections: BriefSection[] = [];
  for (const kind of BRIEF_ORDER) {
    const items = found.filter((f) => f.item.kind === kind).map((f) => f.item);
    if (items.length > 0) sections.push({ kind, items });
  }
  return {
    meetingId: meeting.id,
    provisional: live,
    sections,
    total: found.length,
    suggested: found.filter((f) => awaitsReview(f.item)).length,
  };
}

/** The people who spoke, in order of first appearance — never invented. */
export function speakersOf(turns: ReadonlyArray<{ speaker: string }>): string[] {
  const seen: string[] = [];
  for (const t of turns) {
    const name = t.speaker.trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Elapsed time as a transcript stamp: "04:07", or "1:02:09" past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * The turn indices a citation covers, as pills: one per turn for a short
 * range, or the range's two ends when it spans more than `max` turns (a
 * whole-meeting extraction must not print forty chips).
 */
export function citationTurns(
  range: [number, number],
  max = 4,
): { kind: "turns"; turns: number[] } | { kind: "span"; from: number; to: number } {
  const [start, end] = range;
  if (end - start + 1 > max) return { kind: "span", from: start, to: end };
  const turns: number[] = [];
  for (let i = start; i <= end; i++) turns.push(i);
  return { kind: "turns", turns };
}
