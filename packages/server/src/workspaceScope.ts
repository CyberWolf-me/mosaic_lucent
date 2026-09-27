import type { StoredBoard } from "./boards.js";
import type { MeetingStore, MeetingTranscript } from "./meetings.js";
import type { ProjectStore } from "./projects.js";

/**
 * A scope for workspace Search and Ask (docs/26 J4, ADR 0048): the boards the
 * caller can read, narrowed by project, board or meeting, and bounded in time.
 * Every workspace read resolves its scope here, so none can name a board the
 * caller couldn't open.
 */
export interface ScopeInput {
  project?: string;
  board?: string;
  meeting?: string;
  /** Epoch ms, inclusive. */
  since?: number;
  /** Epoch ms, inclusive. */
  until?: number;
}

export interface ResolvedScope {
  boards: StoredBoard[];
  /** The meetings on those boards (newest first), already time-bounded. */
  meetings: MeetingTranscript[];
  since?: number;
  until?: number;
  /** What the scope is, in words, for the answer's context. */
  label: string;
}

/** How many meetings a scope reads (newest first). */
export const SCOPE_MEETINGS = 60;

/** Read a scope from query params or a JSON body; `null` means malformed. */
export function parseScope(source: URLSearchParams | Record<string, unknown>): ScopeInput | null {
  const get = (key: string): unknown =>
    source instanceof URLSearchParams ? (source.get(key) ?? undefined) : source[key];
  const out: ScopeInput = {};
  for (const key of ["project", "board", "meeting"] as const) {
    const v = get(key);
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 120) return null;
    out[key] = v;
  }
  for (const key of ["since", "until"] as const) {
    const v = get(key);
    if (v === undefined || v === null || v === "") continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) || Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  if (out.since !== undefined && out.until !== undefined && out.since > out.until) return null;
  return out;
}

export const within = (at: number, scope: { since?: number; until?: number }): boolean =>
  (scope.since === undefined || at >= scope.since) &&
  (scope.until === undefined || at <= scope.until);

/**
 * Resolve a scope against what the caller can read. A project, board or
 * meeting the caller can't see is "not found" — the same answer as one that
 * doesn't exist.
 */
export async function resolveScope(
  deps: {
    readableBoards: (
      userId: string,
      orgId: string,
    ) => Promise<{ member: boolean; boards: StoredBoard[] }>;
    projects: ProjectStore;
    meetings: MeetingStore | undefined;
  },
  userId: string,
  orgId: string,
  input: ScopeInput,
): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; error: string }> {
  const { boards: readable } = await deps.readableBoards(userId, orgId);
  let boards = readable;
  const label: string[] = [];
  if (input.project) {
    const project = await deps.projects.get(input.project);
    const linked = new Set(project?.orgId === orgId ? project.boardIds : []);
    boards = boards.filter((b) => linked.has(b.id));
    if (!project || project.orgId !== orgId || boards.length === 0) {
      return { ok: false, error: "project not found" };
    }
    label.push(`the project “${project.name}”`);
  }
  if (input.board) {
    boards = boards.filter((b) => b.id === input.board);
    if (boards.length === 0) return { ok: false, error: "board not found" };
    label.push(`the board “${boards[0]!.name}”`);
  }
  let meetings: MeetingTranscript[] = [];
  if (deps.meetings && boards.length > 0) {
    meetings = await deps.meetings.forBoards(
      boards.map((b) => b.id),
      SCOPE_MEETINGS,
    );
  }
  if (input.meeting) {
    meetings = meetings.filter((m) => m.id === input.meeting);
    if (meetings.length === 0) return { ok: false, error: "meeting not found" };
    boards = boards.filter((b) => b.id === meetings[0]!.boardId);
    label.push(meetings[0]!.title ? `the meeting “${meetings[0]!.title}”` : "one meeting");
  }
  if (input.since !== undefined || input.until !== undefined) {
    meetings = meetings.filter(
      (m) => m.turns.some((t) => within(t.at, input)) || within(m.startedAt, input),
    );
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    label.push(
      input.since !== undefined && input.until !== undefined
        ? `from ${day(input.since)} to ${day(input.until)}`
        : input.since !== undefined
          ? `since ${day(input.since)}`
          : `until ${day(input.until!)}`,
    );
  }
  return {
    ok: true,
    scope: {
      boards,
      meetings,
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      label: label.length > 0 ? label.join(", ") : "the whole workspace",
    },
  };
}
